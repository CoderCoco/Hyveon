import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import { join } from 'node:path';
import { Controller, OnModuleInit } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { RunLockHeldError, isApprovalExpired } from '@hyveon/shared';
import {
  TerraformService,
  TerraformInitError,
  TerraformPlanError,
  TerraformApplyError,
  type TerraformInitConfig,
  type TerraformRunChunk,
  type TerraformPlanResult,
  type TerraformApplyResult,
} from '../services/TerraformService.js';
import { ConfigService, type TfOutputs } from '../services/ConfigService.js';
import { AuditService } from '../services/AuditService.js';
import { RunRecordService } from '../services/RunRecordService.js';
import { RunService } from '../services/RunService.js';
import { logger } from '../logger.js';

/** Fixed side-channel `TerraformController.init` pushes streamed output on. */
const CHUNK_CHANNEL = 'terraform.init.chunk';

/** Fixed side-channel `TerraformController.init` sends its terminal message on. */
const END_CHANNEL = 'terraform.init.end';

/** Fixed side-channel `TerraformController.plan` pushes streamed output on. */
const PLAN_CHUNK_CHANNEL = 'terraform.plan.chunk';

/** Fixed side-channel `TerraformController.plan` sends its terminal message on. */
const PLAN_END_CHANNEL = 'terraform.plan.end';

/** Fixed side-channel `TerraformController.apply` pushes streamed output on. */
const APPLY_CHUNK_CHANNEL = 'terraform.apply.chunk';

/** Fixed side-channel `TerraformController.apply` sends its terminal message on. */
const APPLY_END_CHANNEL = 'terraform.apply.end';

/**
 * Message payload sent, in order, on {@link CHUNK_CHANNEL} for every chunk
 * `TerraformService.init` yields. `streamId` ties the chunk back to the
 * `init()` call that produced it (see {@link TerraformInitAck.streamId}) so
 * the renderer — and a second, rejected concurrent call — can never mix up
 * output from two overlapping runs.
 */
interface TerraformInitChunkMessage {
  streamId: string;
  chunk: TerraformRunChunk;
}

/**
 * Message payload sent once on {@link END_CHANNEL} when a `terraform.init`
 * run finishes. `streamId` identifies which `init()` call this terminates
 * (see {@link TerraformInitAck.streamId}) so a rejected/second concurrent
 * call can't broadcast an end event that the first caller mistakes for its
 * own. `exitCode` is `0` on success. On failure it carries whatever exit
 * code the spawned process reported (or `null` when the run failed
 * before/without an exit code, e.g. the binary couldn't be resolved or a
 * second `init` was already in flight), plus a stringified `error`.
 */
interface TerraformInitEndMessage {
  streamId: string;
  exitCode: number | null;
  error?: string;
}

/**
 * Immediate acknowledgement `init()` resolves with. `started: true` means the
 * streaming loop was kicked off in the background (chunk/end messages will
 * follow on the side channels, tagged with `streamId`). `started: false`
 * means `config` failed validation and no `TerraformService.init` run was
 * attempted — `error` describes why and `streamId` is omitted.
 */
interface TerraformInitAck {
  started: boolean;
  streamId?: string;
  error?: string;
}

/**
 * Payload accepted by {@link TerraformController.output}. `force` is
 * optional and defaults to `false`, mirroring `TerraformService.output`'s
 * own default parameter.
 */
interface TerraformOutputPayload {
  force?: boolean;
}

/**
 * Payload accepted by {@link TerraformController.plan}. `tfvarsVersionId`,
 * when the configured tfvars source is S3-backed, is forwarded verbatim to
 * `TerraformService.plan`'s pre-spawn staleness check against the current
 * head version of the tfvars object. `rolledBackFrom`, when supplied by the
 * rollback flow (#112), is stamped onto the resulting plan's `RunRecord` so
 * history can tag it as a rollback of that `runId`.
 */
interface TerraformPlanPayload {
  tfvarsVersionId?: string;
  rolledBackFrom?: string;
}

/**
 * Message payload sent, in order, on {@link PLAN_CHUNK_CHANNEL} for every
 * chunk `TerraformService.plan` yields. `runId` ties the chunk back to the
 * `plan()` call that produced it — the same id already handed back in
 * {@link TerraformPlanAck.runId} — so the renderer (and a second, rejected
 * concurrent call) can never mix up output from two overlapping runs.
 */
interface TerraformPlanChunkMessage {
  runId: string;
  chunk: TerraformRunChunk;
}

/**
 * Message payload sent once on {@link PLAN_END_CHANNEL} when a
 * `terraform.plan` run finishes. `exitCode` is `0` on success. On failure it
 * carries whatever exit code the spawned process reported (or `null` when
 * the run failed before/without an exit code), plus a stringified `error`.
 * `result` is present only on a successful run — the resource-change counts
 * and artifact paths `TerraformService.plan` resolved.
 */
interface TerraformPlanEndMessage {
  runId: string;
  exitCode: number | null;
  error?: string;
  result?: TerraformPlanResult;
}

/**
 * Immediate acknowledgement `plan()` resolves with. `started: true` means a
 * `runId` was pre-minted and the streaming loop was kicked off in the
 * background (chunk/end messages will follow on the side channels, tagged
 * with that same `runId`). `started: false` means the submission was
 * rejected before any `TerraformService.plan` run was attempted and no
 * `runId` is present — `error` is a human-readable description of why, and
 * `conflict` additionally names the already-running subcommand
 * (`init`/`plan`/`apply`/`destroy`) when the rejection was specifically
 * because the shared workspace was busy (see
 * `TerraformService.getWorkspaceInFlight()`).
 */
interface TerraformPlanAck {
  started: boolean;
  runId?: string;
  error?: string;
  conflict?: 'init' | 'plan' | 'apply' | 'destroy';
}

/**
 * Payload accepted by {@link TerraformController.approve}. `planRunId`
 * identifies the successful `plan` run to approve. Unlike the previous shape
 * of this payload, there is no client-supplied approver identity — the
 * approver is always resolved server-side (see
 * {@link TerraformController.resolveApprover}) so an IPC caller can never
 * spoof who approved a run.
 *
 * Mirrors `approve: (opts: { planRunId: string }) => ...` in
 * `@hyveon/desktop-preload/src/gsd-api.ts` — keep this shape in sync with
 * that sibling contract.
 */
interface TerraformApprovePayload {
  planRunId: string;
}

/**
 * Result `approve()` resolves with. `approved: true` means
 * `RunRecordService.approveRun` succeeded — `approvedBy`/`approvedAt` mirror
 * the values now stamped onto the persisted `RunRecord`. `approved: false`
 * means no write was attempted (payload failed validation) or the write was
 * attempted and rejected (table not configured, no matching record, record
 * isn't a successful `plan` run) — `error` is always a human-readable
 * description of why, and `approvedBy`/`approvedAt` are omitted.
 */
