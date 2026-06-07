# CLAUDE.md

## Common Commands

The repo uses a single **npm-workspaces** tree rooted at the repo root. Workspaces are:

- `@hyveon/shared` — types, `canRun`, sanitizers, status formatter, command descriptors, DynamoDB + Secrets Manager helpers (used by both the server and the Lambdas).
- `@hyveon/desktop-main` — Nest.js management API.
- `@hyveon/web` — React + Vite client.
- `@hyveon/lambda-interactions`, `@hyveon/lambda-followup`, `@hyveon/lambda-update-dns`, `@hyveon/lambda-watchdog` — four Lambda packages, each bundled to a single `dist/handler.cjs` by esbuild.
- `@hyveon/scripts` — maintainer helper scripts (`init-parent.ts` scaffolder).

```bash
# Install all workspaces in one go (run from repo root)
npm install

# Launch the Electron desktop app in dev mode (HMR on renderer saves, auto-restarts main+preload)
npm run app:dev          # delegates to desktop:dev — equivalent to: npm run desktop:dev

# Production build then launch
npm run app:build        # compiles shared → desktop-main → web TypeScript (not the Electron bundle)
npm run desktop:build    # electron-vite build → produces out/main, out/preload, out/renderer
npm run app:start        # starts the built Electron app (requires desktop:build to have run first)

# Electron desktop app — electron-vite drives three pipelines (main/preload/renderer)
# configured in electron.vite.config.ts; outputs land in out/main, out/preload, out/renderer
npm run desktop:dev    # electron-vite dev: HMR on renderer saves, auto-restarts main+preload
npm run desktop:build  # electron-vite build: produces out/main, out/preload, out/renderer

# Package the Electron app into a distributable installer (runs desktop:build first)
# Produces three targets via electron-builder (electron-builder.yml):
#   Windows  → release/Hyveon Setup *.exe   (NSIS installer)
#   macOS    → release/Hyveon-*.dmg         (DMG image)
#   Linux    → release/Hyveon-*.AppImage    (AppImage)
# terraform/terraform.tfstate is embedded via extraResources and lands under
# process.resourcesPath at runtime (not inside the asar archive).
# Lambda bundles are NOT packaged here — they are deployed separately to AWS via Terraform.
# app:build:lambdas is chained automatically inside desktop:package — no separate step needed.
npm run desktop:package

# Build all Lambda bundles (required before `terraform apply`)
npm run app:build:lambdas

# Unit tests (vitest + aws-sdk-client-mock) — discovered across every workspace
npm run app:test             # one-off run
npm run app:test:watch       # watch mode

# Lint / autofix
npm run app:lint
npm run app:lint:fix

# Run the scaffolder script
npm run scripts:init-parent

# Run the app in Docker (mounts ./terraform ro, ./app/server_config.json, ~/.aws)
docker compose up --build               # http://localhost:5000

# Terraform (all infra lives under terraform/). NOTE: terraform apply reads
# the Lambda bundles from app/packages/lambda/*/dist/handler.cjs — run
# `npm run app:build:lambdas` first or the archive_file data sources will fail.
cd terraform
terraform init
terraform plan
terraform apply
terraform destroy

# Cost allocation: all resources tagged Project=game-servers-poc. Activate the
# "Project" tag in AWS Billing → Cost allocation tags for Cost Explorer breakdowns.

# First-time environment bootstrap (installs terraform + aws CLI if missing,
# runs npm ci, builds Lambdas, runs terraform init)
./setup.sh
```

ESLint (flat config) lives at `app/eslint.config.js` using `@eslint/js` + `typescript-eslint` recommended presets, plus `eslint-plugin-react` and `eslint-plugin-react-hooks` recommended for the web package. Run `npm run app:lint` (or `npm run app:lint:fix`) from the repo root.

