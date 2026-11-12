/**
 * Payment Allocation Engine
 *
 * Waterfall per instalment: penalty → fee → interest → principal
 * Excess sits as unapplied customer credit (liability).
 * Allocates to oldest unpaid, due instalment first.
 */

import pg from 'pg';
import { postJournalEntry, JournalLine } from './ledger.js';

export interface AllocationResult {
  paymentId: bigint;
  journalEntryId?: bigint;
  allocations: Array<{
    instalmentId: bigint | null;
    type: 'penalty' | 'fee' | 'interest' | 'principal' | 'unapplied';
    amountKobo: bigint;
  }>;
  unappliedKobo: bigint;
}

/**
 * Apply a payment to a loan.
 * Must be called inside a transaction with the loan row locked.
 */
export async function allocatePayment(
  client: pg.PoolClient,
  opts: {
    paymentId: bigint;
    loanId: bigint;
    amountKobo: bigint;
    paymentDate: string;
    idempotencyKey?: string;
    postLedgerEntry?: boolean;
    /** Set when called from recomputeAllocations: tags the new allocation version. */
    eventId?: bigint;
  }
): Promise<AllocationResult> {
  const { paymentId, loanId, amountKobo, paymentDate, postLedgerEntry = true, eventId } = opts;
  const eventIdParam = eventId === undefined ? null : eventId.toString();

  // Fetch due, unpaid instalments ordered oldest first
  const { rows: instalments } = await client.query<{
    id: string;
    period_number: number;
    due_date: string;
    interest_kobo: string;
    principal_kobo: string;
    penalty_kobo?: string;
    fee_kobo?: string;
    status: string;
    // already allocated amounts
    paid_interest: string;
    paid_principal: string;
    paid_penalty: string;
    paid_fee: string;
  }>(
    `SELECT
       i.id,
       i.period_number,
       i.due_date,
       i.interest_kobo,
       i.principal_kobo,
       COALESCE(i.penalty_kobo, 0) AS penalty_kobo,
       COALESCE(i.fee_kobo, 0) AS fee_kobo,
       i.status,
       COALESCE(SUM(CASE WHEN pa.allocation_type='interest'  THEN pa.amount_kobo ELSE 0 END), 0) AS paid_interest,
       COALESCE(SUM(CASE WHEN pa.allocation_type='principal' THEN pa.amount_kobo ELSE 0 END), 0) AS paid_principal,
       COALESCE(SUM(CASE WHEN pa.allocation_type='penalty'   THEN pa.amount_kobo ELSE 0 END), 0) AS paid_penalty,
       COALESCE(SUM(CASE WHEN pa.allocation_type='fee'       THEN pa.amount_kobo ELSE 0 END), 0) AS paid_fee
     FROM instalments i
     LEFT JOIN payment_allocations pa
       ON pa.instalment_id = i.id
       AND pa.superseded_by_event_id IS NULL
       AND EXISTS (
         SELECT 1 FROM payments p
         WHERE p.id = pa.payment_id AND p.status = 'applied'
       )
     WHERE i.loan_id = $1
       AND i.status IN ('pending', 'partial')
       AND i.due_date <= $2
     GROUP BY i.id, i.period_number, i.due_date, i.interest_kobo, i.principal_kobo, i.penalty_kobo, i.fee_kobo, i.status
     ORDER BY i.due_date ASC, i.period_number ASC`,
    [loanId, paymentDate]
  );

  let remaining = amountKobo;
  const allocations: AllocationResult['allocations'] = [];

  for (const inst of instalments) {
    if (remaining <= 0n) break;

    const instId = BigInt(inst.id);

    // Remaining owed per category in waterfall order: penalty → fee → interest → principal
    const owedPenalty = BigInt(inst.penalty_kobo ?? '0') - BigInt(inst.paid_penalty);
    const owedFee = BigInt(inst.fee_kobo ?? '0') - BigInt(inst.paid_fee);
    const owedInterest = BigInt(inst.interest_kobo) - BigInt(inst.paid_interest);
    const owedPrincipal = BigInt(inst.principal_kobo) - BigInt(inst.paid_principal);

    // Waterfall: penalty → fee → interest → principal
    const steps: Array<{
      type: 'penalty' | 'fee' | 'interest' | 'principal';
      owed: bigint;
    }> = [
      { type: 'penalty', owed: owedPenalty },
      { type: 'fee', owed: owedFee },
      { type: 'interest', owed: owedInterest },
      { type: 'principal', owed: owedPrincipal },
    ];

    for (const step of steps) {
      if (remaining <= 0n || step.owed <= 0n) continue;
      const apply = remaining < step.owed ? remaining : step.owed;
      remaining -= apply;

      allocations.push({ instalmentId: instId, type: step.type, amountKobo: apply });

      await client.query(
        `INSERT INTO payment_allocations (payment_id, instalment_id, allocation_type, amount_kobo, created_by_event_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [paymentId, instId, step.type, apply.toString(), eventIdParam]
      );
    }

    // Check if instalment is now fully paid (considering all waterfall tiers)
    const { rows: [check] } = await client.query<{
      paid_interest: string;
      paid_principal: string;
      paid_penalty: string;
      paid_fee: string;
    }>(
      `SELECT
         COALESCE(SUM(CASE WHEN pa.allocation_type='interest'  THEN pa.amount_kobo ELSE 0 END), 0) AS paid_interest,
         COALESCE(SUM(CASE WHEN pa.allocation_type='principal' THEN pa.amount_kobo ELSE 0 END), 0) AS paid_principal,
         COALESCE(SUM(CASE WHEN pa.allocation_type='penalty'   THEN pa.amount_kobo ELSE 0 END), 0) AS paid_penalty,
         COALESCE(SUM(CASE WHEN pa.allocation_type='fee'       THEN pa.amount_kobo ELSE 0 END), 0) AS paid_fee
       FROM payment_allocations pa
       JOIN payments p ON p.id = pa.payment_id AND p.status='applied'
       WHERE pa.instalment_id = $1 AND pa.superseded_by_event_id IS NULL`,
      [instId]
    );
    const paidInterest = BigInt(check?.paid_interest ?? '0');
    const paidPrincipal = BigInt(check?.paid_principal ?? '0');
    const paidPenalty = BigInt(check?.paid_penalty ?? '0');
    const paidFee = BigInt(check?.paid_fee ?? '0');
    const totalPaid = paidPenalty + paidFee + paidInterest + paidPrincipal;
    const totalOwed = BigInt(inst.penalty_kobo ?? '0') + BigInt(inst.fee_kobo ?? '0') + BigInt(inst.interest_kobo) + BigInt(inst.principal_kobo);

    if (totalPaid >= totalOwed) {
      await client.query(`UPDATE instalments SET status='paid' WHERE id=$1`, [instId]);
    } else if (totalPaid > 0n) {
      await client.query(`UPDATE instalments SET status='partial' WHERE id=$1`, [instId]);
    }
  }

  // Any leftover → unapplied credit
  const unappliedKobo = remaining;
  if (unappliedKobo > 0n) {
    allocations.push({ instalmentId: null, type: 'unapplied', amountKobo: unappliedKobo });
    await client.query(
      `INSERT INTO payment_allocations (payment_id, instalment_id, allocation_type, amount_kobo, created_by_event_id)
       VALUES ($1, NULL, 'unapplied', $2, $3)`,
      [paymentId, unappliedKobo.toString(), eventIdParam]
    );
  }

  // Build journal entry lines for the payment if postLedgerEntry is true
  // Dr Cash; Cr (Interest Receivable, Loans Receivable, Penalty Income, Fee Income, Unapplied Credit)
  let journalEntryId: bigint | undefined;
  if (postLedgerEntry) {
    const lines: JournalLine[] = [
      { accountCode: 'CASH', debitKobo: amountKobo },
    ];
    for (const alloc of allocations) {
      if (alloc.type === 'interest') {
        lines.push({ accountCode: 'INTEREST_RECV', creditKobo: alloc.amountKobo });
      } else if (alloc.type === 'principal') {
        lines.push({ accountCode: 'LOANS_RECV', creditKobo: alloc.amountKobo });
      } else if (alloc.type === 'penalty') {
        lines.push({ accountCode: 'PENALTY_INC', creditKobo: alloc.amountKobo });
      } else if (alloc.type === 'fee') {
        lines.push({ accountCode: 'FEE_INC', creditKobo: alloc.amountKobo });
      } else if (alloc.type === 'unapplied') {
        lines.push({ accountCode: 'UNAPPLIED_CREDIT', creditKobo: alloc.amountKobo });
      }
    }

    const journalEntry = await postJournalEntry(client, {
      description: `Payment allocation for loan #${loanId}`,
      entryDate: paymentDate,
      loanId,
      reference: `PAY-${paymentId}`,
      lines,
    });
    journalEntryId = journalEntry.id;

    // Link journal entry to payment
    await client.query(
      `UPDATE payments SET journal_entry_id = $1 WHERE id = $2`,
      [journalEntry.id, paymentId]
    );
  }

  return {
    paymentId,
    journalEntryId,
    allocations,
    unappliedKobo,
  };
}

