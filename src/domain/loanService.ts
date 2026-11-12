/**
 * Loan Service
 * Handles:
 *  - Creating term loans + posting disbursement entry
 *  - Accrual job: posting interest for all due, unaccrued instalments
 *  - Creating invoice financings
 */

import pg from 'pg';
import { buildTermLoanSchedule } from './termLoan.js';
import { computeInvoiceFinancingWithTenor } from './invoiceFinancing.js';
import { postJournalEntry } from './ledger.js';
import { daysBetween, koboToNairaString } from './money.js';

export interface CreateTermLoanInput {
  principalKobo: bigint;
  annualRateBps: number;    // e.g. 1800 = 18%
  termMonths: number;
  disbursementDate: string;
}

export interface CreateTermLoanResult {
  loanId: bigint;
  schedule: ReturnType<typeof buildTermLoanSchedule>;
  disbursementEntryId: bigint;
}

export async function createTermLoan(
  client: pg.PoolClient,
  input: CreateTermLoanInput
): Promise<CreateTermLoanResult> {
  const { principalKobo, annualRateBps, termMonths, disbursementDate } = input;

  // Build schedule
  const schedule = buildTermLoanSchedule(principalKobo, annualRateBps, termMonths, disbursementDate);

  // Insert loan record
  const { rows: [loanRow] } = await client.query<{ id: string }>(
    `INSERT INTO loans (loan_type, principal_kobo, annual_rate_bps, term_months, disbursement_date)
     VALUES ('term_loan', $1, $2, $3, $4)
     RETURNING id`,
    [principalKobo.toString(), annualRateBps, termMonths, disbursementDate]
  );
  const loanId = BigInt(loanRow!.id);

  // Insert instalment rows
  for (const inst of schedule.instalments) {
    await client.query(
      `INSERT INTO instalments
         (loan_id, period_number, due_date, instalment_kobo, interest_kobo, principal_kobo, opening_balance, closing_balance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        loanId,
        inst.periodNumber,
        inst.dueDate,
        inst.instalmentKobo.toString(),
        inst.interestKobo.toString(),
        inst.principalKobo.toString(),
        inst.openingBalance.toString(),
        inst.closingBalance.toString(),
      ]
    );
  }

  // Post disbursement journal entry
  // Dr Loans Receivable; Cr Cash
  const disbursementEntry = await postJournalEntry(client, {
    description: `Term loan disbursement – ${koboToNairaString(principalKobo)}`,
    entryDate: disbursementDate,
    loanId,
    reference: `DISB-LOAN-${loanId}`,
    lines: [
      { accountCode: 'LOANS_RECV', debitKobo: principalKobo },
      { accountCode: 'CASH', creditKobo: principalKobo },
    ],
  });

  return { loanId, schedule, disbursementEntryId: disbursementEntry.id };
}

/**
 * Accrual Job: post interest income for each instalment that:
 * - has fallen due (due_date <= asOfDate)
 * - has not yet been accrued
 *
 * Dr Interest Receivable; Cr Interest Income
 */
export async function runAccrualJob(
  client: pg.PoolClient,
  asOfDate: string
): Promise<{ accruedCount: number; entryIds: bigint[] }> {
  // Use FOR UPDATE SKIP LOCKED to prevent duplicate accruals across concurrent workers
  const { rows: due } = await client.query<{
    id: string;
    loan_id: string;
    interest_kobo: string;
    due_date: string;
  }>(
    `SELECT id, loan_id, interest_kobo, due_date
     FROM instalments
     WHERE due_date <= $1 AND accrued = FALSE
     ORDER BY due_date ASC
     FOR UPDATE SKIP LOCKED`,
    [asOfDate]
  );

  const entryIds: bigint[] = [];
  for (const inst of due) {
    const interestKobo = BigInt(inst.interest_kobo);
    if (interestKobo === 0n) {
      await client.query(`UPDATE instalments SET accrued=TRUE WHERE id=$1`, [inst.id]);
      continue;
    }

    const entry = await postJournalEntry(client, {
      description: `Interest accrual for instalment #${inst.id}`,
      entryDate: inst.due_date,
      loanId: BigInt(inst.loan_id),
      reference: `ACCRUAL-INST-${inst.id}`,
      lines: [
        { accountCode: 'INTEREST_RECV', debitKobo: interestKobo },
        { accountCode: 'INTEREST_INC', creditKobo: interestKobo },
      ],
    });

    await client.query(`UPDATE instalments SET accrued=TRUE WHERE id=$1`, [inst.id]);
    entryIds.push(entry.id);
  }

  return { accruedCount: due.length, entryIds };
}

