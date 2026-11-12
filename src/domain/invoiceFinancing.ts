/**
 * Invoice Financing Calculator (Product A)
 *
 * Advance = face_value × 80%
 * Reserve = face_value − advance
 * Discount fee = advance × 36% × tenor_days / 365  (round half-up)
 * Late penalty = advance × 0.2% × days_overdue  (round half-up)
 * Settlement: lender keeps fee + penalty from reserve; pays remainder to client.
 * If charges > reserve → client owes shortfall.
 */

import { computeDiscountFee, computeLatepenalty, daysBetween, roundHalfUp, divideRoundHalfUpBigInt } from './money.js';

export const ADVANCE_RATE_BPS = 8000;      // 80%
export const INVOICE_ANNUAL_RATE_BPS = 3600; // 36%

// All calculation done via computeInvoiceFinancingWithTenor below

export interface InvoiceFinancingResult {
  faceValueKobo: bigint;
  advanceKobo: bigint;
  reserveKobo: bigint;
  tenorDays: number;
  discountFeeKobo: bigint;
  daysOverdue: number;
  latePenaltyKobo: bigint;
  totalChargesKobo: bigint;
  settlementAmountKobo: bigint;
  clientPayableKobo: bigint;
  clientReceivableKobo: bigint;
  isShortfall: boolean;
}

export interface InvoiceFinancingWithTenorParams {
  faceValueKobo: bigint;
  dueDate: string;        // when debtor was supposed to pay
  settlementDate: string; // when debtor actually paid
  tenorDays: number;      // days from advance disbursement to due_date
  annualRateBps?: number; // annual discount rate in bps (default 3600 = 36%)
  settlementAmountKobo?: bigint; // actual amount paid by debtor (defaults to faceValueKobo)
}

export function computeInvoiceFinancingWithTenor(
  params: InvoiceFinancingWithTenorParams
): InvoiceFinancingResult {
  const { faceValueKobo, dueDate, settlementDate, tenorDays, annualRateBps, settlementAmountKobo } = params;

  if (faceValueKobo <= 0n) {
    throw new Error('Invoice face value must be positive');
  }
  if (tenorDays <= 0) {
    throw new Error('Tenor days must be positive');
  }
  if (isNaN(Date.parse(dueDate)) || isNaN(Date.parse(settlementDate))) {
    throw new Error('Invalid date format for dueDate or settlementDate');
  }

  const rateBps = annualRateBps ?? INVOICE_ANNUAL_RATE_BPS;
  const advanceKobo = divideRoundHalfUpBigInt(faceValueKobo * BigInt(ADVANCE_RATE_BPS), 10_000n);
  const reserveKobo = faceValueKobo - advanceKobo;

  const discountFeeKobo = computeDiscountFee(advanceKobo, rateBps, tenorDays);
  const daysOverdue = Math.max(0, daysBetween(dueDate, settlementDate));
  const latePenaltyKobo = computeLatepenalty(advanceKobo, daysOverdue);

  const totalChargesKobo = discountFeeKobo + latePenaltyKobo;
  const actualSettlement = settlementAmountKobo ?? faceValueKobo;
  if (actualSettlement < 0n) {
    throw new Error('Settlement amount cannot be negative');
  }

  // Net client settlement: total collected minus advance and total lender charges
  const netClientDistribution = actualSettlement - (advanceKobo + totalChargesKobo);

  const clientPayableKobo = netClientDistribution > 0n ? netClientDistribution : 0n;
  const clientReceivableKobo = netClientDistribution < 0n ? -netClientDistribution : 0n;
  const isShortfall = clientReceivableKobo > 0n;

  return {
    faceValueKobo,
    advanceKobo,
    reserveKobo,
    tenorDays,
    discountFeeKobo,
    daysOverdue,
    latePenaltyKobo,
    totalChargesKobo,
    settlementAmountKobo: actualSettlement,
    clientPayableKobo,
    clientReceivableKobo,
    isShortfall,
  };
}
