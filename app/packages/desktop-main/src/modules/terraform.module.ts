import { Module } from '@nestjs/common';
import { ConfigModule } from './config.module.js';
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
 * a constructor dependency (the seam later terraform orchestration methods
 * will use to resolve the working directory) — plain Nest DI, no factory
 * needed since neither service does async work at construction time.
 *
 * Imported by `AppModule` alongside `TerraformController`, which bridges
 * `TerraformService.init`'s async-generator output onto Electron IPC.
 */
@Module({
  imports: [ConfigModule],
  providers: [TerraformService],
  exports: [TerraformService],
})
export class TerraformModule {}
