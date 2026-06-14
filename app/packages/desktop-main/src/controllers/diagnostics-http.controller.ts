import { Controller, Get } from '@nestjs/common';
import { DiagnosticsService } from '../services/DiagnosticsService.js';

/**
 * HTTP shim that exposes the diagnostics operations as plain REST endpoints
 * (`/api/diagnostics/tail`, `/api/diagnostics/path`). The browser client and
 * the integration-test server both consume these routes over HTTP; the Electron
 * main-process host uses the IPC {@link DiagnosticsController} (`@MessagePattern`)
 * handlers instead.
 *
 * Both controllers delegate to the same {@link DiagnosticsService} provider —
 * the heavy lifting lives in the service, not in the thin orchestration here.
 */
@Controller('diagnostics')
export class DiagnosticsHttpController {
  constructor(private readonly diagnostics: DiagnosticsService) {}

  /** Returns the last 500 lines from today's local log file. */
  @Get('tail')
  async getTail(): Promise<{ lines: string[] }> {
    const lines = await this.diagnostics.readTail(500);
    return { lines };
  }

  /** Returns the absolute path of today's local log file. */
  @Get('path')
  getPath(): { path: string } {
    return { path: this.diagnostics.getTodayLogPath() };
  }
}
