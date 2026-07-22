import { randomUUID } from 'node:crypto';
import { BadRequestException, Controller, OnModuleInit } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { computeRunDetailStatus, type RunDetailStatus } from '@hyveon/shared';
import {
  TerraformService,
  type TerraformRunChunk,
  type TerraformRunRecord,
} from '../services/TerraformService.js';
import { RunService } from '../services/RunService.js';
import { logger } from '../logger.js';

/** Payload accepted by {@link TerraformRunsController.get}. */
export interface TerraformRunsGetPayload {
  runId: string;
}

/**
 * Result of {@link TerraformRunsController.get}: `found: false` when `runId`
 * is neither the currently held apply lock nor a persisted
 * `TerraformRunRecord` on disk. `found: true` always carries the derived
 * {@link RunDetailStatus}; `record` is present only once the run has produced
 * a persisted `TerraformRunRecord` (i.e. every status except `running`, since
 * a run in flight hasn't closed its process yet — see
 * `TerraformRunRecord`'s file-level doc comment).
 */
export type TerraformRunsGetResult =
  | { found: false }
  | { found: true; status: RunDetailStatus; record?: TerraformRunRecord };

/** Payload accepted by {@link TerraformRunsController.logs}. */
export interface TerraformRunsLogsPayload {
  runId: string;
}

/** Fixed side-channel {@link TerraformRunsController.logs} pushes streamed output on. */
const LOGS_CHUNK_CHANNEL = 'terraform.runs.logs.chunk';

/** Fixed side-channel {@link TerraformRunsController.logs} sends its terminal message on. */
const LOGS_END_CHANNEL = 'terraform.runs.logs.end';

/**
 * Message payload sent, in order, on {@link LOGS_CHUNK_CHANNEL} for every
 * chunk `TerraformService.streamRunOutput` yields. `streamId` ties the chunk
 * back to the `logs()` call that produced it (see
 * {@link TerraformRunsLogsAck.streamId}) so the renderer can never mix up
 * output from two overlapping subscriptions.
 */
interface TerraformRunsLogsChunkMessage {
  streamId: string;
  chunk: TerraformRunChunk;
}

/**
 * Message payload sent exactly once on {@link LOGS_END_CHANNEL} once the run
 * identified by `logs()`'s `runId` reaches a terminal status — either
 * `TerraformService.streamRunOutput`'s generator ends cleanly (the run
 * settled, or a finished run's persisted log finished replaying) or it threw
 * (`error` carries the stringified failure). `streamId` identifies which
 * `logs()` call this terminates.
 */
interface TerraformRunsLogsEndMessage {
  streamId: string;
  error?: string;
}

/**
 * Immediate acknowledgement `logs()` resolves with — `streamId` tags every
 * subsequent chunk/end message pushed for this subscription on
 * {@link LOGS_CHUNK_CHANNEL} / {@link LOGS_END_CHANNEL}.
 */
interface TerraformRunsLogsAck {
  streamId: string;
}

/**
 * IPC-only controller for reading the status/detail of a single `terraform`
 * plan/apply/destroy run (issue #108) — no HTTP routes are registered here.
 *
 * `get()` combines two data sources to derive the run's
 * {@link RunDetailStatus} via the shared, pure `computeRunDetailStatus`
 * helper: `RunService.getCurrentLock()` (the in-flight apply lock, #106) for
 * a still-running run, and `TerraformService.readRunRecord()` /
 * `TerraformService.hasPlanArtifact()` (the local `<runsDir>/<runId>/run.json`
 * + `.tfplan` artifact, #108's `TerraformService` half) for a finished one.
 *
 * `logs()` bridges `TerraformService.streamRunOutput`'s async-generator
 * output onto the fixed `terraform.runs.logs.chunk` / `terraform.runs.logs.end`
 * side channels, mirroring `TerraformController.init`/`plan`'s streaming
 * shape, so the renderer can watch (or re-attach to) a run's live or
 * persisted output.
 */
@Controller()
export class TerraformRunsController implements OnModuleInit {
  constructor(
    private readonly terraform: TerraformService,
    private readonly runService: RunService,
  ) {}

  /**
   * Registers an `ipcMain.handle` bridge for the `terraform.runs.logs`
   * channel after the Nest module initialises, so that
   * `ipcRenderer.invoke('terraform.runs.logs', { runId })` in the preload
   * actually resolves.
   *
   * `@MessagePattern('terraform.runs.logs')` only wires the transport's
   * internal dispatcher — it does **not** call `ipcMain.handle`, so
   * `ipcRenderer.invoke` would otherwise hang. This hook bridges the gap,
   * mirroring `TerraformController.onModuleInit`'s handling of
   * `terraform.init`/`terraform.plan` — see `SELF_BRIDGED_PATTERNS` in
   * `../ipc-main-bridge.ts`, which excludes `terraform.runs.logs` from the
   * generic bridge for the same reason: the handler pushes follow-up
   * chunk/end messages over side channels for the duration of a run's output
   * rather than resolving a single value.
   *
   * Only runs inside a real Electron main process. In plain-Node runtimes
   * (integration test server, Docker, CI) `process.versions.electron` is
   * undefined and importing `electron` would throw, so the bridge is skipped
   * entirely rather than guessing which error means "no Electron" from the
   * message.
   */
  async onModuleInit(): Promise<void> {
    if (!process.versions.electron) {
      // Not running inside the Electron main process — ipcMain bridge skipped.
      return;
    }
    const { ipcMain } = (await import('electron')) as unknown as { ipcMain: IpcMain };
    // Remove any existing handler first so hot-reload re-registration does
    // not throw "IPC channel already registered".
    ipcMain.removeHandler('terraform.runs.logs');
    ipcMain.handle('terraform.runs.logs', (evt, payload: TerraformRunsLogsPayload) =>
      this.logs(payload, { evt: evt as IpcMainInvokeEvent }),
    );
  }

