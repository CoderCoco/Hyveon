import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import type { DriftReport } from '@hyveon/shared';
import { DriftService } from '../services/DriftService.js';

/**
 * IPC-only controller exposing drift detection (declared `terraform.tfvars`
 * vs. applied `terraform.tfstate`) for the Electron main-process host. The
 * single handler is bound to an IPC channel via `@MessagePattern` — no HTTP
 * routes are registered here. The browser client and the integration-test
 * server reach the same operation over REST through the
 * {@link DriftHttpController} shim, which delegates to the identical
 * {@link DriftService} provider.
 */
@Controller()
export class DriftController {
  constructor(private readonly drift: DriftService) {}

  /** Returns the current {@link DriftReport} — see `DriftService.getDrift()`. */
  @MessagePattern('drift.get')
  get(): Promise<DriftReport> {
    return this.drift.getDrift();
  }
}
