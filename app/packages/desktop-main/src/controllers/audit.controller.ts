import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type { AuditPageResult } from '@hyveon/shared';
import { AuditService } from '../services/AuditService.js';
import type { ListAuditEntriesOpts } from '../services/AuditService.js';

/**
 * IPC-only controller exposing the `game_servers` mutation audit log for the
 * Electron main-process host. The single handler is bound to an IPC channel
 * via `@MessagePattern` — no HTTP routes are registered here. The browser
 * client and the integration-test server reach the same operation over REST
 * through the {@link AuditHttpController} shim, which delegates to the
 * identical {@link AuditService} provider.
 */
@Controller()
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /**
   * Returns a page of audit entries, newest-first — see
   * `AuditService.list()`. `opts` mirrors {@link ListAuditEntriesOpts}
   * (`limit`/`before`) and defaults to `{}` when the renderer invokes
   * `audit.list` with no arguments.
   *
   * Reachable via the Electron IPC transport (`audit.list`).
   */
  @MessagePattern('audit.list')
  list(@Payload() opts: ListAuditEntriesOpts = {}): Promise<AuditPageResult> {
    return this.audit.list(opts ?? {});
  }
}