Terraform linting uses [tflint](https://github.com/terraform-linters/tflint) with its `recommended` preset and the AWS ruleset plugin. Config lives at `terraform/.tflint.hcl`. Run `tflint --init` once to install the plugin, then `tflint` from `terraform/`. `terraform fmt -check -recursive` and `terraform validate` cover formatting and syntax.

## Architecture

Three loosely-coupled pieces share code via `@hyveon/shared`:

1. **Terraform (`terraform/`)** provisions all AWS infrastructure, including four Node.js Lambdas (interactions, followup, update-dns, watchdog), a DynamoDB table, and two Secrets Manager secrets for Discord credentials.
2. **Management app (`app/packages/desktop-main` + `app/packages/web`)** — Nest.js (on `@nestjs/platform-express`) backend reads `terraform/terraform.tfstate` directly at runtime to discover cluster/subnet/SG IDs + the Discord store locations, then drives AWS via the AWS SDK v3. React/Vite frontend talks to the Nest API. Services use **Nest's built-in DI** (`@Injectable()`) and **Winston** for structured logging. Feature modules under `app/packages/desktop-main/src/modules/` (`AwsModule`, `DiscordModule`) group related providers; HTTP handlers live in `app/packages/desktop-main/src/controllers/` as `@Controller`-decorated classes wired up through `AppModule`.
3. **Lambdas (`app/packages/lambda/*`)** — four TypeScript Lambda packages. All bundle via esbuild to a single CJS file and are zipped by Terraform's `archive_file` data source. The Discord interaction path (`interactions` + `followup`) is described below; `update-dns` and `watchdog` are ports of the original `update_dns.py` / `watchdog.py` — same behaviour, TypeScript runtime.

There is **no persistent ECS Service**. Servers run only when the user clicks Start (or invokes `/server-start`) — the app/followup-Lambda calls `ecs.run_task()` / `ecs.stop_task()` against per-game task definitions named `{game}-server`. This is the core cost-saving design choice; don't introduce a long-running Service.

### The `game_servers` map is the single source of truth

`variables.tf:game_servers` is a `map(object({...}))`. Adding/removing an entry cascades through **every** Terraform resource via `for_each`:

- `aws_ecs_task_definition.game` — one task def per game
- `aws_efs_access_point.game` — isolated save directory per game
- `aws_cloudwatch_log_group.game` — `/ecs/{game}-server`
- `aws_security_group.game_servers` — dynamic ingress rules flattened from all games' ports (deduplicated in `locals.all_game_ports`)
- Lambda env vars `GAME_NAMES` in `route53.tf` and `watchdog.tf`

When adding a game, only edit `terraform.tfvars`. Don't hand-write new resources.

### DNS is Lambda-managed, not Terraform-managed

`route53.tf` creates the zone data source and the updater Lambda, but **no `aws_route53_record` resources**. An EventBridge rule on `ECS Task State Change` fires `@hyveon/lambda-update-dns`, which UPSERTs a record for `{game}.{hosted_zone_name}` on `RUNNING` and DELETEs on `STOPPED`. Terraform would fight the Lambda — keep DNS records out of Terraform.

### Watchdog state lives in ECS task tags

`@hyveon/lambda-watchdog` runs on an EventBridge schedule (`rate(${watchdog_interval_minutes} minutes)`) and checks `NetworkPacketsIn` on each task's ENI via CloudWatch. The consecutive-idle counter is **stored as a tag on the ECS task itself** — there's no DynamoDB/SSM for watchdog state. After `watchdog_idle_checks` consecutive idle intervals, the task is stopped (which triggers the DNS-delete path above).

### App → Terraform coupling

`ConfigService.getTfOutputs()` (in `app/packages/desktop-main/src/services/ConfigService.ts`) parses `terraform.tfstate` as JSON and caches it in-memory. `invalidateCache()` is called on `/api/games` and `/api/status` to pick up new deploys. The app's container mounts `./terraform:/app/terraform:ro` — this path coupling matters if directory structure changes. The parsed `TfOutputs` shape now also exposes `discord_table_name`, `discord_bot_token_secret_arn`, `discord_public_key_secret_arn`, and `interactions_invoke_url` so `DiscordConfigService` can reach the Discord stores without extra env-var plumbing.

**Build-time state embedding**: `app/scripts/embed-tfstate.mjs` (runs via `predev`/`prebuild` hooks) writes `app/packages/desktop-main/src/generated/tfstate.ts`; `ConfigService` uses it as a fallback when the runtime `terraform.tfstate` is absent (Docker/CI). The file is committed as `null` and overwritten at dev/build time.

### API authentication

Every `/api/*` route is gated behind a bearer token via `ApiTokenGuard` in `app/packages/desktop-main/src/guards/api-token.guard.ts`, registered globally in `AppModule` as an `APP_GUARD` provider so it applies to every controller automatically. The token comes from env `API_TOKEN` (wins, even when set to empty to deliberately disable) or `api_token` in `server_config.json`. In production (`NODE_ENV=production`), boot aborts in `main.ts` if no token is configured. In dev, a warning is logged and unauthenticated requests are allowed for convenience. The web client stores the token in `localStorage` under key `apiToken` and sends it as `Authorization: Bearer`. Don't remove the guard or bypass it on individual controllers — Copilot flagged the unauthenticated surface as a security issue and this is the fix.

### Discord bot is fully serverless (Lambda + DynamoDB + Secrets Manager)

There is **no discord.js dependency, no long-running bot process, and no `DiscordBotService`**. The bot is split across two Lambdas provisioned by Terraform (`interactions.tf`, `followup.tf`):

- **`@hyveon/lambda-interactions`** — verifies Ed25519 signature, PONGs pings, handles autocomplete synchronously, and defers slash commands to `@hyveon/lambda-followup` (Discord's 3-second budget doesn't leave room for ECS calls).
- **`@hyveon/lambda-followup`** — does the ECS work (`RunTask` / `StopTask` / `DescribeTasks`) and PATCHes the original interaction message. For start commands it writes a pending-interaction row to DynamoDB so `@hyveon/lambda-update-dns` can patch again with the resolved IP once the task reaches RUNNING.

Persistent state: DynamoDB table `${project_name}-discord` (Discord config + pending-interaction rows with 15-min TTL) and two Secrets Manager secrets (`${project_name}/discord/bot-token`, `${project_name}/discord/public-key`).

Key design rules to preserve:

- **Per-guild command registration only.** `DiscordCommandRegistrar.registerForGuild()` PUTs to `https://discord.com/api/v10/applications/{client_id}/guilds/{guild_id}/commands`. Never register global commands — they'd leak to any guild the bot is invited to.
- **The allowlist is enforced in the interactions Lambda.** It reads the `DiscordConfig` from DynamoDB on every invocation and rejects any command from a guild not in `allowedGuilds`. There's no always-on process to iterate `guilds.cache` — but there doesn't need to be, because Discord only routes interactions to us; we don't maintain a gateway connection.
- **Permission resolution is in `canRun()` (in `@hyveon/shared/canRun`).** Order is guild allowlist → admin user/role → per-game user/role + action gate. This function is pure and is imported verbatim by both the server and the Lambdas — keep it in `@hyveon/shared` so there's exactly one copy.
- **Neither secret is ever sent to the client.** `getRedacted()` returns `botTokenSet: boolean` and `publicKeySet: boolean` instead of the values. API response shapes preserve this.

#### Slash commands are JSON descriptors, not classes

The four commands — `/server-start`, `/server-stop`, `/server-status`, `/server-list` — are defined as static JSON in `@hyveon/shared/commands.ts` (`COMMAND_DESCRIPTORS`). Discord sends the command name in each interaction; the interactions Lambda switches on it directly. There's no `SlashCommand` / `GameOptionSlashCommand` / `SlashCommandRegistry` abstraction anymore — the dispatch is a ~40-line switch in `handler.ts`. To add a new command:

1. Append a descriptor to `COMMAND_DESCRIPTORS` in `@hyveon/shared/commands.ts`.
2. Add a `case` in the interactions Lambda's `handleApplicationCommand()` (kicking off a followup invoke) and in the followup Lambda's `handler()` switch on `event.kind`.
3. Update `actionForCommand()` in the same `commands.ts` so `canRun()` gets the right permission bucket.
4. Rebuild Lambdas + `terraform apply` to redeploy; operators click "Register commands" per guild so Discord picks up the new descriptor.

### Known Lambda env-var quirk

Lambda env vars named `AWS_REGION` are reserved by the runtime. All four Lambdas use `AWS_REGION_` (trailing underscore) to pass the configured region — preserve this when editing.

## AWS IAM Policy

The full deploy IAM policy (`GameServerDeployAll`) lives in **`docs/docs/setup.md`** — that is the single source of truth. Any time a new AWS service or action is needed (e.g. a new Terraform resource), update the policy JSON there and nowhere else. The policy already covers EventBridge tagging (`events:*`) and CloudFront (`cloudfront:*`), both of which are required by `terraform apply` and are not included in the AWS-managed policies used in this setup.

## Reference Documents

When working in a specific area, read the relevant doc rather than relying on what's summarised here:

| Area | File |
|------|------|
| AWS IAM deploy policy | `docs/docs/setup.md` |
| Terraform variables reference | `docs/docs/components/terraform.md` |
| Full setup walkthrough | `docs/docs/setup.md` |
| Integration test architecture | `docs/docs/components/integration-tests.md` |
| Copilot review tuning | `.github/copilot-instructions.md` |
| PR creation command | `.claude/commands/pr.md` |

## Checklist for Terraform variable changes

Any time you add or remove Terraform variables, update **all four** of these in the same commit — failing to touch any one of them is a common oversight:

1. `terraform/variables.tf` — the variable declaration itself.
2. `terraform/terraform.tfvars.example` — a commented-out example entry with a short explanation so operators know how to use it.
3. `docs/docs/components/terraform.md` — the Variables table row.
4. `docs/docs/setup.md` — any relevant step in the setup guide (especially if the variable affects the Discord bot or a core workflow).

## Code & Test Conventions

- **Test names**: every `it(...)` / `test(...)` case must read as a natural-language sentence starting with "should" — e.g. `it('should return null when state file is missing')`, not `it('returns null...')`.
- **TSDoc comments**: document non-trivial functions, helpers, and notable constants/variables with TSDoc (`/** ... */`) so their intent is clear later. This applies to test-file helpers (stub factories, fixtures) as well as production code.
- **Typing in tests**: avoid `as unknown as SomeType` casts. Prefer `vi.mocked(fn)` for mocked modules and `Partial<T>` + a single `as T` for service-shaped stubs.
- **No raw `process.env` in business logic**: wrap environment access behind a service method so tests can stub it via `vi.spyOn` instead of mutating `process.env` (which is flaky and leaks across tests).

### Two-tier browser testing strategy

The test suite has three complementary tiers:

| Tier | Command | What runs | When to add specs |
|------|---------|-----------|-------------------|
| **Unit / integration** | `npm run app:test` | Vitest. Server-side logic, hooks, helpers run under the `node` environment; React component specs in `@hyveon/web` run under `jsdom` via `environmentMatchGlobs`. No real network — AWS SDK mocked via `aws-sdk-client-mock`; the `@hyveon/web` API client is stubbed via `vi.mock`. | Pure logic, hook behaviour, server controllers, **per-component React behaviour** (rendering, callbacks, internal state transitions). |
| **E2E (tier 1 — #74)** | `npm run app:test:e2e` | Playwright against `vite build` + `vite preview`. Nest server never runs; every `/api/*` call is stubbed at the network layer via `page.route()`. | User-visible flows: routing, auth gate, button interactions, status-badge rendering, optimistic updates. |
| **Integration (tier 2 — #75)** | `npm run app:test:integration` | Playwright against `vite build (integration config)` + `vite preview` + real Nest server on `:3002`. AWS SDK intercepted by `aws-sdk-client-mock`. Mock state pushed via `ServerMocks` fixture to `/api/test/mocks/*`. | Real HTTP contract validation, `ApiTokenGuard` behaviour, `ConfigService` tfstate parsing, start/stop flows end-to-end, error propagation from ECS through the API response. |

**React component unit tests (`@hyveon/web`):**
- Use **Vitest + jsdom + `@testing-library/react` + `@testing-library/user-event`**. `@testing-library/jest-dom` matchers (`toBeInTheDocument`, `toHaveTextContent`, etc.) are auto-loaded via `app/vitest.setup.ts`.
- `app/vitest.config.ts` flips to the `jsdom` environment for everything under `packages/web/**` so server tests stay on Node. The setup file also wires `afterEach(cleanup)` because we run with `globals: false`, which disables RTL's normal auto-cleanup.
- Tests live **next to the component** (`Foo.tsx` → `Foo.test.tsx`), not in a separate `__tests__` directory. Mock the API client and any module-level singletons via `vi.mock`. Use `vi.stubGlobal('EventSource', …)` for SSE-driven components (jsdom doesn't ship one).
- Cover: visible rendering for each `state` branch, every callback prop firing with the right argument, internal state transitions (open/close, pause/resume), and any non-trivial pure helper. Don't reach for snapshots — they break on every Tailwind tweak. Don't repeat assertions already covered by the e2e tier (full SSE streaming flow, real network, full routing).

**Routed page tests (`@hyveon/web`):**
- Each routed page (`DashboardPage`, `CostsPage`, `DiscordPage`, `LogsPage`, `SettingsPage`) gets a co-located `*.test.tsx` that mounts the page through `renderPage()` (`app/packages/web/src/test-utils/renderPage.tsx`). The helper wraps children in `PollingProvider → GameStatusProvider → MemoryRouter` so the same provider stack the production app uses is exercised; pass `initialEntries` when the page reads `useLocation`.
- Mock `../api.js` with `vi.mock` + `vi.hoisted` so the page drives off canned data instead of real fetches. Stub every method the page (and the GameStatusProvider above it) calls — at minimum `api.status` and `api.costsEstimate` — or the test will hang waiting for the polling registry to settle.
- These tests are intentionally **complementary** to the e2e tier, not a replacement: the e2e specs prove the indicator + chrome render at the route level under a real Vite preview build; the unit tests pin the page's own provider wiring (e.g. that `<PollingIndicator />` resolves to "Updated …" once the mocked status poll resolves) and let us iterate on the page layout without spinning up Playwright.
- Keep page-test scope tight: smoke-render each header section, exercise interactive controls that aren't already covered by a child component's unit test, and verify the polling indicator wiring. Anything that requires real HTTP belongs in tier-2 integration specs (`e2e/integration-specs/`).

**Playwright conventions:**
- Specs live under `app/packages/web/e2e/specs/`.
- Shared stub helpers and fixtures are in `app/packages/web/e2e/fixtures/`.
- **Page objects** for each route live in `app/packages/web/e2e/pages/` (`DashboardPage`, `CostsPage`, `LogsPage`, etc.). Specs **must** reach for elements through a page-object method (`logs.pauseButton()`, `dashboard.gameCardHeading('minecraft')`) rather than calling `page.getByX(...)` directly. The page object centralises locator drift, gives spec files a vocabulary that reads like the feature it's testing, and is the only place locator strategy (role + accessible name vs. text vs. test-id) gets decided. Add a new page object whenever a spec wants a locator that isn't already wrapped.
- Each page object receives a `Page` in its constructor and exposes `goto()` plus typed `Locator`-returning methods. Encapsulate multi-step flows (`dashboard.filter(query)`, `logs.toggleLevel('ERROR')`) so individual specs stay one-liners.
- Import `{ test, expect, stubApis }` plus the page-object fixture you need (`logs`, `dashboard`, `costs`, `layout`, `authGate`) from `../fixtures/index.js` for authenticated specs; use `@playwright/test` directly for auth-gate specs.
- Use the `authedPage` fixture (token pre-seeded in localStorage) only when a spec needs raw `Page` access (e.g. to call `stubApis` or `addInitScript`); otherwise prefer the higher-level page-object fixtures.
- Stubs must cover every `/api/*` endpoint the page hits, or the catch-all returns 404 and the test will surface the missing stub quickly.

**Integration test conventions (tier 2):**
- Specs live under `app/packages/web/e2e/integration-specs/`. Import `{ test, expect }` from `./index.js` (NOT from `@playwright/test`) — the extended `test` includes the `serverMocks`, `authedPage`, and `dashboard` fixtures.
- `serverMocks` (`ServerMocks` from `e2e/fixtures/server-mocks.ts`) pushes queued responses to the test server via `POST /api/test/mocks/*`. Always include it in test parameters — it resets the MockStore before and after each spec automatically.
- The test Nest server (`test-main.ts`) runs on `:3002`; the Vite integration preview (port 4174) proxies `/api` to it. Pure HTTP tests call `http://localhost:3002/api/...` directly (bypasses the proxy). Browser tests navigate to the `baseURL` (port 4174) and the proxy routes API calls.
- `workers: 1` and `fullyParallel: false` in `playwright.integration.config.ts` are intentional — the shared in-process `MockStore` cannot be used concurrently.
- The integration Vite build sets `VITE_STATUS_POLL_MS=3000` so pollers fire every 3 s instead of 20 s, keeping status-polling specs fast without busy-looping.

## Git & Branch Workflow

`main` is a protected branch — direct pushes are blocked. All changes go through a PR, including trivial chores (`.gitignore` entries, config tweaks). Never commit directly to `main`.

Use `.worktrees/<branch-name>` for feature work (the directory is gitignored). Create with:

```bash
git worktree add .worktrees/<branch> -b <branch>
```

## Claude Code Plugins

This repo expects the **`issue-flow`** plugin (from `CoderCoco/claude-plugin-marketplace`) to drive the issue → PR loop. Two skills, used in order:

- **`work-on`** — start work on a GitHub issue. Creates the `claude/issue-<N>-<slug>` branch, scaffolds a worktree, and pulls the issue checklist into the session as the source of truth for what "done" means.
- **`open-pr`** — finish the loop. Verifies the issue checklist is actually complete, picks up the repo's PR conventions (the rules in the next section), opens the PR with the right `Closes #N` keyword, and moves the project card to "In Review".

Install once:

```
/plugin marketplace add CoderCoco/claude-plugin-marketplace
/plugin install issue-flow@claude-plugin-marketplace
```

If the plugin isn't loaded in the current environment, fetch the skill body from the marketplace repo and follow it manually — don't fall back to ad-hoc PR creation, because the skills enforce checklist-completeness and the closing keyword that this repo's `/pr` command takes for granted.

## PR Conventions

- **Always use `/pr` to create pull requests.** The `.claude/commands/pr.md` skill validates the title format before calling the API. Never call `mcp__github__create_pull_request` directly without running this check first.
- **PR titles MUST use Conventional Commits.** We squash-merge, so the PR title becomes the commit subject on `main` verbatim — a badly-formed title produces a badly-formed commit that can't be fixed after merge. Format: `<type>(<optional-scope>): <imperative summary>`, where `<type>` is one of `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `build`, `ci`, `style`. Keep the subject under ~70 characters; put details in the PR body. Examples: `refactor(app): migrate server from Express+tsyringe to Nest.js`, `docs: reflect Nest.js migration in CLAUDE.md`, `fix(watchdog): stop leaking tags on failed runs`, `chore: add ESLint flat config`.
- **Pre-flight check (mandatory):** before any `create_pull_request` call, verify the title matches `^(feat|fix|refactor|docs|test|chore|perf|build|ci|style)(\([^)]+\))?: .+$`. If it doesn't, fix it first. `Add ESLint configuration` fails (no type prefix); `chore: add ESLint configuration` passes.
- **Always include `Closes #N`** in the PR body when the PR resolves a GitHub issue. Place it as the first line so GitHub auto-closes the issue on merge.

## PR Review Workflow

Copilot runs automatically on every push. Most suggestions are not actionable — expect to apply ~1 in 3.

- **Fix** if: genuinely buggy, insecure, crashes, or incorrect logic.
- **Decline** if: style, naming, "consider", missing non-essential comment, minor nit — one-line reply ("Declined — stylistic, leaving as-is.") then resolve the thread.
- **Ask** (`AskUserQuestion`) if: ambiguous or architecturally significant. Don't silently dismiss.
- **Stop pushing** when the round is all nitpicks — the PR is ready. Reply to each thread and move on.

Always reply on the thread (fix applied + SHA, or reason for decline) and resolve it with `mcp__github__resolve_review_thread`. Copilot's system behaviour is tuned via `.github/copilot-instructions.md` — keep that file and this section in sync.
