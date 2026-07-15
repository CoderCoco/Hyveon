import { Module } from '@nestjs/common';
import { ConfigService } from '../services/ConfigService.js';

/**
 * Standalone module for `ConfigService`, the terraform-state-backed
 * configuration reader shared across the app. Extracted so any feature
 * module (e.g. a future `CloudProviderModule`) can `imports: [ConfigModule]`
 * and receive `ConfigService` via Nest DI without depending on `AwsModule`,
 * which historically bundled it alongside every AWS-facing service.
 */
@Module({
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {}
