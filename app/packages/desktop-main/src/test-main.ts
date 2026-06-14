/**
 * Integration-test entry point for the Nest server.
 *
 * Sets up aws-sdk-client-mock interceptors BEFORE creating the Nest
 * application. EcsService creates its ECSClient lazily (on first request),
 * so patching the prototype here is sufficient — all subsequent send() calls
 * on any ECSClient instance will hit the mock.
 *
 * Run via: PORT=3002 NODE_ENV=test TF_STATE_PATH=<path> node dist/test-main.js
 *
 * SECURITY NOTE — test-only, unauthenticated, localhost-bound:
 * ApiTokenGuard has been removed, so this server exposes the HTTP controllers
 * without authentication. The listener is bound to localhost (loopback only,
 * never a network-routable interface) so the endpoints are unreachable from the
 * network during a test run. Never use this entry point in production.
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ECSClient,
  ListTasksCommand,
  DescribeTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';
import { AppModule } from './app.module.js';
import { TestMocksModule } from './test-mocks/test-mocks.module.js';
import { mockStore } from './test-mocks/mock-store.js';
import { logger } from './logger.js';

// ── Patch ECSClient prototype before DI container creates any instances ──

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
  return (next?.data as object | undefined) ?? {
    tasks: [{ taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/test-cluster/test-task-id' }],
    failures: [],
  };
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

// ── Boot the Nest application ──

/** Wraps AppModule (real providers) and adds TestMocksModule. */
@Module({ imports: [AppModule, TestMocksModule] })
class TestAppModule {}

const PORT = parseInt(process.env['PORT'] ?? '3002', 10);

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(TestAppModule, {
    logger: ['error', 'warn'],
  });
  app.setGlobalPrefix('api');
  // Bind to loopback only — with ApiTokenGuard removed these endpoints are
  // unauthenticated, so they must not be reachable from the network. Bind to
  // 'localhost' (not a literal 127.0.0.1) so the listen host resolves the same
  // way as the Playwright callers, which all use http://localhost:3002 — this
  // avoids dual-stack mismatches on IPv6-first hosts where localhost is ::1.
  await app.listen(PORT, 'localhost');
  logger.info(`Integration test server running on http://localhost:${PORT}`, { port: PORT });
}

void bootstrap();