interface TerraformApproveAck {
  approved: boolean;
  approvedBy?: string;
  approvedAt?: string;
  error?: string;
}

/**
 * Payload accepted by {@link TerraformController.resolveRollback} and
 * {@link TerraformController.confirmRollback} — both key off the `apply` run
 * being rolled back.
 */
interface TerraformRollbackPayload {
  applyRunId: string;
}

/**
 * Result `resolveRollback()` resolves with. `resolved: true` means
 * `TerraformService.resolveRollbackTarget` found a prior tfvars version to
 * restore — `versionId`/`lastModified` identify it, for the confirmation
 * dialog to display before anything is written. `resolved: false` means the
 * payload failed validation or resolution was rejected (no matching apply
 * run, not an apply run, no recorded tfvarsVersionId, or no earlier version
 * exists) — `error` is always a human-readable description of why.
 */
interface TerraformRollbackResolveAck {
  resolved: boolean;
  versionId?: string;
  lastModified?: string;
  error?: string;
}

/**
 * Result `confirmRollback()` resolves with. `confirmed: true` means the
 * historic tfvars content was restored as a new head version —
 * `versionId` is the new version's id, ready to pass to `terraform.plan`'s
 * `tfvarsVersionId` (alongside `rolledBackFrom: applyRunId`) to complete the
 * rollback. `confirmed: false` means no write was attempted — `error` is
 * always a human-readable description of why.
 */
interface TerraformRollbackConfirmAck {
  confirmed: boolean;
  versionId?: string;
  error?: string;
}

/**
 * Payload accepted by {@link TerraformController.apply}. `planRunId`
 * identifies the approved `plan` run to apply — its own `runId` is reused as
 * the apply run's `runId` too, so the plan and the apply that consumes it
 * share one run history entry lineage (see {@link apply}'s TSDoc). `planHash`
 * is the caller's expected plan hash, compared against the plan run's stored
 * `planHash` so a forged or drifted hash can never slip an unreviewed
 * `.tfplan` artifact through to `terraform apply`.
 *
 * Mirrors `TerraformApplyPayload` in
 * `@hyveon/desktop-preload/src/gsd-api.ts` — keep this shape in sync with
 * that sibling contract.
 */
interface TerraformApplyPayload {
  planRunId: string;
  planHash: string;
}

/**
 * Message payload sent, in order, on {@link APPLY_CHUNK_CHANNEL} for every
 * chunk `TerraformService.apply` yields. `runId` ties the chunk back to the
 * `apply()` call that produced it — the same id already handed back in the
 * ack `TerraformController.apply` resolves — mirrors
 * {@link TerraformPlanChunkMessage}.
 */
interface TerraformApplyChunkMessage {
  runId: string;
  chunk: TerraformRunChunk;
}

/**
 * Message payload sent once on {@link APPLY_END_CHANNEL} when a
 * `terraform.apply` run finishes. `exitCode` is `0` on success. On failure it
 * carries whatever exit code the spawned process reported (or `null` when
 * the run failed before/without an exit code — e.g. a stale-tfvars rejection
 * that never spawned `terraform`), plus a stringified `error`. `result` is
 * present only on a successful run.
 */
interface TerraformApplyEndMessage {
  runId: string;
  exitCode: number | null;
  error?: string;
  result?: TerraformApplyResult;
}

/**
 * IPC-only Terraform controller. Handles Electron main-process messages via
 * `@MessagePattern` — no HTTP routes are registered here.
 *
 * Bridges {@link TerraformService.init}'s async-generator output onto the
 * fixed `terraform.init.chunk` / `terraform.init.end` side channels so the
 * renderer's first-run wizard can render `terraform init` output live.
 * {@link plan} mirrors the same bridging shape for `terraform plan`, plus a
 * pre-flight `TerraformService.getWorkspaceInFlight()` conflict check and a
 * persisted `AuditService.record()` entry for every accepted submission.
 * {@link approve} needs no such bridging — it resolves a single value, so
 * the generic `ipcMain.handle` bridge in `../ipc-main-bridge.ts` wires it
 * automatically — and delegates the actual write to
 * `RunRecordService.approveRun` (see issue #109). {@link apply} mirrors
 * {@link plan}'s streaming/bridging shape once more, gated behind the
 * plan-hash + approval + apply-lock checks described in its own TSDoc (issue
 * #109).
 */
@Controller()
export class TerraformController implements OnModuleInit {
  /**
   * `audit`/`runRecord`/`runService`/`config` are typed optional (`?`) purely
   * so existing test call sites that construct
   * `new TerraformController(terraform)` directly (bypassing Nest's DI
   * container) keep compiling without also stubbing them — every real
   * bootstrap through `AppModule` still resolves concrete
   * `AuditService`/`RunRecordService`/`RunService`/`ConfigService` instances
   * regardless of this TS-level optionality. `runService` guards the single
   * durable apply lock {@link apply} acquires before ever spawning
   * `terraform apply` (issue #106); `config` resolves the expected `.tfplan`
   * artifact path for a given `planRunId` via `ConfigService.getRunsDir()`.
   */
  constructor(
    private readonly terraform: TerraformService,
    private readonly audit?: AuditService,
    private readonly runRecord?: RunRecordService,
    private readonly runService?: RunService,
    private readonly config?: ConfigService,
  ) {}

  /**
   * Per-call `AbortController`s keyed by the `streamId` minted in
   * {@link init}. Lets a future `terraform.init.cancel` channel reach the
   * right in-flight run, and lets the `WebContents` `'destroyed'` listener in
   * {@link init} abort immediately without racing the chunk loop's own
   * `isDestroyed()` check.
   */
  private readonly activeInits = new Map<string, AbortController>();

  /**
   * Per-call `AbortController`s keyed by the `runId` minted in {@link plan}.
   * Mirrors {@link activeInits} — lets a future `terraform.plan.cancel`
   * channel reach the right in-flight run, and lets the `WebContents`
   * `'destroyed'` listener in {@link plan} abort immediately without racing
   * the chunk loop's own `isDestroyed()` check.
   */
  private readonly activePlans = new Map<string, AbortController>();

  /**
   * Per-call `AbortController`s keyed by the `runId` (the applied plan's own
   * `runId` — see {@link apply}) an in-flight `apply()` call is running
   * against. Mirrors {@link activePlans} — lets a future
   * `terraform.apply.cancel` channel reach the right in-flight run, and lets
   * the `WebContents` `'destroyed'` listener in {@link apply} abort
   * immediately without racing the chunk loop's own `isDestroyed()` check.
   */
  private readonly activeApplies = new Map<string, AbortController>();

