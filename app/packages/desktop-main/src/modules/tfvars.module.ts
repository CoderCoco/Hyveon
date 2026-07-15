import { Module } from '@nestjs/common';
import { ConfigModule } from './config.module.js';
import { CloudProviderModule } from './cloud-provider.module.js';
import { TfvarsService } from '../services/TfvarsService.js';

/**
 * Feature module for `TfvarsService`, the local-vs-S3 `terraform.tfvars`
 * reader/parser (see `TfvarsService`'s file-level doc comment for source
 * resolution, parsing, and caching behaviour).
 *
 * `ConfigModule` is imported for `ConfigService` (tfvars source resolution)
 * and `CloudProviderModule` for the `REMOTE_FILE_STORE` token (S3-mode
 * reads), both re-exported alongside `TfvarsService` so any consumer that
 * only needs `TfvarsModule` gets the full dependency chain without also
 * importing `AwsModule`.
 */
@Module({
  imports: [ConfigModule, CloudProviderModule],
  providers: [TfvarsService],
  exports: [ConfigModule, CloudProviderModule, TfvarsService],
})
export class TfvarsModule {}
