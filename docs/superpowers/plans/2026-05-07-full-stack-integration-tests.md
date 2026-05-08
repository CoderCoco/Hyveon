# Full-Stack Integration Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Playwright integration test suite where a real Nest server runs on port 3002 (with AWS SDK calls mocked via `aws-sdk-client-mock`) and Vite preview proxies `/api` to it, covering the guard, config, start/stop flows, status polling, and error propagation.

**Architecture:** The test Nest server boots from `test-main.ts` which calls `mockClient()` on every AWS SDK client class before `NestFactory.create()` runs. A `TestMocksModule` (only registered in the test binary) exposes `POST /api/test/mocks/*` endpoints so Playwright tests can queue per-test mock responses at runtime. Playwright's `webServer` config starts both the test Nest server and a Vite preview (built with a separate config) that proxies `/api` to port 3002.

**Tech Stack:** `@playwright/test`, `aws-sdk-client-mock` (already in devDependencies), `@nestjs/common`, Vite 5, TypeScript ESM.

---

## File Map

### New files — server package (`app/packages/server/src/`)

| File | Responsibility |
|------|---------------|
| `test-main.ts` | Test entry point: mocks all AWS clients, boots `TestAppModule` on port 3002 |
| `test-mocks/mock-store.ts` | In-memory queue of per-command mock responses; singleton in the server process |
| `test-mocks/test-mocks.module.ts` | Nest module that exports `TestMocksController` |
| `test-mocks/test-mocks.controller.ts` | `POST /api/test/mocks/reset` and `POST /api/test/mocks/ecs/*` — lets Playwright configure mock behavior |

### Modified files — server package

| File | Change |
|------|--------|
| `src/services/ConfigService.ts` | Check `process.env.TF_STATE_PATH` first in `getTfOutputs()` so the test binary can point at a fixture |

### New files — web package (`app/packages/web/`)

| File | Responsibility |
|------|---------------|
| `vite.integration.config.ts` | Vite config for integration build: `outDir: dist-integration`, `preview.port: 4174`, `preview.proxy → :3002` |
| `playwright.integration.config.ts` | Playwright config: `testDir: e2e/integration-specs`, two `webServer` entries (test Nest + Vite preview) |
| `e2e/fixtures/tfstate.fixture.json` | Synthetic Terraform state with two games (`minecraft`, `valheim`) |
| `e2e/fixtures/server-mocks.ts` | Playwright `serverMocks` fixture — makes HTTP calls to `/api/test/mocks/*` with Bearer token |
| `e2e/integration-specs/index.ts` | Re-exports `test`, `expect`, `serverMocks` for all integration specs |
| `e2e/integration-specs/api-token-guard.spec.ts` | 401 without token; 200 with valid token |
| `e2e/integration-specs/config-service.spec.ts` | tfstate fixture parsed → games endpoint lists minecraft + valheim |
| `e2e/integration-specs/start-stop.spec.ts` | Start flow (RunTask mock → 200 → UI STARTING), Stop flow |
| `e2e/integration-specs/status-polling.spec.ts` | DescribeTasks mock sequence: RUNNING → STOPPED; badge transitions |
| `e2e/integration-specs/error-propagation.spec.ts` | RunTask throws AccessDeniedException → 500 → UI error toast |
| `e2e/integration-specs/can-run.spec.ts` | Skipped placeholder; see note in task |

### Modified files — web package

| File | Change |
|------|--------|
| `package.json` | Add `test:integration` script |

### Root changes

| File | Change |
|------|--------|
| Root `package.json` | Add `app:test:integration` script |
| `.github/workflows/integration.yml` | New CI workflow running integration suite |
| `CLAUDE.md` | Update "two-tier browser testing strategy" table with tier descriptions |
| `docs/docs/components/integration-tests.md` | New: "Running integration tests" section |

---

## Task 1: Add `TF_STATE_PATH` env-var override to ConfigService

**Files:**
- Modify: `app/packages/server/src/services/ConfigService.ts:29-32`

- [ ] **Step 1: Open ConfigService and locate `TF_STATE_PATH`**

The constant is at line 29:
```ts
const TF_STATE_PATH = resolveRuntimePath(
  '../../../../../terraform/terraform.tfstate',
  '../../../../terraform/terraform.tfstate',
);
```

- [ ] **Step 2: Replace with env-var-aware version**

Replace those four lines with:
```ts
const TF_STATE_PATH = process.env['TF_STATE_PATH'] ??
  resolveRuntimePath(
    '../../../../../terraform/terraform.tfstate',
    '../../../../terraform/terraform.tfstate',
  );
```

- [ ] **Step 3: Run existing unit tests to verify no regression**

```bash
npm run app:test
```

Expected: all tests pass (the change is backwards-compatible — env var absent → same behaviour as before).

- [ ] **Step 4: Commit**

```bash
git add app/packages/server/src/services/ConfigService.ts
git commit -m "fix(server): honour TF_STATE_PATH env var in ConfigService"
```

---

## Task 2: Create the synthetic tfstate fixture

**Files:**
- Create: `app/packages/web/e2e/fixtures/tfstate.fixture.json`

- [ ] **Step 1: Create the fixture file**