  /**
   * Registers an `ipcMain.handle` bridge for the `terraform.init` channel
   * after the Nest module initialises, so that
   * `ipcRenderer.invoke('terraform.init', config)` in the preload actually
   * resolves.
   *
   * `@MessagePattern('terraform.init')` only wires the transport's internal
   * dispatcher — it does **not** call `ipcMain.handle`, so `ipcRenderer.invoke`
   * would otherwise hang. This hook bridges the gap, mirroring
   * `LogsController.onModuleInit`'s handling of `logs.stream` — see
   * `SELF_BRIDGED_PATTERNS` in `../ipc-main-bridge.ts`, which excludes
   * `terraform.init` from the generic bridge for the same reason: the handler
   * pushes follow-up chunk/end messages over side channels for the duration
   * of a long-running run rather than resolving a single value.
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
    ipcMain.removeHandler('terraform.init');
    ipcMain.handle('terraform.init', (evt, config: TerraformInitConfig) =>
      this.init(config, { evt: evt as IpcMainInvokeEvent }),
    );
    // `terraform.plan` streams chunk/end messages the same way `terraform.init`
    // does — see `SELF_BRIDGED_PATTERNS` in `../ipc-main-bridge.ts`, which
    // excludes it from the generic bridge for the same reason.
    ipcMain.removeHandler('terraform.plan');
    ipcMain.handle('terraform.plan', (evt, payload: TerraformPlanPayload) =>
      this.plan(payload, { evt: evt as IpcMainInvokeEvent }),
    );
    // `terraform.apply` streams chunk/end messages the same way
    // `terraform.plan` does — see `SELF_BRIDGED_PATTERNS` in
    // `../ipc-main-bridge.ts`, which excludes it from the generic bridge for
    // the same reason.
    ipcMain.removeHandler('terraform.apply');
    ipcMain.handle('terraform.apply', (evt, payload: TerraformApplyPayload) =>
      this.apply(payload, { evt: evt as IpcMainInvokeEvent }),
    );
  }

  /**
   * Kicks off `terraform init` against `config` and streams its output back
   * to the renderer.
   *
   * Validates `config` first: `bucket`, `region`, and `dynamodbTable` must
   * all be non-empty strings. If validation fails, no `TerraformService.init`
   * run is attempted and the method resolves immediately with
   * `{ started: false, error }` — no chunk/end messages are sent.
   *
   * Otherwise a per-call `streamId` (`randomUUID()`) is minted and returned
   * in the ack, and the streaming loop is fired and forgotten (mirroring
   * `LogsController.streamLogs`'s `void (async () => { ... })()` pattern);
   * the method resolves immediately with `{ started: true, streamId }`, well
   * before the `terraform init` run itself settles. Every chunk/end message
   * is tagged with that same `streamId` so the renderer — and a second,
   * rejected concurrent call — can always tell which run a message belongs
   * to and never cross-terminate another caller's stream. Each chunk
   * `TerraformService.init` yields is forwarded, in order, to the renderer
   * via `sender.send` on {@link CHUNK_CHANNEL} as
   * `{ streamId, chunk }`. Once the run settles a single terminal message is
   * sent on {@link END_CHANNEL}: `{ streamId, exitCode: 0 }` on success, or
   * `{ streamId, exitCode, error }` on failure — `exitCode` comes from
   * {@link TerraformInitError} when the spawned process exited non-zero, and
   * is `null` for any other failure (binary not found, a second `init`
   * already in flight, a spawn error, etc).
   *
   * Creates its own `AbortController` per invocation (the same reasoning as
   * `LogsController.streamLogs`: `ElectronIPCTransport` passes `{ evt }` as
   * the execution context, so there's no `signal` injected by the transport),
   * registers it in {@link activeInits} keyed by `streamId` so a future
   * cancel channel can reach it, and passes its `signal` through to
   * `TerraformService.init`. A `'destroyed'` listener on the `WebContents`
   * aborts the controller the instant the window/webview goes away, rather
   * than relying solely on the chunk loop's own `isDestroyed()` check (which
   * only re-evaluates between chunks and never fires at all once
   * `TerraformService.init` stops yielding).
   *
   * Reachable via the Electron IPC transport (`terraform.init`).
   */
  @MessagePattern('terraform.init')
  async init(
    @Payload() config: TerraformInitConfig,
    ctx: { evt: IpcMainInvokeEvent },
  ): Promise<TerraformInitAck> {
    const validationError = TerraformController.validateConfig(config);
    if (validationError) {
      logger.error('terraform init rejected: invalid config', { error: validationError });
      return { started: false, error: validationError };
    }

    const sender: WebContents = ctx.evt.sender;
    const streamId = randomUUID();
    const ac = new AbortController();
    this.activeInits.set(streamId, ac);

    const onDestroyed = () => ac.abort();
    sender.once('destroyed', onDestroyed);
    const cleanup = () => {
      this.activeInits.delete(streamId);
      sender.removeListener('destroyed', onDestroyed);
    };

    // Fire-and-forget the streaming loop. Chunks are pushed back to the
    // renderer directly via WebContents.send rather than through the normal
    // invoke reply mechanism, which only supports a single return value.
    void (async () => {
      try {
        for await (const chunk of this.terraform.init(config, ac.signal)) {
          if (sender.isDestroyed()) { ac.abort(); return; }
          const chunkMessage: TerraformInitChunkMessage = { streamId, chunk };
          sender.send(CHUNK_CHANNEL, chunkMessage);
        }
        if (!sender.isDestroyed()) {
          const message: TerraformInitEndMessage = { streamId, exitCode: 0 };
          sender.send(END_CHANNEL, message);
        }
      } catch (err) {
        logger.error('terraform init error', { err });
        if (!sender.isDestroyed()) {
          const exitCode = err instanceof TerraformInitError ? err.exitCode : null;
          const message: TerraformInitEndMessage = { streamId, exitCode, error: String(err) };
          sender.send(END_CHANNEL, message);
        }
      } finally {
        cleanup();
      }
    })();

    return { started: true, streamId };
  }

