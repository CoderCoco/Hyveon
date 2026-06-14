import { Controller, Get } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { DiagnosticsService } from '../services/DiagnosticsService.js';

/**
 * Exposes local application log data for operator diagnostics.
 *
 * Each handler answers on two transports during the HTTP→IPC migration: the
 * original `/api/diagnostics/*` HTTP route and the matching `diagnostics.*`
 * Electron IPC channel (auto-discovered by the IPC transport from the
 * `@MessagePattern` decorators). The renderer reaches these through
 * `window.gsd.diagnostics.*`; both transports return identical payloads.
 */
@Controller('diagnostics')
export class DiagnosticsController {
  constructor(private readonly diagnostics: DiagnosticsService) {}

  /** Returns the last 500 lines from today's local log file. */
  @Get('tail')
  @MessagePattern('diagnostics.tail')
  async getTail(): Promise<{ lines: string[] }> {
    const lines = await this.diagnostics.readTail(500);
    return { lines };
  }

  /** Returns the absolute path of today's local log file. */
  @Get('path')
  @MessagePattern('diagnostics.path')
  getPath(): { path: string } {
    return { path: this.diagnostics.getTodayLogPath() };
  }
}
