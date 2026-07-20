import type { MessageHandler } from '@nestjs/microservices';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { ElectronIPCTransport } from 'nestjs-electron-ipc-transport';

/**
 * IPC channels that manage their own `ipcMain.handle` registration and must
 * be skipped by the generic bridge to avoid a double registration.
 *
 * - `logs.stream`: `LogsController.onModuleInit` bridges it manually because
 *   the handler needs to push follow-up chunk/end messages over side channels
 *   derived from a `streamId` it mints itself — see
 *   `app/packages/desktop-main/src/controllers/logs.controller.ts`.
 * - `terraform.init`: bridged manually by its own controller because the
 *   handler streams progress events over a side channel for the duration of
 *   a long-running `terraform init` invocation, the same self-bridging
 *   pattern `logs.stream` uses.
 * - `terraform.plan`: bridged manually by the same controller for the same
 *   reason as `terraform.init` — it streams `terraform plan` progress over a
 *   side channel for the duration of a long-running run.
 */
export const SELF_BRIDGED_PATTERNS: ReadonlySet<string> = new Set([
  'logs.stream',
  'terraform.init',
  'terraform.plan',
]);

/**
 * `ElectronIPCTransport` (from `nestjs-electron-ipc-transport`) only exposes
 * its registered `@MessagePattern` handlers via the `messageHandlers` map it
 * inherits from `@nestjs/microservices`'s abstract `Server` class, and that
 * field is `protected`. Rather than reaching into it with an
 * `as unknown as` cast at every call site, this subclass exposes a single
 * public, typed accessor so callers (and this module's own
 * {@link registerIpcMainBridges} helper) can read the map through the normal
 * type system.
 */
export class BridgedElectronIPCTransport extends ElectronIPCTransport {
  /** Public, typed view of the protected `messageHandlers` map inherited from `Server`. */
  public get messagePatternHandlers(): Map<string, MessageHandler> {
    return this.messageHandlers;
  }
}

/**
 * Bridges every NestJS `@MessagePattern` handler registered on `transport`
 * (except those in {@link SELF_BRIDGED_PATTERNS}) onto a matching
 * `ipcMain.handle` registration, so `ipcRenderer.invoke(channel, payload)`
 * calls made from the preload actually resolve.
 *
 * `ElectronIPCTransport.listen()` (from `nestjs-electron-ipc-transport`) only
 * subscribes to its own internal `ipcMessageDispatcher` — it never calls
 * `ipcMain.handle` itself. Without this bridge, every `@MessagePattern`
 * channel other than `logs.stream` (which bridges itself, see
 * {@link SELF_BRIDGED_PATTERNS}) hangs forever when invoked from the
 * renderer, because `ipcRenderer.invoke` requires a matching
 * `ipcMain.handle` registration in the main process (see #277).
 *
 * For each bridged pattern, any existing handler is removed first via
 * `ipcMain.removeHandler` so hot-reload re-registration does not throw
 * "Attempted to register a second handler for '<channel>'", mirroring the
 * approach `LogsController.onModuleInit` already takes for `logs.stream`.
 * The registered `ipcMain.handle` callback invokes the NestJS handler as
 * `handler(payload, { evt })`, matching the `{ evt }` context shape
 * `ElectronIPCTransport.onMessage` passes today so controller method
 * signatures do not need to change.
 *
 * Silent no-op outside a real Electron main process
 * (`process.versions.electron` undefined) — matching the guard
 * `LogsController.onModuleInit` uses — so the plain-Node integration test
 * harness, Docker builds, and CI never attempt to import `electron`.
 */
export async function registerIpcMainBridges(transport: BridgedElectronIPCTransport): Promise<void> {
  if (!process.versions.electron) {
    // Not running inside the Electron main process — bridge skipped.
    return;
  }

  const { ipcMain } = (await import('electron')) as unknown as { ipcMain: IpcMain };

  for (const [pattern, handler] of transport.messagePatternHandlers) {
    if (SELF_BRIDGED_PATTERNS.has(pattern)) {
      continue;
    }

    ipcMain.removeHandler(pattern);
    ipcMain.handle(pattern, (evt: IpcMainInvokeEvent, payload: unknown) =>
      handler(payload, { evt }),
    );
  }
}
