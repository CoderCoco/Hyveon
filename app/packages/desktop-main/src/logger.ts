import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

const isDev = process.env['NODE_ENV'] !== 'production';

/** Shared format used by all transports. */
const sharedFormat = isDev
  ? winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'HH:mm:ss' }),
      winston.format.printf((info) => {
        const { timestamp, level, message, ...meta } = info as Record<string, unknown>;
        const metaStr = Object.keys(meta).length
          ? '\n' + JSON.stringify(meta, null, 2)
          : '';
        return `${timestamp} [${level}] ${message}${metaStr}`;
      }),
    )
  : winston.format.combine(
      winston.format.timestamp(),
      winston.format.json(),
    );

/**
 * Creates a console-only fallback logger used as the initial singleton value
 * before {@link createLogger} is called by main.ts.
 */
function createConsoleOnlyLogger(): winston.Logger {
  return winston.createLogger({
    level: isDev ? 'debug' : 'info',
    format: sharedFormat,
    transports: [new winston.transports.Console()],
  });
}

/**
 * Module-level logger singleton.  Initially console-only; reassigned (as a
 * live ESM binding) when {@link createLogger} is called from main.ts so that
 * all existing importers automatically see the upgraded instance.
 */
export let logger: winston.Logger = createConsoleOnlyLogger();

/**
 * Creates a full winston logger with both a Console transport and a
 * DailyRotateFile transport that writes to `logDir`.  Also reassigns the
 * exported {@link logger} singleton so that modules that imported it before
 * `main.ts` started still get the upgraded instance.
 *
 * @param logDir - Directory in which daily log files will be written.
 * @returns The newly created {@link winston.Logger} instance.
 */
export function createLogger(logDir: string): winston.Logger {
  const newLogger = winston.createLogger({
    level: isDev ? 'debug' : 'info',
    format: sharedFormat,
    transports: [
      new winston.transports.Console(),
      new DailyRotateFile({
        dirname: logDir,
        filename: 'main-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxFiles: '14d',
      }),
    ],
  });

  // Reassign the live ESM binding so importers see the upgraded instance.
  logger = newLogger;
  return newLogger;
}
