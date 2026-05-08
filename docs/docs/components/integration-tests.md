# Integration Test Suite (Tier 2)

Full-stack Playwright tests that run a **real Nest.js server** with **mocked AWS SDK** calls, wired to a **Vite preview build** that proxies `/api` requests to it. The goal is to validate the HTTP contract between the frontend and the server without spinning up real AWS infrastructure.

## How to Run

```bash
# Build the server, then run the integration Playwright suite
npm run app:test:integration
```

This command (from the repo root):
1. Builds `@gsd/server` via `tsc`.
2. Builds the `@gsd/web` integration bundle (port 4174, `dist-integration/`).
3. Starts the test Nest server on `:3002` and the Vite preview on `:4174`.
4. Runs `playwright test --config playwright.integration.config.ts`.

## Architecture

```
Playwright test process
  ├── request (APIRequestContext) ─────────────── HTTP directly to :3002
  └── page (Browser)
        └── http://localhost:4174 (Vite preview)
              └── /api/* proxy ────────────────── http://localhost:3002
                    └── Nest test server (test-main.js)
                          ├── AppModule (real controllers, services, guards)
                          ├── TestMocksModule   (POST /api/test/mocks/*)
                          └── aws-sdk-client-mock (ECSClient prototype patched)
                                └── MockStore  (per-command FIFO queues)
```

### Key Files

| File | Purpose |
|------|---------|
| `app/packages/server/src/test-main.ts` | Integration server entry point. Patches `ECSClient` via `mockClient()` before `NestFactory.create()`, then boots `TestAppModule`. |
| `app/packages/server/src/test-mocks/mock-store.ts` | In-process `MockStore` singleton with per-command FIFO queues. |
| `app/packages/server/src/test-mocks/test-mocks.controller.ts` | `POST /api/test/mocks/{reset,ecs/list-tasks,...}` — Playwright uses these to seed responses. |
| `app/packages/web/vite.integration.config.ts` | Vite build config for integration tests (port 4174, `/api` proxy, `VITE_STATUS_POLL_MS=3000`). |
| `app/packages/web/playwright.integration.config.ts` | Playwright config: `testDir: e2e/integration-specs`, `workers: 1`, two `webServer` entries. |
| `app/packages/web/e2e/fixtures/server-mocks.ts` | `ServerMocks` class + extended `test` with `serverMocks`, `authedPage`, `dashboard` fixtures. |
| `app/packages/web/e2e/fixtures/tfstate.fixture.json` | Synthetic Terraform state (`minecraft` + `valheim`, `us-east-1`, `test.example.com`). |
| `app/packages/web/e2e/integration-specs/` | All integration specs. |

## How Mock Responses Work

The test server's `MockStore` holds separate FIFO queues for `ListTasks`, `DescribeTasks`, `RunTask`, and `StopTask`. When a queue is empty, the corresponding interceptor returns a safe default:

| Command | Default (empty queue) |
|---------|-----------------------|
| `ListTasksCommand` | `{ taskArns: [] }` → game is stopped |
| `DescribeTasksCommand` | `{ tasks: [] }` |
| `RunTaskCommand` | `{ tasks: [{ taskArn: 'arn:…/test-task-id' }], failures: [] }` |
| `StopTaskCommand` | `{}` |

Push a response before navigating or clicking:

```ts
await serverMocks.pushListTasks({
  type: 'success',
  data: { taskArns: ['arn:aws:ecs:us-east-1:123:task/test-cluster/abc'] },
});
await serverMocks.pushDescribeTasks({
  type: 'success',
  data: { tasks: [{ taskArn: '…', lastStatus: 'RUNNING' }] },
});
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
| `api-token-guard.spec.ts` | 401 on missing/wrong token; 200 with valid Bearer; 200 with `?token=` query param. |
| `config-service.spec.ts` | `GET /api/env` returns region + domain from the fixture; `GET /api/games` returns the fixture game list. |
| `start-stop.spec.ts` | Dashboard renders STOPPED games on load; confirm dialog appears when Stop is clicked on a RUNNING game. |
| `status-polling.spec.ts` | Pushing RUNNING mock responses causes the dashboard badge to update within the 3 s poll cycle. |
| `error-propagation.spec.ts` | `AccessDeniedException` from `RunTaskCommand` surfaces as `{ success: false, message: '…' }` in the start response. |
| `can-run.spec.ts` | Placeholder — skipped until Discord module is wired into the test server. |

## Design Constraints

- **`workers: 1`, `fullyParallel: false`** — the `MockStore` is an in-process singleton; concurrent tests would corrupt each other's queues.
- **`serverMocks` resets before and after every test** — the fixture calls `POST /api/test/mocks/reset` in setup and teardown.
- **`VITE_STATUS_POLL_MS=3000`** — the integration Vite build shortens the poller interval from 20 s to 3 s so status-change assertions complete in < 10 s.
- **`TestMocksModule` is never imported by `AppModule`** — it only exists in `TestAppModule` (defined inline in `test-main.ts`), so it cannot accidentally reach the production server.
- **`TF_STATE_PATH`** — the integration Playwright config injects `e2e/fixtures/tfstate.fixture.json` via this env var so `ConfigService` reads the fixture instead of requiring a real Terraform state file.
