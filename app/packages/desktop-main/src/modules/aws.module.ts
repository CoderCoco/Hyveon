import { Module } from '@nestjs/common';
import { AwsCloudProvider, AwsSecretsStore } from '@hyveon/cloud-aws';
import { ConfigModule } from './config.module.js';
import { CloudProviderModule } from './cloud-provider.module.js';
import { ConfigService } from '../services/ConfigService.js';
import { Ec2Service } from '../services/Ec2Service.js';
import { EcsService, createAwsCloudProvider } from '../services/EcsService.js';
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
 * be available. `CloudProviderModule` is imported alongside it (additive —
 * this module's own AWS-concrete providers below are unchanged) so the
 * cloud-agnostic tokens it exports are reachable through the same import
 * chain as the app migrates callers off the concrete Aws classes.
 *
 * `AwsCloudProvider` (from `@hyveon/cloud-aws`) is registered here via a
 * `useFactory` provider so `EcsService` gets it through constructor
 * injection rather than constructing its own — `createAwsCloudProvider`
 * (shared with `EcsService`'s constructor default) wires it to the same
 * `ConfigService` the rest of the module shares, and the app's Winston
 * `logger` so ListTasks/DescribeTasks/DescribeNetworkInterfaces failures
 * swallowed inside `AwsCloudProvider` still land in the log files instead of
 * silently masquerading as "stopped" / "no IP".
 *
 * `AwsSecretsStore` (also from `@hyveon/cloud-aws`) is registered the same
 * way so `DiscordConfigService` (in `DiscordModule`, which imports this
 * module) gets a Secrets-Manager-backed `SecretsStore` via constructor
 * injection instead of importing the module-level `@hyveon/shared` secrets
 * helpers directly.
 */
@Module({
  imports: [ConfigModule, CloudProviderModule],
  providers: [
    Ec2Service,
    {
      provide: AwsCloudProvider,
      useFactory: createAwsCloudProvider,
      inject: [ConfigService],
    },
    {
      provide: AwsSecretsStore,
      useFactory: (config: ConfigService) => new AwsSecretsStore(() => config.getRegion()),
      inject: [ConfigService],
    },
    EcsService,
    LogsService,
    CostService,
    FileManagerService,
  ],
  exports: [
    ConfigModule,
    CloudProviderModule,
    Ec2Service,
    EcsService,
    LogsService,
    CostService,
    FileManagerService,
    AwsSecretsStore,
  ],
})
export class AwsModule {}
