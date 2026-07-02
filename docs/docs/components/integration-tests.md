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

```
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

## Design Constraints

- **`workers: 1`, `fullyParallel: false`** — the `MockStore` is an in-process singleton; concurrent tests would corrupt each other's queues.
- **`serverMocks` resets before and after every test** — the fixture calls `mockStore.reset()` in-process in setup and teardown; there is no HTTP round-trip.
- **No HTTP server, no Vite build/preview, no `BrowserWindow`** — every integration spec dispatches directly to the `AppModule` DI container via the `ipc` fixture (`ipc-harness.ts`) and pushes mock ECS responses straight into the in-process `MockStore` singleton via the `serverMocks` fixture (`server-mocks.ts`), so there is no test-only route surface and nothing for Playwright to boot as a `webServer`.
- **`TF_STATE_PATH`** — `createIpcHarness()` (`ipc-harness.ts`) sets this env var to `e2e/fixtures/tfstate.fixture.json` before building the `AppModule` context, so `ConfigService` reads the fixture instead of requiring a real Terraform state file.
