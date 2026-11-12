/**
 * Integration tests: full loan lifecycle, ledger, payment allocation
 * Uses a real Postgres container via Testcontainers.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { setupTestDb, teardownTestDb } from './helpers/testDb.js';
import { createTermLoan, createInvoiceFinancing, settleInvoice, runAccrualJob } from '../domain/loanService.js';
import { allocatePayment } from '../domain/payment.js';
import { getTrialBalance } from '../domain/ledger.js';
import { closePeriod, reconcile } from '../domain/periodClose.js';

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

describe('Term loan creation & schedule', () => {
  it('creates a loan matching Worked Example 1 exactly', async () => {
    const result = await txn((c) =>
      createTermLoan(c, {
        principalKobo: 120_000_000n,
        annualRateBps: 1800,
        termMonths: 6,
        disbursementDate: '2026-01-01',
      })
    );

    expect(result.loanId).toBeTruthy();
    expect(result.disbursementEntryId).toBeTruthy();

    // Verify schedule in DB
    const { rows } = await pool.query(
      `SELECT * FROM instalments WHERE loan_id = $1 ORDER BY period_number`,
      [result.loanId]
    );
    expect(rows).toHaveLength(6);
    expect(BigInt(rows[0].instalment_kobo)).toBe(21_063_026n);
    expect(BigInt(rows[0].interest_kobo)).toBe(1_800_000n);
    expect(BigInt(rows[0].principal_kobo)).toBe(19_263_026n);
    expect(BigInt(rows[0].closing_balance)).toBe(100_736_974n);
    // Final instalment
    expect(BigInt(rows[5].closing_balance)).toBe(0n);
    expect(BigInt(rows[5].instalment_kobo)).toBe(21_063_024n);
  });

  it('disbursement journal entry is balanced', async () => {
    const result = await txn((c) =>
      createTermLoan(c, {
        principalKobo: 120_000_000n,
        annualRateBps: 1800,
        termMonths: 6,
        disbursementDate: '2026-02-01',
      })
    );

    const { rows } = await pool.query(
      `SELECT SUM(debit_kobo) AS d, SUM(credit_kobo) AS c
       FROM journal_lines WHERE entry_id = $1`,
      [result.disbursementEntryId]
    );
    expect(BigInt(rows[0].d)).toBe(BigInt(rows[0].c));
  });
});

describe('Journal entry immutability', () => {
  it('blocks UPDATE on journal_entries', async () => {
    const result = await txn((c) =>
      createTermLoan(c, {
        principalKobo: 120_000_000n,
        annualRateBps: 1800,
        termMonths: 6,
        disbursementDate: '2026-03-01',
      })
    );

    await expect(
      pool.query(`UPDATE journal_entries SET description='HACK' WHERE id=$1`, [result.disbursementEntryId])
    ).rejects.toThrow(/immutable/i);
  });

  it('blocks DELETE on journal_lines', async () => {
    const result = await txn((c) =>
      createTermLoan(c, {
        principalKobo: 120_000_000n,
        annualRateBps: 1800,
        termMonths: 6,
        disbursementDate: '2026-04-01',
      })
    );
    await expect(
      pool.query(`DELETE FROM journal_lines WHERE entry_id=$1`, [result.disbursementEntryId])
    ).rejects.toThrow(/immutable/i);
  });

  it('rejects an unbalanced journal entry', async () => {
    // The deferred trigger catches this at commit time
    const client = await pool.connect();
    await client.query('BEGIN');
    try {
      const { rows: [loanRow] } = await client.query(
        `INSERT INTO loans (loan_type, disbursement_date) VALUES ('term_loan', '2026-01-01') RETURNING id`
      );
      const { rows: [entry] } = await client.query(
        `INSERT INTO journal_entries (description, entry_date, loan_id) VALUES ('bad', '2026-01-01', $1) RETURNING id`,
        [loanRow.id]
      );
      // Insert only one side — debit only
      const { rows: [acct] } = await client.query(`SELECT id FROM accounts WHERE code='CASH'`);
      await client.query(
        `INSERT INTO journal_lines (entry_id, account_id, debit_kobo, credit_kobo) VALUES ($1, $2, 1000, 0)`,
        [entry.id, acct.id]
      );
      await expect(client.query('COMMIT')).rejects.toThrow(/unbalanced|at least 2 lines/i);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});

describe('Payment allocation waterfall', () => {
  it('applies payment to oldest instalment first (penalty→fee→interest→principal)', async () => {
    // Create loan
    const loan = await txn((c) =>
      createTermLoan(c, {
        principalKobo: 120_000_000n,
        annualRateBps: 1800,
        termMonths: 6,
        disbursementDate: '2026-01-01',
      })
    );

    // Run accrual for instalment 1 due 2026-02-01
    await txn((c) => runAccrualJob(c, '2026-02-01'));

    // Pay exactly the first instalment
    const payResult = await txn(async (c) => {
      const { rows: [pmtRow] } = await c.query<{ id: string }>(
        `INSERT INTO payments (loan_id, amount_kobo, payment_date) VALUES ($1, $2, $3) RETURNING id`,
        [loan.loanId, '21063026', '2026-02-01']
      );
      return allocatePayment(c, {
        paymentId: BigInt(pmtRow!.id),
        loanId: loan.loanId,
        amountKobo: 21_063_026n,
        paymentDate: '2026-02-01',
      });
    });

    expect(payResult.unappliedKobo).toBe(0n);
    const interestAlloc = payResult.allocations.find((a) => a.type === 'interest');
    const principalAlloc = payResult.allocations.find((a) => a.type === 'principal');
    expect(interestAlloc?.amountKobo).toBe(1_800_000n);
    expect(principalAlloc?.amountKobo).toBe(19_263_026n);

    // Instalment 1 should now be 'paid'
    const { rows } = await pool.query(
      `SELECT status FROM instalments WHERE loan_id=$1 AND period_number=1`,
      [loan.loanId]
    );
    expect(rows[0].status).toBe('paid');
  });

  it('puts excess in unapplied credit', async () => {
    const loan = await txn((c) =>
      createTermLoan(c, {
        principalKobo: 120_000_000n,
        annualRateBps: 1800,
        termMonths: 6,
        disbursementDate: '2026-05-01',
      })
    );

    await txn((c) => runAccrualJob(c, '2026-06-01'));

    // Overpay by 1,000,000 kobo
    const payResult = await txn(async (c) => {
      const { rows: [pmtRow] } = await c.query<{ id: string }>(
        `INSERT INTO payments (loan_id, amount_kobo, payment_date) VALUES ($1, $2, $3) RETURNING id`,
        [loan.loanId, '22063026', '2026-06-01']
      );
      return allocatePayment(c, {
        paymentId: BigInt(pmtRow!.id),
        loanId: loan.loanId,
        amountKobo: 22_063_026n,
        paymentDate: '2026-06-01',
      });
    });

    expect(payResult.unappliedKobo).toBe(1_000_000n);
  });
});

describe('Accrual job', () => {
  it('posts interest receivable entries for due instalments', async () => {
    const loan = await txn((c) =>
      createTermLoan(c, {
        principalKobo: 120_000_000n,
        annualRateBps: 1800,
        termMonths: 6,
        disbursementDate: '2026-06-01',
      })
    );

    const result = await txn((c) => runAccrualJob(c, '2026-07-01'));
    expect(result.accruedCount).toBeGreaterThanOrEqual(1);

    // Instalment 1 should now have accrued=true
    const { rows } = await pool.query(
      `SELECT accrued FROM instalments WHERE loan_id=$1 AND period_number=1`,
      [loan.loanId]
    );
    expect(rows[0].accrued).toBe(true);

    // Check journal entry: Dr Interest Receivable, Cr Interest Income
    const { rows: lines } = await pool.query(
      `SELECT a.code, jl.debit_kobo, jl.credit_kobo
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
       JOIN journal_entries je ON je.id = jl.entry_id AND je.loan_id = $1
       WHERE a.code IN ('INTEREST_RECV','INTEREST_INC')`,
      [loan.loanId]
    );
    const irDr = lines.find((l: { code: string }) => l.code === 'INTEREST_RECV');
    const iiCr = lines.find((l: { code: string }) => l.code === 'INTEREST_INC');
    expect(BigInt(irDr.debit_kobo)).toBe(1_800_000n);
    expect(BigInt(iiCr.credit_kobo)).toBe(1_800_000n);
  });

  it('does not double-accrue', async () => {
    const loan = await txn((c) =>
      createTermLoan(c, {
        principalKobo: 120_000_000n,
        annualRateBps: 1800,
        termMonths: 6,
        disbursementDate: '2026-07-01',
      })
    );

    await txn((c) => runAccrualJob(c, '2026-08-01'));
    const result2 = await txn((c) => runAccrualJob(c, '2026-08-01'));
    // Should not accrue again for the same instalment
    expect(result2.accruedCount).toBe(0);
  });
});

describe('Period close', () => {
  it('rejects journal entries in a closed period', async () => {
    // Close 2026-01
    await txn((c) => closePeriod(c, 2026, 1));

    // Try to create a loan with disbursement in that period
    await expect(
      txn((c) =>
        createTermLoan(c, {
          principalKobo: 120_000_000n,
          annualRateBps: 1800,
          termMonths: 6,
          disbursementDate: '2026-01-15', // in closed period
        })
      )
    ).rejects.toThrow(/closed/i);
  });
});

describe('Zero-interest loans (Issue 2 fix)', () => {
  it('creates and persists a zero-interest loan in database', async () => {
    const result = await txn((c) =>
      createTermLoan(c, {
        principalKobo: 60_000_000n,
        annualRateBps: 0,
        termMonths: 6,
        disbursementDate: '2026-08-01',
      })
    );
    expect(result.loanId).toBeTruthy();

    const { rows } = await pool.query(
      `SELECT * FROM instalments WHERE loan_id = $1 ORDER BY period_number`,
      [result.loanId]
    );
    expect(rows).toHaveLength(6);
    expect(BigInt(rows[0].interest_kobo)).toBe(0n);
    expect(BigInt(rows[0].instalment_kobo)).toBe(10_000_000n);
  });
});

describe('Invoice financing partial and excess settlements (Issue 3 fix)', () => {
  it('settles invoice with partial payment resulting in shortfall', async () => {
    const inv = await txn((c) =>
      createInvoiceFinancing(c, {
        faceValueKobo: 1_000_000_000n, // ₦10m
        dueDate: '2026-09-01',
        disbursementDate: '2026-07-03',
        annualRateBps: 3600,
      })
    );

    // Debtor only settles ₦8,000,000 (800,000,000 kobo)
    const settle = await txn((c) =>
      settleInvoice(c, inv.invoiceId, '2026-09-01', 800_000_000n)
    );

    expect(settle.isShortfall).toBe(true);
    expect(settle.clientReceivableKobo).toBeGreaterThan(0n);

    // Verify trial balance remains balanced
    const client = await pool.connect();
    try {
      const rows = await getTrialBalance(client);
      const totalDebit = rows.reduce((s, r) => s + r.totalDebit, 0n);
      const totalCredit = rows.reduce((s, r) => s + r.totalCredit, 0n);
      expect(totalDebit).toBe(totalCredit);
    } finally {
      client.release();
    }
  });

  it('settles invoice with excess payment crediting client payable', async () => {
    const inv = await txn((c) =>
      createInvoiceFinancing(c, {
        faceValueKobo: 1_000_000_000n,
        dueDate: '2026-09-15',
        disbursementDate: '2026-07-17',
        annualRateBps: 3600,
      })
    );

    // Debtor pays ₦1,050,000,000
    const settle = await txn((c) =>
      settleInvoice(c, inv.invoiceId, '2026-09-15', 1_050_000_000n)
    );

    expect(settle.isShortfall).toBe(false);
    expect(settle.clientPayableKobo).toBeGreaterThan(0n);
  });
});

describe('Payment waterfall with penalty and fees (Issue 4 fix)', () => {
  it('allocates strictly in waterfall order: penalty -> fee -> interest -> principal', async () => {
    const loan = await txn((c) =>
      createTermLoan(c, {
        principalKobo: 10_000_000n,
        annualRateBps: 1800,
        termMonths: 1,
        disbursementDate: '2026-09-01',
      })
    );

    // Set penalty and fee on the instalment
    await pool.query(
      `UPDATE instalments SET penalty_kobo = 500000, fee_kobo = 1000000 WHERE loan_id = $1`,
      [loan.loanId]
    );

    // Create payment of ₦10,000 (1,000,000 kobo).
    // Owed: penalty 500k, fee 1,000k, interest ~150k, principal 10,000k
    // 1,000k payment should clear 500k penalty, then 500k of fee, leaving 0 for interest & principal
    const { rows: [pmtRow] } = await pool.query<{ id: string }>(
      `INSERT INTO payments (loan_id, amount_kobo, payment_date) VALUES ($1, 1000000, '2026-10-01') RETURNING id`,
      [loan.loanId]
    );

    const allocResult = await txn((c) =>
      allocatePayment(c, {
        paymentId: BigInt(pmtRow!.id),
        loanId: loan.loanId,
        amountKobo: 1_000_000n,
        paymentDate: '2026-10-01',
      })
    );

    expect(allocResult.allocations).toEqual([
      { instalmentId: expect.any(BigInt), type: 'penalty', amountKobo: 500_000n },
      { instalmentId: expect.any(BigInt), type: 'fee', amountKobo: 500_000n },
    ]);
  });
});

describe('Accrual concurrency safety (Issue 6 fix)', () => {
  it('concurrent accrual jobs do not double-post entries', async () => {
    const loan = await txn((c) =>
      createTermLoan(c, {
        principalKobo: 50_000_000n,
        annualRateBps: 1800,
        termMonths: 3,
        disbursementDate: '2026-10-01',
      })
    );

    // Run 2 parallel accruals for the same due date
    const [res1, res2] = await Promise.all([
      txn((c) => runAccrualJob(c, '2026-11-01')),
      txn((c) => runAccrualJob(c, '2026-11-01')),
    ]);
    // res1/res2 accruedCount reflect all loans in the shared DB, so we cannot
    // assert totalAccrued === 1. Instead verify this specific loan's first
    // instalment was accrued exactly once.
    void res1; void res2;

    // Instalment for period 1 (due 2026-11-01) must be marked accrued exactly once
    const { rows: instRows } = await pool.query(
      `SELECT accrued FROM instalments WHERE loan_id = $1 AND period_number = 1`,
      [loan.loanId]
    );
    expect(instRows[0].accrued).toBe(true);

    // There must be exactly 1 interest-accrual journal entry for this specific loan
    const { rows: entryRows } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM journal_entries
       WHERE loan_id = $1 AND description LIKE 'Interest accrual%'`,
      [loan.loanId]
    );
    expect(Number(entryRows[0].cnt)).toBe(1);
  });
});

describe('Database-level journal entry invariant (empty entry rejection)', () => {
  it('rejects raw SQL insertion of journal entry with 0 lines at transaction commit', async () => {
    await expect(
      txn(async (c) => {
        await c.query(
          `INSERT INTO journal_entries (description, entry_date) VALUES ('Empty rogue entry', '2026-10-01')`
        );
      })
    ).rejects.toThrow(/must have at least 2 lines/);
  });
});

describe('Full ledger reconciliation across all products', () => {
  it('supports zero-discount-rate invoice financing and rejects equal disbursement/due dates', async () => {
    const invZero = await txn((c) =>
      createInvoiceFinancing(c, {
        faceValueKobo: 500_000_000n,
        dueDate: '2026-10-15',
        disbursementDate: '2026-09-15',
        annualRateBps: 0,
      })
    );
    expect(invZero.discountFeeKobo).toBe(0n);

    await expect(
      txn((c) =>
        createInvoiceFinancing(c, {
          faceValueKobo: 500_000_000n,
          dueDate: '2026-09-15',
          disbursementDate: '2026-09-15',
          annualRateBps: 3600,
        })
      )
    ).rejects.toThrow(/at least.+day after/i);
  });

  it('rejects a second settlement attempt on a settled_shortfall invoice', async () => {
    const inv = await txn((c) =>
      createInvoiceFinancing(c, {
        faceValueKobo: 1_000_000_000n,
        dueDate: '2026-10-01',
        disbursementDate: '2026-08-02',
        annualRateBps: 3600,
      })
    );

    const firstSettle = await txn((c) =>
      settleInvoice(c, inv.invoiceId, '2026-10-01', 700_000_000n)
    );
    expect(firstSettle.isShortfall).toBe(true);

    await expect(
      txn((c) => settleInvoice(c, inv.invoiceId, '2026-10-05', 300_000_000n))
    ).rejects.toThrow(/already settled/i);
  });

  it('reconciles control accounts and sub-ledgers for term loans and invoice financings', async () => {
    const client = await pool.connect();
    try {
      const recon = await reconcile(client);
      expect(recon.balanced).toBe(true);
      expect(recon.differences).toHaveLength(0);
      expect(recon.invoiceBreakdown.length).toBeGreaterThan(0);
    } finally {
      client.release();
    }
  });

  it('detects and pinpoints deliberate discrepancies per loan, per invoice, and at the global control level', async () => {
    const client = await pool.connect();
    await client.query('BEGIN');
    try {
      // 1. Create a settled loan and deliberately tamper with its sub-ledger instalment principal
      const settledLoan = await createTermLoan(client, {
        principalKobo: 10_000_000n,
        annualRateBps: 0,
        termMonths: 1,
        disbursementDate: '2026-10-01',
      });
      await client.query(`UPDATE loans SET status = 'settled' WHERE id = $1`, [settledLoan.loanId]);
      // Tamper with instalment principal by +500 kobo so sub-ledger != LOANS_RECV
      await client.query(
        `UPDATE instalments SET principal_kobo = principal_kobo + 500 WHERE loan_id = $1`,
        [settledLoan.loanId]
      );

      // 2. Post an unlinked journal entry (loan_id IS NULL) between LOANS_RECV and CASH
      const { rows: accts } = await client.query<{ id: number; code: string }>(
        `SELECT id, code FROM accounts WHERE code IN ('LOANS_RECV', 'CASH')`
      );
      const lrAcct = accts.find((a) => a.code === 'LOANS_RECV')!.id;
      const cashAcct = accts.find((a) => a.code === 'CASH')!.id;
      const { rows: [rogueEntry] } = await client.query<{ id: string }>(
        `INSERT INTO journal_entries (description, entry_date, loan_id) VALUES ('Unlinked manual adjustment', '2026-10-02', NULL) RETURNING id`
      );
      await client.query(
        `INSERT INTO journal_lines (entry_id, account_id, debit_kobo, credit_kobo) VALUES ($1, $2, 777, 0), ($1, $3, 0, 777)`,
        [rogueEntry!.id, lrAcct, cashAcct]
      );

      const recon = await reconcile(client);
      expect(recon.balanced).toBe(false);

      // Verify the settled loan discrepancy is specifically identified
      const settledDiff = recon.differences.find(
        (d) => d.loanId === settledLoan.loanId && d.account === 'LOANS_RECV'
      );
      expect(settledDiff).toBeDefined();
      expect(settledDiff!.diff).toBe(-500n);

      // Verify the global control vs sub-ledger discrepancy (loanId = 0n) is identified
      const globalDiff = recon.differences.find(
        (d) => d.loanId === 0n && d.account === 'LOANS_RECV'
      );
      expect(globalDiff).toBeDefined();
      expect(globalDiff!.diff).toBe(277n); // +777 unlinked control debit - 500 sub-ledger tamper
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