  /**
   * Kicks off `terraform plan` and streams its output back to the renderer —
   * mirrors {@link init}'s streaming shape, but pre-mints a `runId` (rather
   * than a `streamId`) since `TerraformService.plan` already needs one to
   * name its `.tfplan` artifact directory.
   *
   * Checks `TerraformService.getWorkspaceInFlight()` first: if `init`,
   * `plan`, `apply`, or `destroy` is already running against the shared
   * workspace, no run is attempted — the method resolves immediately with
   * `{ started: false, error, conflict: <in-flight op> }` naming whichever
   * subcommand is in flight. No chunk/end messages are sent and no audit
   * entry is recorded for a rejected submission.
   *
   * Otherwise a `runId` (`randomUUID()`) is minted up front and handed to
   * `TerraformService.plan` as `preMintedRunId`, and the generator's first
   * step is driven synchronously (before anything is awaited) to reserve the
   * shared workspace — see the inline comment at the call site for why this
   * ordering matters. Only once that reservation has happened is an audit
   * entry (`action: 'plan'`) recorded via `AuditService.record()` for the
   * now-accepted submission, and the streaming loop fired and forgotten
   * (mirroring {@link init}'s `void (async () => { ... })()` pattern); the
   * method resolves immediately with `{ started: true, runId }`, well before
   * the `terraform plan` run itself settles. Every chunk/end message is
   * tagged with that same `runId` so the renderer — and a second, rejected
   * concurrent call — can always tell which run a message belongs to. Each
   * chunk `TerraformService.plan` yields is forwarded, in order, to the
   * renderer via `sender.send` on {@link PLAN_CHUNK_CHANNEL} as
   * `{ runId, chunk }`. Once the run settles a single terminal message is
   * sent on {@link PLAN_END_CHANNEL}: `{ runId, exitCode: 0, result }` on
   * success, or `{ runId, exitCode, error }` on failure — `exitCode` comes
   * from {@link TerraformPlanError} when the spawned process exited
   * non-zero, and is `null` for any other failure (binary not found, a
   * stale-tfvars staleness rejection, a run-record persistence failure,
   * etc).
   *
   * Unlike {@link init} (which uses `for await...of` because it discards the
   * generator's return value), `plan()` drives `TerraformService.plan`'s
   * async generator manually via repeated `.next()` calls so the terminal
   * `TerraformPlanResult` (the generator's return value once it's `done`)
   * can be attached to the end message's `result` field. If the `WebContents`
   * is destroyed mid-stream, the generator is explicitly finalized via
   * `stream.return()` — the manual-drive equivalent of what `for await...of`
   * does automatically on an early `return` out of its loop body — so
   * `TerraformService.plan`'s own force-closed-generator cleanup (persisting
   * a cancelled run record) still runs.
   *
   * Creates its own `AbortController` per invocation (the same reasoning as
   * {@link init}), registers it in {@link activePlans} keyed by `runId` so a
   * future cancel channel can reach it, and passes its `signal` through to
   * `TerraformService.plan`. A `'destroyed'` listener on the `WebContents`
   * aborts the controller the instant the window/webview goes away.
   *
   * Reachable via the Electron IPC transport (`terraform.plan`).
   */
  @MessagePattern('terraform.plan')
  async plan(
    @Payload() payload: TerraformPlanPayload = {},
    ctx: { evt: IpcMainInvokeEvent },
  ): Promise<TerraformPlanAck> {
    const inFlight = this.terraform.getWorkspaceInFlight();
    if (inFlight) {
      const error =
        `terraform plan refused: ${inFlight} is already in flight; wait for it to finish ` +
        'before submitting another plan';
      logger.error('terraform plan rejected: workspace busy', { inFlight });
      return { started: false, error, conflict: inFlight };
    }

    const sender: WebContents = ctx.evt.sender;
    const runId = randomUUID();
    const ac = new AbortController();

    // Reserve the shared workspace *synchronously* — no `await` runs between
    // the `getWorkspaceInFlight()` check above and this `stream.next()` call,
    // which is the only thing that actually flips
    // `TerraformService`'s internal `workspaceInFlight` lock (its
    // check-and-set runs synchronously, before its own first `await`). That
    // closes the TOCTOU gap a previous version of this method left open by
    // only driving the generator from inside the fire-and-forget block below,
    // *after* awaiting `audit.record()`: two calls arriving back-to-back could
    // both pass the check above while the first was still awaiting its audit
    // write, so both would resolve `started: true` and both would get an
    // audit entry, even though the second necessarily fails deep inside
    // `TerraformService.plan()`. Because JS is single-threaded and there's no
    // `await` between the check and this reservation, at most one concurrent
    // `plan()` invocation can ever win it — a second invocation's own
    // `getWorkspaceInFlight()` check above is now guaranteed to observe the
    // reservation and bail out with a conflict ack before ever awaiting audit
    // or creating a generator of its own. The `.catch()` below exists solely
    // to mark `firstStep` as "handled" so Node doesn't log an
    // unhandledRejection warning while it sits unawaited during the
    // `audit.record()` call further down — the real handling of whatever it
    // settles to happens in the streaming loop below, the same way every
    // later `.next()` result already is.
    const stream = this.terraform.plan(payload.tfvarsVersionId, ac.signal, runId, payload.rolledBackFrom);
    const firstStep = stream.next();
    firstStep.catch(() => { /* handled in the streaming loop below */ });

    this.activePlans.set(runId, ac);

    const onDestroyed = () => ac.abort();
    sender.once('destroyed', onDestroyed);
    const cleanup = () => {
      this.activePlans.delete(runId);
      sender.removeListener('destroyed', onDestroyed);
    };

    // Best-effort: AuditService.record() never throws (failures are logged
    // and swallowed internally), so awaiting it here cannot block or fail
    // this now-accepted submission's ack. `game`/`before`/`after` are the
    // fixed values the `game_servers`-shaped audit schema takes for a
    // workspace-wide `plan` action that isn't scoped to a single game. By
    // this point the workspace reservation above has already succeeded, so
    // this audit entry is only ever recorded for a submission that really
    // did start a run.
    await this.audit?.record({
      action: 'plan',
      game: '',
      before: null,
      after: null,
      ...(payload.tfvarsVersionId !== undefined ? { versionId: payload.tfvarsVersionId } : {}),
    });

    // Fire-and-forget the streaming loop. Chunks are pushed back to the
    // renderer directly via WebContents.send rather than through the normal
    // invoke reply mechanism, which only supports a single return value.
    void (async () => {
      try {
        let next = await firstStep;
        while (!next.done) {
          if (sender.isDestroyed()) {
            ac.abort();
            await stream.return(undefined);
            return;
          }
          const chunkMessage: TerraformPlanChunkMessage = { runId, chunk: next.value };
          sender.send(PLAN_CHUNK_CHANNEL, chunkMessage);
          next = await stream.next();
        }
        if (!sender.isDestroyed()) {
          const message: TerraformPlanEndMessage = { runId, exitCode: 0, result: next.value };
          sender.send(PLAN_END_CHANNEL, message);
        }
      } catch (err) {
        logger.error('terraform plan error', { err });
        if (!sender.isDestroyed()) {
          const exitCode = err instanceof TerraformPlanError ? err.exitCode : null;
          const message: TerraformPlanEndMessage = { runId, exitCode, error: String(err) };
          sender.send(PLAN_END_CHANNEL, message);
        }
      } finally {
        cleanup();
      }
    })();

    return { started: true, runId };
  }

