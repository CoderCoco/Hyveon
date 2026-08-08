/** A detected log severity level, shared between the `/logs` page and the Settings Diagnostics panel. */
export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

/** Every {@link LogLevel}, in display order. */
export const ALL_LOG_LEVELS: LogLevel[] = ['INFO', 'WARN', 'ERROR', 'DEBUG'];

/** Matches a level token bounded by word boundaries, e.g. `INFO`, `WARNING`, `ERR`, `DBG`. */
const LEVEL_PATTERN = /\b(INFO|WARN(?:ING)?|ERROR|ERR|DEBUG|DBG)\b/i;

/** Detect a {@link LogLevel} from a single log line, or `null` if no level token is present. */
export function detectLogLevel(line: string): LogLevel | null {
  const m = LEVEL_PATTERN.exec(line);
  if (!m) return null;
  const tok = m[1]!.toUpperCase();
  if (tok === 'WARNING' || tok === 'WARN') return 'WARN';
  if (tok === 'ERR' || tok === 'ERROR') return 'ERROR';
  if (tok === 'DBG' || tok === 'DEBUG') return 'DEBUG';
  if (tok === 'INFO') return 'INFO';
  return null;
}

/** Badge display metadata for each {@link LogLevel}. */
export const LOG_LEVEL_BADGE: Record<LogLevel, { variant: 'cyan' | 'warning' | 'destructive' | 'secondary'; label: string }> = {
  INFO: { variant: 'cyan', label: 'INFO' },
  WARN: { variant: 'warning', label: 'WARN' },
  ERROR: { variant: 'destructive', label: 'ERROR' },
  DEBUG: { variant: 'secondary', label: 'DEBUG' },
};
