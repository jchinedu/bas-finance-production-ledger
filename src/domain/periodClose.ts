/**
 * Period Close & Reconciliation Service (Task 5)
 */

import pg from 'pg';

export interface ReconciliationResult {
  balanced: boolean;
  loansReceivableControl: bigint;
  interestReceivableControl: bigint;
  unappliedCreditControl: bigint;
  invoiceReceivableControl: bigint;
  clientPayableControl: bigint;
  clientReceivableControl: bigint;
  loanBreakdown: Array<{
    loanId: bigint;
    loansReceivable: bigint;
    interestReceivable: bigint;
    unappliedCredit: bigint;
    difference: bigint;
  }>;
  invoiceBreakdown: Array<{
    loanId: bigint;
    status: string;
    invoiceReceivable: bigint;
    clientPayable: bigint;
    clientReceivable: bigint;
    difference: bigint;
  }>;
  differences: Array<{
    loanId: bigint;
    account: string;
    controlAmount: bigint;
    loanLevelAmount: bigint;
    diff: bigint;
  }>;
}

/** Lock a period: reject future entries dated inside it with exclusive coordination */
export async function closePeriod(
  client: pg.PoolClient,
  year: number,
  month: number
): Promise<{ periodId: bigint }> {
  // Ensure period row exists first
  await client.query(
    `INSERT INTO accounting_periods (year, month, status)
     VALUES ($1, $2, 'open')
     ON CONFLICT (year, month) DO NOTHING`,
    [year, month]
  );

  // Acquire exclusive lock on the period row (conflicts with FOR SHARE in assertPeriodOpen)
  const { rows } = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM accounting_periods WHERE year = $1 AND month = $2 FOR UPDATE`,
    [year, month]
  );

  const periodId = BigInt(rows[0]!.id);
  if (rows[0]!.status !== 'closed') {
    await client.query(
      `UPDATE accounting_periods SET status = 'closed', closed_at = NOW() WHERE id = $1`,
      [rows[0]!.id]
    );
  }

  return { periodId };
}

/** Reopen a period (admin use only) */
export async function reopenPeriod(
  client: pg.PoolClient,
  year: number,
  month: number
): Promise<void> {
  await client.query(
    `UPDATE accounting_periods SET status='open', closed_at=NULL
     WHERE year=$1 AND month=$2`,
    [year, month]
  );
}

/**
 * Reconciliation: prove that the sum of loan-level balances
 * equals the control account totals (Loans Receivable, Interest Receivable,
 * Unapplied Credit). Report any difference per loan.
 */
export async function reconcile(
  client: pg.PoolClient
): Promise<ReconciliationResult> {
  // Control account totals from the ledger
  const { rows: controlRows } = await client.query<{
    code: string;
    net: string;
  }>(
    `SELECT a.code, 
            COALESCE(SUM(jl.debit_kobo), 0) - COALESCE(SUM(jl.credit_kobo), 0) AS net
     FROM accounts a
     LEFT JOIN journal_lines jl ON jl.account_id = a.id
     WHERE a.code IN ('LOANS_RECV', 'INTEREST_RECV', 'UNAPPLIED_CREDIT')
     GROUP BY a.code`
  );

  const controlMap = new Map<string, bigint>();
  for (const r of controlRows) controlMap.set(r.code, BigInt(r.net));

  const loansReceivableControl = controlMap.get('LOANS_RECV') ?? 0n;
  const interestReceivableControl = controlMap.get('INTEREST_RECV') ?? 0n;
  const unappliedCreditControl = -(controlMap.get('UNAPPLIED_CREDIT') ?? 0n); // liability: net is negative

  // Per-loan balances from instalment + allocation data.
  // ALL term loans are reconciled regardless of status: a settled loan with a residual
  // ledger balance is exactly the kind of discrepancy this check must surface.
  const { rows: loanRows } = await client.query<{ id: string }>(
    `SELECT id FROM loans WHERE loan_type = 'term_loan' ORDER BY id`
  );

  const loanBreakdown: ReconciliationResult['loanBreakdown'] = [];
  const differences: ReconciliationResult['differences'] = [];

  let totalLoansRecv = 0n;
  let totalInterestRecv = 0n;
  let totalUnapplied = 0n;

  for (const loan of loanRows) {
    const loanId = BigInt(loan.id);

    // Loans Receivable for this loan = scheduled principal less active principal allocations
    const { rows: [lr] } = await client.query<{ balance: string }>(
      `SELECT COALESCE(SUM(
         i.principal_kobo - COALESCE((
           SELECT SUM(pa.amount_kobo)
           FROM payment_allocations pa
           JOIN payments p ON p.id = pa.payment_id AND p.status='applied'
           WHERE pa.instalment_id = i.id AND pa.allocation_type = 'principal'
             AND pa.superseded_by_event_id IS NULL
         ), 0)
       ), 0) AS balance
       FROM instalments i WHERE i.loan_id = $1`,
      [loanId]
    );
    const loanLoansRecv = BigInt(lr?.balance ?? '0');

    // Interest Receivable: accrued but unpaid interest
    const { rows: [ir] } = await client.query<{ balance: string }>(
      `SELECT COALESCE(SUM(
         i.interest_kobo - COALESCE((
           SELECT SUM(pa.amount_kobo)
           FROM payment_allocations pa
           JOIN payments p ON p.id = pa.payment_id AND p.status='applied'
           WHERE pa.instalment_id = i.id AND pa.allocation_type = 'interest'
             AND pa.superseded_by_event_id IS NULL
         ), 0)
       ), 0) AS balance
       FROM instalments i
       WHERE i.loan_id = $1 AND i.accrued = TRUE`,
      [loanId]
    );
    const loanInterestRecv = BigInt(ir?.balance ?? '0');

    // Unapplied credit for this loan
    const { rows: [uc] } = await client.query<{ balance: string }>(
      `SELECT COALESCE(SUM(pa.amount_kobo), 0) AS balance
       FROM payment_allocations pa
       JOIN payments p ON p.id = pa.payment_id AND p.status = 'applied'
       WHERE p.loan_id = $1 AND pa.allocation_type = 'unapplied'
         AND pa.superseded_by_event_id IS NULL`,
      [loanId]
    );
    const loanUnapplied = BigInt(uc?.balance ?? '0');

    totalLoansRecv += loanLoansRecv;
    totalInterestRecv += loanInterestRecv;
    totalUnapplied += loanUnapplied;

    // Ledger-side balances for THIS loan
    const { rows: loanLedger } = await client.query<{ code: string; net: string }>(
      `SELECT a.code,
              COALESCE(SUM(jl.debit_kobo),0) - COALESCE(SUM(jl.credit_kobo),0) AS net
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id AND je.loan_id = $1
       JOIN accounts a ON a.id = jl.account_id
       WHERE a.code IN ('LOANS_RECV','INTEREST_RECV','UNAPPLIED_CREDIT')
       GROUP BY a.code`,
      [loanId]
    );
    const ledgerMap = new Map<string, bigint>();
    for (const r of loanLedger) ledgerMap.set(r.code, BigInt(r.net));

    const ledgerLoansRecv = ledgerMap.get('LOANS_RECV') ?? 0n;
    const ledgerInterestRecv = ledgerMap.get('INTEREST_RECV') ?? 0n;
    const ledgerUnapplied = -(ledgerMap.get('UNAPPLIED_CREDIT') ?? 0n);

    const diffLR = ledgerLoansRecv - loanLoansRecv;
    const diffIR = ledgerInterestRecv - loanInterestRecv;
    const diffUC = ledgerUnapplied - loanUnapplied;

    loanBreakdown.push({
      loanId,
      loansReceivable: loanLoansRecv,
      interestReceivable: loanInterestRecv,
      unappliedCredit: loanUnapplied,
      difference: diffLR + diffIR + diffUC,
    });

    if (diffLR !== 0n) differences.push({ loanId, account: 'LOANS_RECV', controlAmount: ledgerLoansRecv, loanLevelAmount: loanLoansRecv, diff: diffLR });
    if (diffIR !== 0n) differences.push({ loanId, account: 'INTEREST_RECV', controlAmount: ledgerInterestRecv, loanLevelAmount: loanInterestRecv, diff: diffIR });
    if (diffUC !== 0n) differences.push({ loanId, account: 'UNAPPLIED_CREDIT', controlAmount: ledgerUnapplied, loanLevelAmount: loanUnapplied, diff: diffUC });
  }

  // Control accounts vs the sum of all loan-level sub-ledgers. This catches postings to a
  // term-loan control account that carry no loan_id (and so escape every per-loan check).
  const pushGlobal = (account: string, control: bigint, sub: bigint) => {
    if (control !== sub) {
      differences.push({ loanId: 0n, account, controlAmount: control, loanLevelAmount: sub, diff: control - sub });
    }
  };
  pushGlobal('LOANS_RECV', loansReceivableControl, totalLoansRecv);
  pushGlobal('INTEREST_RECV', interestReceivableControl, totalInterestRecv);
  pushGlobal('UNAPPLIED_CREDIT', unappliedCreditControl, totalUnapplied);

  // ---- Invoice financing: every invoice, every status -------------------------------
  const { rows: invoices } = await client.query<{
    loan_id: string;
    advance_kobo: string;
    discount_fee_kobo: string;
    status: string;
    settlement_amount_kobo: string | null;
    late_penalty_kobo: string | null;
    client_payable_kobo: string | null;
    client_receivable_kobo: string | null;
  }>(
    `SELECT loan_id, advance_kobo, discount_fee_kobo, status, settlement_amount_kobo,
            late_penalty_kobo, client_payable_kobo, client_receivable_kobo
     FROM invoice_financings ORDER BY id`
  );

  const invoiceCodes = ['INVOICE_RECV', 'FEE_INC', 'PENALTY_INC', 'CLIENT_PAY', 'CLIENT_RECV', 'CASH'];
  const invoiceBreakdown: ReconciliationResult['invoiceBreakdown'] = [];
  let expectedInvoiceRecvTotal = 0n;
  let expectedClientPayTotal = 0n;
  let expectedClientRecvTotal = 0n;

  for (const inv of invoices) {
    const loanId = BigInt(inv.loan_id);
    const advance = BigInt(inv.advance_kobo);
    const settled = inv.status !== 'open';
    const detailed = settled && inv.settlement_amount_kobo !== null;

    // Expected ledger NET (debit - credit) per account for this invoice's loan_id
    const expected = new Map<string, bigint>();
    expected.set('INVOICE_RECV', settled ? 0n : advance);
    if (settled) {
      expected.set('FEE_INC', -BigInt(inv.discount_fee_kobo));
    }
    if (detailed) {
      expected.set('PENALTY_INC', -BigInt(inv.late_penalty_kobo ?? '0'));
      expected.set('CLIENT_PAY', -BigInt(inv.client_payable_kobo ?? '0'));
      expected.set('CLIENT_RECV', BigInt(inv.client_receivable_kobo ?? '0'));
      expected.set('CASH', BigInt(inv.settlement_amount_kobo!) - advance);
    } else if (!settled) {
      expected.set('CASH', -advance);
    }

    const { rows: ledgerRows } = await client.query<{ code: string; net: string }>(
      `SELECT a.code, COALESCE(SUM(jl.debit_kobo),0) - COALESCE(SUM(jl.credit_kobo),0) AS net
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id AND je.loan_id = $1
       JOIN accounts a ON a.id = jl.account_id
       WHERE a.code = ANY($2::text[])
       GROUP BY a.code`,
      [loanId, invoiceCodes]
    );
    const actual = new Map<string, bigint>();
    for (const r of ledgerRows) actual.set(r.code, BigInt(r.net));

    let invDiffTotal = 0n;
    for (const [code, exp] of expected) {
      const act = actual.get(code) ?? 0n;
      if (act !== exp) {
        const diff = act - exp;
        invDiffTotal += diff;
        differences.push({ loanId, account: code, controlAmount: act, loanLevelAmount: exp, diff });
      }
    }

    invoiceBreakdown.push({
      loanId,
      status: inv.status,
      invoiceReceivable: expected.get('INVOICE_RECV') ?? 0n,
      clientPayable: -(expected.get('CLIENT_PAY') ?? 0n),
      clientReceivable: expected.get('CLIENT_RECV') ?? 0n,
      difference: invDiffTotal,
    });

    expectedInvoiceRecvTotal += expected.get('INVOICE_RECV') ?? 0n;
    expectedClientPayTotal += expected.get('CLIENT_PAY') ?? 0n;
    expectedClientRecvTotal += expected.get('CLIENT_RECV') ?? 0n;
  }

  // Control totals for accounts used ONLY by invoice financing
  const { rows: invControlRows } = await client.query<{ code: string; net: string }>(
    `SELECT a.code, COALESCE(SUM(jl.debit_kobo),0) - COALESCE(SUM(jl.credit_kobo),0) AS net
     FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id = a.id
     WHERE a.code IN ('INVOICE_RECV','CLIENT_PAY','CLIENT_RECV')
     GROUP BY a.code`
  );
  const invControl = new Map<string, bigint>();
  for (const r of invControlRows) invControl.set(r.code, BigInt(r.net));
  const invoiceReceivableControl = invControl.get('INVOICE_RECV') ?? 0n;
  const clientPayableControl = -(invControl.get('CLIENT_PAY') ?? 0n);
  const clientReceivableControl = invControl.get('CLIENT_RECV') ?? 0n;
  pushGlobal('INVOICE_RECV', invoiceReceivableControl, expectedInvoiceRecvTotal);
  pushGlobal('CLIENT_PAY', invControl.get('CLIENT_PAY') ?? 0n, expectedClientPayTotal);
  pushGlobal('CLIENT_RECV', clientReceivableControl, expectedClientRecvTotal);

  const balanced = differences.length === 0;

  return {
    balanced,
    loansReceivableControl,
    interestReceivableControl,
    unappliedCreditControl,
    invoiceReceivableControl,
    clientPayableControl,
    clientReceivableControl,
    loanBreakdown,
    invoiceBreakdown,
    differences,
  };
}