  /**
   * Kicks off `terraform apply <planFile>` for the approved plan run
   * `payload.planRunId` and streams its output back to the renderer —
   * mirrors {@link plan}'s streaming shape, but gated behind a chain of
   * pre-spawn checks that must *all* pass before `terraform` is ever spawned
   * (issue #109):
   *
   * 1. `payload` validation — `planRunId` and `planHash` must both be
   *    non-empty strings.
   * 2. A plan {@link RunRecord} for `payload.planRunId` must exist
   *    (`RunRecordService.getByRunId`) and be a `kind: 'plan'` record.
   * 3. That record must be approved (`approvedBy`/`approvedAt` both set —
   *    see {@link TerraformController.approve}) and the approval must not
   *    have expired (`isApprovalExpired(record.approvedAt)`, a fixed 15
   *    minute window — see `APPROVAL_WINDOW_MS` in `@hyveon/shared/runs.ts`).
   * 4. `payload.planHash` must match the plan record's own stored
   *    `planHash` exactly — this is what stops a forged or stale hash from
   *    ever reaching `terraform apply`: the tfvars/plan an admin reviewed
   *    and approved is exactly what gets applied. That alone only proves the
   *    two in-memory values agree with each other, so this step also
   *    re-reads the actual `.tfplan` bytes at
   *    `<runsDir>/<planRunId>/<planRunId>.tfplan` and recomputes their
   *    SHA-256 digest via `TerraformService.computePlanHash` — a fresh
   *    artifact-level hash that must *also* match `payload.planHash`. A
   *    swapped/tampered `.tfplan` file on disk (with `record.planHash` left
   *    untouched) fails this second check even though the two stored hashes
   *    still agree, and never reaches `terraform apply`.
   * 5. The shared Terraform workspace must be free
   *    (`TerraformService.getWorkspaceInFlight()`), mirroring {@link plan}'s
   *    own conflict check.
   * 6. The durable apply lock (`RunService.createRun`, issue #106) must be
   *    acquirable — if another non-terminal run already holds it, the call
   *    is rejected with a {@link RunLockHeldError}-derived message and
   *    `conflict: 'apply'` and no lock is acquired by this call (so there is
   *    nothing for it to release).
   * 7. Immediately after step 6's `await` settles, the workspace check from
   *    step 5 is repeated (`TerraformService.getWorkspaceInFlight()` again).
   *    Step 6 is itself an `await`, so a concurrent `plan`/`init` could have
   *    reserved the workspace during that gap; this re-check closes it. If
   *    the workspace is now busy, the apply lock acquired in step 6 is
   *    released (`RunService.releaseRun`) and the call is rejected with
   *    `conflict` set to the new in-flight run — mirroring step 5's ack
   *    shape — before anything externally visible (the audit entry, the
   *    streaming loop) has happened.
   *
   * Any failure in 1–7 resolves immediately with `{ started: false, error }`
   * (plus `conflict` for 5–7) — `TerraformService.apply` is never called, so
   * no `terraform apply` process is ever spawned, and no run record is
   * written for the rejected attempt.
   *
   * Once the lock is acquired, `TerraformService.apply` is invoked with the
   * plan's own `runId` (`payload.planRunId` — so the applied plan and its
   * apply run record share the same `<runsDir>/<runId>/` lineage, per
   * `TerraformService.apply`'s own TSDoc), the plan record's stored
   * `tfvarsVersionId` (so `TerraformService.apply`'s own pre-spawn
   * stale-tfvars guard re-checks it against the current S3 head version),
   * and the expected plan artifact path
   * (`<runsDir>/<planRunId>/<planRunId>.tfplan`, matching exactly what
   * `TerraformService.plan` persisted and what `TerraformService.apply`
   * itself independently re-validates before spawning).
   *
   * Once the lock is acquired and step 7's post-lock workspace re-check has
   * passed, the generator's first step is driven *synchronously* — the same
   * synchronous-first-`.next()` workspace reservation (before anything is
   * `await`ed) that {@link plan} uses, for the same TOCTOU reason described
   * at that call site: `TerraformService`'s `workspaceInFlight` check-and-set
   * runs synchronously, before its own first `await`, so driving `.next()`
   * here — rather than only from inside the fire-and-forget block below —
   * closes the gap a second concurrent call could otherwise race through
   * between this re-check and the reservation itself. The un-awaited
   * first-step promise is given a no-op `.catch()` purely so Node doesn't log an
   * unhandledRejection warning while it sits unawaited; the real handling of
   * whatever it settles to happens in the streaming loop below, the same way
   * every later `.next()` result already is. This means a pre-spawn failure
   * inside `TerraformService.apply` itself (most notably a
   * {@link StalePlanError} when the tfvars drifted since the plan was
   * generated, but also e.g. a workspace-conflict race or a missing plan
   * artifact) is *not* observed before this method resolves its ack — it
   * surfaces as a normal `{ runId, exitCode: null, error }` message on
   * {@link APPLY_END_CHANNEL} once the streaming loop's `await firstStep`
   * rejects, mirroring how any other pre-spawn failure is reported. The
   * streaming loop's own `finally` block (see below) unconditionally
   * releases the just-acquired apply lock on this path too, since
   * `TerraformService.apply` never reaches its own lock-releasing
   * `persistRunRecord` call for a run that never spawned.
   *
   * Only once that reservation has happened is a best-effort audit entry
   * (`action: 'apply'`) recorded via `AuditService.record()` for the
   * now-accepted submission — mirroring {@link plan}'s own audit-entry call —
   * and the streaming loop fired and forgotten immediately afterward; the
   * method resolves `{ started: true, runId }`
   * (`runId` again being `payload.planRunId`) well before the
   * `terraform apply` run itself settles. Each chunk
   * `TerraformService.apply` yields is forwarded, in order, to the renderer
   * via `sender.send` on {@link APPLY_CHUNK_CHANNEL} as
   * `{ runId, chunk }`; once the run settles a single terminal message is
   * sent on {@link APPLY_END_CHANNEL}: `{ runId, exitCode: 0, result }` on
   * success, or `{ runId, exitCode, error }` on failure (`exitCode` from
   * {@link TerraformApplyError} when the spawned process exited non-zero,
   * `null` for any other failure).
   *
   * Regardless of how the streaming loop ends — success,
   * {@link TerraformApplyError}, an unrelated exception, or the `WebContents`
   * being destroyed mid-run (which aborts the run via `ac.signal` and
   * finalizes the generator via `stream.return()`, mirroring {@link plan}) —
   * its `finally` block unconditionally calls `RunService.releaseRun(runId)`
   * once more. This is deliberately redundant with the release
   * `TerraformService.apply`'s own `persistRunRecord` already performs
   * internally on every path that reaches it (`RunService.releaseRun` is
   * idempotent — see its own TSDoc) — the guarantee this method provides is
   * that the lock is released on *every* exit path this method can take,
   * not just the ones `TerraformService.apply` itself accounts for.
   *
   * Creates its own `AbortController` per invocation and registers it in
   * {@link activeApplies} keyed by `runId`, the same reasoning as
   * {@link plan}.
   *
   * Reachable via the Electron IPC transport (`terraform.apply`).
   */
  @MessagePattern('terraform.apply')
  async apply(
    @Payload() payload: TerraformApplyPayload,
    ctx: { evt: IpcMainInvokeEvent },
  ): Promise<TerraformPlanAck> {
    const validationError = TerraformController.validateApplyPayload(payload);
    if (validationError) {
      logger.error('terraform apply rejected: invalid payload', { error: validationError });
      return { started: false, error: validationError };
    }

    if (!this.runRecord) {
      const error = 'terraform.apply requires a configured RunRecordService';
      logger.error('terraform apply rejected: no RunRecordService available', { planRunId: payload.planRunId });
      return { started: false, error };
    }
    if (!this.runService) {
      const error = 'terraform.apply requires a configured RunService';
      logger.error('terraform apply rejected: no RunService available', { planRunId: payload.planRunId });
      return { started: false, error };
    }
    if (!this.config) {
      const error = 'terraform.apply requires a configured ConfigService';
      logger.error('terraform apply rejected: no ConfigService available', { planRunId: payload.planRunId });
      return { started: false, error };
    }

    const record = await this.runRecord.getByRunId(payload.planRunId);
    if (!record) {
      const error = `No plan run found for planRunId "${payload.planRunId}"`;
      logger.error('terraform apply rejected: no plan run found', { planRunId: payload.planRunId });
      return { started: false, error };
    }
    if (record.kind !== 'plan') {
      const error = `Run "${payload.planRunId}" is a "${record.kind}" run, not a "plan" run, and cannot be applied`;
      logger.error('terraform apply rejected: run is not a plan run', { planRunId: payload.planRunId, kind: record.kind });
      return { started: false, error };
    }
    if (!record.approvedBy || !record.approvedAt) {
      const error = `Plan run "${payload.planRunId}" has not been approved`;
      logger.error('terraform apply rejected: plan run not approved', { planRunId: payload.planRunId });
      return { started: false, error };
    }
    if (isApprovalExpired(record.approvedAt)) {
      const error = `Approval for plan run "${payload.planRunId}" has expired; re-approve before applying`;
      logger.error('terraform apply rejected: approval expired', { planRunId: payload.planRunId, approvedAt: record.approvedAt });
      return { started: false, error };
    }
    if (!record.planHash || record.planHash !== payload.planHash) {
      const error = `Plan hash mismatch for run "${payload.planRunId}": the supplied planHash does not match the approved plan`;
      logger.error('terraform apply rejected: plan hash mismatch', { planRunId: payload.planRunId });
      return { started: false, error };
    }

    const planFile = join(this.config.getRunsDir(), payload.planRunId, `${payload.planRunId}.tfplan`);
    let artifactHash: string;
    try {
      artifactHash = this.terraform.computePlanHash(planFile);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('terraform apply rejected: failed to re-hash on-disk plan artifact', {
        planRunId: payload.planRunId,
        error,
      });
      return { started: false, error: `Failed to verify plan artifact for run "${payload.planRunId}": ${error}` };
    }
    if (artifactHash !== payload.planHash) {
      const error =
        `Plan artifact hash mismatch for run "${payload.planRunId}": the on-disk .tfplan artifact does not ` +
        'match the approved plan hash';
      logger.error('terraform apply rejected: plan artifact hash mismatch', { planRunId: payload.planRunId });
      return { started: false, error };
    }

    const inFlight = this.terraform.getWorkspaceInFlight();
    if (inFlight) {
      const error =
        `terraform apply refused: ${inFlight} is already in flight; wait for it to finish ` +
        'before submitting another apply';
      logger.error('terraform apply rejected: workspace busy', { inFlight });
      return { started: false, error, conflict: inFlight };
    }

    const initiator = TerraformController.resolveApprover();
    try {
      await this.runService.createRun('apply', initiator, payload.planRunId);
    } catch (err) {
      if (err instanceof RunLockHeldError) {
        logger.error('terraform apply rejected: apply lock already held', { planRunId: payload.planRunId, lock: err.lock });
        return { started: false, error: err.message, conflict: 'apply' };
      }
      const error = err instanceof Error ? err.message : String(err);
      logger.error('terraform apply rejected: failed to acquire apply lock', { planRunId: payload.planRunId, error });
      return { started: false, error };
    }

    // `createRun` above is the first `await` since the `getWorkspaceInFlight()`
    // check at the top of this method, so a concurrent `plan`/`init` could
    // have reserved the shared workspace during that gap. Re-check here,
    // synchronously before anything externally visible happens, and release
    // the just-acquired apply lock if the workspace is now busy — otherwise
    // this call would ack `{ started: true }`, record a spurious 'apply'
    // audit entry, and only then fail on the end channel once the streaming
    // loop's `await firstStep` rejects.
    const inFlightAfterLock = this.terraform.getWorkspaceInFlight();
    if (inFlightAfterLock) {
      await this.runService.releaseRun(payload.planRunId);
      const error =
        `terraform apply refused: ${inFlightAfterLock} is already in flight; wait for it to finish ` +
        'before submitting another apply';
      logger.error('terraform apply rejected: workspace busy after acquiring apply lock', {
        inFlight: inFlightAfterLock,
        planRunId: payload.planRunId,
      });
      return { started: false, error, conflict: inFlightAfterLock };
    }

    const runId = payload.planRunId;
    const sender: WebContents = ctx.evt.sender;
    const ac = new AbortController();

    // Reserve the shared workspace *synchronously* — mirrors plan()'s own
    // synchronous-first-`.next()` reservation (see the inline comment on
    // that call site for why the ordering matters): no `await` runs between
    // the `getWorkspaceInFlight()` re-check immediately above and this
    // `stream.next()` call, which is the only thing that actually flips
    // `TerraformService`'s internal `workspaceInFlight` lock. The `.catch()`
    // below exists solely to mark `firstStep` as "handled" so Node doesn't
    // log an unhandledRejection warning while it sits unawaited; the real
    // handling of whatever it settles to happens in the streaming loop
    // below, the same way every later `.next()` result already is. A
    // pre-spawn failure (e.g. a StalePlanError from TerraformService.apply's
    // own re-check, an invalid runId/planFile, or a workspace-conflict race)
    // therefore surfaces as a normal end-message error on
    // `terraform.apply.end` once the streaming loop awaits `firstStep`,
    // rather than as a synchronous ack rejection.
    const stream = this.terraform.apply(runId, record.tfvarsVersionId, planFile, ac.signal);
    const firstStep = stream.next();
    firstStep.catch(() => { /* handled in the streaming loop below */ });

    this.activeApplies.set(runId, ac);

    const onDestroyed = () => ac.abort();
    sender.once('destroyed', onDestroyed);
    const cleanup = () => {
      this.activeApplies.delete(runId);
      sender.removeListener('destroyed', onDestroyed);
    };

    // Best-effort: AuditService.record() never throws (failures are logged
    // and swallowed internally), so awaiting it here cannot block or fail
    // this now-accepted submission's ack. `game`/`before`/`after` are the
    // fixed values the `game_servers`-shaped audit schema takes for a
    // workspace-wide `apply` action that isn't scoped to a single game. By
    // this point the workspace reservation above has already succeeded, so
    // this audit entry is only ever recorded for a submission that really
    // did start a run — mirrors plan()'s own audit-entry call.
    await this.audit?.record({
      action: 'apply',
      game: '',
      before: null,
      after: null,
      ...(record.tfvarsVersionId !== undefined ? { versionId: record.tfvarsVersionId } : {}),
    });

    // Fire-and-forget the streaming loop, mirroring plan()'s shape.
    void (async () => {
      try {
        let next = await firstStep;
        while (!next.done) {
          if (sender.isDestroyed()) {
            ac.abort();
            await stream.return(undefined);
            return;
          }
          const chunkMessage: TerraformApplyChunkMessage = { runId, chunk: next.value };
          sender.send(APPLY_CHUNK_CHANNEL, chunkMessage);
          next = await stream.next();
        }
        if (!sender.isDestroyed()) {
          const message: TerraformApplyEndMessage = { runId, exitCode: 0, result: next.value };
          sender.send(APPLY_END_CHANNEL, message);
        }
      } catch (err) {
        logger.error('terraform apply error', { err });
        if (!sender.isDestroyed()) {
          const exitCode = err instanceof TerraformApplyError ? err.exitCode : null;
          const message: TerraformApplyEndMessage = { runId, exitCode, error: String(err) };
          sender.send(APPLY_END_CHANNEL, message);
        }
      } finally {
        cleanup();
        // Redundant with (but a safety net alongside) the release
        // TerraformService.apply's own persistRunRecord already performs
        // internally on every path that reaches it — releaseRun is
        // idempotent, so this unconditionally guarantees the lock is
        // released on every exit path this method can take.
        await this.runService?.releaseRun(runId);
      }
    })();

    return { started: true, runId };
  }

