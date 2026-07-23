# Tasks: remove-legacy-operator-surface

## 1. Verify baseline (pre-work, no code changes)

- [ ] 1.1 Confirm CI is green on `main` (`test.yml`, `e2e.yml`, `integration.yml`, `lint.yml`) so any later failure is attributable to this change
- [ ] 1.2 Re-verify no integration spec imports a `*-http.controller` module: `grep -rn "HttpController\|-http.controller" app/packages/web/e2e/integration-specs/` returns only the doc comment in `error-propagation.spec.ts`
- [ ] 1.3 Confirm `app/packages/desktop-main/src/generated/` is empty and untracked (`git ls-files app/packages/desktop-main/src/generated/` is empty) — the #164 tfstate stub is already gone; remove the empty local directory

## 2. PR1 — delete HTTP shims and api_token remnants (branch `claude/issue-293-delete-http-shims`)

- [ ] 2.1 Create worktree: `git worktree add .worktrees/claude/issue-293-delete-http-shims -b claude/issue-293-delete-http-shims`
- [ ] 2.2 Delete all nine `*-http.controller.ts` files and their `*-http.controller.test.ts` siblings in `app/packages/desktop-main/src/controllers/` (`audit`, `config`, `costs`, `diagnostics`, `discord`, `drift`, `env`, `files`, `games`)
- [ ] 2.3 Remove the nine `*HttpController` imports and `controllers` array entries from `app/packages/desktop-main/src/app.module.ts`
- [ ] 2.4 Strip `api_token` plumbing from `app/packages/desktop-main/src/services/ConfigService.ts`: the `API_TOKEN` env accessor, the `api_token` field parsing from `server_config.json`, and the token-resolution method; keep the watchdog-tunable read/write paths intact
- [ ] 2.5 Update `ConfigService.test.ts` — delete api_token cases, keep watchdog-config coverage; confirm the watchdog writer does not re-persist a stale `api_token` field from an existing file
- [ ] 2.6 Remove `@nestjs/platform-express`, `express`, and `@types/express` from `app/packages/desktop-main/package.json`; run `npm install` to refresh the lockfile; if the build reveals a hard Nest peer requirement, restore the dep with an explanatory comment (design D4)
- [ ] 2.7 Sweep desktop-main for stragglers: `grep -rn "HttpController\|platform-express\|api_token\|API_TOKEN" app/packages/desktop-main/src/` returns nothing (update the doc comment in `games.controller.ts`/`error-propagation.spec.ts` that references the deleted shim)
- [ ] 2.8 Gate: `npm run app:build` compiles clean
- [ ] 2.9 Gate: `npm run app:lint` passes
- [ ] 2.10 Gate: `npm run app:test` passes
- [ ] 2.11 Gate: `npm run app:test:e2e` passes — both projects; the five chromium specs (`audit`, `games`, `pending-changes-banner`, `polling`, `settings`) must pass unchanged, proving the retention decision (design D2)
- [ ] 2.12 Gate: `npm run app:test:integration` passes
- [ ] 2.13 Open PR via `/pr`: title `refactor(desktop-main): delete HTTP shim controllers and api_token plumbing`, body first line `Part of #293`
- [ ] 2.14 Work Copilot review per repo conventions; merge PR1

## 3. PR2 — remove Docker deployment story and refresh docs (branch `claude/issue-293-remove-docker-story`)

- [ ] 3.1 Create worktree: `git worktree add .worktrees/claude/issue-293-remove-docker-story -b claude/issue-293-remove-docker-story` (after PR1 merges; rebase on `main`)
- [ ] 3.2 Delete `Dockerfile`, `docker-compose.yml`, `Makefile`, `setup.sh`, `setup.ps1` from the repo root
- [ ] 3.3 Refresh `CLAUDE.md`: remove the Docker run block and `./setup.sh` bootstrap from Common Commands, delete the entire "API authentication" section (describes the removed `ApiTokenGuard` as current), and update the architecture summary to the Electron/IPC reality (design D6)
- [ ] 3.4 Update `README.md`: remove the `setup.sh` quick-start step, the "run in Docker" option, and the `Dockerfile`/`docker-compose.yml`/`setup.sh` entries in the repo-layout tree
- [ ] 3.5 Rewrite `docs/docs/setup.md`: drop the Docker prerequisite row, the `setup.sh`/`setup.ps1` bootstrap steps, and API-token configuration; describe the desktop-app-driven setup instead
- [ ] 3.6 Rewrite `docs/docs/architecture.md`: present the Electron desktop app driving desktop-main over IPC as the control plane (currently describes the Nest HTTP API + browser dashboard)
- [ ] 3.7 Sweep remaining docs (`docs/docs/intro.md`, `docs/docs/components/management-app.md`, `docs/docs/components/terraform.md`, `docs/docs/guides/*.md`) for Docker/`setup.sh`/`Makefile`/bearer-token instructions; check whether `scripts/init-parent.ts` and `docs/docs/guides/submodule.md` generate a wrapper that invokes the deleted root `Makefile`/`setup.sh`, and update the scaffolder/guide if so
- [ ] 3.8 Exit-criterion grep across `CLAUDE.md`, `README.md`, `docs/`: no remaining *instruction* referencing `docker compose`, `Dockerfile`, `setup.sh`, `setup.ps1`, root `Makefile`, `api_token`, or `ApiTokenGuard` (historical/changelog mentions acceptable)
- [ ] 3.9 Gate: `npm run app:lint` and `npm run app:test` pass (guard against accidental code impact, e.g. `scripts/init-parent.ts`)
- [ ] 3.10 Gate: docs site builds (run the `docs-build.yml` steps locally or rely on the PR check)
- [ ] 3.11 Open PR via `/pr`: title `chore: remove Docker deployment story and stale pre-pivot docs`, body first line `Closes #293`
- [ ] 3.12 Work Copilot review; merge PR2 and confirm GitHub auto-closed #293

## 4. Issue closeout

- [ ] 4.1 Perform the one-time AWS-side orphan audit from #293 (list account resources by `Project` tag + untagged-in-region, cross-check against `terraform state list`, delete pre-pivot orphans) — operator console/CLI activity, no repo change
- [ ] 4.2 Tick the completed checklist items on #293 and note the two scope deltas: nine shim pairs deleted (not seven), and `server_config.json` retained for watchdog tunables (only `api_token` stripped)
