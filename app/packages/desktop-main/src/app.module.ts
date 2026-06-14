import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'module';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AwsModule } from './modules/aws.module.js';
import { DiscordModule } from './modules/discord.module.js';
import { GamesController } from './controllers/games.controller.js';
import { GamesHttpController } from './controllers/games-http.controller.js';
import { ConfigController } from './controllers/config.controller.js';
import { ConfigHttpController } from './controllers/config-http.controller.js';
import { CostsController } from './controllers/costs.controller.js';
import { CostsHttpController } from './controllers/costs-http.controller.js';
import { LogsController } from './controllers/logs.controller.js';
import { FilesController } from './controllers/files.controller.js';
import { FilesHttpController } from './controllers/files-http.controller.js';
import { DiscordController } from './controllers/discord.controller.js';
import { DiscordHttpController } from './controllers/discord-http.controller.js';
import { EnvController } from './controllers/env.controller.js';
import { EnvHttpController } from './controllers/env-http.controller.js';
import { DiagnosticsController } from './controllers/diagnostics.controller.js';
import { DiagnosticsHttpController } from './controllers/diagnostics-http.controller.js';
import { ApiTokenGuard } from './guards/api-token.guard.js';
import { DiagnosticsService, DIAGNOSTICS_LOG_DIR } from './services/DiagnosticsService.js';
import { SafeStorageService } from './services/SafeStorageService.js';
import { ElectronStoreService } from './services/ElectronStoreService.js';

/**
 * Root Nest module. Wires the feature modules (`AwsModule`, `DiscordModule`) to
 * the IPC controllers.
 *
 * `ApiTokenGuard` is registered as a global guard so every HTTP route requires
 * a bearer token. The guard is context-aware and passes through IPC (non-HTTP)
 * calls without token enforcement.
 */
@Module({
  imports: [AwsModule, DiscordModule],
  controllers: [
    GamesController,
    GamesHttpController,
    ConfigController,
    ConfigHttpController,
    CostsController,
    CostsHttpController,
    LogsController,
    FilesController,
    FilesHttpController,
    DiscordController,
    DiscordHttpController,
    EnvController,
    EnvHttpController,
    DiagnosticsController,
    DiagnosticsHttpController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ApiTokenGuard },
    {
      provide: DIAGNOSTICS_LOG_DIR,
      useFactory: () => {
        if (!process.versions['electron']) {
          return process.env['DIAGNOSTICS_LOG_DIR'] ?? os.tmpdir();
        }
        const _require = createRequire(import.meta.url);
        const { app } = _require('electron') as { app: { getPath(name: string): string } };
        return path.join(app.getPath('userData'), 'logs');
      },
    },
    DiagnosticsService,
    SafeStorageService,
    ElectronStoreService,
  ],
})
export class AppModule {}
