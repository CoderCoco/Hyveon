import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { DiagnosticsService } from '../services/DiagnosticsService.js';
import { logger } from '../logger.js';

/** Payload accepted by `diagnostics.reportError`. */
export interface ReportRendererErrorInput {
  message: string;
  stack?: string;
  source: 'boundary' | 'window-error' | 'unhandled-rejection';
}

/** The `console.*` method a forwarded renderer log entry originated from. */
export type RendererConsoleLevel = 'log' | 'info' | 'warn' | 'error';

/** A single batched renderer `console.*` call, as queued client-side before a flush. */
export interface RendererLogEntry {
  level: RendererConsoleLevel;
  message: string;
}

/** Payload accepted by `diagnostics.reportLog`. */
export interface ReportRendererLogBatchInput {
  entries: RendererLogEntry[];
  /** Entries the renderer's own client-side batch cap already dropped before sending, if any. */
  droppedCount?: number;
}

/**
 * IPC-only controller for local application log data.
 *
 * Registers the `diagnostics.tail`, `diagnostics.path`, `diagnostics.reportError`,
 * and `diagnostics.reportLog` Electron IPC channels so the renderer can reach
 * them through `window.hyveon.diagnostics.*`. No HTTP routes are declared here.
 */
@Controller()
export class DiagnosticsController {
  constructor(private readonly diagnostics: DiagnosticsService) {}

  /** Returns the last 500 lines from today's local log file. */
  @MessagePattern('diagnostics.tail')
  async getTail(): Promise<{ lines: string[] }> {
    logger.debug('DiagnosticsController: diagnostics.tail invoked');
    const lines = await this.diagnostics.readTail(500);
    return { lines };
  }

  /** Returns the absolute path of today's local log file. */
  @MessagePattern('diagnostics.path')
  getPath(): { path: string } {
    logger.debug('DiagnosticsController: diagnostics.path invoked');
    return { path: this.diagnostics.getTodayLogPath() };
  }

  /** Forwards a renderer-side crash into the local winston log file. Never rejects. */
  @MessagePattern('diagnostics.reportError')
  reportError(@Payload() body: ReportRendererErrorInput): void {
    logger.debug('DiagnosticsController: diagnostics.reportError invoked');
    this.diagnostics.logRendererError(body.message, body.stack, body.source);
  }

  /** Forwards a batch of renderer-side `console.*` calls into the local winston log file. Never rejects. */
  @MessagePattern('diagnostics.reportLog')
  reportLog(@Payload() body: ReportRendererLogBatchInput): void {
    logger.debug('DiagnosticsController: diagnostics.reportLog invoked');
    this.diagnostics.logRendererConsoleBatch(body.entries, body.droppedCount);
  }
}