export interface ReallocationTrigger {
  type: 'payment_reversal' | 'out_of_order_payment';
  paymentId: bigint;
  reason?: string;
}

/**
 * Recompute allocations for all applied payments on a loan, in value-date order.
 *
 * Audit model (append-only):
 *  - a reallocation_events row is created for every recomputation;
 *  - the previous ACTIVE allocation rows are marked superseded by that event
 *    (never deleted) and new rows are inserted, tagged with the same event;
 *  - each payment's delta is posted as a correcting journal entry whose reference
 *    is unique per (payment, event), and is linked back to the new allocation rows.
 *
 * Must run inside a transaction holding the loan row lock.
 */
export async function recomputeAllocations(
  client: pg.PoolClient,
  loanId: bigint,
  effectiveDate: string,
  trigger: ReallocationTrigger
): Promise<{ correctedPayments: bigint[]; correctingEntries: bigint[]; eventId: bigint }> {
  const { rows: [eventRow] } = await client.query<{ id: string }>(
    `INSERT INTO reallocation_events (loan_id, trigger_type, trigger_payment_id, reason, effective_date)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [loanId, trigger.type, trigger.paymentId, trigger.reason ?? null, effectiveDate]
  );
  const eventId = BigInt(eventRow!.id);
  const reversalDate = effectiveDate;

  // Reset all instalment statuses to pending
  const { rows: loanInstalments } = await client.query<{ id: string }>(
    `SELECT id FROM instalments WHERE loan_id = $1 ORDER BY period_number ASC`,
    [loanId]
  );
  for (const inst of loanInstalments) {
    await client.query(`UPDATE instalments SET status='pending' WHERE id=$1`, [inst.id]);
  }

  // Get all applied (non-reversed) payments in value-date order
  const { rows: payments } = await client.query<{
    id: string;
    amount_kobo: string;
    payment_date: string;
    journal_entry_id: string | null;
  }>(
    `SELECT id, amount_kobo, payment_date, journal_entry_id
     FROM payments
     WHERE loan_id = $1 AND status = 'applied'
     ORDER BY payment_date ASC, id ASC`,
    [loanId]
  );

  // Snapshot the currently active allocations of EVERY applied payment, then supersede
  // them all up-front so that no stale row from a later payment is counted as "already
  // paid" while an earlier payment is being recomputed.
  const paymentIds = payments.map((p) => p.id);
  const { rows: activeRows } = await client.query<{
    payment_id: string;
    allocation_type: string;
    amount_kobo: string;
  }>(
    `SELECT payment_id, allocation_type, amount_kobo
     FROM payment_allocations
     WHERE payment_id = ANY($1::bigint[]) AND superseded_by_event_id IS NULL`,
    [paymentIds]
  );
  await client.query(
    `UPDATE payment_allocations SET superseded_by_event_id = $2
     WHERE payment_id = ANY($1::bigint[]) AND superseded_by_event_id IS NULL`,
    [paymentIds, eventId.toString()]
  );
  const oldByPayment = new Map<string, Array<{ allocation_type: string; amount_kobo: string }>>();
  for (const r of activeRows) {
    const list = oldByPayment.get(r.payment_id) ?? [];
    list.push(r);
    oldByPayment.set(r.payment_id, list);
  }

  const correctedPayments: bigint[] = [];
  const correctingEntries: bigint[] = [];

  for (const payment of payments) {
    const paymentId = BigInt(payment.id);
    const amountKobo = BigInt(payment.amount_kobo);

    // Previous ACTIVE allocation rows (already superseded above; kept for history)
    const oldAllocs = oldByPayment.get(payment.id) ?? [];

    // Re-run allocation without posting a new payment journal entry
    const result = await allocatePayment(client, {
      paymentId,
      loanId,
      amountKobo,
      paymentDate: payment.payment_date,
      postLedgerEntry: false,
      eventId,
    });

    // Aggregate old allocations by general ledger account
    const oldAccountTotals = new Map<string, bigint>();
    for (const a of oldAllocs) {
      const acct = allocTypeToAccount(a.allocation_type);
      if (acct) {
        oldAccountTotals.set(acct, (oldAccountTotals.get(acct) ?? 0n) + BigInt(a.amount_kobo));
      }
    }

    // Aggregate new allocations by general ledger account
    const newAccountTotals = new Map<string, bigint>();
    for (const a of result.allocations) {
      const acct = allocTypeToAccount(a.type);
      if (acct) {
        newAccountTotals.set(acct, (newAccountTotals.get(acct) ?? 0n) + a.amountKobo);
      }
    }

    // Compare account totals:
    // Payments normally CREDIT these asset/revenue/liability accounts (and debit Cash).
    // An increase in credit to account X needs Cr X.
    // A decrease in credit to account X needs Dr X.
    const allAccounts = new Set([...oldAccountTotals.keys(), ...newAccountTotals.keys()]);
    const deltaLines: JournalLine[] = [];

    for (const acct of allAccounts) {
      const oldAmt = oldAccountTotals.get(acct) ?? 0n;
      const newAmt = newAccountTotals.get(acct) ?? 0n;
      const diff = newAmt - oldAmt;

      if (diff > 0n) {
        deltaLines.push({ accountCode: acct, creditKobo: diff });
      } else if (diff < 0n) {
        deltaLines.push({ accountCode: acct, debitKobo: -diff });
      }
    }

    if (deltaLines.length >= 2) {
      const correctingEntry = await postJournalEntry(client, {
        description: `Re-allocation delta for payment #${paymentId} (reallocation event #${eventId}: ${trigger.type} of payment #${trigger.paymentId})`,
        entryDate: reversalDate,
        loanId,
        // Unique per (payment, event): the same payment can be reallocated many times.
        reference: `REALLOC-${paymentId}-E${eventId}`,
        lines: deltaLines,
      });

      // Link this allocation version to the journal entry that booked its delta
      await client.query(
        `UPDATE payment_allocations SET correcting_entry_id = $1
         WHERE payment_id = $2 AND created_by_event_id = $3 AND correcting_entry_id IS NULL`,
        [correctingEntry.id.toString(), paymentId.toString(), eventId.toString()]
      );

      correctedPayments.push(paymentId);
      correctingEntries.push(correctingEntry.id);
    }
  }

  return { correctedPayments, correctingEntries, eventId };
}

function allocTypeToAccount(type: string): string | null {
  switch (type) {
    case 'interest': return 'INTEREST_RECV';
    case 'principal': return 'LOANS_RECV';
    case 'penalty': return 'PENALTY_INC';
    case 'fee': return 'FEE_INC';
    case 'unapplied': return 'UNAPPLIED_CREDIT';
    default: return null;
  }
}
