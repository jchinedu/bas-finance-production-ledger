# NOTES.md

## Assumptions

- **Money representation**: All amounts are stored and computed as integer kobo (₦1 = 100 kobo) throughout — TypeScript `bigint`, PostgreSQL `BIGINT`. No floating-point arithmetic is used at any stage of financial calculation.
- **Rounding**: Half-up rounding (`divideRoundHalfUpBigInt`) is applied exactly once per named output point (instalment amount, discount fee, late penalty). Intermediate values are never rounded.
- **Dates**: All dates are ISO `YYYY-MM-DD` strings with no timezone shifting. The database server and application are assumed to share the same UTC clock.
- **Accrual timing**: Interest accrues and is recognised as income on the instalment due date, via the accrual job. Discount fees and late penalties are recognised at settlement.
- **Late penalty threshold**: Invoice financing penalties begin the calendar day *after* the due date (i.e. `settlementDate > dueDate`).
- **Invoice settlement model**: Single-collection recourse — once an invoice is settled (or settled with shortfall), it cannot be re-settled. The outstanding shortfall is booked to `CLIENT_RECV` for recourse recovery; we do not model a second collection event.
- **Term loan annuity**: The final instalment absorbs any kobo remainder from rounding so the closing balance is exactly zero.
- **Concurrency scope**: Serialisation is at the single-primary PostgreSQL level using row locks. Multi-region active-active splits are out of scope.

---

## What I Verified By Hand

1. **Worked Example 1 (term loan)** — ₦1,200,000 @ 18% p.a., 6 months. Verified every period's interest (₦18,000.00), principal, and closing balance to the exact kobo against the schedule in the brief. Instalment = **21,063,026 kobo** (periods 1–5), **21,063,024 kobo** (period 6, closing balance = 0).
2. **Invoice financing (Product A)** — 80% advance, 20% reserve, 36% discount fee over 60-day tenor. Verified advance, discount fee (47,342,466 kobo), and late penalty calculation (10 days overdue) against the brief's worked example.
3. **Double-entry balance** — after every test scenario (term loan disbursement, invoice settlement, payment allocation, reversal), confirmed `SUM(debit_kobo) = SUM(credit_kobo)` on the trial balance.
4. **Trigger immutability** — manually attempted `UPDATE journal_entries SET description = 'hack'` and `DELETE FROM journal_lines` via raw SQL; confirmed both are blocked by database triggers.
5. **Concurrent accrual** — ran two parallel accrual jobs for the same loan and confirmed exactly one journal entry was posted for the instalment (via `FOR UPDATE SKIP LOCKED`).

---

## What I Did Not Complete

- **Distributed saga / compensating transactions across external APIs** — payment processing is fully ACID within a single PostgreSQL primary. Cross-service saga orchestration (e.g. Kafka-driven compensation) was not implemented.
- **Async webhook ingestion worker** — the API processes payments synchronously. A production-grade system would decouple ingestion (write to event stream) from processing (worker pool), but this is outside the stated scope.
- **Multi-currency support** — the system is NGN kobo only. Currency conversion tables and multi-currency journal lines were not built.
- **Read replica routing** — reconciliation and trial balance queries run on the primary. At scale these should be offloaded to read replicas.
