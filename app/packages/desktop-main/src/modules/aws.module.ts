import { Module } from '@nestjs/common';
import { AwsCloudProvider } from '@hyveon/cloud-aws';
import { ConfigService } from '../services/ConfigService.js';
import { Ec2Service } from '../services/Ec2Service.js';
import { EcsService, buildProviderConfig } from '../services/EcsService.js';
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
 * injection rather than constructing its own — `buildProviderConfig` wires
 * it to the same `ConfigService` the rest of the module shares.
 */
@Module({
  providers: [
    ConfigService,
    Ec2Service,
    {
      provide: AwsCloudProvider,
      useFactory: (config: ConfigService) => new AwsCloudProvider(() => buildProviderConfig(config)),
      inject: [ConfigService],
    },
    EcsService,
    LogsService,
    CostService,
    FileManagerService,
  ],
  exports: [ConfigService, Ec2Service, EcsService, LogsService, CostService, FileManagerService],
})
export class AwsModule {}
