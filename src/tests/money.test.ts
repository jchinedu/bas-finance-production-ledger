/**
 * Unit tests: money math and term loan schedule
 * These are pure-function tests — no database needed.
 */

import { describe, it, expect } from 'vitest';
import {
  roundHalfUp,
  computeDiscountFee,
  computeLatepenalty,
  daysBetween,
  koboToNairaString,
  nairaToKobo,
  divideRoundHalfUpBigInt,
} from '../domain/money.js';
import { buildTermLoanSchedule, computeStandardInstalment } from '../domain/termLoan.js';
import { computeInvoiceFinancingWithTenor } from '../domain/invoiceFinancing.js';
import { isValidIsoDate, parsePositiveKobo, parseId, MAX_BIGINT } from '../validation.js';

describe('roundHalfUp', () => {
  it('rounds 0.5 up to 1', () => expect(roundHalfUp(0.5)).toBe(1));
  it('rounds 1.5 up to 2', () => expect(roundHalfUp(1.5)).toBe(2));
  it('rounds 2.5 up to 3', () => expect(roundHalfUp(2.5)).toBe(3));
  it('rounds 1.4 down to 1', () => expect(roundHalfUp(1.4)).toBe(1));
  it('rounds 1.6 up to 2', () => expect(roundHalfUp(1.6)).toBe(2));
  it('handles negative with symmetric half-away-from-zero convention', () => {
    expect(roundHalfUp(-1.5)).toBe(-2);
    expect(roundHalfUp(-1.4)).toBe(-1);
    expect(roundHalfUp(-1.6)).toBe(-2);
  });
});

describe('daysBetween', () => {
  it('counts correctly', () => {
    expect(daysBetween('2026-01-01', '2026-03-02')).toBe(60);
    expect(daysBetween('2026-01-01', '2026-01-11')).toBe(10);
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0);
  });
});

describe('computeDiscountFee', () => {
  it('matches worked example: 800,000,000 × 36% × 60/365 = 47,342,466', () => {
    const fee = computeDiscountFee(800_000_000n, 3600, 60);
    expect(fee).toBe(47_342_466n);
  });
});

describe('computeLatepenalty', () => {
  it('matches worked example: 800,000,000 × 0.2% × 10 = 16,000,000', () => {
    const penalty = computeLatepenalty(800_000_000n, 10);
    expect(penalty).toBe(16_000_000n);
  });
  it('returns 0 for 0 days overdue', () => {
    expect(computeLatepenalty(800_000_000n, 0)).toBe(0n);
  });
});

describe('buildTermLoanSchedule — Worked Example 1', () => {
  // Principal ₦1,200,000 = 120,000,000 kobo, 18% annual, 6 months
  const schedule = buildTermLoanSchedule(120_000_000n, 1800, 6, '2026-01-01');

  const expected = [
    { payment: 21_063_026n, interest: 1_800_000n, principal: 19_263_026n, closing: 100_736_974n },
    { payment: 21_063_026n, interest: 1_511_055n, principal: 19_551_971n, closing: 81_185_003n },
    { payment: 21_063_026n, interest: 1_217_775n, principal: 19_845_251n, closing: 61_339_752n },
    { payment: 21_063_026n, interest:   920_096n, principal: 20_142_930n, closing: 41_196_822n },
    { payment: 21_063_026n, interest:   617_952n, principal: 20_445_074n, closing: 20_751_748n },
    { payment: 21_063_024n, interest:   311_276n, principal: 20_751_748n, closing:          0n },
  ];

  it('produces 6 instalments', () => {
    expect(schedule.instalments).toHaveLength(6);
  });

  expected.forEach((exp, idx) => {
    it(`period ${idx + 1}: instalment=${exp.payment}, interest=${exp.interest}, principal=${exp.principal}, closing=${exp.closing}`, () => {
      const inst = schedule.instalments[idx]!;
      expect(inst.instalmentKobo).toBe(exp.payment);
      expect(inst.interestKobo).toBe(exp.interest);
      expect(inst.principalKobo).toBe(exp.principal);
      expect(inst.closingBalance).toBe(exp.closing);
    });
  });

  it('final instalment closes to exactly 0', () => {
    expect(schedule.instalments[5]!.closingBalance).toBe(0n);
  });

  it('total interest = 6,378,154 kobo', () => {
    const totalInterest = schedule.instalments.reduce((s, i) => s + i.interestKobo, 0n);
    expect(totalInterest).toBe(6_378_154n);
  });
});

