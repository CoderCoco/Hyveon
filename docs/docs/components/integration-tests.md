# Integration Test Suite (Tier 2)

Playwright-driven tests that dispatch directly into the real `AppModule` Nest.js DI container — built in-process via `NestFactory.createApplicationContext()` — with the AWS SDK mocked. There is no HTTP server, no Vite build/preview, and no `BrowserWindow`: everything runs in a single Node process. The goal is to validate controller-level business logic (permission checks, tfstate parsing, ECS command orchestration, error propagation) against the exact provider wiring the Electron IPC transport uses at runtime, without spinning up real AWS infrastructure.

## How to Run

```bash
# Build the server, then run the integration Playwright suite
npm run app:test:integration
```

This command (from the repo root):
1. Builds `@hyveon/desktop-main` via `tsc` (produces `dist/`, which the harness deep-imports).
2. Runs `playwright test --config playwright.integration.config.ts` from `@hyveon/web`.

`playwright.integration.config.ts` has no `webServer` and no `projects` entries — each spec builds its own `ipc` harness (a fresh `AppModule` application context) via the `ipc` fixture, so there's nothing to boot ahead of time.

## Architecture

```text
Playwright test process (single Node process, no HTTP server, no BrowserWindow)
  ├── ipc (IpcHarness) ─────────────────────────── NestFactory.createApplicationContext(AppModule)
  │     └── dispatch(Controller, 'method', ...) ── invokes the controller instance directly
  └── serverMocks (ServerMocks) ────────────────── pushes into the shared MockStore singleton
        └── aws-sdk-client-mock (ECSClient prototype patched) ── installEcsMock() reads from MockStore
```

### Key Files

| File | Purpose |
|------|---------|
| `app/packages/desktop-main/src/test-mocks/mock-store.ts` | In-process `MockStore` singleton with per-command FIFO queues. |
| `app/packages/desktop-main/src/test-mocks/ecs-mock.ts` | Installs `aws-sdk-client-mock` interceptors on `ECSClient`, wired to `MockStore`. |
| `app/packages/web/e2e/fixtures/ipc-harness.ts` | Builds the in-process IPC test harness (`createIpcHarness()`) via `NestFactory.createApplicationContext(AppModule)`, deep-importing `@hyveon/desktop-main`'s compiled `dist/`, and dispatches directly to controller methods. |
| `app/packages/web/e2e/fixtures/server-mocks.ts` | `ServerMocks` class + extended `test` with `serverMocks` and `ipc` fixtures. |
| `app/packages/web/playwright.integration.config.ts` | Playwright config: `testDir: e2e/integration-specs`, `workers: 1`, no `webServer`, no `projects`. |
| `app/packages/web/e2e/fixtures/tfstate.fixture.json` | Synthetic Terraform state (`minecraft` + `valheim`, `us-east-1`, `test.example.com`), injected via `TF_STATE_PATH` when the `ipc` harness boots. |
| `app/packages/web/e2e/integration-specs/` | All integration specs; import `test`/`expect` from `./index.js`, not `@playwright/test`. |

## How Mock Responses Work

The in-process `MockStore` singleton holds separate FIFO queues for `ListTasks`, `DescribeTasks`, `RunTask`, and `StopTask`. When a queue is empty, the corresponding interceptor returns a safe default:

| Command | Default (empty queue) |
|---------|-----------------------|
| `ListTasksCommand` | `{ taskArns: [] }` → game is stopped |
| `DescribeTasksCommand` | `{ tasks: [] }` |
| `RunTaskCommand` | `{ tasks: [{ taskArn: 'arn:…/test-task-id' }], failures: [] }` |
| `StopTaskCommand` | `{}` |

Push a response before dispatching the controller call that will consume it:

```ts
await serverMocks.pushListTasks({
  type: 'success',
  data: { taskArns: ['arn:aws:ecs:us-east-1:123:task/test-cluster/abc'] },
});
await serverMocks.pushDescribeTasks({
  type: 'success',
  data: { tasks: [{ taskArn: '…', lastStatus: 'RUNNING' }] },
});

const status = await ipc.dispatch(GamesController, 'getStatus', 'minecraft');
```

Push an error to test propagation:

```ts
await serverMocks.pushRunTask({
  type: 'error',
  code: 'AccessDeniedException',
  message: 'User is not authorized to perform ecs:RunTask',
});
```

## Spec Inventory

