/**
 * Task 2 & 3 — Idempotency + Concurrency Tests
 *
 * Task 2: 50 simultaneous requests with the same key → exactly 1 journal entry
 * Task 3: 50 parallel different payments → correct waterfall, balanced trial balance
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { setupTestDb, teardownTestDb } from './helpers/testDb.js';
import { createTermLoan, runAccrualJob } from '../domain/loanService.js';
import { withIdempotency } from '../domain/idempotency.js';
import { allocatePayment } from '../domain/payment.js';
import { getTrialBalance } from '../domain/ledger.js';

let pool: pg.Pool;

beforeAll(async () => {
  pool = await setupTestDb();
}, 120_000);

afterAll(async () => {
  await teardownTestDb();
});

async function txn<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

describe('Task 2 — Idempotent payments', () => {
  it('50 simultaneous requests with same key produce exactly 1 journal entry', async () => {
    // Setup loan
    const loan = await txn((c) =>
      createTermLoan(c, {
        principalKobo: 120_000_000n,
        annualRateBps: 1800,
        termMonths: 6,
        disbursementDate: '2026-01-01',
      })
    );
    await txn((c) => runAccrualJob(c, '2026-02-01'));

    const idempotencyKey = `test-idempotency-${Date.now()}`;
    const requestBody = { loanId: loan.loanId.toString(), amountKobo: '21063026', paymentDate: '2026-02-01' };

    // 50 concurrent requests
    const requests = Array.from({ length: 50 }, async () => {
      const client = await pool.connect();
      await client.query('BEGIN');
      try {
        const result = await withIdempotency(
          client,
          idempotencyKey,
          requestBody,
          async () => {
            // Lock loan
            await client.query(`SELECT id FROM loans WHERE id=$1 FOR UPDATE`, [loan.loanId]);
            const { rows: [pmtRow] } = await client.query<{ id: string }>(
              `INSERT INTO payments (loan_id, amount_kobo, payment_date, idempotency_key)
               VALUES ($1, $2, $3, $4) RETURNING id`,
              [loan.loanId, '21063026', '2026-02-01', idempotencyKey]
            );
            const paymentId = BigInt(pmtRow!.id);
            const alloc = await allocatePayment(client, {
              paymentId,
              loanId: loan.loanId,
              amountKobo: 21_063_026n,
              paymentDate: '2026-02-01',
            });
            return { data: { paymentId: paymentId.toString(), journalEntryId: alloc.journalEntryId!.toString() }, statusCode: 201 };
          }
        );
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    });

    const results = await Promise.allSettled(requests);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(50);

    // All should return the same journal entry ID
    const entryIds = new Set(
      fulfilled.map((r) => (r as PromiseFulfilledResult<{ data: { journalEntryId: string } }>).value.data.journalEntryId)
    );
    expect(entryIds.size).toBe(1); // exactly 1 journal entry

    // Count actual journal entries in DB for this loan
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM journal_entries
       WHERE loan_id=$1 AND description LIKE 'Payment allocation%'`,
      [loan.loanId]
    );
    expect(Number(rows[0].cnt)).toBe(1);
  });

  it('same key + different body → conflict error', async () => {
    const loan = await txn((c) =>
      createTermLoan(c, {
        principalKobo: 120_000_000n,
        annualRateBps: 1800,
        termMonths: 6,
        disbursementDate: '2026-03-01',
      })
    );

    const key = `conflict-test-${Date.now()}`;
    const body1 = { loanId: loan.loanId.toString(), amountKobo: '1000000' };
    const body2 = { loanId: loan.loanId.toString(), amountKobo: '2000000' };

    // First request
    const client1 = await pool.connect();
    await client1.query('BEGIN');
    await withIdempotency(client1, key, body1, async () => ({ data: { ok: true }, statusCode: 201 }));
    await client1.query('COMMIT');
    client1.release();

    // Second request with different body
    const client2 = await pool.connect();
    await client2.query('BEGIN');
    await expect(
      withIdempotency(client2, key, body2, async () => ({ data: { ok: true }, statusCode: 201 }))
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
    await client2.query('ROLLBACK');
    client2.release();
  });
});

describe('Task 3 — Concurrency: 50 parallel payments, 1 loan', () => {
  /**
   * Scenario:
   *  - Loan: 120,000,000 kobo, 18%, 6 months
   *  - Only instalment 1 is due (and accrued)
   *  - 50 payments of 1,000,000 kobo each arrive simultaneously
   *
   * Expected:
   *  - Exactly 21,063,026 applied to instalment 1
   *  - Remaining 28,936,974 as unapplied credit
   *  - Trial balance is balanced
   */
  it('50 parallel payments produce correct allocation and balanced trial balance', async () => {
    const loan = await txn((c) =>
      createTermLoan(c, {
        principalKobo: 120_000_000n,
        annualRateBps: 1800,
        termMonths: 6,
        disbursementDate: '2026-01-15',
      })
    );

    // Only accrue instalment 1
    await txn((c) => runAccrualJob(c, '2026-02-15'));

    const PAYMENT_AMOUNT = 1_000_000n;
    const N = 50;
    const totalPayments = PAYMENT_AMOUNT * BigInt(N); // 50,000,000

    // Fire 50 concurrent payments
    const tasks = Array.from({ length: N }, async (_, i) => {
      const client = await pool.connect();
      await client.query('BEGIN');
      try {
        // Row-lock the loan — this serializes all concurrent payments
        await client.query(`SELECT id FROM loans WHERE id=$1 FOR UPDATE`, [loan.loanId]);

        const { rows: [pmtRow] } = await client.query<{ id: string }>(
          `INSERT INTO payments (loan_id, amount_kobo, payment_date)
           VALUES ($1, $2, $3) RETURNING id`,
          [loan.loanId, PAYMENT_AMOUNT.toString(), '2026-02-15']
        );
        const paymentId = BigInt(pmtRow!.id);

        await allocatePayment(client, {
          paymentId,
          loanId: loan.loanId,
          amountKobo: PAYMENT_AMOUNT,
          paymentDate: '2026-02-15',
        });

        await client.query('COMMIT');
        return { ok: true, paymentId };
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    });

    const results = await Promise.all(tasks);
    expect(results.every((r) => r.ok)).toBe(true);

    // Verify allocations
    const { rows: allocRows } = await pool.query(
      `SELECT pa.allocation_type, SUM(pa.amount_kobo)::bigint AS total
       FROM payment_allocations pa
       JOIN payments p ON p.id = pa.payment_id
       WHERE p.loan_id = $1 AND p.status = 'applied'
       GROUP BY pa.allocation_type`,
      [loan.loanId]
    );

    const allocMap = new Map<string, bigint>();
    for (const r of allocRows) allocMap.set(r.allocation_type, BigInt(r.total));

    const appliedInterest = allocMap.get('interest') ?? 0n;
    const appliedPrincipal = allocMap.get('principal') ?? 0n;
    const unapplied = allocMap.get('unapplied') ?? 0n;

    // Total applied to instalment 1 = 21,063,026 (interest 1,800,000 + principal 19,263,026)
    expect(appliedInterest + appliedPrincipal).toBe(21_063_026n);
    expect(appliedInterest).toBe(1_800_000n);
    expect(appliedPrincipal).toBe(19_263_026n);
    expect(unapplied).toBe(28_936_974n);
    expect(appliedInterest + appliedPrincipal + unapplied).toBe(totalPayments);

    // Trial balance must be balanced
    const client = await pool.connect();
    try {
      const tb = await getTrialBalance(client);
      const totalDebit = tb.reduce((s, r) => s + r.totalDebit, 0n);
      const totalCredit = tb.reduce((s, r) => s + r.totalCredit, 0n);
      expect(totalDebit).toBe(totalCredit);
    } finally {
      client.release();
    }
  }, 60_000);
});
