/**
 * Task 4 — Reversal & Re-allocation Tests
 *
 * Tests the exact scenario from the brief:
 *   Payment X on D1 → clears instalment 1
 *   Payment Y on D2 → clears instalment 2
 *   X is reversed → Y re-allocated to instalment 1, correcting entries posted
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { setupTestDb, teardownTestDb } from './helpers/testDb.js';
import { createTermLoan, runAccrualJob } from '../domain/loanService.js';
import { allocatePayment } from '../domain/payment.js';
import { reversePayment } from '../domain/reversal.js';
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

describe('Task 4 — Reversal & Re-allocation (visible scenario)', () => {
  /**
   * Worked Example 1 loan. Instalment 1 due D1=2026-02-01, Instalment 2 due D2=2026-03-01.
   * Accrual run for both.
   * Payment X: 21,063,026 on D1 → clears instalment 1
   * Payment Y: 21,063,026 on D2 → clears instalment 2
   * X reversed.
   *
   * Expected:
   *   - X marked reversed, instalment 1 → unpaid
   *   - Y re-allocated to instalment 1 (interest 1,800,000, principal 19,263,026)
   *   - Correcting entry for Y's delta: Cr Interest Receivable 288,945; Dr Loans Receivable 288,945
   *   - Loans Receivable nets to 100,736,974
   *   - Interest Receivable nets to 1,511,055
   *   - Trial balance balanced
   */
  it('reversal + re-allocation matches the brief specification exactly', async () => {
    // Create loan
    const loan = await txn((c) =>
      createTermLoan(c, {
        principalKobo: 120_000_000n,
        annualRateBps: 1800,
        termMonths: 6,
        disbursementDate: '2026-01-01',
      })
    );
    const loanId = loan.loanId;

    const D1 = '2026-02-01';
    const D2 = '2026-03-01';

    // Accrue both instalments
    await txn((c) => runAccrualJob(c, D2));

    // Payment X: clears instalment 1
    const payX = await txn(async (c) => {
      await c.query(`SELECT id FROM loans WHERE id=$1 FOR UPDATE`, [loanId]);
      const { rows: [row] } = await c.query<{ id: string }>(
        `INSERT INTO payments (loan_id, amount_kobo, payment_date) VALUES ($1, 21063026, $2) RETURNING id`,
        [loanId, D1]
      );
      const pId = BigInt(row!.id);
      await allocatePayment(c, { paymentId: pId, loanId, amountKobo: 21_063_026n, paymentDate: D1 });
      return pId;
    });

    // Verify instalment 1 is paid
    const { rows: [i1Before] } = await pool.query(
      `SELECT status FROM instalments WHERE loan_id=$1 AND period_number=1`,
      [loanId]
    );
    expect(i1Before.status).toBe('paid');

    // Payment Y: clears instalment 2
    const payY = await txn(async (c) => {
      await c.query(`SELECT id FROM loans WHERE id=$1 FOR UPDATE`, [loanId]);
      const { rows: [row] } = await c.query<{ id: string }>(
        `INSERT INTO payments (loan_id, amount_kobo, payment_date) VALUES ($1, 21063026, $2) RETURNING id`,
        [loanId, D2]
      );
      const pId = BigInt(row!.id);
      await allocatePayment(c, { paymentId: pId, loanId, amountKobo: 21_063_026n, paymentDate: D2 });
      return pId;
    });

    // Verify Y's original allocation: interest 1,511,055, principal 19,551,971 (instalment 2 values)
    const { rows: yAllocsOrig } = await pool.query(
      `SELECT allocation_type, amount_kobo FROM payment_allocations WHERE payment_id=$1`,
      [payY]
    );
    const yOrigInterest = yAllocsOrig.find((a: { allocation_type: string }) => a.allocation_type === 'interest');
    expect(BigInt(yOrigInterest.amount_kobo)).toBe(1_511_055n);

    // Reverse X
    const reversalResult = await txn(async (c) => {
      await c.query(`SELECT id FROM loans WHERE id=$1 FOR UPDATE`, [loanId]);
      return reversePayment(c, payX, '2026-03-01', 'Bounced cheque');
    });

    expect(reversalResult.reversedPaymentId).toBe(payX);
    expect(reversalResult.reversalEntryId).toBeTruthy();
    expect(reversalResult.auditTrail.length).toBeGreaterThan(0);

    // Verify X is reversed
    const { rows: [xRow] } = await pool.query(
      `SELECT status FROM payments WHERE id=$1`,
      [payX]
    );
    expect(xRow.status).toBe('reversed');

    // Verify instalment 2 is now unpaid (pending) since Y was reallocated to instalment 1
    const { rows: [i2After] } = await pool.query(
      `SELECT status FROM instalments WHERE loan_id=$1 AND period_number=2`,
      [loanId]
    );
    expect(i2After.status).toBe('pending');

    // Verify instalment 1 is cleared by Y
    const { rows: [i1After] } = await pool.query(
      `SELECT status FROM instalments WHERE loan_id=$1 AND period_number=1`,
      [loanId]
    );
    expect(i1After.status).toBe('paid');

    // Verify Y's re-allocation: now applied to instalment 1
    // interest = 1,800,000 (instalment 1's interest), principal = 19,263,026
    const { rows: yAllocsNew } = await pool.query(
      `SELECT pa.allocation_type, pa.amount_kobo, pa.correcting_entry_id, i.period_number
       FROM payment_allocations pa
       LEFT JOIN instalments i ON i.id = pa.instalment_id
       WHERE pa.payment_id=$1 AND pa.superseded_by_event_id IS NULL`,
      [payY]
    );
    const yNewInterest = yAllocsNew.find((a: { allocation_type: string }) => a.allocation_type === 'interest');
    const yNewPrincipal = yAllocsNew.find((a: { allocation_type: string }) => a.allocation_type === 'principal');
    expect(BigInt(yNewInterest.amount_kobo)).toBe(1_800_000n);
    expect(BigInt(yNewPrincipal.amount_kobo)).toBe(19_263_026n);
    expect(yNewInterest.period_number).toBe(1); // now on instalment 1
    expect(yNewInterest.correcting_entry_id).toBeTruthy();

    // Verify historical superseded allocation rows are preserved in payment_allocations
    const { rows: yAllocsSuperseded } = await pool.query(
      `SELECT pa.allocation_type, pa.amount_kobo, pa.superseded_by_event_id
       FROM payment_allocations pa
       WHERE pa.payment_id=$1 AND pa.superseded_by_event_id IS NOT NULL`,
      [payY]
    );
    expect(yAllocsSuperseded.length).toBeGreaterThanOrEqual(2);
    const ySupInterest = yAllocsSuperseded.find((a: { allocation_type: string }) => a.allocation_type === 'interest');
    expect(BigInt(ySupInterest.amount_kobo)).toBe(1_511_055n);

    // Verify ledger balances
    const { rows: lrRow } = await pool.query(
      `SELECT COALESCE(SUM(jl.debit_kobo),0) - COALESCE(SUM(jl.credit_kobo),0) AS net
       FROM journal_lines jl
       JOIN journal_entries je ON je.id=jl.entry_id AND je.loan_id=$1
       JOIN accounts a ON a.id=jl.account_id AND a.code='LOANS_RECV'`,
      [loanId]
    );
    // Loans Receivable net = 100,736,974 as specified in brief
    expect(BigInt(lrRow[0].net)).toBe(100_736_974n);

    const { rows: irRow } = await pool.query(
      `SELECT COALESCE(SUM(jl.debit_kobo),0) - COALESCE(SUM(jl.credit_kobo),0) AS net
       FROM journal_lines jl
       JOIN journal_entries je ON je.id=jl.entry_id AND je.loan_id=$1
       JOIN accounts a ON a.id=jl.account_id AND a.code='INTEREST_RECV'`,
      [loanId]
    );
    // Interest Receivable net = 1,511,055 as specified in brief
    expect(BigInt(irRow[0].net)).toBe(1_511_055n);

    // Trial balance balanced
    const client = await pool.connect();
    try {
      const tb = await getTrialBalance(client);
      const totalDebit = tb.reduce((s, r) => s + r.totalDebit, 0n);
      const totalCredit = tb.reduce((s, r) => s + r.totalCredit, 0n);
      expect(totalDebit).toBe(totalCredit);
    } finally {
      client.release();
    }
  });

  it('double reversal is rejected', async () => {
    const loan = await txn((c) =>
      createTermLoan(c, {
        principalKobo: 120_000_000n,
        annualRateBps: 1800,
        termMonths: 6,
        disbursementDate: '2026-04-01',
      })
    );
    await txn((c) => runAccrualJob(c, '2026-05-01'));

    const payId = await txn(async (c) => {
      await c.query(`SELECT id FROM loans WHERE id=$1 FOR UPDATE`, [loan.loanId]);
      const { rows: [row] } = await c.query<{ id: string }>(
        `INSERT INTO payments (loan_id, amount_kobo, payment_date) VALUES ($1, 1000000, '2026-05-01') RETURNING id`,
        [loan.loanId]
      );
      const pId = BigInt(row!.id);
      await allocatePayment(c, { paymentId: pId, loanId: loan.loanId, amountKobo: 1_000_000n, paymentDate: '2026-05-01' });
      return pId;
    });

    await txn(async (c) => {
      await c.query(`SELECT id FROM loans WHERE id=$1 FOR UPDATE`, [loan.loanId]);
      return reversePayment(c, payId, '2026-05-02');
    });

    await expect(
      txn(async (c) => {
        await c.query(`SELECT id FROM loans WHERE id=$1 FOR UPDATE`, [loan.loanId]);
        return reversePayment(c, payId, '2026-05-03');
      })
    ).rejects.toThrow(/already reversed/i);
  });

  it('reallocates the same payment twice across multiple reversals without reference collision and preserves allocation history', async () => {
    const loan = await txn((c) =>
      createTermLoan(c, {
        principalKobo: 120_000_000n,
        annualRateBps: 1800,
        termMonths: 6,
        disbursementDate: '2026-06-01',
      })
    );
    const loanId = loan.loanId;

    // Accrue first 3 instalments
    await txn((c) => runAccrualJob(c, '2026-09-01'));

    // Payment A clears instalment 1
    const payA = await txn(async (c) => {
      await c.query(`SELECT id FROM loans WHERE id=$1 FOR UPDATE`, [loanId]);
      const { rows: [row] } = await c.query<{ id: string }>(
        `INSERT INTO payments (loan_id, amount_kobo, payment_date) VALUES ($1, 21063026, '2026-07-01') RETURNING id`,
        [loanId]
      );
      const pId = BigInt(row!.id);
      await allocatePayment(c, { paymentId: pId, loanId, amountKobo: 21_063_026n, paymentDate: '2026-07-01' });
      return pId;
    });

    // Payment C clears instalment 2
    const payC = await txn(async (c) => {
      await c.query(`SELECT id FROM loans WHERE id=$1 FOR UPDATE`, [loanId]);
      const { rows: [row] } = await c.query<{ id: string }>(
        `INSERT INTO payments (loan_id, amount_kobo, payment_date) VALUES ($1, 21063026, '2026-08-01') RETURNING id`,
        [loanId]
      );
      const pId = BigInt(row!.id);
      await allocatePayment(c, { paymentId: pId, loanId, amountKobo: 21_063_026n, paymentDate: '2026-08-01' });
      return pId;
    });

    // Payment B clears instalment 3
    const payB = await txn(async (c) => {
      await c.query(`SELECT id FROM loans WHERE id=$1 FOR UPDATE`, [loanId]);
      const { rows: [row] } = await c.query<{ id: string }>(
        `INSERT INTO payments (loan_id, amount_kobo, payment_date) VALUES ($1, 21063026, '2026-09-01') RETURNING id`,
        [loanId]
      );
      const pId = BigInt(row!.id);
      await allocatePayment(c, { paymentId: pId, loanId, amountKobo: 21_063_026n, paymentDate: '2026-09-01' });
      return pId;
    });

    // 1. Reverse A -> C moves from inst 2 to inst 1, B moves from inst 3 to inst 2 (1st reallocation of B)
    const revA = await txn(async (c) => {
      await c.query(`SELECT id FROM loans WHERE id=$1 FOR UPDATE`, [loanId]);
      return reversePayment(c, payA, '2026-09-02', 'First reversal');
    });
    expect(revA.correctedPayments).toContain(payB);

    // 2. Reverse C -> B moves from inst 2 to inst 1 (2nd reallocation of B!)
    const revC = await txn(async (c) => {
      await c.query(`SELECT id FROM loans WHERE id=$1 FOR UPDATE`, [loanId]);
      return reversePayment(c, payC, '2026-09-03', 'Second reversal');
    });
    expect(revC.correctedPayments).toContain(payB);

    // Verify 3 versions of B's allocations exist in payment_allocations (original + 2 reallocations)
    const { rows: bVersions } = await pool.query(
      `SELECT DISTINCT COALESCE(created_by_event_id, 0) AS ver FROM payment_allocations WHERE payment_id = $1`,
      [payB]
    );
    expect(bVersions).toHaveLength(3);

    // Verify DELETE on payment_allocations is blocked by trigger
    await expect(
      pool.query(`DELETE FROM payment_allocations WHERE payment_id = $1`, [payB])
    ).rejects.toThrow(/append-only/i);

    // Verify direct SQL UPDATE to immutable columns (amount_kobo, allocation_type) on payment_allocations is blocked
    await expect(
      pool.query(`UPDATE payment_allocations SET amount_kobo = 999 WHERE payment_id = $1`, [payB])
    ).rejects.toThrow(/immutable/i);

    // Verify direct SQL UPDATE attempting to overwrite an already-set superseded_by_event_id is blocked
    await expect(
      pool.query(
        `UPDATE payment_allocations SET superseded_by_event_id = 999999 WHERE payment_id = $1 AND superseded_by_event_id IS NOT NULL`,
        [payB]
      )
    ).rejects.toThrow(/already superseded/i);

    // Verify direct SQL UPDATE and DELETE on reallocation_events are blocked
    await expect(
      pool.query(`DELETE FROM reallocation_events WHERE loan_id = $1`, [loanId])
    ).rejects.toThrow(/append-only/i);
  });
});
