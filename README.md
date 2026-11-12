# BAS Finance – Production Ledger Engine

A production-grade **double-entry lending ledger engine** built with **Node.js (TypeScript)** and **PostgreSQL**.

Handles term loans, invoice financing, payment allocation, reversals, accrual, and period closing — with strict financial invariants enforced at the database level.

---

## Quick Start

**Prerequisites:** Node.js 20+, Docker & Docker Compose (or a local PostgreSQL 16 instance).

```bash
# 1. Start PostgreSQL
docker compose up -d

# 2. Install dependencies
npm install

# 3. Apply schema + migrations
npm run migrate

# 4. Run the full test suite (requires Postgres)
npm test

# 5. Start the development server (http://localhost:3000)
npm run dev
```

**Run only the pure unit tests (no database required):**
```bash
npx vitest run src/tests/money.test.ts
```

**Environment variables** — copy `.env.example` to `.env` and fill in:
```bash
cp .env.example .env
```

---

## Test Results

```
Test Files  4 passed (4)
     Tests  61 passed (61)
  Duration  ~115s
```

| Suite | Tests | What it covers |
|---|---|---|
| `money.test.ts` | 35 | BigInt annuity math, rounding, invoice fees, validation helpers |
| `integration.test.ts` | 20 | Full loan lifecycle, journal immutability, reconciliation |
| `reversal.test.ts` | 3 | Multi-reversal, append-only allocation history, trigger enforcement |
| `concurrency.test.ts` | 3 | Parallel accrual safety with `FOR UPDATE SKIP LOCKED` |

---

## Architecture

### 1. Money Precision — No Floats, Ever

All monetary values are stored and computed as integers in **kobo** (₦1 = 100 kobo).

```typescript
// ✅ Correct — BigInt kobo
const principal = 120_000_000n; // ₦1,200,000.00

// ❌ Never used — IEEE-754 floats lose precision
// 0.1 + 0.2 === 0.30000000000000004
```

- TypeScript: native `bigint`
- PostgreSQL: `BIGINT` columns with `CHECK (amount >= 0)` constraints
- Rounding: `divideRoundHalfUpBigInt` applied **once only** at named output points (instalment, fee, penalty). Never on intermediate values.

**Term loan annuity** uses exact rational BigInt arithmetic:

$$A = \frac{P \cdot a \cdot (a + b)^n}{b \cdot ((a + b)^n - b^n)}$$

where $a$ = `annualRateBps`, $b$ = `1200` (12 months × 100 bps), computed with GCD-reduced fractions to avoid BigInt overflow.

---

### 2. Double-Entry Ledger

Every financial event posts a balanced journal entry. The database enforces two invariants at `COMMIT` via **deferred constraint triggers**:

- `trg_check_journal_entry_nonempty` — every entry must have ≥ 2 lines
- `trg_check_journal_balance` — `SUM(debit_kobo) = SUM(credit_kobo)` per entry

**Journal entries and lines are immutable** — `UPDATE` and `DELETE` are blocked by `block_journal_mutation()`. Corrections are made by posting new reversing entries, never by editing past records.

| Account | Code | Type | Purpose |
|---|---|---|---|
| Loans Receivable | `LOANS_RECV` | Asset | Outstanding term loan principal |
| Interest Receivable | `INTEREST_RECV` | Asset | Accrued but uncollected interest |
| Invoice Receivable | `INVOICE_RECV` | Asset | Invoice financing advances |
| Cash | `CASH` | Asset | Cash received or disbursed |
| Client Receivable | `CLIENT_RECV` | Asset | Shortfall recourse amount owed by client |
| Interest Income | `INTEREST_INC` | Income | Interest earned |
| Fee Income | `FEE_INC` | Income | Discount fees earned |
| Penalty Income | `PENALTY_INC` | Income | Late penalties earned |
| Client Payable | `CLIENT_PAY` | Liability | Excess cash owed back to client |
| Unapplied Credit | `UNAPPLIED_CREDIT` | Liability | Overpayments pending allocation |

---

### 3. Products

#### Term Loan (Reducing-Balance Annuity)

Monthly instalment for principal $P$, annual rate $r$, $n$ months:

$$A = P \times \frac{i}{1 - (1+i)^{-n}}, \quad i = \frac{r}{12}$$

**Worked Example 1** (₦1,200,000 @ 18% p.a., 6 months):