  /**
   * Returns the current Terraform outputs by delegating to
   * `TerraformService.output`. Unlike {@link init}, this channel needs no
   * manual bridging — it resolves a single value rather than streaming
   * progress, so the generic `ipcMain.handle` bridge in
   * `../ipc-main-bridge.ts` wires `ipcRenderer.invoke('terraform.output', ...)`
   * to this handler automatically (it isn't listed in
   * `SELF_BRIDGED_PATTERNS`).
   *
   * `payload.force` defaults to `false` when the payload is omitted or
   * `force` isn't set, matching `TerraformService.output`'s own default —
   * pass `force: true` to bypass its in-memory cache and re-spawn
   * `terraform output -json` regardless of how recently the last call
   * resolved. Any error `TerraformService.output` throws (e.g.
   * `TerraformNotFoundError`, a non-zero `terraform output` exit) propagates
   * to the caller unchanged, causing `ipcRenderer.invoke` to reject.
   *
   * Reachable via the Electron IPC transport (`terraform.output`).
   */
  @MessagePattern('terraform.output')
  async output(@Payload() payload: TerraformOutputPayload = {}): Promise<TfOutputs | null> {
    return this.terraform.output(payload?.force ?? false);
  }

  /**
   * Approves a successful `plan` run for a later apply, delegating the
   * actual write to `RunRecordService.approveRun` (see issue #109).
   *
   * Validates `payload` first: `planRunId` must be a non-empty string. If
   * validation fails, neither `RunRecordService.approveRun` nor
   * `AuditService.record` is ever called and the method resolves immediately
   * with `{ approved: false, error }`.
   *
   * The approver identity is never taken from the client — it's resolved
   * server-side via {@link resolveApprover} (the local OS username), so an
   * IPC caller can't spoof who approved a run. `RunRecordService.approveRun`
   * is then awaited directly (unlike {@link init}/{@link plan}, there is no
   * streaming output to bridge — this resolves a single value):
   *
   * - On success, a best-effort `AuditService.record()` entry (action
   *   `'approve'`) is recorded — mirroring {@link plan}'s audit shape, this
   *   never throws and never blocks/fails the response — and the method
   *   resolves `{ approved: true, approvedBy, approvedAt }` with the values
   *   `RunRecordService.approveRun` stamped onto the persisted `RunRecord`.
   * - On failure (the run-history table isn't configured, no record exists
   *   for `planRunId`, the record isn't a `plan` run, or the record's status
   *   isn't `success`), the thrown error's `message` — one of
   *   `RunRecordTableNotConfiguredError` / `RunRecordNotFoundError` /
   *   `RunRecordNotPlanError` / `RunRecordNotSuccessfulError`, each already
   *   descriptive — is surfaced as `{ approved: false, error }`. Nothing is
   *   written in this case: `RunRecordService.approveRun` only calls
   *   `store.putRecord` after all of its validation has passed, and no audit
   *   entry is recorded for a rejected approval.
   *
   * Reachable via the Electron IPC transport (`terraform.approve`), bridged
   * automatically by the generic `ipcMain.handle` bridge in
   * `../ipc-main-bridge.ts` since (unlike `terraform.init`/`terraform.plan`)
   * it resolves a single value rather than streaming progress.
   */
  @MessagePattern('terraform.approve')
  async approve(@Payload() payload: TerraformApprovePayload): Promise<TerraformApproveAck> {
    const validationError = TerraformController.validateApprovePayload(payload);
    if (validationError) {
      logger.error('terraform approve rejected: invalid payload', { error: validationError });
      return { approved: false, error: validationError };
    }

    if (!this.runRecord) {
      const error = 'terraform.approve requires a configured RunRecordService';
      logger.error('terraform approve rejected: no RunRecordService available', { planRunId: payload.planRunId });
      return { approved: false, error };
    }

    try {
      const approvedBy = TerraformController.resolveApprover();
      const record = await this.runRecord.approveRun(payload.planRunId, approvedBy);

      // Best-effort: AuditService.record() never throws (failures are logged
      // and swallowed internally), mirroring the audit entry recorded by
      // plan() for its own accepted submissions.
      await this.audit?.record({
        action: 'approve',
        game: '',
        before: null,
        after: null,
      });

      return { approved: true, approvedBy: record.approvedBy, approvedAt: record.approvedAt };
    } catch (err) {
      logger.error('terraform approve error', { err, planRunId: payload.planRunId });
      const error = err instanceof Error ? err.message : String(err);
      return { approved: false, error };
    }
  }

