import { test as base } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { DashboardPage } from '../pages/DashboardPage.js';
import { installGsdHttpBridge } from './gsd-http-bridge.js';

const SERVER_BASE = 'http://localhost:3002';

/** Shape matching the server-side MockResponse — one queued ECS command reply. */
export interface MockResponse {
  type: 'success' | 'error';
  data?: unknown;
  code?: string;
  message?: string;
}

/**
 * Playwright-side helper that pushes queued responses into the test server's
 * MockStore via its HTTP control endpoints at `/api/test/mocks/*`. Each method
 * maps to one ECS command type. Construct via the `serverMocks` fixture — it
 * resets the store automatically before and after every test.
 */
export class ServerMocks {
  constructor(private readonly request: APIRequestContext) {}

  private async post(path: string, body?: unknown): Promise<void> {
    const res = await this.request.post(`${SERVER_BASE}${path}`, {
      ...(body !== undefined ? { data: body } : {}),
    });
    if (!res.ok()) throw new Error(`Mock control call failed ${res.status()} ${path}`);
  }

  /** Clear all ECS command queues — called automatically before and after each test. */
  async reset(): Promise<void> { await this.post('/api/test/mocks/reset'); }

  /** Queue a response for the next ListTasksCommand call. */
  async pushListTasks(r: MockResponse): Promise<void> { await this.post('/api/test/mocks/ecs/list-tasks', r); }

  /** Queue a response for the next DescribeTasksCommand call. */
  async pushDescribeTasks(r: MockResponse): Promise<void> { await this.post('/api/test/mocks/ecs/describe-tasks', r); }

  /** Queue a response for the next RunTaskCommand call. */
  async pushRunTask(r: MockResponse): Promise<void> { await this.post('/api/test/mocks/ecs/run-task', r); }

  /** Queue a response for the next StopTaskCommand call. */
  async pushStopTask(r: MockResponse): Promise<void> { await this.post('/api/test/mocks/ecs/stop-task', r); }
}

type IntegrationFixtures = {
  /**
   * Pre-seeded mock controller — resets the MockStore before and after each
   * test so no queued responses leak between specs.
   */
  serverMocks: ServerMocks;
  /**
   * Page with the `window.gsd` HTTP bridge installed so every navigation to the
   * Vite preview can reach the real Nest server on :3002.
   */
  authedPage: Page;
  /** Dashboard page object backed by `authedPage`. */
  dashboard: DashboardPage;
};

export const test = base.extend<IntegrationFixtures>({
  serverMocks: async ({ request }, use) => {
    const mocks = new ServerMocks(request);
    await mocks.reset();
    await use(mocks);
    await mocks.reset();
  },

  authedPage: async ({ page }, use) => {
    // The web client talks to `window.gsd.*`; install a browser-side bridge
    // that forwards each IPC call to the matching `/api/*` route, which the
    // integration preview proxies to the real Nest server on :3002.
    await page.addInitScript(installGsdHttpBridge);
    await use(page);
  },

  dashboard: async ({ authedPage }, use) => {
    await use(new DashboardPage(authedPage));
  },
});
