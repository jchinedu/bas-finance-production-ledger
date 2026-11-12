/**
 * Term Loan Schedule Calculator
 *
 * Monthly reducing-balance annuity, computed with EXACT integer arithmetic (no floats):
 *   monthly rate i = annualRateBps / 120,000           (a rational number a/b)
 *   Instalment    = P × i / (1 − (1+i)^−n)  — rounded half-up ONCE
 *   Each period:  interest  = opening_balance × i, rounded half-up
 *                 principal = instalment − interest
 *   Final period: principal = remaining balance, payment = principal + interest
 *
 * With i = a/b and u = a + b:   (1+i)^n = u^n / b^n, hence
 *   Instalment = P · a · u^n / ( b · (u^n − b^n) )
 * which is evaluated as one BigInt fraction and rounded once.
 */

import { addMonths, divideRoundHalfUpBigInt } from './money.js';

export const MAX_BIGINT = 9_223_372_036_854_775_807n; // PostgreSQL BIGINT upper bound
export const MAX_TERM_MONTHS = 360;                   // 30-year maximum tenor cap
export const MAX_ANNUAL_RATE_BPS = 100_000;           // 1,000% APR ceiling to bound exponentiation
const MONTHLY_RATE_DENOMINATOR = 120_000n;            // 10,000 bps × 12 months

function gcdBigInt(x: bigint, y: bigint): bigint {
  let a = x < 0n ? -x : x;
  let b = y < 0n ? -y : y;
  while (b !== 0n) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

/** Input/terms problems are client errors (HTTP 400), not server faults. */
function invalid(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400, code: 'INVALID_LOAN_TERMS' });
}

export interface InstalmentRow {
  periodNumber: number;
  dueDate: string;
  instalmentKobo: bigint;
  interestKobo: bigint;
  principalKobo: bigint;
  openingBalance: bigint;
  closingBalance: bigint;
}

export interface LoanSchedule {
  loanId?: bigint;
  principalKobo: bigint;
  annualRateBps: number;
  termMonths: number;
  disbursementDate: string;
  /** Informational only (never used in calculations) */
  monthlyRateDecimal: number;
  standardInstalmentKobo: bigint;
  instalments: InstalmentRow[];
}

/** Exact standard instalment in kobo (half-up rounded once). */
export function computeStandardInstalment(
  principalKobo: bigint,
  annualRateBps: number,
  termMonths: number
): bigint {
  if (!Number.isInteger(termMonths) || termMonths <= 0 || termMonths > MAX_TERM_MONTHS) {
    throw invalid(`Term months must be an integer between 1 and ${MAX_TERM_MONTHS}`);
  }
  if (!Number.isInteger(annualRateBps) || annualRateBps < 0 || annualRateBps > MAX_ANNUAL_RATE_BPS) {
    throw invalid(`Annual interest rate must be an integer between 0 and ${MAX_ANNUAL_RATE_BPS} bps`);
  }
  if (annualRateBps === 0) {
    return divideRoundHalfUpBigInt(principalKobo, BigInt(termMonths));
  }
  const rawA = BigInt(annualRateBps);
  const rawB = MONTHLY_RATE_DENOMINATOR;
  const g = gcdBigInt(rawA, rawB);
  const a = rawA / g;
  const b = rawB / g;
  const u = a + b;
  const n = BigInt(termMonths);
  const un = u ** n;
  const bn = b ** n;
  return divideRoundHalfUpBigInt(principalKobo * a * un, b * (un - bn));
}

export function buildTermLoanSchedule(
  principalKobo: bigint,
  annualRateBps: number,  // e.g. 1800 = 18%
  termMonths: number,
  disbursementDate: string
): LoanSchedule {
  if (principalKobo <= 0n || principalKobo > MAX_BIGINT) {
    throw invalid('Principal must be a positive integer in kobo within the BIGINT range');
  }
  if (!Number.isInteger(annualRateBps) || annualRateBps < 0 || annualRateBps > MAX_ANNUAL_RATE_BPS) {
    throw invalid('Annual interest rate must be a non-negative integer (basis points) within bounds');
  }
  if (!Number.isInteger(termMonths) || termMonths <= 0 || termMonths > MAX_TERM_MONTHS) {
    throw invalid('Term months must be a positive integer up to 360');
  }
  if (isNaN(Date.parse(disbursementDate))) {
    throw invalid('Invalid disbursement date format');
  }

  const n = termMonths;
  const standardInstalment = computeStandardInstalment(principalKobo, annualRateBps, n);

  const instalments: InstalmentRow[] = [];
  let balance = principalKobo;

  for (let period = 1; period <= n; period++) {
    const dueDate = addMonths(disbursementDate, period);
    const openingBalance = balance;

    // interest = opening × annualRateBps / 120,000 — pure BigInt, half-up
    const interestKobo = divideRoundHalfUpBigInt(
      openingBalance * BigInt(annualRateBps),
      MONTHLY_RATE_DENOMINATOR
    );

    let instalmentKobo: bigint;
    let principalPart: bigint;

    if (period === n) {
      // Final instalment clears the remaining balance exactly
      principalPart = openingBalance;
      instalmentKobo = principalPart + interestKobo;
    } else {
      instalmentKobo = standardInstalment;
      principalPart = instalmentKobo - interestKobo;
    }

    // Every row must be storable: principal in (0, opening], amounts within BIGINT
    if (principalPart <= 0n || principalPart > openingBalance || instalmentKobo > MAX_BIGINT || instalmentKobo <= 0n) {
      throw invalid(
        'These loan terms do not produce a valid repayment schedule ' +
        `(period ${period}: principal=${principalPart}, instalment=${instalmentKobo}); ` +
        'check principal, rate and term'
      );
    }

    const closingBalance = openingBalance - principalPart;
    balance = closingBalance;

    instalments.push({
      periodNumber: period,
      dueDate,
      instalmentKobo,
      interestKobo,
      principalKobo: principalPart,
      openingBalance,
      closingBalance,
    });
  }

  return {
    principalKobo,
    annualRateBps,
    termMonths,
    disbursementDate,
    monthlyRateDecimal: annualRateBps / 120_000, // display only
    standardInstalmentKobo: standardInstalment,
    instalments,
  };
}
