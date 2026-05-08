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
 *  - ListTasks    → \{ taskArns: [] \}   (no running tasks)
 *  - DescribeTasks → \{ tasks: [] \}
 *  - RunTask      → \{ tasks: [\{ taskArn: 'arn:aws:ecs:us-east-1:123:task/test-cluster/test-task-id' \}] \}
 *  - StopTask     → \{\}
 */
class MockStore {
  private listTasksQueue: MockResponse[] = [];
  private describeTasksQueue: MockResponse[] = [];
  private runTaskQueue: MockResponse[] = [];
  private stopTaskQueue: MockResponse[] = [];

  pushListTasks(r: MockResponse): void     { this.listTasksQueue.push(r); }
  pushDescribeTasks(r: MockResponse): void { this.describeTasksQueue.push(r); }
  pushRunTask(r: MockResponse): void       { this.runTaskQueue.push(r); }
  pushStopTask(r: MockResponse): void      { this.stopTaskQueue.push(r); }

  dequeueListTasks(): MockResponse | null     { return this.listTasksQueue.shift() ?? null; }
  dequeueDescribeTasks(): MockResponse | null { return this.describeTasksQueue.shift() ?? null; }
  dequeueRunTask(): MockResponse | null       { return this.runTaskQueue.shift() ?? null; }
  dequeueStopTask(): MockResponse | null      { return this.stopTaskQueue.shift() ?? null; }

  /** Clear all queues — called between tests via `POST /api/test/mocks/reset`. */
  reset(): void {
    this.listTasksQueue = [];
    this.describeTasksQueue = [];
    this.runTaskQueue = [];
    this.stopTaskQueue = [];
  }
}

export const mockStore = new MockStore();
