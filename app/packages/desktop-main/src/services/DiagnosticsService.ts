import { Injectable, Inject } from '@nestjs/common';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

/** Maximum bytes read from the end of the log file per tail call (~200 KB covers ~500 typical log lines). */
const TAIL_READ_BYTES = 200 * 1024;

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
    let fh: fs.FileHandle | undefined;
    try {
      fh = await fs.open(filePath, 'r');
      const { size } = await fh.stat();
      const offset = Math.max(0, size - TAIL_READ_BYTES);
      // Peek one byte before the window so the first split element is always either
      // an empty string (offset landed on a newline) or a partial fragment (offset
      // landed mid-line) — both are safe to drop, eliminating the risk of discarding
      // a complete first line when the offset coincides with a line boundary.
      const readFrom = Math.max(0, offset - 1);
      const buf = Buffer.alloc(size - readFrom);
      const { bytesRead } = await fh.read(buf, 0, buf.length, readFrom);
      const content = buf.subarray(0, bytesRead).toString('utf-8');
      const lines = content.split('\n');
      const trimmed = readFrom > 0 ? lines.slice(1) : lines;
      if (trimmed.at(-1) === '') trimmed.pop();
      return trimmed.slice(-maxLines);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    } finally {
      await fh?.close();
    }
  }
}
