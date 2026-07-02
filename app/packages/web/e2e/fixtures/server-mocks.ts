import { test as base } from '@playwright/test';
// Deep import into @hyveon/desktop-main's compiled `dist/`, mirroring
// `ipc-harness.ts` — the module is a process-wide singleton, so pushing here
// is visible to any `ipc` harness dispatched in the same test process.
import { mockStore } from '@hyveon/desktop-main/dist/test-mocks/mock-store.js';
import type { MockResponse } from '@hyveon/desktop-main/dist/test-mocks/mock-store.js';
import { createIpcHarness } from './ipc-harness.js';
import type { IpcHarness } from './ipc-harness.js';

export type { MockResponse };

/**
 * Playwright-side helper that pushes queued responses directly into the
 * in-process {@link mockStore} singleton — no HTTP round-trip and no
 * BrowserWindow/page involved. Each method maps to one ECS command type.
 * Construct via the `serverMocks` fixture — it resets the store automatically
 * before and after every test.
 */
export class ServerMocks {
  /** Clear all ECS command queues — called automatically before and after each test. */
  async reset(): Promise<void> { mockStore.reset(); }

  /** Queue a response for the next ListTasksCommand call. */
  async pushListTasks(r: MockResponse): Promise<void> { mockStore.pushListTasks(r); }

  /** Queue a response for the next DescribeTasksCommand call. */
  async pushDescribeTasks(r: MockResponse): Promise<void> { mockStore.pushDescribeTasks(r); }

  /** Queue a response for the next RunTaskCommand call. */
  async pushRunTask(r: MockResponse): Promise<void> { mockStore.pushRunTask(r); }

  /** Queue a response for the next StopTaskCommand call. */
  async pushStopTask(r: MockResponse): Promise<void> { mockStore.pushStopTask(r); }
}

type IntegrationFixtures = {
  /**
   * In-process IPC test harness — dispatches directly to `AppModule`
   * controller methods (e.g. `ipc.dispatch(GamesController, 'listStatus')`)
   * with no HTTP server and no BrowserWindow. See `./ipc-harness.js`.
   */
  ipc: IpcHarness;
  /**
   * Pre-seeded mock controller — resets the MockStore before and after each
   * test so no queued responses leak between specs.
   */
  serverMocks: ServerMocks;
};

export const test = base.extend<IntegrationFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature requires the deps param even when unused.
  ipc: async ({}, use) => {
    const harness = await createIpcHarness();
    await use(harness);
    await harness.close();
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature requires the deps param even when unused.
  serverMocks: async ({}, use) => {
    const mocks = new ServerMocks();
    await mocks.reset();
    await use(mocks);
    await mocks.reset();
  },
});