| Period | Instalment (kobo) | Interest (kobo) | Principal (kobo) | Closing Balance (kobo) |
|---|---|---|---|---|
| 1 | 21,063,026 | 1,800,000 | 19,263,026 | 100,736,974 |
| 2 | 21,063,026 | 1,511,055 | 19,551,971 | 81,185,003 |
| 3 | 21,063,026 | 1,217,775 | 19,845,251 | 61,339,752 |
| 4 | 21,063,026 | 920,096 | 20,142,930 | 41,196,822 |
| 5 | 21,063,026 | 617,952 | 20,445,074 | 20,751,748 |
| 6 | 21,063,024 | 311,276 | 20,751,748 | **0** |

The final instalment absorbs the rounding remainder to close the balance to exactly zero.

#### Invoice Financing (Advance + Reserve + Discount Fee)

- 80% advance disbursed immediately; 20% held as reserve
- Discount fee accrues over tenor at the agreed rate (pure BigInt rational division)
- Late penalty accrues per calendar day after due date
- Settlement: `open → settled` (full/excess) or `open → settled_shortfall` (partial)
- A settled invoice cannot be re-settled — `422 ALREADY_SETTLED`

---

### 4. Payment Waterfall

Payments are applied in strict priority order:

```
1. Late penalty  →  PENALTY_INC
2. Fee           →  FEE_INC
3. Interest      →  INTEREST_RECV / INTEREST_INC
4. Principal     →  LOANS_RECV
5. Excess        →  UNAPPLIED_CREDIT (liability)
```

Payments for the same loan are serialized with `SELECT ... FOR UPDATE` on the loan row to prevent concurrent double-allocation.

---

### 5. Payment Reversal & Reallocation

When a payment is reversed:

1. A new reversing journal entry is posted (never mutating the original).
2. All subsequent payments for the loan are **recomputed** in value-date order.
3. Each reallocation event gets a unique scoped reference: `REALLOC-{paymentId}-E{eventId}`.
4. Prior `payment_allocations` rows are marked `superseded_by_event_id = <eventId>` (never deleted). New allocation rows carry `created_by_event_id`.
5. The `protect_payment_allocations` trigger makes the table append-only and blocks overwriting an already-set `superseded_by_event_id`.

---

### 6. Concurrency & Idempotency

| Concern | Mechanism |
|---|---|
| Concurrent payments on same loan | `SELECT ... FOR UPDATE` on `loans` row |
| Concurrent accrual workers | `FOR UPDATE SKIP LOCKED` on `instalments` |
| Period close vs. active posting | `FOR SHARE` (posting) / `FOR UPDATE` (closing) on `accounting_periods` |
| Duplicate webhook / network retry | `pg_advisory_xact_lock(hash(idempotency_key))` + `idempotency_keys` table storing payload hash and cached response |
| Mismatched payload same key | `409 IDEMPOTENCY_CONFLICT` |

---

### 7. Period Closing & Reconciliation

`POST /periods/:year/:month/close` locks the accounting period. Any subsequent journal entry dated within that period is rejected.

`GET /periods/reconcile` runs a 3-layer check:

```
Layer 1 — Real-time: deferred trigger ensures Debits = Credits on every COMMIT
Layer 2 — Trial balance view: SUM(all debits) = SUM(all credits) globally
Layer 3 — Sub-ledger reconciliation:
  • Per term loan: principal outstanding vs. LOANS_RECV control account
  • Per invoice: advance vs. INVOICE_RECV, fees vs. FEE_INC, penalties vs. PENALTY_INC
  • Global: each control account sum vs. sum of all per-loan sub-ledgers
    (catches unlinked entries where loan_id IS NULL)
```

Returns a per-loan, per-invoice breakdown with the exact kobo difference for any drift detected.

---

### 8. Security

| Control | Implementation |
|---|---|
| API key comparison | `crypto.timingSafeEqual` over SHA-256 digests — prevents timing attacks |
| Key strength enforcement | Production startup rejects keys shorter than 32 characters |
| Admin-only routes | `/accrual/run`, `/periods/*`, `/payments/:id/reverse` require `ADMIN_API_KEY` |
| Input validation | All monetary inputs parsed as `BigInt` with overflow guard (`< MAX_BIGINT`); dates validated as ISO `YYYY-MM-DD` |

---

### 9. Failure Modes Handled

