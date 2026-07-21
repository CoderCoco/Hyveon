import { randomUUID } from 'node:crypto';
import { Controller, OnModuleInit } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import {
  TerraformService,
  TerraformInitError,
  TerraformPlanError,
  type TerraformInitConfig,
  type TerraformRunChunk,
  type TerraformPlanResult,
} from '../services/TerraformService.js';
import type { TfOutputs } from '../services/ConfigService.js';
import { AuditService } from '../services/AuditService.js';
import { logger } from '../logger.js';

/** Fixed side-channel `TerraformController.init` pushes streamed output on. */
const CHUNK_CHANNEL = 'terraform.init.chunk';

/** Fixed side-channel `TerraformController.init` sends its terminal message on. */
const END_CHANNEL = 'terraform.init.end';

/** Fixed side-channel `TerraformController.plan` pushes streamed output on. */
const PLAN_CHUNK_CHANNEL = 'terraform.plan.chunk';

/** Fixed side-channel `TerraformController.plan` sends its terminal message on. */
const PLAN_END_CHANNEL = 'terraform.plan.end';

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
 * head version of the tfvars object.
 */
interface TerraformPlanPayload {
  tfvarsVersionId?: string;
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
 * IPC-only Terraform controller. Handles Electron main-process messages via
 * `@MessagePattern` — no HTTP routes are registered here.
 *
 * Bridges {@link TerraformService.init}'s async-generator output onto the
 * fixed `terraform.init.chunk` / `terraform.init.end` side channels so the
 * renderer's first-run wizard can render `terraform init` output live.
 * {@link plan} mirrors the same bridging shape for `terraform plan`, plus a
 * pre-flight `TerraformService.getWorkspaceInFlight()` conflict check and a
 * persisted `AuditService.record()` entry for every accepted submission.
 */
@Controller()
export class TerraformController implements OnModuleInit {
  /**
   * `audit` is typed optional (`?`) purely so existing test call sites that
   * construct `new TerraformController(terraform)` directly (bypassing Nest's
   * DI container) keep compiling without also stubbing it — every real
   * bootstrap through `AppModule` still resolves a concrete `AuditService`
   * instance regardless of this TS-level optionality.
   */
  constructor(
    private readonly terraform: TerraformService,
    private readonly audit?: AuditService,
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
    const stream = this.terraform.plan(payload.tfvarsVersionId, ac.signal, runId);
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
}