```json
{
  "version": 4,
  "terraform_version": "1.9.0",
  "outputs": {
    "aws_region":                     { "value": "us-east-1",          "type": "string" },
    "ecs_cluster_name":               { "value": "test-cluster",        "type": "string" },
    "ecs_cluster_arn":                { "value": "arn:aws:ecs:us-east-1:123456789012:cluster/test-cluster", "type": "string" },
    "subnet_ids":                     { "value": "subnet-test1234",     "type": "string" },
    "security_group_id":              { "value": "sg-test1234",         "type": "string" },
    "file_manager_security_group_id": { "value": "sg-fm-test1234",      "type": "string" },
    "efs_file_system_id":             { "value": "fs-test1234",         "type": "string" },
    "efs_access_points": {
      "value": { "minecraft": "fsap-mc1234", "valheim": "fsap-vh1234" },
      "type": ["object", { "minecraft": "string", "valheim": "string" }]
    },
    "domain_name":                    { "value": "test.example.com",   "type": "string" },
    "game_names":                     { "value": ["minecraft", "valheim"], "type": ["tuple", ["string", "string"]] },
    "alb_dns_name":                   { "value": null,                  "type": "string" },
    "acm_certificate_arn":            { "value": null,                  "type": "string" },
    "discord_table_name":             { "value": "test-discord-table",  "type": "string" },
    "discord_bot_token_secret_arn":   { "value": "arn:aws:secretsmanager:us-east-1:123456789012:secret/test/discord/bot-token",   "type": "string" },
    "discord_public_key_secret_arn":  { "value": "arn:aws:secretsmanager:us-east-1:123456789012:secret/test/discord/public-key",  "type": "string" },
    "interactions_invoke_url":        { "value": null,                  "type": "string" }
  }
}
```

- [ ] **Step 2: Verify ConfigService parses it correctly (manual smoke test)**

```bash
TF_STATE_PATH=app/packages/web/e2e/fixtures/tfstate.fixture.json node -e "
import('./app/packages/server/dist/services/ConfigService.js').then(m => {
  const svc = new m.ConfigService();
  console.log(JSON.stringify(svc.getTfOutputs(), null, 2));
});
"
```

