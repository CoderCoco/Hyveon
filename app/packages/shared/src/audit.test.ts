import { describe, it, expect } from 'vitest';
import { buildAuditSk } from './audit.js';

/** Crockford base32 alphabet used by ULID (excludes I, L, O, U). */
const ULID_CHARS = '0-9A-HJKMNP-TV-Z';
const AUDIT_SK_PATTERN = new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z#[${ULID_CHARS}]{26}$`);

describe('buildAuditSk', () => {
  it('should produce a sort key shaped like <ISO timestamp>#<ULID>', () => {
    const sk = buildAuditSk(new Date('2026-07-17T12:34:56.789Z'));
    expect(sk).toMatch(AUDIT_SK_PATTERN);
  });

  it('should prefix the sort key with the ISO string of the provided timestamp', () => {
    const now = new Date('2020-01-01T00:00:00.000Z');
    const sk = buildAuditSk(now);
    expect(sk.startsWith(`${now.toISOString()}#`)).toBe(true);
  });

  it('should default to the current time when no timestamp is provided', () => {
    const before = Date.now();
    const sk = buildAuditSk();
    const after = Date.now();

    const [timestamp] = sk.split('#');
    const encoded = new Date(timestamp!).getTime();
    expect(encoded).toBeGreaterThanOrEqual(before);
    expect(encoded).toBeLessThanOrEqual(after);
  });

  it('should produce sort keys that sort chronologically for increasing timestamps', () => {
    const earlier = buildAuditSk(new Date('2026-01-01T00:00:00.000Z'));
    const later = buildAuditSk(new Date('2026-06-01T00:00:00.000Z'));
    expect(earlier < later).toBe(true);
  });

  it('should not mutate any shared state across calls (pure)', () => {
    const first = buildAuditSk(new Date('2026-07-17T12:34:56.789Z'));
    const second = buildAuditSk(new Date('2026-07-17T12:34:56.789Z'));
    expect(first.split('#')[0]).toBe(second.split('#')[0]);
    expect(first).toMatch(AUDIT_SK_PATTERN);
    expect(second).toMatch(AUDIT_SK_PATTERN);
  });
});
