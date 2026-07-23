# Proposal: remove-legacy-operator-surface

## Why

The Electron desktop pivot (#214) made the old web-app/Docker operator workflow obsolete, and the pre-pivot AWS stack has already been destroyed (checked off in #293). What remains is dead surface that actively misleads: `main.ts` boots only the Electron IPC microservice, yet nine `*-http.controller.ts` shim pairs are still registered in `AppModule`; the repo root still ships `Dockerfile`/`docker-compose.yml`/`Makefile`/`setup.sh`/`setup.ps1`; `ConfigService` still resolves an `api_token` that nothing consumes (the `ApiTokenGuard` it fed was deleted in #161/#162); and `CLAUDE.md`, `README.md`, and the docs site still describe the Docker + bearer-token deployment as current architecture. Issue #293 tracks removing all of it.

## What Changes

- **BREAKING** Delete the HTTP transport layer in `@hyveon/desktop-main`: all nine `*-http.controller.ts` shim controllers and their tests (`audit`, `config`, `costs`, `diagnostics`, `discord`, `drift`, `env`, `files`, `games` — the issue predates `audit-http`/`drift-http`, which were added by later IPC conversions), their `AppModule` registrations, and the now-unused `@nestjs/platform-express` / `express` / `@types/express` dependencies.
- **BREAKING** Delete the Docker/shell deployment story at the repo root: `Dockerfile`, `docker-compose.yml`, `Makefile`, `setup.sh`, and its Windows twin `setup.ps1`.
- Strip `api_token` handling from `ConfigService` (env `API_TOKEN` accessor + `api_token` field parsing in `server_config.json`) and its tests. `server_config.json` itself stays — it still persists the watchdog tunables consumed by `ConfigController` and the Settings page.
- Verify the already-empty `src/generated/` stub directory stays gone (`generated/tfstate.ts` was removed with the #164 decommission; the directory is untracked and empty).
- Refresh stale docs so no operator is pointed at removed surface: `CLAUDE.md` (Docker run block, `setup.sh` bootstrap, the entire "API authentication" section describing the deleted `ApiTokenGuard`), `README.md`, `docs/docs/setup.md`, `docs/docs/architecture.md` (still presents the Nest HTTP API as the local control plane), `docs/docs/intro.md`, `docs/docs/components/management-app.md`, and the guides that reference `setup.sh`/Docker/Makefile.
- **Explicitly retained**: the five chromium Playwright specs (`audit`, `games`, `pending-changes-banner`, `polling`, `settings`) and the `gsd-http-bridge.ts` test fixture. They run against `vite preview` with `page.route()` browser-side stubs and never contact the desktop-main HTTP surface, so deleting the shims does not affect them. Their migration to the `electron` project remains Epic F scope (F.2–F.6), not #293.

## Capabilities

### New Capabilities

- `desktop-only-operator-surface`: Asserts the legacy pre-pivot operator surface is absent — no HTTP transport in desktop-main, no container/shell deployment artifacts, no API-token plumbing, docs and test harnesses aligned with the desktop-only (Electron + IPC) workflow. Modeled as ADDED requirements because `openspec/specs/` is empty; the removals are expressed as absence assertions.

### Modified Capabilities

_None — `openspec/specs/` contains no existing capabilities._

## Impact

- **Code**: `app/packages/desktop-main/src/controllers/` (18 files deleted: 9 controllers + 9 tests), `app/packages/desktop-main/src/app.module.ts`, `app/packages/desktop-main/package.json`, `app/packages/desktop-main/src/services/ConfigService.ts` (+ test), repo-root `Dockerfile`/`docker-compose.yml`/`Makefile`/`setup.sh`/`setup.ps1`.
- **Docs**: `CLAUDE.md`, `README.md`, `docs/docs/setup.md`, `docs/docs/architecture.md`, `docs/docs/intro.md`, `docs/docs/components/management-app.md`, guides under `docs/docs/guides/`.
- **CI**: none — no workflow in `.github/workflows/` builds or tests the Docker image (verified: zero docker/setup.sh references across all seven workflows).
- **Tests**: tier-2 integration harness (`ipc-harness.ts`) dispatches only to IPC controllers (`GamesController`, `DiscordController`, `EnvController`) — no shim dependency; the only shim mention in `e2e/integration-specs/` is a doc comment in `error-propagation.spec.ts`. Chromium e2e specs are self-contained (see retention note above) and CI e2e is currently green on both projects.
- **Runtime behavior**: none — the shims were registered but never served (no HTTP adapter is bootstrapped).
