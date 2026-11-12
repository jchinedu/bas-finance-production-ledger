/**
 * Double-Entry Ledger Engine
 *
 * Rules:
 *  - Every entry has ≥2 lines, total debits = total credits in kobo
 *  - Entries are immutable; correct via reversing entry
 *  - A second reversal is rejected
 *  - Lines with zero amount are not posted
 */

import pg from 'pg';

export interface JournalLine {
  accountCode: string;  // e.g. 'CASH', 'LOANS_RECV'
  debitKobo?: bigint;
  creditKobo?: bigint;
}

export interface JournalEntryInput {
  description: string;
  entryDate: string;         // 'YYYY-MM-DD'
  loanId?: bigint;
  reference?: string;
  lines: JournalLine[];
}

export interface JournalEntryRecord {
  id: bigint;
  description: string;
  entryDate: string;
  loanId: bigint | null;
  reference: string | null;
  reversalOf: bigint | null;
  reversedBy: bigint | null;
  createdAt: Date;
}

export interface TrialBalanceLine {
  code: string;
  name: string;
  type: string;
  totalDebit: bigint;
  totalCredit: bigint;
  net: bigint;
}

/** Look up account IDs by code (cached per client/session) */
async function getAccountIds(
  client: pg.PoolClient,
  codes: string[]
): Promise<Map<string, bigint>> {
  const unique = [...new Set(codes)];
  const { rows } = await client.query<{ id: string; code: string }>(
    `SELECT id, code FROM accounts WHERE code = ANY($1)`,
    [unique]
  );
  const map = new Map<string, bigint>();
  for (const row of rows) {
    map.set(row.code, BigInt(row.id));
  }
  return map;
}

/**
 * Post a journal entry within an existing transaction.
 * Caller is responsible for BEGIN/COMMIT.
 * The balance deferred trigger fires at COMMIT.
 */
