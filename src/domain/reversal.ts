/**
 * Reversal Service (Task 4)
 *
 * - Reverses a payment (bounced cheque, wrong loan)
 * - Triggers re-allocation of all subsequent payments
 * - Posts correcting journal entries
 * - Builds audit trail
 */

import pg from 'pg';
import { reverseJournalEntry } from './ledger.js';
import { recomputeAllocations } from './payment.js';

export interface ReversalResult {
  reversedPaymentId: bigint;
  reversalEntryId: bigint;
  correctedPayments: bigint[];
  correctingEntries: bigint[];
  auditTrail: AuditEntry[];
}

export interface AuditEntry {
  event: string;
  paymentId?: bigint;
  entryId?: bigint;
  description: string;
  timestamp: string;
}

export async function reversePayment(
  client: pg.PoolClient,
  paymentId: bigint,
  reversalDate: string,
  reason?: string
): Promise<ReversalResult> {
  const auditTrail: AuditEntry[] = [];

  // Load payment
  const { rows: [payment] } = await client.query<{
    id: string;
    loan_id: string;
    status: string;
    journal_entry_id: string | null;
    amount_kobo: string;
    payment_date: string;
    reversal_of: string | null;
  }>(
    `SELECT id, loan_id, status, journal_entry_id, amount_kobo, payment_date, reversal_of
     FROM payments WHERE id = $1`,
    [paymentId]
  );

  if (!payment) throw new Error(`Payment ${paymentId} not found`);
  if (payment.status === 'reversed') {
    throw Object.assign(new Error(`Payment ${paymentId} is already reversed`), { code: 'ALREADY_REVERSED' });
  }
  if (payment.reversal_of) {
    throw Object.assign(new Error(`Cannot reverse a reversal payment`), { code: 'CANNOT_REVERSE_REVERSAL' });
  }

  const loanId = BigInt(payment.loan_id);

  auditTrail.push({
    event: 'REVERSAL_INITIATED',
    paymentId,
    description: `Payment #${paymentId} of ${payment.amount_kobo} kobo on ${payment.payment_date} being reversed. Reason: ${reason ?? 'not specified'}`,
    timestamp: new Date().toISOString(),
  });

  // 1. Mark original payment as reversed
  await client.query(
    `UPDATE payments SET status='reversed' WHERE id=$1`,
    [paymentId]
  );

  // 2. Create reversal payment record
  const { rows: [revPayRow] } = await client.query<{ id: string }>(
    `INSERT INTO payments (loan_id, amount_kobo, payment_date, status, reversal_of)
     VALUES ($1, $2, $3, 'reversed', $4)
     RETURNING id`,
    [loanId, payment.amount_kobo, reversalDate, paymentId]
  );
  const reversalPaymentId = BigInt(revPayRow!.id);

  // Link back
  await client.query(
    `UPDATE payments SET reversed_by = $1 WHERE id = $2`,
    [reversalPaymentId, paymentId]
  );

  // 3. Reverse the original journal entry
  const originalEntryId = payment.journal_entry_id ? BigInt(payment.journal_entry_id) : null;
  let reversalEntryId: bigint;

  if (originalEntryId) {
    const reversalEntry = await reverseJournalEntry(
      client,
      originalEntryId,
      reversalDate,
      `Reversal of payment #${paymentId}: ${reason ?? 'bounced/wrong loan'}`
    );
    reversalEntryId = reversalEntry.id;

    auditTrail.push({
      event: 'JOURNAL_ENTRY_REVERSED',
      paymentId,
      entryId: reversalEntryId,
      description: `Original journal entry #${originalEntryId} reversed by entry #${reversalEntryId}`,
      timestamp: new Date().toISOString(),
    });
  } else {
    throw new Error(`Payment ${paymentId} has no linked journal entry`);
  }

  // 4. Recompute allocations for all remaining applied payments on this loan
  const { correctedPayments, correctingEntries } = await recomputeAllocations(
    client,
    loanId,
    reversalDate,
    { type: 'payment_reversal', paymentId, reason }
  );

  for (const corrPayId of correctedPayments) {
    auditTrail.push({
      event: 'ALLOCATION_RECOMPUTED',
      paymentId: corrPayId,
      description: `Payment #${corrPayId} re-allocated after reversal of #${paymentId}`,
      timestamp: new Date().toISOString(),
    });
  }

  for (const entryId of correctingEntries) {
    auditTrail.push({
      event: 'CORRECTING_ENTRY_POSTED',
      entryId,
      description: `Correcting journal entry #${entryId} posted for allocation delta`,
      timestamp: new Date().toISOString(),
    });
  }

  auditTrail.push({
    event: 'REVERSAL_COMPLETE',
    paymentId,
    description: `Reversal complete. ${correctedPayments.length} payments re-allocated, ${correctingEntries.length} correcting entries posted.`,
    timestamp: new Date().toISOString(),
  });

  return {
    reversedPaymentId: paymentId,
    reversalEntryId,
    correctedPayments,
    correctingEntries,
    auditTrail,
  };
}
