import { Module } from '@nestjs/common';
import { ConfigModule } from './config.module.js';
import { CloudProviderModule } from './cloud-provider.module.js';
import { ElectronStoreModule } from './electron-store.module.js';
import { Ec2Service } from '../services/Ec2Service.js';
import { EcsService } from '../services/EcsService.js';
import { LogsService } from '../services/LogsService.js';
import { CostService } from '../services/CostService.js';
import { FileManagerService } from '../services/FileManagerService.js';
import { SchedulerService } from '../services/SchedulerService.js';

/**
 * Feature module grouping every AWS-facing service (ECS, EC2, CloudWatch
 * Logs, EventBridge Scheduler, the FileBrowser task helper).
 * Imported by `AppModule`
 * so controllers get these via Nest's DI without wiring each provider
 * individually.
 *
 * `ConfigService` is sourced from `ConfigModule` (imported and re-exported
 * here) rather than provided directly, so there is exactly one `ConfigModule`
 * instance backing every feature module — this module no longer owns
 * `ConfigService`'s lifecycle, it just re-exports it for existing consumers
 * (e.g. `DiscordModule`) that import `AwsModule` expecting `ConfigService` to
 * be available. `CloudProviderModule` is imported alongside it so the
 * cloud-agnostic tokens it exports (`CLOUD_PROVIDER`, `SECRETS_STORE`, etc.)
 * are reachable through the same import chain.
 *
 * The concrete `AwsCloudProvider` / `AwsSecretsStore` providers that used to
 * live here have been removed: `EcsService` now injects `CLOUD_PROVIDER` and
 * `DiscordConfigService` now injects `SECRETS_STORE`, both bound by
 * `CloudProviderModule` to their AWS implementations via `useFactory`. This
 * module only re-exports `CloudProviderModule` for callers that need those
 * tokens.
 *
 * Also imports `ElectronStoreModule` directly (not re-exported by
 * `ConfigModule`/`CloudProviderModule`) so `Ec2Service`/`EcsService` can
 * inject `ElectronStoreService` to resolve AWS credentials for their own
 * raw `EC2Client`/`ECSClient` — see `resolveAwsClientCredentials`.
 */
@Module({
  imports: [ConfigModule, CloudProviderModule, ElectronStoreModule],
  providers: [Ec2Service, EcsService, LogsService, CostService, SchedulerService, FileManagerService],
  exports: [
    ConfigModule,
    CloudProviderModule,
    Ec2Service,
    EcsService,
    LogsService,
    CostService,
    SchedulerService,
    FileManagerService,
  ],
})
export class AwsModule {}