export async function postJournalEntry(
  client: pg.PoolClient,
  input: JournalEntryInput
): Promise<JournalEntryRecord> {
  // Filter zero-amount lines
  const lines = input.lines.filter((l) => {
    const d = l.debitKobo ?? 0n;
    const c = l.creditKobo ?? 0n;
    return d > 0n || c > 0n;
  });

  if (lines.length < 2) {
    throw new Error('Journal entry must have at least 2 non-zero lines');
  }

  // Validate balance eagerly (the trigger also checks, but fail fast)
  let totalDebit = 0n;
  let totalCredit = 0n;
  for (const l of lines) {
    totalDebit += l.debitKobo ?? 0n;
    totalCredit += l.creditKobo ?? 0n;
  }
  if (totalDebit !== totalCredit) {
    throw new Error(
      `Unbalanced entry: debits=${totalDebit} credits=${totalCredit}`
    );
  }

  // Validate period is open and acquire shared lock to prevent race conditions
  const periodId = await assertPeriodOpen(client, input.entryDate);

  // Get account IDs
  const accountIds = await getAccountIds(client, lines.map((l) => l.accountCode));
  for (const l of lines) {
    if (!accountIds.has(l.accountCode)) {
      throw new Error(`Unknown account code: ${l.accountCode}`);
    }
  }

  // Insert journal entry with period_id
  const entryResult = await client.query<JournalEntryRecord & { id: string }>(
    `INSERT INTO journal_entries (description, entry_date, loan_id, reference, period_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, description, entry_date as "entryDate", loan_id as "loanId",
               reference, reversal_of as "reversalOf", reversed_by as "reversedBy", created_at as "createdAt"`,
    [input.description, input.entryDate, input.loanId ?? null, input.reference ?? null, periodId]
  );
  const entry = entryResult.rows[0]!;
  const entryId = BigInt(entry.id);

  // Insert lines
  for (const line of lines) {
    const accountId = accountIds.get(line.accountCode)!;
    const debit = line.debitKobo ?? 0n;
    const credit = line.creditKobo ?? 0n;
    await client.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit_kobo, credit_kobo)
       VALUES ($1, $2, $3, $4)`,
      [entryId, accountId, debit.toString(), credit.toString()]
    );
  }

  return { ...entry, id: entryId };
}

/**
 * Reverse a journal entry.
 * Creates a new entry with all debits/credits flipped.
 * Rejects a second reversal.
 */
export async function reverseJournalEntry(
  client: pg.PoolClient,
  entryId: bigint,
  reversalDate: string,
  description?: string
): Promise<JournalEntryRecord> {
  // Load original entry
  const origResult = await client.query<{
    id: string;
    description: string;
    reversal_of: string | null;
    reversed_by: string | null;
    loan_id: string | null;
    entry_date: string;
  }>(
    `SELECT id, description, reversal_of, reversed_by, loan_id, entry_date
     FROM journal_entries WHERE id = $1`,
    [entryId]
  );
  if (origResult.rows.length === 0) {
    throw new Error(`Journal entry ${entryId} not found`);
  }
  const orig = origResult.rows[0]!;
  if (orig.reversed_by) {
    throw new Error(`Journal entry ${entryId} has already been reversed`);
  }

  // Load original lines
  const linesResult = await client.query<{
    account_id: string;
    debit_kobo: string;
    credit_kobo: string;
    code: string;
  }>(
    `SELECT jl.account_id, jl.debit_kobo, jl.credit_kobo, a.code
     FROM journal_lines jl
     JOIN accounts a ON a.id = jl.account_id
     WHERE jl.entry_id = $1`,
    [entryId]
  );

  // Post reversed entry (flip debit/credit)
  const reversedLines: JournalLine[] = linesResult.rows.map((r) => ({
    accountCode: r.code,
    debitKobo: BigInt(r.credit_kobo),
    creditKobo: BigInt(r.debit_kobo),
  }));

  const reversalEntry = await postJournalEntry(client, {
    description: description ?? `Reversal of entry #${entryId}: ${orig.description}`,
    entryDate: reversalDate,
    loanId: orig.loan_id ? BigInt(orig.loan_id) : undefined,
    reference: `REV-${entryId}`,
    lines: reversedLines,
  });

  // Link original ↔ reversal (we update the reversed_by column via raw query,
  // bypassing the immutability trigger which only blocks UPDATE from app layer;
  // we use a privileged direct update to set the cross-reference)
  await client.query(
    `UPDATE journal_entries SET reversed_by = $1 WHERE id = $2`,
    [reversalEntry.id, entryId]
  );

  return reversalEntry;
}

/**
 * Returns trial balance: per-account totals.
 */
export async function getTrialBalance(
  client: pg.PoolClient
): Promise<TrialBalanceLine[]> {
  const { rows } = await client.query<{
    code: string;
    name: string;
    type: string;
    total_debit: string;
    total_credit: string;
    net: string;
  }>(`SELECT code, name, type, total_debit, total_credit, net FROM trial_balance`);

  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    type: r.type,
    totalDebit: BigInt(r.total_debit),
    totalCredit: BigInt(r.total_credit),
    net: BigInt(r.net),
  }));
}

/**
 * Assert that the given date falls in an open period and return its period_id.
 * Acquires a row-level FOR SHARE lock on the period row to serialize against closePeriod().
 */
export async function assertPeriodOpen(client: pg.PoolClient, dateStr: string): Promise<bigint> {
  const d = new Date(dateStr);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;

  // Ensure period row exists
  await client.query(
    `INSERT INTO accounting_periods (year, month, status)
     VALUES ($1, $2, 'open')
     ON CONFLICT (year, month) DO NOTHING`,
    [year, month]
  );

  // Acquire shared row lock: blocks if closePeriod holds FOR UPDATE, and blocks closePeriod while posting
  const { rows } = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM accounting_periods WHERE year = $1 AND month = $2 FOR SHARE`,
    [year, month]
  );

  if (rows.length > 0 && rows[0]!.status === 'closed') {
    throw Object.assign(
      new Error(`Period ${year}-${String(month).padStart(2, '0')} is closed`),
      { code: 'PERIOD_CLOSED', statusCode: 422, year, month }
    );
  }

  return BigInt(rows[0]!.id);
}