Expected: JSON with `game_names: ['minecraft', 'valheim']`, `aws_region: 'us-east-1'`. (Skip this step if the server isn't compiled yet — it will be validated when the test server starts in Task 5.)

- [ ] **Step 3: Commit**

```bash
git add app/packages/web/e2e/fixtures/tfstate.fixture.json
git commit -m "test: add synthetic tfstate fixture for integration tests"
```

---

## Task 3: Create the mock-store (server-side in-process mock state)

**Files:**
- Create: `app/packages/server/src/test-mocks/mock-store.ts`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p app/packages/server/src/test-mocks
```

- [ ] **Step 2: Create `mock-store.ts`**

```ts
/** Shape of a single queued mock response. */
export interface MockResponse {
  /** 'success' returns `data`; 'error' throws an error with `code` and `message`. */
  type: 'success' | 'error';
  data?: unknown;
  code?: string;
  message?: string;
}

/**
 * Singleton in-process store of queued AWS SDK mock responses.
 * `test-main.ts` sets up `aws-sdk-client-mock` interceptors that read from
 * this store via `dequeue*()`. Playwright tests push responses via the
 * `TestMocksController` HTTP endpoints before exercising each flow.
 *
 * Default (empty queue) behaviour per command:
 *  - ListTasks   → { taskArns: [] }   (no running tasks)
 *  - DescribeTasks → { tasks: [] }
 *  - RunTask     → { tasks: [{ taskArn: 'arn:aws:ecs:us-east-1:123:task/test-task-id' }] }
 *  - StopTask    → {}
 */
class MockStore {
  private listTasksQueue: MockResponse[] = [];
  private describeTasksQueue: MockResponse[] = [];
  private runTaskQueue: MockResponse[] = [];
  private stopTaskQueue: MockResponse[] = [];

  pushListTasks(r: MockResponse): void    { this.listTasksQueue.push(r); }
  pushDescribeTasks(r: MockResponse): void{ this.describeTasksQueue.push(r); }
  pushRunTask(r: MockResponse): void      { this.runTaskQueue.push(r); }
  pushStopTask(r: MockResponse): void     { this.stopTaskQueue.push(r); }

  dequeueListTasks(): MockResponse | null    { return this.listTasksQueue.shift() ?? null; }
  dequeueDescribeTasks(): MockResponse | null{ return this.describeTasksQueue.shift() ?? null; }
  dequeueRunTask(): MockResponse | null      { return this.runTaskQueue.shift() ?? null; }
  dequeueStopTask(): MockResponse | null     { return this.stopTaskQueue.shift() ?? null; }

  /** Clear all queues — called between tests via `POST /api/test/mocks/reset`. */
  reset(): void {
    this.listTasksQueue = [];
    this.describeTasksQueue = [];
    this.runTaskQueue = [];
    this.stopTaskQueue = [];
  }
}

export const mockStore = new MockStore();
```

- [ ] **Step 3: Commit**

```bash
git add app/packages/server/src/test-mocks/mock-store.ts
git commit -m "test(server): add in-process MockStore for integration test mock control"
```

---

## Task 4: Create TestMocksController and TestMocksModule

**Files:**
- Create: `app/packages/server/src/test-mocks/test-mocks.controller.ts`
- Create: `app/packages/server/src/test-mocks/test-mocks.module.ts`

- [ ] **Step 1: Create `test-mocks.controller.ts`**

```ts
import { Body, Controller, Post } from '@nestjs/common';
import { mockStore, type MockResponse } from './mock-store.js';

/**
 * HTTP endpoints for Playwright integration tests to control mock AWS SDK
 * responses. Only registered in the test binary — never imported by AppModule.
 *
 * Protected by ApiTokenGuard (the global guard from AppModule applies to all
 * routes) — callers must send `Authorization: Bearer test-token`.
 */
@Controller('test/mocks')
export class TestMocksController {
  /** Reset all queues between test scenarios. */
  @Post('reset')
  reset(): { ok: true } {
    mockStore.reset();
    return { ok: true };
  }

  /** Push a response for the next `ListTasksCommand` call. */
  @Post('ecs/list-tasks')
  pushListTasks(@Body() body: MockResponse): { ok: true } {
    mockStore.pushListTasks(body);
    return { ok: true };
  }

  /** Push a response for the next `DescribeTasksCommand` call. */
  @Post('ecs/describe-tasks')
  pushDescribeTasks(@Body() body: MockResponse): { ok: true } {
    mockStore.pushDescribeTasks(body);
    return { ok: true };
  }

  /** Push a response for the next `RunTaskCommand` call. */
  @Post('ecs/run-task')
  pushRunTask(@Body() body: MockResponse): { ok: true } {
    mockStore.pushRunTask(body);
    return { ok: true };
  }

  /** Push a response for the next `StopTaskCommand` call. */
  @Post('ecs/stop-task')
  pushStopTask(@Body() body: MockResponse): { ok: true } {
    mockStore.pushStopTask(body);
    return { ok: true };
  }
}
```

- [ ] **Step 2: Create `test-mocks.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { TestMocksController } from './test-mocks.controller.js';

/** Nest module exposing mock-control endpoints. Only imported by TestAppModule in test-main.ts. */
@Module({
  controllers: [TestMocksController],
})
export class TestMocksModule {}
```

- [ ] **Step 3: Commit**

```bash
git add app/packages/server/src/test-mocks/
git commit -m "test(server): add TestMocksModule for per-test mock control via HTTP"
```

---

## Task 5: Create the test Nest server entry point

**Files:**
- Create: `app/packages/server/src/test-main.ts`

The key constraint is that `mockClient(ECSClient)` must be called **before** `NestFactory.create()` so the prototype mock is in place when EcsService's lazy `getClient()` first creates an `ECSClient` instance.

- [ ] **Step 1: Create `test-main.ts`**

```ts
/**
 * Integration-test entry point for the Nest server.
 *
 * Sets up aws-sdk-client-mock interceptors BEFORE creating the Nest
 * application so that any ECSClient instances created by DI providers
 * (EcsService's lazy getClient()) hit the mock rather than real AWS.
 *
 * Run via: PORT=3002 NODE_ENV=test API_TOKEN=test-token
 *           TF_STATE_PATH=<path> node dist/test-main.js
 */
import 'reflect-metadata';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ECSClient,
  ListTasksCommand,
  DescribeTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';
import { mockStore } from './test-mocks/mock-store.js';

// ── Patch ECSClient prototype before the DI container creates any instances ──

const ecsMock = mockClient(ECSClient);

ecsMock.on(ListTasksCommand).callsFake(async () => {
  const next = mockStore.dequeueListTasks();
  if (next?.type === 'error') {
    const err = Object.assign(new Error(next.message ?? 'Mock ListTasks error'), { name: next.code ?? 'ServiceException' });
    throw err;
  }
  return (next?.data as object | undefined) ?? { taskArns: [] };
});

ecsMock.on(DescribeTasksCommand).callsFake(async () => {
  const next = mockStore.dequeueDescribeTasks();
  if (next?.type === 'error') {
    const err = Object.assign(new Error(next.message ?? 'Mock DescribeTasks error'), { name: next.code ?? 'ServiceException' });
    throw err;
  }
  return (next?.data as object | undefined) ?? { tasks: [] };
});

ecsMock.on(RunTaskCommand).callsFake(async () => {
  const next = mockStore.dequeueRunTask();
  if (next?.type === 'error') {
    const err = Object.assign(new Error(next.message ?? 'Mock RunTask error'), { name: next.code ?? 'ServiceException' });
    throw err;
  }
  return (next?.data as object | undefined) ?? {
    tasks: [{ taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/test-cluster/test-task-id' }],
    failures: [],
  };
});

ecsMock.on(StopTaskCommand).callsFake(async () => {
  const next = mockStore.dequeueStopTask();
  if (next?.type === 'error') {
    const err = Object.assign(new Error(next.message ?? 'Mock StopTask error'), { name: next.code ?? 'ServiceException' });
    throw err;
  }
  return (next?.data as object | undefined) ?? {};
});

// ── Now boot the Nest application ──

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Module } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { TestMocksModule } from './test-mocks/test-mocks.module.js';
import { logger } from './logger.js';

/** Wraps AppModule (all real providers + global guard) and adds TestMocksModule. */
@Module({ imports: [AppModule, TestMocksModule] })
class TestAppModule {}

const PORT = parseInt(process.env['PORT'] ?? '3002', 10);

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(TestAppModule, {
    logger: ['error', 'warn'],
  });
  app.setGlobalPrefix('api');
  await app.listen(PORT);
  logger.info(`Integration test server running on http://localhost:${PORT}`, { port: PORT });
}

void bootstrap();
```

> **Note on ESM imports:** With TypeScript ESM, static `import` statements at the top of the file are hoisted and evaluated before the module body executes. The `mockClient(ECSClient)` calls run in the module body — after the import of `ECSClient`, but before `NestFactory.create()`. Since `aws-sdk-client-mock` patches `ECSClient.prototype.send`, all subsequent client instances (including those EcsService creates lazily on first request) will hit the mock.

- [ ] **Step 2: Compile the server to verify `test-main.ts` type-checks**

```bash
npm run build -w @gsd/server
```

Expected: no TypeScript errors. The `dist/test-main.js` file is produced.

- [ ] **Step 3: Smoke-test the server starts**

```bash
TF_STATE_PATH=$(pwd)/app/packages/web/e2e/fixtures/tfstate.fixture.json \
  API_TOKEN=test-token \
  NODE_ENV=test \
  PORT=3002 \
  node app/packages/server/dist/test-main.js &

sleep 3
curl -s "http://localhost:3002/api/env?token=test-token" | grep region
kill %1
```

Expected: JSON containing `"aws_region":"us-east-1"` printed, then the background job is killed cleanly.

- [ ] **Step 4: Commit**

```bash
git add app/packages/server/src/test-main.ts
git commit -m "test(server): add integration test entry point with aws-sdk-client-mock setup"
```

---

## Task 6: Create Vite integration config

**Files:**
- Create: `app/packages/web/vite.integration.config.ts`

- [ ] **Step 1: Create the file**

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Vite config for integration tests. Differences from vite.config.ts:
 *  - outDir → dist-integration (avoids clobbering the regular e2e build)
 *  - preview runs on port 4174 (4173 is the tier-1 e2e port)
 *  - preview.proxy routes /api to the test Nest server on :3002
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist-integration',
    emptyOutDir: true,
  },
  preview: {
    port: 4174,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
    },
  },
});
```

- [ ] **Step 2: Verify the build works with this config**

```bash
cd app/packages/web && npx vite build --config vite.integration.config.ts
```

Expected: `dist-integration/` produced with `index.html`.

- [ ] **Step 3: Commit**

```bash
git add app/packages/web/vite.integration.config.ts
git commit -m "test(web): add Vite integration config (port 4174, proxy → :3002)"
```

---

## Task 7: Create Playwright integration config

**Files:**
- Create: `app/packages/web/playwright.integration.config.ts`

- [ ] **Step 1: Create the file**

```ts
import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const fixtureDir = fileURLToPath(new URL('e2e/fixtures', import.meta.url));
const tfstatePath = join(fixtureDir, 'tfstate.fixture.json');
const serverDist = fileURLToPath(new URL('../../packages/server/dist', import.meta.url));

export default defineConfig({
  testDir: './e2e/integration-specs',
  /** Single worker prevents mock-state races between specs running in parallel. */
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:4174',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    extraHTTPHeaders: { Authorization: 'Bearer test-token' },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      /**
       * The real Nest server with mocked AWS clients. Built by the
       * `app:test:integration` npm script before Playwright is invoked.
       */
      command: `node ${join(serverDist, 'test-main.js')}`,
      url: 'http://localhost:3002/api/env?token=test-token',
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
      env: {
        PORT: '3002',
        NODE_ENV: 'test',
        API_TOKEN: 'test-token',
        TF_STATE_PATH: tfstatePath,
      },
    },
    {
      /** Vite preview serving the integration build, proxying /api → :3002. */
      command: 'npx vite build --config vite.integration.config.ts && npx vite preview --config vite.integration.config.ts',
      url: 'http://localhost:4174',
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
```

- [ ] **Step 2: Verify Playwright can parse the config**

```bash
cd app/packages/web && npx playwright test --config playwright.integration.config.ts --list 2>&1 | head -20
```

Expected: Playwright lists 0 tests (no specs yet) without errors.

- [ ] **Step 3: Commit**

```bash
git add app/packages/web/playwright.integration.config.ts
git commit -m "test(web): add Playwright integration config (real Nest :3002 + Vite preview :4174)"
```

---

## Task 8: Add npm scripts and CI workflow

**Files:**
- Modify: `app/packages/web/package.json`
- Modify: Root `package.json`
- Create: `.github/workflows/integration.yml`

- [ ] **Step 1: Add `test:integration` to `app/packages/web/package.json`**

In the `scripts` block, add after `test:e2e`:
```json
"test:integration": "playwright test --config playwright.integration.config.ts"
```

- [ ] **Step 2: Add scripts to root `package.json`**

In the `scripts` block, add after `app:test:e2e` (or near it):
```json
"app:test:integration": "npm run build -w @gsd/server && npm run test:integration -w @gsd/web"
```

The `npm run build -w @gsd/server` ensures `dist/test-main.js` exists before Playwright starts the webServer.

- [ ] **Step 3: Create `.github/workflows/integration.yml`**

```yaml
name: Integration Tests

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - uses: actions/setup-node@v5
        with:
          node-version: '24'
          cache: npm
          cache-dependency-path: package-lock.json

      - run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install chromium --with-deps
        working-directory: app/packages/web

      - run: npm run app:test:integration

      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: integration-playwright-report
          path: app/packages/web/playwright-report/
          retention-days: 30
```

- [ ] **Step 4: Verify scripts run (will fail on missing specs — expected)**

```bash
npm run app:test:integration 2>&1 | head -30
```

Expected: Server compiles and starts, Vite builds and starts, Playwright reports "0 tests" or similar.

- [ ] **Step 5: Commit**

```bash
git add app/packages/web/package.json package.json .github/workflows/integration.yml
git commit -m "chore: add app:test:integration script and CI workflow"
```

---

## Task 9: Create the Playwright-side server-mocks fixture

**Files:**
- Create: `app/packages/web/e2e/fixtures/server-mocks.ts`

This runs in Playwright's Node.js test runner (not the browser). It wraps the `POST /api/test/mocks/*` endpoints with typed helper methods.

- [ ] **Step 1: Create `server-mocks.ts`**

```ts
import { test as base } from '@playwright/test';

const SERVER = 'http://localhost:3002';
const TOKEN  = 'test-token';

async function post(path: string, body: object = {}): Promise<void> {
  const res = await fetch(`${SERVER}/api/test/mocks${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Mock endpoint ${path} returned ${res.status}`);
}

/**
 * Helper for configuring the real Nest server's AWS mock responses from
 * within Playwright specs. Call `serverMocks.reset()` at the start of each
 * spec to clear leftover state from the previous test.
 */
export type ServerMocks = {
  /** Clear all mock queues. Call this in `beforeEach`. */
  reset(): Promise<void>;

  /**
   * Queue a `ListTasksCommand` response.
   * Default when queue is empty: `{ taskArns: [] }` (no running tasks).
   */
  listTasks(response: { taskArns: string[] }): Promise<void>;

  /**
   * Queue a `DescribeTasksCommand` response.
   * Default when queue is empty: `{ tasks: [] }`.
   */
  describeTasks(response: {
    tasks: Array<{
      taskArn: string;
      lastStatus: string;
      attachments?: Array<{ type: string; details: Array<{ name: string; value: string }> }>;
    }>;
  }): Promise<void>;

  /** Queue a successful `RunTaskCommand` response. */
  runTaskSuccess(taskArn?: string): Promise<void>;

  /** Queue an error for the next `RunTaskCommand`. */
  runTaskError(code: string, message: string): Promise<void>;

  /** Queue a successful `StopTaskCommand` response. */
  stopTaskSuccess(): Promise<void>;
};

type Fixtures = { serverMocks: ServerMocks };

export const test = base.extend<Fixtures>({
  serverMocks: async ({}, use) => {
    const mocks: ServerMocks = {
      reset: () => post('/reset'),

      listTasks: (data) => post('/ecs/list-tasks', { type: 'success', data }),

      describeTasks: (data) => post('/ecs/describe-tasks', { type: 'success', data }),

      runTaskSuccess: (taskArn = 'arn:aws:ecs:us-east-1:123:task/test-cluster/test-id') =>
        post('/ecs/run-task', {
          type: 'success',
          data: { tasks: [{ taskArn }], failures: [] },
        }),

      runTaskError: (code, message) =>
        post('/ecs/run-task', { type: 'error', code, message }),

      stopTaskSuccess: () => post('/ecs/stop-task', { type: 'success', data: {} }),
    };
    await use(mocks);
  },
});

export { expect } from '@playwright/test';
```

- [ ] **Step 2: Create `e2e/integration-specs/index.ts`**

```ts
/** Unified test/expect/fixtures export for all integration specs. */
export { test, expect, type ServerMocks } from '../fixtures/server-mocks.js';
```

- [ ] **Step 3: Commit**

```bash
git add app/packages/web/e2e/fixtures/server-mocks.ts \
        app/packages/web/e2e/integration-specs/index.ts
git commit -m "test(web): add Playwright serverMocks fixture for integration test mock control"
```

---

## Task 10: Write ApiTokenGuard spec

**Files:**
- Create: `app/packages/web/e2e/integration-specs/api-token-guard.spec.ts`

- [ ] **Step 1: Create the spec**

```ts
import { test, expect } from './index.js';

test.describe('ApiTokenGuard', () => {
  test('should return 401 when Authorization header is missing', async ({ request }) => {
    const res = await request.get('http://localhost:3002/api/env');
    expect(res.status()).toBe(401);
  });

  test('should return 401 when bearer token is wrong', async ({ request }) => {
    const res = await request.get('http://localhost:3002/api/env', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status()).toBe(401);
  });

  test('should return 200 when bearer token is correct', async ({ request }) => {
    const res = await request.get('http://localhost:3002/api/env', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as { aws_region?: string };
    expect(body.aws_region).toBe('us-east-1');
  });

  test('should return 200 when token is passed as ?token= query param', async ({ request }) => {
    const res = await request.get('http://localhost:3002/api/env?token=test-token');
    expect(res.status()).toBe(200);
  });
});
```

- [ ] **Step 2: Run this spec in isolation**

```bash
cd app/packages/web && npx playwright test --config playwright.integration.config.ts api-token-guard.spec.ts
```

Expected: 4 tests pass (server must be running — start it manually if `reuseExistingServer` is enabled).

- [ ] **Step 3: Commit**

```bash
git add app/packages/web/e2e/integration-specs/api-token-guard.spec.ts
git commit -m "test(integration): ApiTokenGuard — 401 without token, 200 with valid token"
```

---

## Task 11: Write ConfigService spec

**Files:**
- Create: `app/packages/web/e2e/integration-specs/config-service.spec.ts`

- [ ] **Step 1: Create the spec**

```ts
import { test, expect } from './index.js';

test.describe('ConfigService tfstate integration', () => {
  test('should list games from the fixture tfstate', async ({ request }) => {
    const res = await request.get('http://localhost:3002/api/games', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as { games: string[] };
    expect(body.games).toEqual(expect.arrayContaining(['minecraft', 'valheim']));
    expect(body.games).toHaveLength(2);
  });

  test('should return aws_region from the fixture tfstate', async ({ request }) => {
    const res = await request.get('http://localhost:3002/api/env', {
      headers: { Authorization: 'Bearer test-token' },
    });
    const body = await res.json() as { aws_region: string };
    expect(body.aws_region).toBe('us-east-1');
  });

  test('should reload tfstate after cache invalidation', async ({ request }) => {
    // /api/games calls invalidateCache() internally — calling it twice should
    // still return the same fixture-file data (the file hasn't changed).
    const res1 = await request.get('http://localhost:3002/api/games', {
      headers: { Authorization: 'Bearer test-token' },
    });
    const res2 = await request.get('http://localhost:3002/api/games', {
      headers: { Authorization: 'Bearer test-token' },
    });
    const body1 = await res1.json() as { games: string[] };
    const body2 = await res2.json() as { games: string[] };
    expect(body1.games).toEqual(body2.games);
  });
});
```

- [ ] **Step 2: Run this spec**

```bash
cd app/packages/web && npx playwright test --config playwright.integration.config.ts config-service.spec.ts
```

Expected: 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add app/packages/web/e2e/integration-specs/config-service.spec.ts
git commit -m "test(integration): ConfigService — tfstate parsed from fixture, games listed correctly"
```

---

## Task 12: Write start/stop flow specs

**Files:**
- Create: `app/packages/web/e2e/integration-specs/start-stop.spec.ts`

These specs navigate the actual UI (via the Vite preview at port 4174) and interact with buttons. They need `serverMocks` to queue ECS responses.

The UI shows a "Start" button when a game is stopped and a "Stop" button + confirm dialog when running.

- [ ] **Step 1: Create the spec**

```ts
import { test, expect } from './index.js';
import { DashboardPage } from '../pages/index.js';

test.describe('Start/Stop flow (full stack)', () => {
  test.beforeEach(async ({ serverMocks, page }) => {
    // Pre-seed token so the UI doesn't show the auth gate
    await page.addInitScript(() => { localStorage.setItem('apiToken', 'test-token'); });
    await serverMocks.reset();
  });

  test('should show STARTING after clicking Start when game is stopped', async ({ page, serverMocks }) => {
    // Status poll: ListTasks returns empty → game is stopped
    // (default mock returns empty, no push needed for this first poll)
    
    // RunTask will succeed
    await serverMocks.runTaskSuccess();

    const dashboard = new DashboardPage(page);
    await dashboard.goto();

    // Wait for the stopped state to render
    await expect(dashboard.statusBadge('stopped')).toBeVisible({ timeout: 10_000 });

    // Click Start — the real Nest server calls ECS.runTask() on the mock
    await dashboard.startButton().click();

    // The API returns { success: true } → UI transitions to optimistic STARTING
    await expect(
      page.getByText(/starting/i).or(dashboard.statusBadge('starting')),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('should call StopTask and show stopped after confirm dialog', async ({ page, serverMocks }) => {
    // Queue: ListTasks → running task exists, DescribeTasks → RUNNING state
    const taskArn = 'arn:aws:ecs:us-east-1:123:task/test-cluster/running-task';
    await serverMocks.listTasks({ taskArns: [taskArn] });
    await serverMocks.describeTasks({
      tasks: [{ taskArn, lastStatus: 'RUNNING' }],
    });
    await serverMocks.stopTaskSuccess();

    const dashboard = new DashboardPage(page);
    await dashboard.goto();

    await expect(dashboard.statusBadge('running')).toBeVisible({ timeout: 10_000 });

    // Click Stop — triggers confirmation dialog
    await dashboard.stopButton().click();
    // Confirm the dialog
    await page.getByRole('button', { name: /confirm|stop|yes/i }).click();

    // The real Nest server calls ECS.stopTask() on the mock → success response
    await expect(
      page.getByText(/stopping|stopped/i),
    ).toBeVisible({ timeout: 5_000 });
  });
});
```

> **Note:** The locator for "stopped" / "running" badges and "Start" / "Stop" buttons assumes the DashboardPage conventions established in `e2e/pages/DashboardPage.ts`. If the exact locators don't match, check `DashboardPage.statusBadge()` and `DashboardPage.startButton()` / `stopButton()` and adjust the assertions above accordingly.

- [ ] **Step 2: Run this spec**

```bash
cd app/packages/web && npx playwright test --config playwright.integration.config.ts start-stop.spec.ts
```

Expected: 2 tests pass. If a test fails, examine the HTML snapshot / trace to check the actual badge/button text and update the locators.

- [ ] **Step 3: Commit**

```bash
git add app/packages/web/e2e/integration-specs/start-stop.spec.ts
git commit -m "test(integration): start/stop full-stack flow — RunTask/StopTask mock → UI transitions"
```

---

## Task 13: Write status-polling spec

**Files:**
- Create: `app/packages/web/e2e/integration-specs/status-polling.spec.ts`

This spec pushes two different `ListTasks` responses — the first poll returns RUNNING, the second returns empty (STOPPED). It verifies the dashboard badge transitions.

- [ ] **Step 1: Create the spec**

```ts
import { test, expect } from './index.js';
import { DashboardPage } from '../pages/index.js';

test.describe('Status polling (full stack)', () => {
  test.beforeEach(async ({ serverMocks, page }) => {
    await page.addInitScript(() => { localStorage.setItem('apiToken', 'test-token'); });
    await serverMocks.reset();
  });

  test('should transition badge from running to stopped as mock queue is consumed', async ({ page, serverMocks }) => {
    const taskArn = 'arn:aws:ecs:us-east-1:123:task/test-cluster/poll-task';

    // First poll: task is RUNNING
    await serverMocks.listTasks({ taskArns: [taskArn] });
    await serverMocks.describeTasks({ tasks: [{ taskArn, lastStatus: 'RUNNING' }] });

    // Second poll: no running tasks (task stopped)
    // (dequeue returns null → default empty response for both list and describe)

    const dashboard = new DashboardPage(page);
    await dashboard.goto();

    // Initial render should show running
    await expect(dashboard.statusBadge('running')).toBeVisible({ timeout: 10_000 });

    // After the queued running response is consumed, next poll gets the default
    // (empty tasks) → status becomes stopped. The UI polls every few seconds;
    // wait up to 20s for the transition.
    await expect(dashboard.statusBadge('stopped')).toBeVisible({ timeout: 20_000 });
  });
});
```

- [ ] **Step 2: Run the spec**

```bash
cd app/packages/web && npx playwright test --config playwright.integration.config.ts status-polling.spec.ts
```

Expected: 1 test passes. The test may need the dashboard poll interval to elapse — if it takes too long, check the dashboard's polling interval and set a matching timeout.

- [ ] **Step 3: Commit**

```bash
git add app/packages/web/e2e/integration-specs/status-polling.spec.ts
git commit -m "test(integration): status polling — RUNNING→STOPPED badge transition via mock queue"
```

---

## Task 14: Write error-propagation spec

**Files:**
- Create: `app/packages/web/e2e/integration-specs/error-propagation.spec.ts`

This spec queues a `RunTask` error and verifies the UI shows an error toast.

- [ ] **Step 1: Create the spec**

```ts
import { test, expect } from './index.js';
import { DashboardPage } from '../pages/index.js';

test.describe('Error propagation (full stack)', () => {
  test.beforeEach(async ({ serverMocks, page }) => {
    await page.addInitScript(() => { localStorage.setItem('apiToken', 'test-token'); });
    await serverMocks.reset();
  });

  test('should show error toast when ECS RunTask throws AccessDeniedException', async ({ page, serverMocks }) => {
    // Game is stopped (default mock: empty ListTasks)
    // RunTask will throw an AWS error
    await serverMocks.runTaskError('AccessDeniedException', 'User is not authorized to perform ecs:RunTask');

    const dashboard = new DashboardPage(page);
    await dashboard.goto();

    await expect(dashboard.statusBadge('stopped')).toBeVisible({ timeout: 10_000 });
    await dashboard.startButton().click();

    // The real Nest server catches the exception and returns { success: false, message: '...' }
    // (EcsService.start wraps the thrown error and returns { success: false, message: String(err) })
    // The UI reads this and shows an error toast or inline error
    await expect(
      page.getByText(/failed|error|denied/i).or(page.getByRole('alert')),
    ).toBeVisible({ timeout: 5_000 });
  });
});
```

- [ ] **Step 2: Run the spec**

```bash
cd app/packages/web && npx playwright test --config playwright.integration.config.ts error-propagation.spec.ts
```

Expected: 1 test passes.

- [ ] **Step 3: Commit**

```bash
git add app/packages/web/e2e/integration-specs/error-propagation.spec.ts
git commit -m "test(integration): error propagation — AccessDeniedException from RunTask → UI error toast"
```

---

## Task 15: Write canRun() enforcement spec (placeholder)

**Files:**
- Create: `app/packages/web/e2e/integration-specs/can-run.spec.ts`

> **Design note:** The management web app authenticates via API token, not Discord guild/user permissions. `canRun()` enforcement in the Nest routes is not currently implemented — `GamesController.start()` does not call `canRun()`. This spec is a placeholder. Once per-game permission enforcement is added to the management API (separate issue), remove the `test.skip` annotation.

- [ ] **Step 1: Create the placeholder**

```ts
import { test, expect } from './index.js';

test.describe('canRun() enforcement', () => {
  test.skip(
    true,
    'canRun() is not yet enforced on the management API routes. ' +
    'GamesController.start/stop authenticate via API token only. ' +
    'Add enforcement and enable this spec when per-game permission gates are added to the Nest controllers.',
  );

  test('should return 403 when game action is disallowed by canRun()', async ({ request }) => {
    // When implemented: configure the fixture Discord config with a restricted
    // game, then attempt start/stop and expect HTTP 403.
    const res = await request.post('http://localhost:3002/api/start/restricted-game', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status()).toBe(403);
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add app/packages/web/e2e/integration-specs/can-run.spec.ts
git commit -m "test(integration): canRun() spec placeholder (skipped — enforcement not yet in Nest API)"
```

---

## Task 16: Update docs and CLAUDE.md

**Files:**
- Create: `docs/docs/components/integration-tests.md`
- Modify: `CLAUDE.md` — "Code & Test Conventions" → "Two-tier browser testing strategy"

- [ ] **Step 1: Create `docs/docs/components/integration-tests.md`**

```markdown
# Running integration tests

The project has two complementary browser-test tiers. This page covers **Tier 2** — the full-stack integration suite. For Tier 1 (route-stubbed Playwright tests), see the README at `app/packages/web/e2e/`.

## Tier overview

| Tier | Command | Backend | When to add |
|------|---------|---------|-------------|
| **1 — E2E (#74)** | `npm run app:test:e2e` | Playwright route stubs — no Nest server | UI behaviour, routing, auth gate, component interactions |
| **2 — Integration (#75)** | `npm run app:test:integration` | Real Nest server (port 3002) + mocked AWS SDK | Guard logic, ConfigService parsing, ECS orchestration, error propagation |

## Running locally

```bash
# First run: install Playwright browsers if you haven't already
cd app/packages/web && npx playwright install chromium --with-deps

# Run the integration suite
npm run app:test:integration
```

The script compiles `@gsd/server`, then Playwright starts:
1. The test Nest server on `http://localhost:3002` (using `aws-sdk-client-mock`)
2. A Vite preview on `http://localhost:4174` that proxies `/api → :3002`

## Architecture

```
Playwright browser
  └─► Vite preview :4174 (dist-integration/ build)
          └─► Real Nest server :3002 (test-main.ts)
                  ├─► aws-sdk-client-mock  (ECS — ListTasks, DescribeTasks, RunTask, StopTask)
                  └─► Fixture tfstate.json (e2e/fixtures/tfstate.fixture.json)
```

## Controlling mock responses from specs

`serverMocks` is a Playwright fixture that sends HTTP requests to the test server's `POST /api/test/mocks/*` endpoints. Use it to queue per-test AWS responses:

```ts
import { test, expect } from '../fixtures/server-mocks.js';

test('should start a game', async ({ page, serverMocks }) => {
  await serverMocks.reset();         // clear queues from previous test
  await serverMocks.runTaskSuccess(); // next RunTask returns success
  // ... navigate and click Start ...
});
```

## Fixture tfstate

`e2e/fixtures/tfstate.fixture.json` is a synthetic Terraform state with two games (`minecraft`, `valheim`) and realistic output shapes. The Nest server reads it via the `TF_STATE_PATH` environment variable set in `playwright.integration.config.ts`.

## CI

Integration tests run on every PR via `.github/workflows/integration.yml`. Playwright traces and videos are uploaded as artifacts on failure.
```

- [ ] **Step 2: Update `CLAUDE.md` "Two-tier browser testing strategy" table**

Locate the table under "Two-tier browser testing strategy" and replace just the `| **E2E (tier 1 — #74)** |` row and the paragraph that follows with:

```markdown
| **Unit / integration** | `npm run app:test` | Vitest. Server-side logic, hooks, helpers run under the `node` environment; React component specs in `@gsd/web` run under `jsdom` via `environmentMatchGlobs`. No real network — AWS SDK mocked via `aws-sdk-client-mock`; the `@gsd/web` API client is stubbed via `vi.mock`. | Pure logic, hook behaviour, server controllers, **per-component React behaviour** (rendering, callbacks, internal state transitions). |
| **E2E (tier 1 — #74)** | `npm run app:test:e2e` | Playwright against `vite build` + `vite preview`. Nest server never runs; every `/api/*` call is stubbed at the network layer via `page.route()`. | User-visible flows: routing, auth gate, button interactions, status-badge rendering, optimistic updates. |
| **Integration (tier 2 — #75)** | `npm run app:test:integration` | Playwright against a real Nest server (port 3002, AWS SDK mocked) + Vite preview (port 4174, proxies `/api`). | Guard logic (`ApiTokenGuard`), `ConfigService` tfstate parsing, ECS orchestration, error propagation from real controller code. |
```

Also update the paragraph after the table to read:

```markdown
A **tier 2** integration suite (#75) runs Playwright against a real Nest server in test mode (`NODE_ENV=test`, `API_TOKEN=test-token`, AWS SDK clients replaced by `aws-sdk-client-mock`). Use it for any scenario that requires real HTTP contract validation between the browser and server — especially when a regression could only be caught by exercising the actual guard, service, or controller code.
```

- [ ] **Step 3: Commit**

```bash
git add docs/docs/components/integration-tests.md CLAUDE.md
git commit -m "docs: add integration-tests.md and update CLAUDE.md two-tier strategy table"
```

---

## Task 17: Full suite smoke run and verify no regressions

- [ ] **Step 1: Run all three test tiers**

```bash
npm run app:test
npm run app:test:e2e
npm run app:test:integration
```

Expected: all pass. Fix any failures before marking the issue done.

- [ ] **Step 2: Confirm integration test count matches spec coverage**

```bash
cd app/packages/web && npx playwright test --config playwright.integration.config.ts --list
```

Expected: at least 9 named tests across 5 spec files (api-token-guard: 4, config-service: 3, start-stop: 2, status-polling: 1, error-propagation: 1), plus 1 skipped test in can-run.spec.ts.

- [ ] **Step 3: Final commit (none needed if previous tasks committed cleanly)**

---

## Self-Review

### Spec coverage check

| Acceptance criterion | Covered by |
|---------------------|-----------|
| `playwright.integration.config.ts` with webServer entries | Task 7 |
| `aws-sdk-client-mock` fixture module | Tasks 3–5, 9 |
| `tfstate.fixture.json` with two games | Task 2 |
| `app:test:integration` script + CI job | Task 8 |
| `ApiTokenGuard` 401/200 tests | Task 10 |
| `ConfigService.getTfOutputs()` + cache invalidation | Task 11 |
| Start flow full-stack | Task 12 |
| Stop flow full-stack | Task 12 |
| Status polling RUNNING→STOPPED | Task 13 |
| Error propagation (AccessDeniedException) | Task 14 |
| `canRun()` enforcement | Task 15 (skipped with note — not yet in Nest API) |
| "Running integration tests" docs section | Task 16 |
| `CLAUDE.md` two-tier strategy updated | Task 16 |
| Unit + e2e tests unaffected | Task 17 |

### Known gaps / follow-ups

1. **EC2 mock not included.** `EcsService.getStatus()` calls `ec2.getPublicIp(eniId)` for RUNNING tasks. The status-polling spec works around this by relying on the task having no ENI attachments (so `extractEniId` returns null and the IP lookup is skipped). If specs need a running task with an IP, add `Ec2Client` to the mock setup in `test-main.ts` and a `mockPublicIp()` helper in `server-mocks.ts`.
2. **canRun() enforcement** is not yet in the Nest API (Task 15 placeholder).
3. **Other AWS clients** (DynamoDB, SecretsManager, CloudWatch, CostExplorer) are not mocked in `test-main.ts`. Add them if specs need to exercise `DiscordConfigService`, `LogsService`, or `CostService` paths through the full stack.