| Failure | Mitigation |
|---|---|
| Concurrent webhook races | Pessimistic row lock on loan; transactions serialise in commit order |
| Network retry / duplicate submission | Two-tier idempotency (advisory lock + persistent key table) |
| Unbalanced journal entry | Deferred constraint trigger at `COMMIT` — transaction is aborted |
| Rogue `UPDATE`/`DELETE` on ledger | Database triggers block all mutations on journal tables |
| Retroactive correction into closed period | `assertPeriodOpen()` acquires shared row lock; `closePeriod()` acquires exclusive lock |
| Sub-ledger drift from General Ledger | Reconciliation endpoint detects and pinpoints per-loan/global discrepancies |

**Honest boundaries — not in scope:**
- Multi-region active-active database (relies on single-primary PostgreSQL ACID)
- Upstream bank payload mutation resolution (rejected as `409 Conflict`)
- Multi-currency ledger (NGN kobo only)

---

### 10. Scaling to 100× Volume

| Component | Current | At 100× |
|---|---|---|
| Locking | Row lock on `loans` | Row locks remain optimal; shard accrual batches by `loan_id % N` |
| Ingestion | Synchronous HTTP handler | Webhooks → Kafka partitioned by `loan_id` → worker pool |
| Storage | Single `journal_lines` table | Declarative PostgreSQL table partitioning by month on `entry_date` |
| Idempotency cache | PostgreSQL `idempotency_keys` table | Redis + Redlock for 24h hot cache; Postgres for long-term audit |
| Read / audit workload | Direct queries on primary DB | PostgreSQL read replicas via PgBouncer for reconciliation and reporting |

---

## Project Structure

```
src/
├── app.ts                    # Fastify app setup, auth middleware
├── routes/
│   ├── loans.ts              # POST /loans, /invoice, /invoice/:id/settle
│   ├── payments.ts           # POST /payments, GET /payments/:id, POST /payments/:id/reverse
│   ├── accrual.ts            # POST /accrual/run
│   └── periods.ts            # POST /periods/:y/:m/close, GET /periods/reconcile
├── domain/
│   ├── money.ts              # BigInt maths, daysBetween, koboToNairaString
│   ├── termLoan.ts           # buildTermLoanSchedule (rational BigInt annuity)
│   ├── invoiceFinancing.ts   # computeInvoiceFinancingWithTenor
│   ├── loanService.ts        # createTermLoan, createInvoiceFinancing, settleInvoice, runAccrualJob
│   ├── payment.ts            # allocatePayment, recomputeAllocations (waterfall)
│   ├── reversal.ts           # reversePayment
│   ├── ledger.ts             # postJournalEntry, getTrialBalance, assertPeriodOpen
│   └── periodClose.ts        # closePeriod, reconcile
├── db/
│   └── schema.sql            # Full schema: tables, triggers, indexes, accounts
├── validation.ts             # isValidIsoDate, parsePositiveKobo, parseId
└── tests/
    ├── money.test.ts         # 35 pure unit tests (no DB)
    ├── integration.test.ts   # 20 integration tests (full lifecycle)
    ├── reversal.test.ts      # 3 reversal + allocation-history tests
    └── concurrency.test.ts   # 3 concurrency safety tests
```

---

## API Reference

A full Postman collection is included: `bas-finance-ledger.postman_collection.json`.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/loans` | Create a term loan |
| `POST` | `/invoice` | Create an invoice financing |
| `POST` | `/invoice/:id/settle` | Settle an invoice (partial / full / excess) |
| `POST` | `/payments` | Record and allocate a payment |
| `GET` | `/payments/:id` | Get payment + allocation history |
| `POST` | `/payments/:id/reverse` | Reverse a payment and recompute waterfall |
| `POST` | `/accrual/run` | Run the interest accrual job (admin) |
| `POST` | `/periods/:year/:month/close` | Close an accounting period (admin) |
| `GET` | `/periods/reconcile` | Run full sub-ledger reconciliation (admin) |

---

## Assumptions

- All dates are ISO strings (`YYYY-MM-DD`), no timezone shifting.
- Interest accrues on the instalment due date via the accrual job; fees and penalties are recognised when collected.
- Late penalties on invoice financing start the calendar day after the due date.
- Invoice financing follows a **single-collection recourse** model — once settled (or settled with shortfall), it cannot be re-settled.
