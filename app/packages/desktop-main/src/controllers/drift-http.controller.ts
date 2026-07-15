import { Controller, Get } from '@nestjs/common';
import type { DriftReport } from '@hyveon/shared';
import { DriftService } from '../services/DriftService.js';

/**
 * HTTP shim that exposes drift detection as a plain REST endpoint
 * (`GET /api/drift`). The browser client (`api.service.ts`) and the
 * integration-test server consume this route over HTTP; the Electron
 * main-process host uses the IPC {@link DriftController} (`@MessagePattern`)
 * handler instead.
 *
 * Both controllers delegate to the same {@link DriftService} provider — the
 * heavy lifting lives in that service, not in the thin orchestration
 * duplicated here.
 */
@Controller('drift')
export class DriftHttpController {
  constructor(private readonly drift: DriftService) {}

  /** Returns the current {@link DriftReport} — see `DriftService.getDrift()`. */
  @Get()
  get(): Promise<DriftReport> {
    return this.drift.getDrift();
  }
}
