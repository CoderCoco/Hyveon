import { randomUUID } from 'node:crypto';
import { Controller, OnModuleInit } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import {
  TerraformService,
  TerraformInitError,
  type TerraformInitConfig,
  type TerraformRunChunk,
} from '../services/TerraformService.js';
import type { TfOutputs } from '../services/ConfigService.js';
import { logger } from '../logger.js';

/** Fixed side-channel `TerraformController.init` pushes streamed output on. */
const CHUNK_CHANNEL = 'terraform.init.chunk';

/** Fixed side-channel `TerraformController.init` sends its terminal message on. */
const END_CHANNEL = 'terraform.init.end';

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
 * IPC-only Terraform controller. Handles Electron main-process messages via
 * `@MessagePattern` — no HTTP routes are registered here.
 *
 * Bridges {@link TerraformService.init}'s async-generator output onto the
 * fixed `terraform.init.chunk` / `terraform.init.end` side channels so the
 * renderer's first-run wizard can render `terraform init` output live.
 */
@Controller()
export class TerraformController implements OnModuleInit {
  constructor(private readonly terraform: TerraformService) {}

  /**
   * Per-call `AbortController`s keyed by the `streamId` minted in
   * {@link init}. Lets a future `terraform.init.cancel` channel reach the
   * right in-flight run, and lets the `WebContents` `'destroyed'` listener in
   * {@link init} abort immediately without racing the chunk loop's own
   * `isDestroyed()` check.
   */
  private readonly activeInits = new Map<string, AbortController>();

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
