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
