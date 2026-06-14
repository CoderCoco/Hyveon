import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { DiagnosticsService } from '../services/DiagnosticsService.js';

/**
 * IPC-only controller for local application log data.
 *
 * Registers the `diagnostics.tail` and `diagnostics.path` Electron IPC
 * channels so the renderer can reach them through `window.gsd.diagnostics.*`.
 * No HTTP routes are declared here — the REST surface lives in the companion
 * {@link DiagnosticsHttpController} shim.
 */
@Controller()
export class DiagnosticsController {
  constructor(private readonly diagnostics: DiagnosticsService) {}

  /** Returns the last 500 lines from today's local log file. */
  @MessagePattern('diagnostics.tail')
  async getTail(): Promise<{ lines: string[] }> {
    const lines = await this.diagnostics.readTail(500);
    return { lines };
  }

  /** Returns the absolute path of today's local log file. */
  @MessagePattern('diagnostics.path')
  getPath(): { path: string } {
    return { path: this.diagnostics.getTodayLogPath() };
  }
}
