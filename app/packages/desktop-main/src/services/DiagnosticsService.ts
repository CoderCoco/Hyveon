import { Injectable, Inject } from '@nestjs/common';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

/** Injection token for the directory where DailyRotateFile writes logs. */
export const DIAGNOSTICS_LOG_DIR = 'DIAGNOSTICS_LOG_DIR';

/**
 * Provides access to the local application log file written by
 * winston-daily-rotate-file. Used by the diagnostics API endpoint so
 * operators can read today's log without SSH access.
 */
@Injectable()
export class DiagnosticsService {
  constructor(
    @Inject(DIAGNOSTICS_LOG_DIR) private readonly logDir: string,
  ) {}

  /**
   * Returns the absolute path for today's log file using the
   * `main-YYYY-MM-DD.log` naming convention that DailyRotateFile applies.
   */
  getTodayLogPath(): string {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const datePart = `${yyyy}-${mm}-${dd}`;
    return path.join(this.logDir, `main-${datePart}.log`);
  }

  /**
   * Reads the tail of today's log file, returning up to `maxLines` lines.
   * Returns an empty array when the file does not yet exist (e.g. on the
   * very first boot before any log rotation has occurred).
   *
   * @param maxLines - Maximum number of trailing lines to return. Defaults to 500.
   */
  async readTail(maxLines = 500): Promise<string[]> {
    const filePath = this.getTodayLogPath();
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }

    const lines = content.split('\n').filter((line, idx, arr) => {
      // Drop trailing empty strings that arise from a trailing newline,
      // but only at the very end of the array.
      if (line === '' && idx === arr.length - 1) return false;
      return true;
    });

    return lines.slice(-maxLines);
  }
}
