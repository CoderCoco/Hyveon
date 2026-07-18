import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'module';
import { Module } from '@nestjs/common';
import { AwsModule } from './modules/aws.module.js';
import { DiscordModule } from './modules/discord.module.js';
import { TfvarsModule } from './modules/tfvars.module.js';
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
import { DriftController } from './controllers/drift.controller.js';
import { DriftHttpController } from './controllers/drift-http.controller.js';
import { AuditController } from './controllers/audit.controller.js';
import { AuditHttpController } from './controllers/audit-http.controller.js';
import { DiagnosticsService, DIAGNOSTICS_LOG_DIR } from './services/DiagnosticsService.js';
import { DriftService } from './services/DriftService.js';
import { GamesWriteService } from './services/GamesWriteService.js';
import { SafeStorageService } from './services/SafeStorageService.js';
import { ElectronStoreService } from './services/ElectronStoreService.js';
import { AuditService } from './services/AuditService.js';

/**
 * Root Nest module. Wires the feature modules (`AwsModule`, `DiscordModule`,
 * `TfvarsModule`) to the IPC controllers.
 */
@Module({
  imports: [AwsModule, DiscordModule, TfvarsModule],
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
    DriftController,
    DriftHttpController,
    AuditController,
    AuditHttpController,
  ],
  providers: [
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
    DriftService,
    GamesWriteService,
    SafeStorageService,
    ElectronStoreService,
    AuditService,
  ],
})
export class AppModule {}
