import { Controller, OnModuleInit } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { TerraformService, TerraformInitError, type TerraformInitConfig } from '../services/TerraformService.js';
import { logger } from '../logger.js';

/** Fixed side-channel `TerraformController.init` pushes streamed output on. */
const CHUNK_CHANNEL = 'terraform.init.chunk';

/** Fixed side-channel `TerraformController.init` sends its terminal message on. */
const END_CHANNEL = 'terraform.init.end';

/**
 * Message payload sent once on {@link END_CHANNEL} when a `terraform.init`
 * run finishes. `exitCode` is `0` on success. On failure it carries whatever
 * exit code the spawned process reported (or `null` when the run failed
 * before/without an exit code, e.g. the binary couldn't be resolved or a
 * second `init` was already in flight), plus a stringified `error`.
 */
interface TerraformInitEndMessage {
  exitCode: number | null;
  error?: string;
}

/**
 * Immediate acknowledgement `init()` resolves with. `started: true` means the
 * streaming loop was kicked off in the background (chunk/end messages will
 * follow on the side channels). `started: false` means `config` failed
 * validation and no `TerraformService.init` run was attempted — `error`
 * describes why.
 */
interface TerraformInitAck {
  started: boolean;
  error?: string;
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
   * Otherwise the streaming loop is fired and forgotten (mirroring
   * `LogsController.streamLogs`'s `void (async () => { ... })()` pattern) and
   * the method resolves immediately with `{ started: true }`, well before the
   * `terraform init` run itself settles. Each chunk `TerraformService.init`
   * yields is forwarded, in order, to the renderer via `sender.send` on
   * {@link CHUNK_CHANNEL}. Once the run settles a single terminal message is
   * sent on {@link END_CHANNEL}: `{ exitCode: 0 }` on success, or
   * `{ exitCode, error }` on failure — `exitCode` comes from
   * {@link TerraformInitError} when the spawned process exited non-zero, and
   * is `null` for any other failure (binary not found, a second `init`
   * already in flight, a spawn error, etc).
   *
   * Creates its own `AbortController` per invocation (the same reasoning as
   * `LogsController.streamLogs`: `ElectronIPCTransport` passes `{ evt }` as
   * the execution context, so there's no `signal` injected by the transport)
   * and passes its `signal` through to `TerraformService.init` so a future
   * cancel channel (or WebContents-destroyed cleanup) has something to abort
   * against.
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
    const ac = new AbortController();

    // Fire-and-forget the streaming loop. Chunks are pushed back to the
    // renderer directly via WebContents.send rather than through the normal
    // invoke reply mechanism, which only supports a single return value.
    void (async () => {
      try {
        for await (const chunk of this.terraform.init(config, ac.signal)) {
          if (sender.isDestroyed()) { ac.abort(); return; }
          sender.send(CHUNK_CHANNEL, chunk);
        }
        if (!sender.isDestroyed()) {
          const message: TerraformInitEndMessage = { exitCode: 0 };
          sender.send(END_CHANNEL, message);
        }
      } catch (err) {
        logger.error('terraform init error', { err });
        if (!sender.isDestroyed()) {
          const exitCode = err instanceof TerraformInitError ? err.exitCode : null;
          const message: TerraformInitEndMessage = { exitCode, error: String(err) };
          sender.send(END_CHANNEL, message);
        }
      }
    })();

    return { started: true };
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
