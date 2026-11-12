# Design Note — Production Lending Ledger Engine

---

## 1. Failure Modes Handled

**Concurrent payment races.**
Multiple payments for the same loan arriving simultaneously (retried webhooks, split transfers) are serialised with `SELECT ... FOR UPDATE` on the loan row inside an ACID transaction. Transactions commit in strict order; there are no phantom reads, lost updates, or double-allocations.

**Duplicate submissions / network retries.**
A two-tier idempotency system handles retries transparently:
1. `pg_advisory_xact_lock(fnv1a(idempotency_key))` serialises concurrent threads sharing the same key within a single process.
2. A persistent `idempotency_keys` table stores the SHA-256 hash of the request payload and the cached HTTP response body.

On retry with a matching key and payload hash, the cached response is returned immediately — no second journal entry is posted. A retry with the same key but a different payload is rejected `409 IDEMPOTENCY_CONFLICT`.

**Unbalanced or malformed journal entries.**
Enforced at the database level by two deferred constraint triggers that fire at `COMMIT`:
- `trg_check_journal_entry_nonempty` — every entry must have ≥ 2 lines.
- `trg_check_journal_balance` — `SUM(debit_kobo) = SUM(credit_kobo)` per entry.

If the application posts an asymmetric entry due to a bug, Postgres aborts the transaction before it reaches disk.

**Audit history corruption.**
`UPDATE` and `DELETE` are blocked on `journal_entries`, `journal_lines`, `reallocation_events`, and `payment_allocations` by database triggers. When a payment is reversed, prior allocation rows are marked `superseded_by_event_id` (never deleted); new rows carry `created_by_event_id`. Every reallocation uses a unique scoped reference (`REALLOC-{paymentId}-E{eventId}`) so the same payment can be reversed and reallocated multiple times without key collision.

**Retroactive posting into closed periods.**
`assertPeriodOpen(entryDate)` acquires a shared row lock (`FOR SHARE`) on `accounting_periods` before posting. `closePeriod()` acquires an exclusive row lock (`FOR UPDATE`). These two lock modes are mutually exclusive — a close cannot race with an in-flight posting, and a posting cannot succeed into a period being closed.

---

## 2. Failure Modes Not Handled

**Multi-region active-active splits.** The system relies on single-primary PostgreSQL ACID guarantees. It does not handle network partition splits between database primaries without a distributed consensus coordinator (e.g. Raft / Paxos).

**Upstream provider reusing a webhook ID.** If a bank reuses the same idempotency key for a completely different transaction, the system returns the cached prior response (`409 Conflict`) rather than attempting heuristic resolution — a deliberate conservative choice.

**Database clock skew.** Period boundary validation relies on the database server system clock. Extreme NTP drift could cause edge-case validation anomalies at period boundaries.

---

## 3. Duplicate and Out-of-Order Bank Webhooks

**Duplicate webhook:**
The idempotency system (Section 1) absorbs it. The second delivery of the same webhook returns the cached 200 response body without posting a second journal entry.

**Out-of-order webhook (Webhook B dated T₂ arrives before Webhook A dated T₁):**
1. Webhook B is processed and allocated against instalments due ≤ T₂.
2. When Webhook A arrives later, it is recorded with its actual value date T₁.
3. The reversal engine treats A's late arrival as equivalent to reversing B and reprocessing both payments in value-date order: it posts a reversing entry for B's allocations, then `recomputeAllocations` replays all payments for the loan chronologically. Delta journal entries (`REALLOC-{id}-E{eventId}`) adjust the General Ledger without mutating any past journal entry. The result is the same as if A had arrived first.

---

## 4. Detecting Ledger Drift in Production

Three independent layers run continuously:

**Layer 1 — Real-time trigger.** The deferred `trg_check_journal_balance` trigger ensures `Debits = Credits` on every transaction commit. Any application bug that produces an unbalanced entry is caught immediately and the transaction is aborted.

**Layer 2 — Trial balance health probe.** `GET /trial-balance` (or a scheduled query against the `trial_balance` view) confirms `SUM(all debit_kobo) = SUM(all credit_kobo)` across the entire general ledger. A non-zero difference means a trigger has been bypassed or a direct database write has occurred. This should alert within seconds via a monitoring probe.

**Layer 3 — Sub-ledger reconciliation.** `GET /periods/reconcile` compares every sub-ledger against its General Ledger control account:
- Term loans: sum of outstanding instalment principals vs. `LOANS_RECV`
- Invoice financings: open advances vs. `INVOICE_RECV`; fees vs. `FEE_INC`; penalties vs. `PENALTY_INC`
- Global control check: each control account total vs. the sum of all per-loan sub-ledgers (catches unlinked entries where `loan_id IS NULL`)

The endpoint returns the exact kobo difference per loan/invoice and per account, so any drift is immediately localised to a specific record.

---

## 5. What Changes at 100× Volume

| Component | Current | 100× |
|---|---|---|
| **Payment ingestion** | Synchronous HTTP handler | Webhooks write to a Kafka topic partitioned by `loan_id`. Worker pool consumes in partition order, guaranteeing per-loan FIFO serialisation before the database write. Row locks remain correct; throughput scales with partition count. |
| **Idempotency cache** | `idempotency_keys` table on primary | Redis + Redlock for 24-hour hot deduplication. PostgreSQL table retained for long-term audit. Eliminates hot-row contention on the idempotency table. |
| **Accrual job** | Sequential scan of all unaccrued instalments | Shard by `loan_id % N` across N workers. `FOR UPDATE SKIP LOCKED` already prevents double-accrual; sharding reduces lock contention and enables horizontal scaling. |
| **Journal storage** | Single `journal_lines` table | Declarative PostgreSQL table partitioning by month on `entry_date`. Prevents B-tree index bloat, enables efficient `VACUUM`, and allows old partitions to be archived without locking the live table. |
| **Read / audit workload** | Direct queries on primary | Reconciliation, trial balance, and reporting queries routed to PostgreSQL read replicas via PgBouncer. Removes read contention from the write path entirely. |
