// Module-level Set — lives for the JS module lifetime (one browser session,
// resets on hard reload, survives SPA navigation).
const suppressed = new Set<string>();

/** Returns true if the given confirmation key has been suppressed for this session. */
export function isSuppressed(key: string): boolean {
  return suppressed.has(key);
}

/** Marks a confirmation key as suppressed so future checks return true immediately. */
export function suppress(key: string): void {
  suppressed.add(key);
}
