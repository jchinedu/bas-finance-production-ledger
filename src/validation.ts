/**
 * Shared request-validation helpers. All validation is strict and dependency-free.
 */

export const MAX_BIGINT = 9_223_372_036_854_775_807n; // PostgreSQL BIGINT upper bound

/** Strict calendar date: YYYY-MM-DD, real day of a real month (rejects 2026-02-30, "2026-1-5", ISO datetimes). */
export function isValidIsoDate(d: unknown): d is string {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const [y, m, day] = d.split('-').map(Number);
  if (y! < 1970 || y! > 2200) return false;
  const date = new Date(Date.UTC(y!, m! - 1, day));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m! - 1 && date.getUTCDate() === day;
}

/**
 * Parse a kobo amount from a string of digits (or a safe integer number).
 * Returns null unless 1 <= value <= PostgreSQL BIGINT max.
 */
export function parsePositiveKobo(v: unknown): bigint | null {
  let big: bigint;
  try {
    if (typeof v === 'string' && /^\d+$/.test(v)) big = BigInt(v);
    else if (typeof v === 'number' && Number.isSafeInteger(v)) big = BigInt(v);
    else return null;
  } catch {
    return null;
  }
  return big >= 1n && big <= MAX_BIGINT ? big : null;
}

/** Parse a database id from a path/body string of digits. Returns null if invalid. */
export function parseId(v: unknown): bigint | null {
  return parsePositiveKobo(v);
}
