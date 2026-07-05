import { Module } from '@nestjs/common';
import { ConfigModule } from './config.module.js';
import { CloudProviderModule } from './cloud-provider.module.js';
import { Ec2Service } from '../services/Ec2Service.js';
import { EcsService } from '../services/EcsService.js';
import { LogsService } from '../services/LogsService.js';
import { CostService } from '../services/CostService.js';
import { FileManagerService } from '../services/FileManagerService.js';

/**
 * Feature module grouping every AWS-facing service (ECS, EC2, CloudWatch
 * Logs, Cost Explorer, the FileBrowser task helper). Imported by `AppModule`
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
 */
@Module({
  imports: [ConfigModule, CloudProviderModule],
  providers: [Ec2Service, EcsService, LogsService, CostService, FileManagerService],
  exports: [
    ConfigModule,
    CloudProviderModule,
    Ec2Service,
    EcsService,
    LogsService,
    CostService,
    FileManagerService,
  ],
})
export class AwsModule {}
