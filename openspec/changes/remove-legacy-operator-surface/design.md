# Design: remove-legacy-operator-surface

## Context

The Electron pivot (#214) replaced the old operator workflow (Nest HTTP API on a port, React app in a browser, Docker compose, `setup.sh` bootstrap, bearer-token auth) with a packaged desktop app whose renderer talks to desktop-main over Electron IPC. The HTTP→IPC conversions (#152–#159) used a paired-controller pattern: each IPC controller got a sibling `*-http.controller.ts` shim so the browser workflow kept working during the transition. That transition is over: `main.ts` boots only `NestFactory.createMicroservice` with the Electron IPC transport, `ApiTokenGuard`/`ApiTokenModal` are deleted (#161/#162), `web/src/api.service.ts` talks exclusively to `window.gsd`, and the deployed pre-pivot AWS stack has been destroyed. Issue #293 tracks deleting the leftovers.

Investigation findings that shape this design:

- **Nine shim pairs exist, not seven.** The issue lists 7 (`config`, `costs`, `diagnostics`, `discord`, `env`, `files`, `games`); `audit-http` and `drift-http` were added by later conversions. All 9 are registered in `AppModule` but never served — no HTTP adapter is bootstrapped anywhere.
- **The tier-2 integration harness has no shim dependency.** `ipc-harness.ts` dispatches to controller methods through the DI container; every `ipc.dispatch(...)` in `e2e/integration-specs/` targets an IPC controller (`GamesController`, `DiscordController`, `EnvController`). The only `*Http*` mention is a doc comment in `error-propagation.spec.ts`.
- **The five chromium Playwright specs never touch the real HTTP surface.** They run against `vite preview` (a static file server). `page.addInitScript(installGsdHttpBridge)` installs a fake `window.gsd` that forwards each call to a `fetch('/api/...')`, and `page.route()` intercepts those fetches *inside the browser*. desktop-main is never started. CI e2e is green on both projects as of 2026-07-23.
- **`server_config.json` is dual-purpose.** It stores the (dead) `api_token` field AND the (live) watchdog tunables consumed by `ConfigController` and the Settings page. Only the token path can go.
- **No CI workflow references Docker or `setup.sh`** — nothing to remove in `.github/workflows/`.
- **`src/generated/tfstate.ts` is already gone** — the directory is empty and untracked; the issue's dead-artifact item is verify-only.
- **`setup.ps1` exists** as the Windows twin of `setup.sh` (referenced by `docs/docs/setup.md`); it is part of the same legacy bootstrap story.

## Goals / Non-Goals

**Goals:**

- Delete the HTTP transport layer from desktop-main (9 shim controllers + tests, `AppModule` registrations, express dependencies) with zero behavior change to the IPC surface.
- Delete the Docker/shell deployment artifacts (`Dockerfile`, `docker-compose.yml`, `Makefile`, `setup.sh`, `setup.ps1`).
- Strip `api_token` plumbing from `ConfigService` while preserving watchdog-tunable persistence in `server_config.json`.
- Refresh every operator-facing doc (`CLAUDE.md`, `README.md`, `docs/docs/setup.md`, `docs/docs/architecture.md`, `docs/docs/intro.md`, `docs/docs/components/management-app.md`, guides) so nothing points at removed surface.
- Close #293.

**Non-Goals:**

- Migrating the five chromium specs (`audit`, `games`, `pending-changes-banner`, `polling`, `settings`) to the `electron` Playwright project — that is Epic F scope (F.2–F.6, gated on per-spec issues), and the specs are proven independent of the deleted surface.
- Deleting `gsd-http-bridge.ts` or the `chromium` project config — they are test-only browser-side fixtures that Epic F retires spec-by-spec.
- Terraform restructure (#185/#187), `project_name` rename (#213), ALB removal (#292) — explicitly out of scope per the issue.
- Any change to the IPC controllers, preload bridge, or renderer.

## Decisions

**D1 — Delete all nine shim pairs, not the issue's seven.** The issue text predates the `audit` and `drift` conversions. The requirement is "no HTTP transport layer", so the two newer shims (`audit-http`, `drift-http`) are in scope. Alternative — sticking to the literal list of 7 — would leave two orphaned shims registered in `AppModule` and defeat the purpose.

**D2 — Retain the chromium specs and `gsd-http-bridge.ts` unchanged; do not migrate or delete them here.** Verified: they are fully self-contained (browser-side `page.route()` stubs; the bridge fakes `window.gsd` in the page; no server is started), so shim deletion cannot break them. Alternatives considered: (a) migrate them to the `electron` project now — rejected, that is Epic F's per-spec work (F.2–F.6) with its own issues and would balloon this chore far past #293's scope (see the systems-check scope-explosion lesson); (b) delete them — rejected, they still provide the only coverage for those five pages' route-level behavior. The e2e chromium suite runs as a verification gate in the shim-deletion PR to prove the retention decision, honoring the issue's "verify, don't assume" note.

**D3 — Strip only the `api_token` path from `ConfigService`; keep `server_config.json`.** The issue's "strip `api_token` / `server_config.json` handling … if nothing consumes it" resolves to: the token has no consumers (guard deleted, web has zero `apiToken` references), but the file also persists watchdog tunables that the Settings page actively reads/writes. Deleting the whole file handling would break a live feature. Removed: the `API_TOKEN` env accessor, the `api_token` field parsing, and the token-resolution method + their tests.

**D4 — Drop `@nestjs/platform-express`, `express`, `@types/express` from desktop-main.** After the shims go, no source file imports express or uses HTTP route decorators (verified by grep — only the `-http` controllers do today). Keeping unused deps would preserve the illusion that an HTTP surface exists. If compilation reveals a hidden transitive need (e.g. a Nest peer requirement), the dep is restored with a comment explaining why — but `createMicroservice` with a custom transport strategy does not require the express platform.

**D5 — Two PRs, shims first.** PR1 (code): shim + `api_token` + dependency deletion — mechanical, test-gated, easy to review as pure deletion. PR2 (repo root + docs): Docker artifacts and the doc sweep including the `CLAUDE.md` refresh — doc rewrites generate discussion and should not block the code deletion. PR2 carries `Closes #293`. Alternative — one PR — rejected: ~18 deleted source files plus a multi-file doc rewrite in one diff makes it hard to see whether behavior changed. A three-PR split (separate chromium-spec migration PR) is unnecessary per D2.

**D6 — `CLAUDE.md` gets a targeted refresh, not just deletions.** Known-stale content: the "API authentication" section describes the deleted `ApiTokenGuard` as current and load-bearing ("Don't remove the guard"); the commands block still shows `docker compose up` and `./setup.sh`; the architecture summary describes the Nest API reading tfstate for a browser client. The refresh rewrites these to the Electron/IPC reality and removes the setup.sh bootstrap mention, staying scoped to pre-pivot content (no wholesale rewrite).

## Risks / Trade-offs

- [A doc reference to Docker/setup.sh survives the sweep and misleads an operator] → The sweep task greps the whole `docs/`, `README.md`, and `CLAUDE.md` for `docker`, `setup.sh`, `setup.ps1`, `Makefile`, `api_token`, `ApiTokenGuard`, `server_config.json` (auth context) as its exit criterion, not a hand-curated file list. Historical mentions (e.g. changelog-style notes clearly marked as past) are acceptable; instructions are not.
- [Dropping express deps breaks a hidden Nest peer dependency at build time] → `npm run app:build` + full unit suite gate PR1; fallback in D4 (restore with explanatory comment).
- [The `Makefile` deletion breaks the submodule guide's wrapper workflow] → The submodule guide (`docs/docs/guides/submodule.md`) and `scripts/init-parent.ts` generate a wrapper Makefile in the *parent* repo — verify during PR2 whether the generated wrapper invokes the deleted root `Makefile`/`setup.sh` and update the scaffolder/guide if so.
- [Chromium specs silently depended on something unforeseen] → The retention decision is verified, not assumed: PR1's gate runs the full e2e suite (both projects), and CI runs it again on the PR.
- [`server_config.json` files in the wild still contain an `api_token` field] → The stripped parser simply ignores unknown fields; no migration needed. Confirm the watchdog-config writer does not round-trip (and thus re-persist) the stale field.

## Migration Plan

1. PR1 (`claude/issue-293-delete-http-shims`): delete shims + tests, clean `AppModule`, strip `api_token` from `ConfigService`, drop express deps. Gates: `npm run app:lint`, `npm run app:test`, `npm run app:test:e2e` (both projects), `npm run app:test:integration`.
2. PR2 (`claude/issue-293-remove-docker-story`): delete root deployment artifacts, sweep docs, refresh `CLAUDE.md`, rewrite `architecture.md`. Gates: `npm run app:lint`, `npm run app:test`, docs build (`docs-build.yml` CI), grep sweep clean.
3. Rollback: both PRs are pure deletions/doc edits with no data migration — revert the squash commit if needed.

## Open Questions

- None blocking. The AWS-side orphan audit checklist item in #293 is an operator console/CLI activity, not a repo change; it is tracked as a task but produces no code.
