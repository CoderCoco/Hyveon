import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  SchedulerClient,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-scheduler';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SchedulerService } from './SchedulerService.js';
import type { ConfigService } from './ConfigService.js';
import type { ElectronStoreService } from './ElectronStoreService.js';

/** Typed stand-in for the AWS EventBridge Scheduler SDK client. */
const schedulerMock = mockClient(SchedulerClient);

/** Build a minimal ConfigService stub exposing only the members SchedulerService actually reads at runtime. */
function makeConfig(): ConfigService {
  const stub: Partial<ConfigService> = { getRegion: () => 'us-east-1' };
  return stub as ConfigService;
}

/**
 * Build a minimal `ElectronStoreService` stub reporting no wizard-configured
 * AWS profile — `resolveAwsClientCredentials` resolves this to `undefined`
 * credentials, letting the globally-patched `schedulerMock` client intercept
 * calls regardless of what `credentials` the client was constructed with.
 */
function makeStore(): ElectronStoreService {
  const stub: Partial<ElectronStoreService> = { get: vi.fn().mockReturnValue(undefined) };
  return stub as ElectronStoreService;
}

describe('SchedulerService', () => {
  /** Service under test, freshly constructed per test. */
  let service: SchedulerService;

  beforeEach(() => {
    schedulerMock.reset();
    service = new SchedulerService(makeConfig(), makeStore());
  });

  describe('createStopSchedule', () => {
    it('should delete any existing schedule with the same name before creating a fresh one', async () => {
      schedulerMock.on(DeleteScheduleCommand).resolves({});
      schedulerMock.on(CreateScheduleCommand).resolves({ ScheduleArn: 'arn:schedule' });

      await service.createStopSchedule({
        name: 'filemgr-stop-minecraft',
        cluster: 'game-cluster',
        taskArn: 'arn:aws:ecs:us-east-1:123:task/game-cluster/abc',
        roleArn: 'arn:aws:iam::123:role/filebrowser-scheduler',
        at: new Date('2030-01-01T00:00:00.000Z'),
      });

      expect(schedulerMock.commandCalls(DeleteScheduleCommand)).toHaveLength(1);
      expect(schedulerMock.commandCalls(DeleteScheduleCommand)[0]!.args[0].input.Name).toBe('filemgr-stop-minecraft');
    });

    it('should create a one-time schedule with the universal ecs:StopTask target, no flexible time window, and delete-after-completion', async () => {
      schedulerMock.on(DeleteScheduleCommand).resolves({});
      schedulerMock.on(CreateScheduleCommand).resolves({ ScheduleArn: 'arn:schedule' });

      const ok = await service.createStopSchedule({
        name: 'filemgr-stop-minecraft',
        cluster: 'game-cluster',
        taskArn: 'arn:aws:ecs:us-east-1:123:task/game-cluster/abc',
        roleArn: 'arn:aws:iam::123:role/filebrowser-scheduler',
        at: new Date('2030-01-01T12:34:56.000Z'),
      });

      expect(ok).toBe(true);
      const input = schedulerMock.commandCalls(CreateScheduleCommand)[0]!.args[0].input;
      expect(input.Name).toBe('filemgr-stop-minecraft');
      expect(input.ScheduleExpression).toBe('at(2030-01-01T12:34:56)');
      expect(input.FlexibleTimeWindow).toEqual({ Mode: 'OFF' });
      expect(input.ActionAfterCompletion).toBe('DELETE');
      expect(input.Target?.Arn).toBe('arn:aws:scheduler:::aws-sdk:ecs:stopTask');
      expect(input.Target?.RoleArn).toBe('arn:aws:iam::123:role/filebrowser-scheduler');
      expect(JSON.parse(input.Target!.Input!)).toEqual({
        cluster: 'game-cluster',
        task: 'arn:aws:ecs:us-east-1:123:task/game-cluster/abc',
        reason: expect.any(String),
      });
    });

    it('should return false and log rather than throw when CreateScheduleCommand fails', async () => {
      schedulerMock.on(DeleteScheduleCommand).resolves({});
      schedulerMock.on(CreateScheduleCommand).rejects(new Error('boom'));

      const ok = await service.createStopSchedule({
        name: 'filemgr-stop-minecraft',
        cluster: 'game-cluster',
        taskArn: 'arn:task',
        roleArn: 'arn:role',
        at: new Date('2030-01-01T00:00:00.000Z'),
      });

      expect(ok).toBe(false);
    });
  });

  describe('deleteSchedule', () => {
    it('should call DeleteScheduleCommand with the given name', async () => {
      schedulerMock.on(DeleteScheduleCommand).resolves({});

      await service.deleteSchedule('filemgr-stop-minecraft');

      expect(schedulerMock.commandCalls(DeleteScheduleCommand)[0]!.args[0].input.Name).toBe('filemgr-stop-minecraft');
    });

    it('should treat ResourceNotFoundException as a no-op, not an error', async () => {
      schedulerMock.on(DeleteScheduleCommand).rejects(
        new ResourceNotFoundException({ message: 'not found', $metadata: {} }),
      );

      await expect(service.deleteSchedule('filemgr-stop-minecraft')).resolves.toBeUndefined();
    });

    it('should swallow any other error rather than throw', async () => {
      schedulerMock.on(DeleteScheduleCommand).rejects(new Error('boom'));

      await expect(service.deleteSchedule('filemgr-stop-minecraft')).resolves.toBeUndefined();
    });
  });
});