  /**
   * Looks up a single run by `runId` and returns its current
   * {@link RunDetailStatus}:
   *
   * - `{ found: true, status: 'running' }` when `runId` matches the run
   *   currently holding the apply lock (`RunService.getCurrentLock()`) — no
   *   `record` is attached, since a {@link TerraformRunRecord} is only ever
   *   persisted once the run's process has closed.
   * - `{ found: true, status, record }` when a persisted
   *   {@link TerraformRunRecord} exists for `runId` — `status` is derived via
   *   `computeRunDetailStatus`, checking `TerraformService.hasPlanArtifact()`
   *   for `plan` records to distinguish `awaiting_approval` from a terminal
   *   `success`/`failed`/`aborted`.
   * - `{ found: false }` when `runId` is neither in flight nor has a
   *   persisted record.
   *
   * @throws `BadRequestException` when `payload.runId` isn't a non-empty
   *   string.
   *
   * Reachable via the Electron IPC transport (`terraform.runs.get`).
   */
  @MessagePattern('terraform.runs.get')
  async get(@Payload() payload: TerraformRunsGetPayload): Promise<TerraformRunsGetResult> {
    const runId = payload?.runId;
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new BadRequestException({
        success: false,
        error: 'terraform.runs.get requires a non-empty runId string',
      });
    }

    const currentLock = this.runService.getCurrentLock();
    if (currentLock?.runId === runId) {
      return { found: true, status: 'running' };
    }

    const record = this.terraform.readRunRecord(runId);
    if (!record) {
      return { found: false };
    }

    const planArtifactExists = record.kind === 'plan' ? this.terraform.hasPlanArtifact(runId) : false;
    const status = computeRunDetailStatus({
      isInFlight: false,
      kind: record.kind,
      exitCode: record.exitCode,
      planArtifactExists,
    });

    return { found: true, status, record };
  }

  /**
   * Opens a live/replayed log stream for the run identified by `payload.runId`
   * and returns an opaque `streamId` immediately. Chunks are pushed to the
   * renderer via `sender.send` on {@link LOGS_CHUNK_CHANNEL} as
   * `{ streamId, chunk }`, forwarded in order straight from
   * `TerraformService.streamRunOutput` — which itself either replays an
   * in-flight run's buffered + live output or, for a finished run, replays
   * its persisted `terraform.log`.
   *
   * Exactly one terminal message is sent on {@link LOGS_END_CHANNEL} once the
   * run reaches a terminal status: `{ streamId }` when
   * `TerraformService.streamRunOutput`'s generator ends cleanly (the run
   * settled, or a finished run's log finished replaying), or
   * `{ streamId, error }` when it throws (e.g. `runId` doesn't match any
   * known run).
   *
   * Mirrors `LogsController.streamLogs`/`TerraformController.init`'s
   * fire-and-forget streaming shape: the controller creates its own
   * `AbortController` per invocation (since `ElectronIPCTransport` passes
   * `{ evt }` as the execution context, with no `signal` injected), and a
   * `'destroyed'` listener on the `WebContents` aborts it — and stops any
   * further `sender.send` calls — the instant the window/webview goes away,
   * in addition to the chunk loop's own `isDestroyed()` check between chunks.
   *
   * @throws `BadRequestException` when `payload.runId` isn't a non-empty
   *   string.
   *
   * Reachable via the Electron IPC transport (`terraform.runs.logs`).
   */
  @MessagePattern('terraform.runs.logs')
  async logs(
    @Payload() payload: TerraformRunsLogsPayload,
    ctx: { evt: IpcMainInvokeEvent },
  ): Promise<TerraformRunsLogsAck> {
    const runId = payload?.runId;
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new BadRequestException({
        success: false,
        error: 'terraform.runs.logs requires a non-empty runId string',
      });
    }

    const sender: WebContents = ctx.evt.sender;
    const streamId = randomUUID();
    const ac = new AbortController();

    const onDestroyed = () => ac.abort();
    sender.once('destroyed', onDestroyed);

    // Fire-and-forget the streaming loop. Chunks are pushed back to the
    // renderer directly via WebContents.send rather than through the normal
    // invoke reply mechanism, which only supports a single return value.
    void (async () => {
      try {
        for await (const chunk of this.terraform.streamRunOutput(runId, ac.signal)) {
          if (sender.isDestroyed()) { ac.abort(); return; }
          const chunkMessage: TerraformRunsLogsChunkMessage = { streamId, chunk };
          sender.send(LOGS_CHUNK_CHANNEL, chunkMessage);
        }
        if (!sender.isDestroyed()) {
          const message: TerraformRunsLogsEndMessage = { streamId };
          sender.send(LOGS_END_CHANNEL, message);
        }
      } catch (err) {
        logger.error('terraform.runs.logs error', { err, runId, streamId });
        if (!sender.isDestroyed()) {
          const message: TerraformRunsLogsEndMessage = { streamId, error: String(err) };
          sender.send(LOGS_END_CHANNEL, message);
        }
      } finally {
        sender.removeListener('destroyed', onDestroyed);
      }
    })();

    return { streamId };
  }
}
