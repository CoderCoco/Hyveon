import { Module } from '@nestjs/common';
import { TerraformService } from '../services/TerraformService.js';

/**
 * Feature module for `TerraformService`, the local `terraform` CLI
 * detection/orchestration seam (see `TerraformService`'s file-level doc
 * comment). Construction is asynchronous (binary lookup + `terraform version`),
 * so the provider is wired via a `useFactory` that delegates to the static
 * `TerraformService.create()` rather than `useClass`.
 *
 * Not yet imported by `AppModule` — this is scaffolding only. A later child
 * issue of Epic D (local terraform orchestration) will import this module
 * once IPC-driven plan/apply/destroy/output handlers exist to consume it.
 */
@Module({
  providers: [
    {
      provide: TerraformService,
      useFactory: () => TerraformService.create(),
    },
  ],
  exports: [TerraformService],
})
export class TerraformModule {}