| Spec | What it tests |
|------|---------------|
| `config-service.spec.ts` | `EnvController.getEnv` returns region + domain from the tfstate fixture; `GamesController.listGames`/`listStatus` return the fixture game list. |
| `discord-config.spec.ts` | `DiscordController.getConfig` never echoes the raw bot token or public key — only the redacted `botTokenSet`/`publicKeySet` booleans. |
| `start-stop.spec.ts` | `GamesController.listGames`/`listStatus` report STOPPED games on initial load; a game seeded as RUNNING via mocked ECS responses can be stopped. |
| `status-polling.spec.ts` | Pushing RUNNING mock responses causes the next `GamesController.listStatus` dispatch to reflect the state change (the in-process analogue of the dashboard's poller). |
| `error-propagation.spec.ts` | `AccessDeniedException` from `RunTaskCommand` surfaces as `{ success: false, message: '…' }` from `GamesController.start`. |
| `can-run.spec.ts` | Placeholder — skipped until Discord permission enforcement (`canRun()`) is wired into the `ipc` test harness. |

## `fake-terraform.mjs` — Scripted Terraform Stand-In

`app/test/fake-terraform.mjs` is a scripted stand-in for the real `terraform` binary. It lets the integration tier (and any orchestrator unit tests) exercise `TerraformService` against realistic `stdout`/`stderr` output and exit codes without shelling out to real Terraform or touching real AWS.

**Wiring this into `TerraformService` integration coverage (stale-plan rejection, destroy confirmation gate, ANSI passthrough, run-record persistence) is deferred to #204** — this doc only covers the script's contract as implemented in #201.

### Invocation

```bash
FAKE_TERRAFORM_SCRIPT=/path/to/fixture.json node app/test/fake-terraform.mjs plan -out=tfplan
```

- `FAKE_TERRAFORM_SCRIPT` (required) — absolute path to a JSON fixture file describing the scripted output. If unset, unreadable, or not valid JSON, the script writes a `fake-terraform: …` message to stderr and exits `1`.
- The subcommand (`init`, `plan`, `apply`, `destroy`, or `output` — whatever `TerraformService` would invoke `terraform` with) is read from `process.argv[2]`. Any extra CLI args (`-out=tfplan`, `-auto-approve`, etc.) are accepted but ignored — only the subcommand name is used to look up the scripted response.
- If no subcommand is given, or the fixture has no entry for the given subcommand, the script writes an error to stderr (listing the subcommands that *are* scripted) and exits `1`.

### Fixture Schema

The fixture is a JSON object keyed by subcommand name:

```json
{
  "plan": {
    "exitCode": 0,
    "lines": [
      { "stream": "stdout", "text": "Refreshing state...", "delayMs": 10 },
      { "stream": "stderr", "text": "Warning: deprecated argument", "delayMs": 5 },
      { "stream": "stdout", "text": "Plan: 1 to add, 0 to change, 0 to destroy." }
    ]
  }
}
```

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `<subcommand>.exitCode` | `number` | `0` | Process exit code once every line has been written. |
| `<subcommand>.lines` | `array` | `[]` | Emitted strictly in array order regardless of which stream each line targets, so fixtures can script realistic stdout/stderr interleaving. |
| `lines[].stream` | `"stdout"` \| `"stderr"` | `"stdout"` | Any value other than `"stderr"` is treated as `"stdout"`. |
| `lines[].text` | `string` | — | Written followed by a newline. |
| `lines[].delayMs` | `number` | `0` | Awaited immediately before that line is written, per-line, so fixtures can simulate realistic Terraform timing (e.g. a slow `plan` refresh before later output). |

## Design Constraints

- **`workers: 1`, `fullyParallel: false`** — the `MockStore` is an in-process singleton; concurrent tests would corrupt each other's queues.
- **`serverMocks` resets before and after every test** — the fixture calls `mockStore.reset()` in-process in setup and teardown; there is no HTTP round-trip.
- **No HTTP server, no Vite build/preview, no `BrowserWindow`** — every integration spec dispatches directly to the `AppModule` DI container via the `ipc` fixture (`ipc-harness.ts`) and pushes mock ECS responses straight into the in-process `MockStore` singleton via the `serverMocks` fixture (`server-mocks.ts`), so there is no test-only route surface and nothing for Playwright to boot as a `webServer`.
- **`TF_STATE_PATH`** — `createIpcHarness()` (`ipc-harness.ts`) sets this env var to `e2e/fixtures/tfstate.fixture.json` before building the `AppModule` context, so `ConfigService` reads the fixture instead of requiring a real Terraform state file.
