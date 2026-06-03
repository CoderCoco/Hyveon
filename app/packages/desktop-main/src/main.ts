import 'reflect-metadata';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions } from '@nestjs/microservices';
import { ElectronIPCTransport } from 'nestjs-electron-ipc-transport';
import { AppModule } from './app.module.js';
import { applyFixPath } from './fix-path-bootstrap.js';
import { createLogger } from './logger.js';

applyFixPath();

// ElectronIPCTransport requires ipcMain, which is only available inside an
// Electron main process. Fail fast with a readable message rather than a
// cryptic module-resolution error when someone runs `node dist/main.js`.
// This guard must run before any Electron API calls (e.g. app.getPath).
if (!process.versions['electron']) {
  throw new Error(
    'desktop-main must run inside an Electron main process. ' +
      'Launch via Electron — running with plain Node is not supported.',
  );
}

const { app } = await import('electron') as unknown as { app: { getPath(name: string): string } };
createLogger(path.join(app.getPath('userData'), 'logs'));

/**
 * Bootstraps the NestJS IPC microservice.
 *
 * Called from `electron-entry.ts` after `app.whenReady()` so that
 * `ipcMain` is available before the transport is initialised.
 */
export async function bootstrap(): Promise<void> {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    strategy: new ElectronIPCTransport(),
  });

  await app.listen();
}