  /**
   * Previews the rollback flow's (#112) target tfvars version for
   * `payload.applyRunId`, without writing anything — delegates to
   * `TerraformService.resolveRollbackTarget`. Called when the operator clicks
   * "Rollback" on an apply row in history, so the confirmation dialog can
   * name the version it would restore before the operator commits to it.
   *
   * Reachable via the Electron IPC transport (`terraform.rollback.resolve`),
   * bridged automatically by the generic `ipcMain.handle` bridge since it
   * resolves a single value rather than streaming progress.
   */
  @MessagePattern('terraform.rollback.resolve')
  async resolveRollback(@Payload() payload: TerraformRollbackPayload): Promise<TerraformRollbackResolveAck> {
    const validationError = TerraformController.validateRollbackPayload(payload);
    if (validationError) {
      logger.error('terraform rollback resolve rejected: invalid payload', { error: validationError });
      return { resolved: false, error: validationError };
    }

    try {
      const target = await this.terraform.resolveRollbackTarget(payload.applyRunId);
      return { resolved: true, versionId: target.versionId, lastModified: target.lastModified.toISOString() };
    } catch (err) {
      logger.error('terraform rollback resolve error', { err, applyRunId: payload.applyRunId });
      const error = err instanceof Error ? err.message : String(err);
      return { resolved: false, error };
    }
  }

