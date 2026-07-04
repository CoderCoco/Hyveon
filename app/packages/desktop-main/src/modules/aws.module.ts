import { Module } from '@nestjs/common';
import { AwsCloudProvider, AwsSecretsStore } from '@hyveon/cloud-aws';
import { ConfigService } from '../services/ConfigService.js';
import { Ec2Service } from '../services/Ec2Service.js';
import { EcsService, createAwsCloudProvider } from '../services/EcsService.js';
import { LogsService } from '../services/LogsService.js';
import { CostService } from '../services/CostService.js';
import { FileManagerService } from '../services/FileManagerService.js';

/**
 * Feature module grouping every AWS-facing service (ECS, EC2, CloudWatch
 * Logs, Cost Explorer, the FileBrowser task helper) plus the `ConfigService`
 * they all depend on. Imported by `AppModule` so controllers get these via
 * Nest's DI without wiring each provider individually.
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
  providers: [
    ConfigService,
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
    ConfigService,
    Ec2Service,
    EcsService,
    LogsService,
    CostService,
    FileManagerService,
    AwsSecretsStore,
  ],
})
export class AwsModule {}
