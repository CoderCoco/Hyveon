import { Controller, Get } from '@nestjs/common';
import { DiagnosticsService } from '../services/DiagnosticsService.js';

/** Exposes local application log data for operator diagnostics. */
@Controller('diagnostics')
export class DiagnosticsController {
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