describe('Term loan validation and edge cases', () => {
  it('handles zero-interest loans correctly', () => {
    const sched = buildTermLoanSchedule(120_000_000n, 0, 6, '2026-01-01');
    expect(sched.instalments).toHaveLength(6);
    expect(sched.instalments[0]!.interestKobo).toBe(0n);
    expect(sched.instalments[0]!.instalmentKobo).toBe(20_000_000n);
    expect(sched.instalments[5]!.closingBalance).toBe(0n);
  });

  it('rejects negative or zero principal', () => {
    expect(() => buildTermLoanSchedule(0n, 1800, 6, '2026-01-01')).toThrow(/positive/);
    expect(() => buildTermLoanSchedule(-100n, 1800, 6, '2026-01-01')).toThrow(/positive/);
  });

  it('rejects negative annual rate', () => {
    expect(() => buildTermLoanSchedule(100_000n, -100, 6, '2026-01-01')).toThrow(/negative/);
  });

  it('rejects invalid tenors', () => {
    expect(() => buildTermLoanSchedule(100_000n, 1800, 0, '2026-01-01')).toThrow(/positive/);
    expect(() => buildTermLoanSchedule(100_000n, 1800, 2.5, '2026-01-01')).toThrow(/positive/);
  });
});

describe('Money formatting and integer precision', () => {
  it('formats kobo to Naira string safely without floats', () => {
    expect(koboToNairaString(100_000n)).toBe('₦1,000.00');
    expect(koboToNairaString(50n)).toBe('₦0.50');
    expect(koboToNairaString(1n)).toBe('₦0.01');
    expect(koboToNairaString(120_000_000n)).toBe('₦1,200,000.00');
    expect(koboToNairaString(-500_000n)).toBe('-₦5,000.00');
  });

  it('parses Naira string to kobo correctly', () => {
    expect(nairaToKobo('1000.00')).toBe(100_000n);
    expect(nairaToKobo('1,000.50')).toBe(100_050n);
    expect(nairaToKobo('0.50')).toBe(50n);
    expect(nairaToKobo('0.01')).toBe(1n);
    expect(nairaToKobo('-500.00')).toBe(-50_000n);
  });

  it('performs pure BigInt division with half-up rounding', () => {
    expect(divideRoundHalfUpBigInt(10n, 3n)).toBe(3n);
    expect(divideRoundHalfUpBigInt(11n, 3n)).toBe(4n);
    expect(divideRoundHalfUpBigInt(100n, 200n)).toBe(1n); // 0.5 rounds up
    expect(divideRoundHalfUpBigInt(99n, 200n)).toBe(0n);  // 0.495 rounds down
  });
});

describe('Invoice financing calculations (Product A)', () => {
  it('handles early settlement without penalties', () => {
    const res = computeInvoiceFinancingWithTenor({
      faceValueKobo: 1_000_000_000n,
      dueDate: '2026-03-02',
      settlementDate: '2026-02-15', // early
      tenorDays: 60,
    });
    expect(res.daysOverdue).toBe(0);
    expect(res.latePenaltyKobo).toBe(0n);
    expect(res.isShortfall).toBe(false);
  });

  it('handles partial settlement resulting in shortfall', () => {
    const res = computeInvoiceFinancingWithTenor({
      faceValueKobo: 1_000_000_000n,
      dueDate: '2026-03-02',
      settlementDate: '2026-03-12', // 10 days late
      tenorDays: 60,
      settlementAmountKobo: 800_000_000n, // partial payment (only ₦8m of ₦10m)
    });
    // total charges = 47,342,466 + 16,000,000 = 63,342,466
    // advance = 800,000,000
    // total due to lender = 863,342,466
    // actual settlement = 800,000,000
    // shortfall = 63,342,466
    expect(res.isShortfall).toBe(true);
    expect(res.clientReceivableKobo).toBe(63_342_466n);
    expect(res.clientPayableKobo).toBe(0n);
  });

  it('handles excess settlement', () => {
    const res = computeInvoiceFinancingWithTenor({
      faceValueKobo: 1_000_000_000n,
      dueDate: '2026-03-02',
      settlementDate: '2026-03-02', // on time
      tenorDays: 60,
      settlementAmountKobo: 1_050_000_000n, // excess payment
    });
    expect(res.isShortfall).toBe(false);
    expect(res.clientPayableKobo).toBe(1_050_000_000n - 800_000_000n - res.discountFeeKobo);
  });
});

