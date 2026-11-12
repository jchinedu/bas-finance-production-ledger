/**
 * Money utilities – all amounts in KOBO (integer). No floats allowed.
 *
 * Rounding: half-up to nearest kobo, applied only at named points.
 * Never round intermediate values.
 */

/**
 * Round a floating-point number using symmetric half-up (half away from zero).
 */
export function roundHalfUp(value: number): number {
  if (value < 0) {
    return Math.ceil(value - 0.5);
  }
  return Math.floor(value + 0.5);
}

/**
 * Pure BigInt division with symmetric half-up rounding (half away from zero).
 * No floating-point conversions; prevents 2^53 precision loss on large monetary amounts.
 */
export function divideRoundHalfUpBigInt(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('Division by zero');
  const isNegative = (numerator < 0n) !== (denominator < 0n);
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = denominator < 0n ? -denominator : denominator;

  const quotient = absNum / absDen;
  const remainder = absNum % absDen;

  // Symmetric half-up: if remainder * 2 >= denominator, round away from zero
  const roundUp = (remainder * 2n) >= absDen;
  const result = roundUp ? quotient + 1n : quotient;

  return isNegative ? -result : result;
}

/**
 * Format integer kobo to display Naira string without floating-point drift.
 * Example: 100000n -> "₦1,000.00"
 */
export function koboToNairaString(kobo: bigint): string {
  const isNeg = kobo < 0n;
  const abs = isNeg ? -kobo : kobo;
  const whole = abs / 100n;
  const fraction = abs % 100n;
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fractionStr = fraction.toString().padStart(2, '0');
  return `${isNeg ? '-' : ''}₦${wholeStr}.${fractionStr}`;
}

/**
 * Parse a Naira string (e.g. "1,000.50" or "1000.50") into integer Kobo (bigint).
 */
export function nairaToKobo(naira: string | number): bigint {
  const str = String(naira).replace(/,/g, '').trim();
  const isNeg = str.startsWith('-');
  const clean = isNeg ? str.slice(1) : str;
  const parts = clean.split('.');
  const whole = BigInt(parts[0] || '0');
  let fraction = 0n;
  if (parts[1]) {
    const raw = (parts[1] + '00').slice(0, 2);
    fraction = BigInt(raw);
  }
  const total = whole * 100n + fraction;
  return isNeg ? -total : total;
}

/**
 * Compute: numerator / denominator, rounded half-up.
 * Always works on the exact float result – do NOT pre-round.
 */
export function divideRoundHalfUp(numerator: number, denominator: number): number {
  return roundHalfUp(numerator / denominator);
}

/**
 * Compute discount fee for invoice financing using pure BigInt math.
 * formula: advance_kobo × (annual_rate_bps / 10,000) × tenor_days / 365
 */
export function computeDiscountFee(
  advanceKobo: bigint,
  annualRateBps: number,  // basis points, e.g. 3600 = 36%
  tenorDays: number
): bigint {
  if (tenorDays <= 0) return 0n;
  const num = advanceKobo * BigInt(annualRateBps) * BigInt(tenorDays);
  const den = 365n * 10_000n;
  return divideRoundHalfUpBigInt(num, den);
}

/**
 * Compute late penalty for invoice financing using pure BigInt math.
 * formula: advance_kobo × 0.2% × days_overdue (0.2% = 20 bps = 20 / 10,000)
 */
export function computeLatepenalty(
  advanceKobo: bigint,
  daysOverdue: number
): bigint {
  if (daysOverdue <= 0) return 0n;
  const num = advanceKobo * 20n * BigInt(daysOverdue);
  const den = 10_000n;
  return divideRoundHalfUpBigInt(num, den);
}

/**
 * Days between two calendar dates (later - earlier).
 * Both dates as ISO strings: "YYYY-MM-DD"
 */
export function daysBetween(earlier: string, later: string): number {
  const [ey, em, ed] = earlier.split('-').map(Number);
  const [ly, lm, ld] = later.split('-').map(Number);
  const aUtc = Date.UTC(ey!, em! - 1, ed);
  const bUtc = Date.UTC(ly!, lm! - 1, ld);
  const msPerDay = 86_400_000;
  return Math.round((bUtc - aUtc) / msPerDay);
}

/**
 * Add months to a calendar date ("YYYY-MM-DD") with month-end clipping.
 * e.g., 2026-01-31 + 1 month -> 2026-02-28 (never overflows into March).
 */
export function addMonths(dateStr: string, months: number): string {
  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  const year = parseInt(yearStr!, 10);
  const month = parseInt(monthStr!, 10) - 1; // 0-based
  const day = parseInt(dayStr!, 10);

  const targetMonth = month + months;
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;

  // Max days in target month
  const maxDays = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, maxDays);

  const y = targetYear.toString().padStart(4, '0');
  const m = (normalizedMonth + 1).toString().padStart(2, '0');
  const d = targetDay.toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}
