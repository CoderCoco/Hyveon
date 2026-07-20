import { Module } from '@nestjs/common';
import { ConfigModule } from './config.module.js';
import { CloudProviderModule } from './cloud-provider.module.js';
import { TerraformService } from '../services/TerraformService.js';
import { RunRecordService } from '../services/RunRecordService.js';

/**
 * Feature module for `TerraformService`, the local `terraform` CLI
 * detection/orchestration seam (see `TerraformService`'s file-level doc
 * comment), and `RunRecordService`, the inline-vs-offload run-history
 * persistence facade (see its own file-level doc comment) `terraform`
 * subcommand runners will eventually write their `TerraformRunRecord`s
 * through instead of (or alongside) the local `run.json` file.
 * Construction is synchronous and never throws — binary lookup and
 * version resolution are deferred to first use of `getBinaryPath()` /
 * `getVersion()` — so the provider is wired as a plain class provider rather
 * than an async `useFactory`, and `AppModule` can import this module safely
 * even on machines without `terraform` on PATH.
 *
 * Imports `ConfigModule` because both `TerraformService` and
 * `RunRecordService` take `ConfigService` as a constructor dependency
 * (`TerraformService` to resolve the working directory and the per-run
 * artifacts directory; `RunRecordService` to guard `persist()` on the
 * `runs_table_name` Terraform output, mirroring `AuditService`'s
 * table-not-deployed guard) and `CloudProviderModule` for the
 * `REMOTE_FILE_STORE` token — `TerraformService.plan()` pulls the current
 * tfvars snapshot from it in S3 mode, mirroring `TfvarsModule`'s wiring —
 * and for the `RUN_RECORD_STORE` token `RunRecordService` depends on. Both
 * modules are re-exported alongside `TerraformService`/`RunRecordService` so
 * any consumer that only needs `TerraformModule` gets the full dependency
 * chain without also importing `AwsModule`. Plain Nest DI, no async factory
 * needed since none of these providers do async work at construction time.
 *
 * Imported by `AppModule` alongside `TerraformController`, which bridges
 * `TerraformService.init`'s async-generator output onto Electron IPC.
 */
@Module({
  imports: [ConfigModule, CloudProviderModule],
  providers: [TerraformService, RunRecordService],
  exports: [ConfigModule, CloudProviderModule, TerraformService, RunRecordService],
})
export class TerraformModule {}
