import { Module } from '@nestjs/common';
import { ConfigModule } from './config.module.js';
import { CloudProviderModule } from './cloud-provider.module.js';
import { TerraformService } from '../services/TerraformService.js';

/**
 * Feature module for `TerraformService`, the local `terraform` CLI
 * detection/orchestration seam (see `TerraformService`'s file-level doc
 * comment). Construction is synchronous and never throws — binary lookup and
 * version resolution are deferred to first use of `getBinaryPath()` /
 * `getVersion()` — so the provider is wired as a plain class provider rather
 * than an async `useFactory`, and `AppModule` can import this module safely
 * even on machines without `terraform` on PATH.
 *
 * Imports `ConfigModule` because `TerraformService` takes `ConfigService` as
 * a constructor dependency (used to resolve the working directory and the
 * per-run artifacts directory) and `CloudProviderModule` for the
 * `REMOTE_FILE_STORE` token — `TerraformService.plan()` pulls the current
 * tfvars snapshot from it in S3 mode, mirroring `TfvarsModule`'s wiring —
 * both re-exported alongside `TerraformService` so any consumer that only
 * needs `TerraformModule` gets the full dependency chain without also
 * importing `AwsModule`. Plain Nest DI, no async factory needed since none of
 * these providers do async work at construction time.
 *
 * Imported by `AppModule` alongside `TerraformController`, which bridges
 * `TerraformService.init`'s async-generator output onto Electron IPC.
 */
@Module({
  imports: [ConfigModule, CloudProviderModule],
  providers: [TerraformService],
  exports: [ConfigModule, CloudProviderModule, TerraformService],
})
export class TerraformModule {}