describe('Pure BigInt Annuity & High-Precision Edge Cases', () => {
  it('computes exact rational BigInt annuity for 360-month long tenor and large principal without precision drift', () => {
    // ₦50,000,000,000.00 (5_000_000_000_000n kobo), 24% annual (2400 bps -> 2% monthly), 360 months
    const inst = computeStandardInstalment(5_000_000_000_000n, 2400, 360);
    // Exact rational value: 5_000_000_000_000 * (2/100) * (102^360) / (102^360 - 100^360) = 100_080_220_695n
    // (Note: IEEE-754 float Math.pow(1.02, -360) drifts to 100_080_295_627, off by 74,932 kobo!)
    expect(inst).toBe(100_080_220_695n);

    const schedule = buildTermLoanSchedule(5_000_000_000_000n, 2400, 360, '2026-01-01');
    expect(schedule.instalments).toHaveLength(360);
    expect(schedule.instalments[359]!.closingBalance).toBe(0n);
    const totalPrincipal = schedule.instalments.reduce((s, r) => s + r.principalKobo, 0n);
    expect(totalPrincipal).toBe(5_000_000_000_000n);
  });

  it('matches independent reference calculations across multiple interest rates and tenors and clears final balance to 0', () => {
    const cases = [
      // 1-month tenor, 12% APR (1% monthly): P=10,000,000 -> inst = 10,100,000
      { P: 10_000_000n, bps: 1200, n: 1, expectedInst: 10_100_000n },
      // 12-month tenor, 12% APR (1% monthly): P=100,000,000 -> 100,000,000 * 0.01 * 1.01^12 / (1.01^12 - 1) = 8,884,878.8678... -> 8,884,879
      { P: 100_000_000n, bps: 1200, n: 12, expectedInst: 8_884_879n },
      // 24-month tenor, 30% APR (2.5% monthly): P=250,000,000 -> 250,000,000 * 0.025 * 1.025^24 / (1.025^24 - 1) = 13,978,205.1066... -> 13,978,205
      { P: 250_000_000n, bps: 3000, n: 24, expectedInst: 13_978_205n },
      // Zero-interest with non-even division: 100 kobo over 3 months -> half-up standard = 33, final = 34
      { P: 100n, bps: 0, n: 3, expectedInst: 33n },
    ];

    for (const tc of cases) {
      expect(computeStandardInstalment(tc.P, tc.bps, tc.n)).toBe(tc.expectedInst);
      const sched = buildTermLoanSchedule(tc.P, tc.bps, tc.n, '2026-01-01');
      expect(sched.instalments).toHaveLength(tc.n);
      expect(sched.instalments[tc.n - 1]!.closingBalance).toBe(0n);
      const sumPrincipal = sched.instalments.reduce((s, r) => s + r.principalKobo, 0n);
      expect(sumPrincipal).toBe(tc.P);
    }
  });

  it('bounds exponentiation by rejecting tenors > 360 or rates > 100,000 bps', () => {
    expect(() => computeStandardInstalment(10_000_000n, 1800, 361)).toThrow(/360/);
    expect(() => computeStandardInstalment(10_000_000n, 100_001, 12)).toThrow(/100000/);
  });
});

describe('Strict Input Validation Helpers', () => {
  it('validates strict calendar dates', () => {
    expect(isValidIsoDate('2026-02-28')).toBe(true);
    expect(isValidIsoDate('2026-02-29')).toBe(false); // 2026 is not a leap year
    expect(isValidIsoDate('2024-02-29')).toBe(true);  // 2024 is a leap year
    expect(isValidIsoDate('2026-13-01')).toBe(false);
    expect(isValidIsoDate('not-a-date')).toBe(false);
  });

  it('validates positive kobo and PostgreSQL BIGINT upper bound', () => {
    expect(parsePositiveKobo('1000')).toBe(1000n);
    expect(parsePositiveKobo(0)).toBeNull();
    expect(parsePositiveKobo(-50)).toBeNull();
    expect(parsePositiveKobo(MAX_BIGINT.toString())).toBe(MAX_BIGINT);
    expect(parsePositiveKobo((MAX_BIGINT + 1n).toString())).toBeNull();
  });

  it('validates positive IDs within BIGINT bounds', () => {
    expect(parseId('42')).toBe(42n);
    expect(parseId('0')).toBeNull();
    expect(parseId('-1')).toBeNull();
    expect(parseId('abc')).toBeNull();
    expect(parseId((MAX_BIGINT + 1n).toString())).toBeNull();
  });
});