  /**
   * Confirms the rollback flow (#112) for `payload.applyRunId`: restores the
   * previewed historic tfvars version as a new head version — delegates to
   * `TerraformService.confirmRollback`, which re-resolves the target so an
   * expiry between preview and confirm is still caught before anything is
   * written. The renderer follows a successful ack with an ordinary
   * `terraform.plan` call passing the returned `versionId` as
   * `tfvarsVersionId` and `payload.applyRunId` as `rolledBackFrom`, so the
   * rollback plan streams and gates through the exact same channel every
   * other plan does.
   *
   * Reachable via the Electron IPC transport (`terraform.rollback.confirm`),
   * bridged automatically by the generic `ipcMain.handle` bridge since it
   * resolves a single value rather than streaming progress.
   */
  @MessagePattern('terraform.rollback.confirm')
  async confirmRollback(@Payload() payload: TerraformRollbackPayload): Promise<TerraformRollbackConfirmAck> {
    const validationError = TerraformController.validateRollbackPayload(payload);
    if (validationError) {
      logger.error('terraform rollback confirm rejected: invalid payload', { error: validationError });
      return { confirmed: false, error: validationError };
    }

    try {
      const result = await this.terraform.confirmRollback(payload.applyRunId);

      // Best-effort: AuditService.record() never throws (failures are
      // logged and swallowed internally), mirroring the audit entry
      // recorded by plan()/apply()/approve() for their own accepted
      // submissions — restoring a version as a new head is the most
      // consequential of these writes, so it shouldn't be the one exempt
      // from the audit trail.
      await this.audit?.record({
        action: 'rollback',
        game: '',
        before: null,
        after: null,
        versionId: result.versionId,
      });

      return { confirmed: true, versionId: result.versionId };
    } catch (err) {
      logger.error('terraform rollback confirm error', { err, applyRunId: payload.applyRunId });
      const error = err instanceof Error ? err.message : String(err);
      return { confirmed: false, error };
    }
  }

  /**
   * Resolves the identity of the local operator approving a plan run, as the
   * OS username reported by `node:os`'s `userInfo()`. Wrapped in its own
   * method (rather than calling `os.userInfo().username` inline in
   * {@link approve}) so it's a single, stubbable seam for tests — and so the
   * approver identity is always derived server-side, never trusted from a
   * client-supplied field.
   */
  private static resolveApprover(): string {
    return os.userInfo().username;
  }

  /**
   * Validates that `config.bucket`, `config.region`, and
   * `config.dynamodbTable` are all non-empty strings. Returns a descriptive
   * error message when validation fails, or `null` when `config` is valid.
   */
  private static validateConfig(config: TerraformInitConfig): string | null {
    const isNonEmptyString = (value: unknown): value is string =>
      typeof value === 'string' && value.length > 0;

    if (
      !isNonEmptyString(config?.bucket) ||
      !isNonEmptyString(config?.region) ||
      !isNonEmptyString(config?.dynamodbTable)
    ) {
      return 'terraform.init requires non-empty bucket, region, and dynamodbTable strings';
    }
    return null;
  }

  /**
   * Validates that `payload.planRunId` is a non-empty string. Returns a
   * descriptive error message when validation fails, or `null` when
   * `payload` is valid.
   */
  private static validateApprovePayload(payload: TerraformApprovePayload): string | null {
    const isNonEmptyString = (value: unknown): value is string =>
      typeof value === 'string' && value.length > 0;

    if (!isNonEmptyString(payload?.planRunId)) {
      return 'terraform.approve requires a non-empty planRunId string';
    }
    return null;
  }

  /**
   * Validates that `payload.applyRunId` is a non-empty string. Returns a
   * descriptive error message when validation fails, or `null` when
   * `payload` is valid. Shared by {@link resolveRollback} and
   * {@link confirmRollback} — both key off the same field.
   */
  private static validateRollbackPayload(payload: TerraformRollbackPayload): string | null {
    const isNonEmptyString = (value: unknown): value is string =>
      typeof value === 'string' && value.length > 0;

    if (!isNonEmptyString(payload?.applyRunId)) {
      return 'terraform.rollback requires a non-empty applyRunId string';
    }
    return null;
  }

  /**
   * Validates that `payload.planRunId` and `payload.planHash` are both
   * non-empty strings. Returns a descriptive error message when validation
   * fails, or `null` when `payload` is valid.
   */
  private static validateApplyPayload(payload: TerraformApplyPayload): string | null {
    const isNonEmptyString = (value: unknown): value is string =>
      typeof value === 'string' && value.length > 0;

    if (!isNonEmptyString(payload?.planRunId) || !isNonEmptyString(payload?.planHash)) {
      return 'terraform.apply requires non-empty planRunId and planHash strings';
    }
    return null;
  }
}