/** Create an invoice financing record + post advance entry */
export async function createInvoiceFinancing(
  client: pg.PoolClient,
  input: {
    faceValueKobo: bigint;
    dueDate: string;
    disbursementDate: string;
    annualRateBps?: number;
  }
): Promise<{
  loanId: bigint;
  invoiceId: bigint;
  advanceKobo: bigint;
  reserveKobo: bigint;
  discountFeeKobo: bigint;
  disbursementEntryId: bigint;
}> {
  const { faceValueKobo, dueDate, disbursementDate } = input;
  const tenorDays = daysBetween(disbursementDate, dueDate);
  if (tenorDays < 1) {
    throw Object.assign(new Error('dueDate must be at least one day after disbursementDate'), { statusCode: 400, code: 'INVALID_TENOR' });
  }
  const annualRateBps = input.annualRateBps ?? 3600;

  // We compute the settlement result with settlement = dueDate (on-time) for initial setup
  const { advanceKobo, reserveKobo, discountFeeKobo } = computeInvoiceFinancingWithTenor({
    faceValueKobo,
    dueDate,
    settlementDate: dueDate,
    tenorDays,
    annualRateBps,
  });

  // Insert loan
  const { rows: [loanRow] } = await client.query<{ id: string }>(
    `INSERT INTO loans (loan_type, disbursement_date) VALUES ('invoice_financing', $1) RETURNING id`,
    [disbursementDate]
  );
  const loanId = BigInt(loanRow!.id);

  // Insert invoice record storing tenor_days explicitly
  const { rows: [invRow] } = await client.query<{ id: string }>(
    `INSERT INTO invoice_financings (loan_id, face_value_kobo, advance_kobo, reserve_kobo, discount_fee_kobo, tenor_days, annual_rate_bps, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [loanId, faceValueKobo.toString(), advanceKobo.toString(), reserveKobo.toString(), discountFeeKobo.toString(), tenorDays, annualRateBps, dueDate]
  );
  const invoiceId = BigInt(invRow!.id);

  // Post advance: Dr Invoice Receivables; Cr Cash
  const disbursementEntry = await postJournalEntry(client, {
    description: `Invoice financing advance`,
    entryDate: disbursementDate,
    loanId,
    reference: `INVOICE-ADV-${invoiceId}`,
    lines: [
      { accountCode: 'INVOICE_RECV', debitKobo: advanceKobo },
      { accountCode: 'CASH', creditKobo: advanceKobo },
    ],
  });

  return { loanId, invoiceId, advanceKobo, reserveKobo, discountFeeKobo, disbursementEntryId: disbursementEntry.id };
}

/** Settle an invoice: post settlement journal entry supporting partial, full, and excess settlement */
export async function settleInvoice(
  client: pg.PoolClient,
  invoiceId: bigint,
  settlementDate: string,
  settlementAmountKobo?: bigint
): Promise<{
  journalEntryId: bigint;
  clientPayableKobo: bigint;
  clientReceivableKobo: bigint;
  isShortfall: boolean;
}> {
  // Lock invoice row with FOR UPDATE to prevent concurrent/duplicate settlement
  const { rows: [inv] } = await client.query<{
    loan_id: string;
    face_value_kobo: string;
    advance_kobo: string;
    due_date: string;
    discount_fee_kobo: string;
    tenor_days: number;
    annual_rate_bps: string;
    status: string;
  }>(
    `SELECT loan_id, face_value_kobo, advance_kobo, due_date, discount_fee_kobo, tenor_days, annual_rate_bps, status
     FROM invoice_financings WHERE id = $1 FOR UPDATE`,
    [invoiceId]
  );

  if (!inv) throw new Error(`Invoice ${invoiceId} not found`);
  // One collection settles the invoice: both 'settled' and 'settled_shortfall' are terminal.
  if (inv.status !== 'open') {
    throw Object.assign(new Error(`Invoice ${invoiceId} already settled (${inv.status})`), { statusCode: 422, code: 'ALREADY_SETTLED' });
  }

  const faceValueKobo = BigInt(inv.face_value_kobo);
  const advanceKobo = BigInt(inv.advance_kobo);
  const discountFeeKobo = BigInt(inv.discount_fee_kobo);
  const loanId = BigInt(inv.loan_id);
  const annualRateBps = Number(inv.annual_rate_bps);
  const tenorDays = inv.tenor_days; // stored at creation; never reverse-engineered from the fee

  const actualSettlementKobo = settlementAmountKobo ?? faceValueKobo;

  // PostgreSQL DATE columns may come back as JS Date objects via the pg driver.
  // Normalise to an ISO string (YYYY-MM-DD) before passing to domain functions
  // that call daysBetween() / split('-').
  const dueDateStr: string =
    typeof inv.due_date === 'string'
      ? inv.due_date
      : (inv.due_date as unknown as Date).toISOString().slice(0, 10);

  const { latePenaltyKobo, clientPayableKobo, clientReceivableKobo, isShortfall } =
    computeInvoiceFinancingWithTenor({
      faceValueKobo,
      dueDate: dueDateStr,
      settlementDate,
      tenorDays,
      annualRateBps,
      settlementAmountKobo: actualSettlementKobo,
    });

  // Dr Cash (actual amount collected); Cr Invoice Receivables + Fee Income + Penalty Income + Client Payable/Receivable
  const lines: Array<{ accountCode: string; debitKobo?: bigint; creditKobo?: bigint }> = [
    { accountCode: 'CASH', debitKobo: actualSettlementKobo },
    { accountCode: 'INVOICE_RECV', creditKobo: advanceKobo },
    { accountCode: 'FEE_INC', creditKobo: discountFeeKobo },
  ];

  if (latePenaltyKobo > 0n) {
    lines.push({ accountCode: 'PENALTY_INC', creditKobo: latePenaltyKobo });
  }

  if (clientPayableKobo > 0n) {
    lines.push({ accountCode: 'CLIENT_PAY', creditKobo: clientPayableKobo });
  }

  if (clientReceivableKobo > 0n) {
    lines.push({ accountCode: 'CLIENT_RECV', debitKobo: clientReceivableKobo });
  }

  const entry = await postJournalEntry(client, {
    description: `Invoice settlement for invoice #${invoiceId}`,
    entryDate: settlementDate,
    loanId,
    reference: `INVOICE-SET-${invoiceId}`,
    lines,
  });

  const finalStatus = isShortfall ? 'settled_shortfall' : 'settled';

  await client.query(
    `UPDATE invoice_financings
        SET status=$1, settled_date=$2, settlement_amount_kobo=$3, late_penalty_kobo=$4,
            client_payable_kobo=$5, client_receivable_kobo=$6
      WHERE id=$7`,
    [
      finalStatus, settlementDate, actualSettlementKobo.toString(), latePenaltyKobo.toString(),
      clientPayableKobo.toString(), clientReceivableKobo.toString(), invoiceId,
    ]
  );
  await client.query(
    `UPDATE loans SET status=$1 WHERE id=$2`,
    [finalStatus, loanId]
  );

  return {
    journalEntryId: entry.id,
    clientPayableKobo,
    clientReceivableKobo,
    isShortfall,
  };
}
