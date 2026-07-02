import { mockClient, type AwsClientStub } from 'aws-sdk-client-mock';
import {
  ECSClient,
  ListTasksCommand,
  DescribeTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';
import { mockStore } from './mock-store.js';

/**
 * Installs `aws-sdk-client-mock` interceptors on the `ECSClient` prototype,
 * wired to the shared {@link mockStore} FIFO queues (`ListTasks`,
 * `DescribeTasks`, `RunTask`, `StopTask`).
 *
 * Extracted from `test-main.ts` so both the HTTP integration server
 * (`test-main.ts`, port 3002) and the in-process IPC test harness
 * (`e2e/fixtures/ipc-harness.ts`) can patch `ECSClient` identically without
 * duplicating the four command handlers.
 *
 * `EcsService` creates its `ECSClient` lazily (on first request), so patching
 * the *prototype* is sufficient — this only needs to run once, before the
 * first `send()` call anywhere in the process, regardless of when the DI
 * container instantiates `EcsService`.
 *
 * @returns the `aws-sdk-client-mock` stub. Callers rarely need it directly
 * since all queued state routes through {@link mockStore}, but it's returned
 * so callers can `.reset()` the interceptor itself if ever needed.
 */
export function installEcsMock(): AwsClientStub<ECSClient> {
  const ecsMock = mockClient(ECSClient);

  ecsMock.on(ListTasksCommand).callsFake(async () => {
    const next = mockStore.dequeueListTasks();
    if (next?.type === 'error') {
      throw Object.assign(new Error(next.message ?? 'Mock ListTasks error'), {
        name: next.code ?? 'ServiceException',
      });
    }
    return (next?.data as object | undefined) ?? { taskArns: [] };
  });

  ecsMock.on(DescribeTasksCommand).callsFake(async () => {
    const next = mockStore.dequeueDescribeTasks();
    if (next?.type === 'error') {
      throw Object.assign(new Error(next.message ?? 'Mock DescribeTasks error'), {
        name: next.code ?? 'ServiceException',
      });
    }
    return (next?.data as object | undefined) ?? { tasks: [] };
  });

  ecsMock.on(RunTaskCommand).callsFake(async () => {
    const next = mockStore.dequeueRunTask();
    if (next?.type === 'error') {
      throw Object.assign(new Error(next.message ?? 'Mock RunTask error'), {
        name: next.code ?? 'ServiceException',
      });
    }
    return (
      (next?.data as object | undefined) ?? {
        tasks: [{ taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/test-cluster/test-task-id' }],
        failures: [],
      }
    );
  });

  ecsMock.on(StopTaskCommand).callsFake(async () => {
    const next = mockStore.dequeueStopTask();
    if (next?.type === 'error') {
      throw Object.assign(new Error(next.message ?? 'Mock StopTask error'), {
        name: next.code ?? 'ServiceException',
      });
    }
    return (next?.data as object | undefined) ?? {};
  });

  return ecsMock;
}
