import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import type { AuditPageResult } from '@hyveon/shared';
import { AuditService } from '../services/AuditService.js';

/**
 * Parses the `limit` query parameter into a number for `AuditService.list`.
 * Returns `undefined` when the parameter is absent — `AuditService` applies
 * its own default (25) and hard maximum (100) in that case. Throws
 * `BadRequestException` when `raw` is present but isn't a finite positive
 * number, since `Number('abc')` etc. would otherwise silently fall through
 * to the service's default and mask a client-side bug.
 */
function parseLimit(raw?: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BadRequestException({ success: false, error: 'limit must be a positive number' });
  }
  return parsed;
}

/**
 * HTTP shim that exposes the audit log as a plain REST endpoint
 * (`GET /api/audit?limit=N&before=`). The browser client (`api.service.ts`)
 * and the integration-test server consume this route over HTTP; the
 * Electron main-process host uses the IPC {@link AuditController}
 * (`@MessagePattern`) handler instead.
 *
 * Both controllers delegate to the same {@link AuditService} provider — the
 * heavy lifting lives in that service, not in the thin orchestration
 * duplicated here.
 */
@Controller('audit')
export class AuditHttpController {
  constructor(private readonly audit: AuditService) {}

  /**
   * Returns a page of audit entries, newest-first. `limit` is parsed via
   * {@link parseLimit} (400 on a malformed value); `before` is forwarded
   * verbatim as the pagination cursor, treating an empty string the same as
   * an absent query param.
   */
  @Get()
  list(@Query('limit') limitRaw?: string, @Query('before') before?: string): Promise<AuditPageResult> {
    return this.audit.list({ limit: parseLimit(limitRaw), before: before || undefined });
  }
}
