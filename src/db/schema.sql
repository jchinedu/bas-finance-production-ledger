-- =============================================================================
-- BAS Finance Production Ledger – Database Schema
-- Task 1: Schema and invariants
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Accounting Periods (for Task 5: period close)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounting_periods (
  id          BIGSERIAL PRIMARY KEY,
  year        INTEGER NOT NULL,
  month       INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at   TIMESTAMPTZ,
  UNIQUE (year, month)
);

-- ---------------------------------------------------------------------------
-- Chart of Accounts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,         -- e.g. 'CASH', 'LOANS_RECEIVABLE'
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'income', 'expense', 'equity')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed chart of accounts
INSERT INTO accounts (code, name, type) VALUES
  ('CASH',               'Cash',                 'asset'),
  ('LOANS_RECV',         'Loans Receivable',     'asset'),
  ('INTEREST_RECV',      'Interest Receivable',  'asset'),
  ('INVOICE_RECV',       'Invoice Receivables',  'asset'),
  ('CLIENT_RECV',        'Client Receivable',    'asset'),
  ('INTEREST_INC',       'Interest Income',      'income'),
  ('FEE_INC',            'Fee Income',           'income'),
  ('PENALTY_INC',        'Penalty Income',       'income'),
  ('CLIENT_PAY',         'Client Payable',       'liability'),
  ('UNAPPLIED_CREDIT',   'Unapplied Credit',     'liability')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Journal Entries (immutable – append-only enforced by trigger below)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS journal_entries (
  id              BIGSERIAL PRIMARY KEY,
  reference       TEXT,                            -- human-readable ref
  description     TEXT NOT NULL,
  entry_date      DATE NOT NULL,
  period_id       BIGINT REFERENCES accounting_periods(id),
  loan_id         BIGINT,                          -- FK added after loans table
  reversal_of     BIGINT REFERENCES journal_entries(id), -- if this is a reversal
  reversed_by     BIGINT REFERENCES journal_entries(id), -- back-ref
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Journal Lines  (immutable – append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS journal_lines (
  id              BIGSERIAL PRIMARY KEY,
  entry_id        BIGINT NOT NULL REFERENCES journal_entries(id),
  account_id      BIGINT NOT NULL REFERENCES accounts(id),
  -- debits and credits stored as separate positive integers (kobo)
  debit_kobo      BIGINT NOT NULL DEFAULT 0 CHECK (debit_kobo  >= 0),
  credit_kobo     BIGINT NOT NULL DEFAULT 0 CHECK (credit_kobo >= 0),
  -- exactly one of debit or credit must be non-zero
  CONSTRAINT one_side_nonzero CHECK (
    (debit_kobo > 0 AND credit_kobo = 0) OR
    (credit_kobo > 0 AND debit_kobo = 0)
  ),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- TRIGGER: Enforce journal entry balance & minimum 2 lines (deferred)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_journal_entry_completeness()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_line_count   INTEGER;
  v_total_debit  BIGINT;
  v_total_credit BIGINT;
  v_target_id    BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'journal_lines' THEN
    v_target_id := NEW.entry_id;
  ELSE
    v_target_id := NEW.id;
  END IF;

  SELECT
    COUNT(*),
    COALESCE(SUM(debit_kobo),  0),
    COALESCE(SUM(credit_kobo), 0)
  INTO v_line_count, v_total_debit, v_total_credit
  FROM journal_lines
  WHERE entry_id = v_target_id;

  IF v_line_count < 2 THEN
    RAISE EXCEPTION 'Journal entry % must have at least 2 lines (found %)',
      v_target_id, v_line_count;
  END IF;

  IF v_total_debit <> v_total_credit THEN
    RAISE EXCEPTION 'Journal entry % is unbalanced: debits=% credits=%',
      v_target_id, v_total_debit, v_total_credit;
  END IF;

  RETURN NEW;
END;
$$;

-- Deferred constraint trigger fires at END of transaction on lines insertion
DROP TRIGGER IF EXISTS trg_journal_balance ON journal_lines;
CREATE CONSTRAINT TRIGGER trg_journal_balance
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_journal_entry_completeness();

-- Deferred constraint trigger fires at END of transaction on entry creation (catches empty entries)
DROP TRIGGER IF EXISTS trg_journal_entry_has_lines ON journal_entries;
CREATE CONSTRAINT TRIGGER trg_journal_entry_has_lines
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_journal_entry_completeness();

-- ---------------------------------------------------------------------------
-- TRIGGER: Block updates/deletes on journal_entries and journal_lines
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION block_journal_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Journal entries and lines are immutable (attempted DELETE on %)', TG_TABLE_NAME;
  END IF;
  -- Allow ONLY the reversal cross-reference columns to be updated
  IF TG_TABLE_NAME = 'journal_entries' THEN
    -- Only reversed_by may be set (once), and only from NULL to a value
    IF OLD.reversed_by IS NOT NULL THEN
      RAISE EXCEPTION 'Journal entry % has already been reversed (double reversal rejected)', OLD.id;
    END IF;
    -- Allow if only reversed_by changed
    IF NEW.description        IS DISTINCT FROM OLD.description OR
       NEW.entry_date         IS DISTINCT FROM OLD.entry_date  OR
       NEW.loan_id            IS DISTINCT FROM OLD.loan_id     OR
       NEW.reference          IS DISTINCT FROM OLD.reference   OR
       NEW.reversal_of        IS DISTINCT FROM OLD.reversal_of THEN
      RAISE EXCEPTION 'Journal entries are immutable (attempted UPDATE on %)', TG_TABLE_NAME;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Journal entries and lines are immutable (attempted % on %)',
    TG_OP, TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS trg_no_update_journal_entries ON journal_entries;
CREATE TRIGGER trg_no_update_journal_entries
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION block_journal_mutation();

DROP TRIGGER IF EXISTS trg_no_update_journal_lines ON journal_lines;
CREATE TRIGGER trg_no_update_journal_lines
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION block_journal_mutation();

-- ---------------------------------------------------------------------------
-- Loans
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loans (
  id                BIGSERIAL PRIMARY KEY,
  loan_type         TEXT NOT NULL CHECK (loan_type IN ('term_loan', 'invoice_financing')),
  -- Term loan fields
  principal_kobo    BIGINT CHECK (principal_kobo > 0),
  annual_rate_bps   INTEGER CHECK (annual_rate_bps >= 0),  -- basis points (0 = 0%, 1800 = 18%)
  term_months       INTEGER CHECK (term_months > 0),
  -- Common fields
  disbursement_date DATE,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled', 'settled_shortfall', 'cancelled')),
  -- Concurrency: optimistic lock version
  version           INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Instalments (Term Loan schedule)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS instalments (
  id                  BIGSERIAL PRIMARY KEY,
  loan_id             BIGINT NOT NULL REFERENCES loans(id),
  period_number       INTEGER NOT NULL,          -- 1-based
  due_date            DATE NOT NULL,
  instalment_kobo     BIGINT NOT NULL CHECK (instalment_kobo > 0),
  interest_kobo       BIGINT NOT NULL CHECK (interest_kobo >= 0),
  principal_kobo      BIGINT NOT NULL CHECK (principal_kobo > 0),
  penalty_kobo        BIGINT NOT NULL DEFAULT 0 CHECK (penalty_kobo >= 0),
  fee_kobo            BIGINT NOT NULL DEFAULT 0 CHECK (fee_kobo >= 0),
  opening_balance     BIGINT NOT NULL CHECK (opening_balance >= 0),
  closing_balance     BIGINT NOT NULL CHECK (closing_balance >= 0),
  accrued             BOOLEAN NOT NULL DEFAULT FALSE,  -- has accrual job run?
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'partial', 'paid')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (loan_id, period_number)
);

-- ---------------------------------------------------------------------------
-- Idempotency Keys (Task 2)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key               TEXT PRIMARY KEY,
  request_hash      TEXT NOT NULL,     -- SHA-256 of request body
  response_body     JSONB NOT NULL,
  status_code       INTEGER NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                BIGSERIAL PRIMARY KEY,
  loan_id           BIGINT NOT NULL REFERENCES loans(id),
  idempotency_key   TEXT,
  amount_kobo       BIGINT NOT NULL CHECK (amount_kobo > 0),
  payment_date      DATE NOT NULL,
  status            TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'reversed')),
  reversal_of       BIGINT REFERENCES payments(id),
  reversed_by       BIGINT REFERENCES payments(id),
  journal_entry_id  BIGINT REFERENCES journal_entries(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_idempotency_key_fkey;

-- ---------------------------------------------------------------------------
-- Payment Allocations (what portion of a payment went where)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_allocations (
  id                BIGSERIAL PRIMARY KEY,
  payment_id        BIGINT NOT NULL REFERENCES payments(id),
  instalment_id     BIGINT REFERENCES instalments(id),  -- NULL = unapplied credit
  allocation_type   TEXT NOT NULL CHECK (allocation_type IN ('penalty', 'fee', 'interest', 'principal', 'unapplied')),
  amount_kobo       BIGINT NOT NULL CHECK (amount_kobo > 0),
  -- Link to the correcting journal entry that recorded this version's delta
  correcting_entry_id BIGINT REFERENCES journal_entries(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Reallocation events: one row per recomputation of a loan's allocations
-- (caused by a payment reversal or an out-of-order payment). Append-only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reallocation_events (
  id                 BIGSERIAL PRIMARY KEY,
  loan_id            BIGINT NOT NULL REFERENCES loans(id),
  trigger_type       TEXT NOT NULL CHECK (trigger_type IN ('payment_reversal', 'out_of_order_payment')),
  trigger_payment_id BIGINT REFERENCES payments(id),
  reason             TEXT,
  effective_date     DATE NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Allocation versioning. A row is ACTIVE while superseded_by_event_id IS NULL.
-- Rows are never deleted; reallocation marks old rows superseded and inserts new rows.
ALTER TABLE payment_allocations ADD COLUMN IF NOT EXISTS created_by_event_id    BIGINT REFERENCES reallocation_events(id);
ALTER TABLE payment_allocations ADD COLUMN IF NOT EXISTS superseded_by_event_id BIGINT REFERENCES reallocation_events(id);
CREATE INDEX IF NOT EXISTS idx_payment_allocs_active ON payment_allocations (payment_id) WHERE superseded_by_event_id IS NULL;

CREATE OR REPLACE FUNCTION protect_payment_allocations()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_allocations are append-only (DELETE rejected)';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
     OR NEW.instalment_id IS DISTINCT FROM OLD.instalment_id
     OR NEW.allocation_type IS DISTINCT FROM OLD.allocation_type
     OR NEW.amount_kobo IS DISTINCT FROM OLD.amount_kobo
     OR NEW.created_by_event_id IS DISTINCT FROM OLD.created_by_event_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'payment_allocations are append-only (immutable columns changed)';
  END IF;
  IF OLD.superseded_by_event_id IS NOT NULL
     AND NEW.superseded_by_event_id IS DISTINCT FROM OLD.superseded_by_event_id THEN
    RAISE EXCEPTION 'payment_allocations row already superseded';
  END IF;
  IF OLD.correcting_entry_id IS NOT NULL
     AND NEW.correcting_entry_id IS DISTINCT FROM OLD.correcting_entry_id THEN
    RAISE EXCEPTION 'payment_allocations correcting_entry_id already set';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_payment_allocations ON payment_allocations;
CREATE TRIGGER trg_protect_payment_allocations
  BEFORE UPDATE OR DELETE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION protect_payment_allocations();

CREATE OR REPLACE FUNCTION block_append_only_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_reallocation_events_append_only ON reallocation_events;
CREATE TRIGGER trg_reallocation_events_append_only
  BEFORE UPDATE OR DELETE ON reallocation_events
  FOR EACH ROW EXECUTE FUNCTION block_append_only_mutation();

-- ---------------------------------------------------------------------------
-- Invoice Financing (Product A)
-- Policy: ONE debtor collection settles the invoice. Any amount short of
-- advance + charges becomes a client receivable (recourse) and the invoice is
-- closed as 'settled_shortfall'. Multiple partial collections are not supported.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_financings (
  id                  BIGSERIAL PRIMARY KEY,
  loan_id             BIGINT NOT NULL REFERENCES loans(id),
  face_value_kobo     BIGINT NOT NULL CHECK (face_value_kobo > 0),
  advance_kobo        BIGINT NOT NULL CHECK (advance_kobo > 0),
  reserve_kobo        BIGINT NOT NULL CHECK (reserve_kobo >= 0),
  discount_fee_kobo   BIGINT NOT NULL CHECK (discount_fee_kobo >= 0),
  tenor_days          INTEGER NOT NULL CHECK (tenor_days > 0),
  annual_rate_bps     INTEGER NOT NULL DEFAULT 3600,   -- 36%
  due_date            DATE NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'settled_shortfall')),
  settled_date        DATE,
  -- Recorded at settlement so reconciliation can verify the ledger per invoice
  settlement_amount_kobo BIGINT CHECK (settlement_amount_kobo >= 0),
  late_penalty_kobo      BIGINT CHECK (late_penalty_kobo >= 0),
  client_payable_kobo    BIGINT CHECK (client_payable_kobo >= 0),
  client_receivable_kobo BIGINT CHECK (client_receivable_kobo >= 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Upgrades for databases created by earlier versions of this schema.
-- CREATE TABLE IF NOT EXISTS never alters an existing table, so every column or
-- constraint change since the first release must be repeated here (idempotent).
-- ---------------------------------------------------------------------------
ALTER TABLE instalments ADD COLUMN IF NOT EXISTS penalty_kobo BIGINT NOT NULL DEFAULT 0;
ALTER TABLE instalments ADD COLUMN IF NOT EXISTS fee_kobo     BIGINT NOT NULL DEFAULT 0;

ALTER TABLE invoice_financings ADD COLUMN IF NOT EXISTS tenor_days INTEGER;
UPDATE invoice_financings f
   SET tenor_days = (f.due_date - l.disbursement_date)
  FROM loans l
 WHERE l.id = f.loan_id AND f.tenor_days IS NULL AND f.due_date > l.disbursement_date;
ALTER TABLE invoice_financings ALTER COLUMN tenor_days SET NOT NULL;
ALTER TABLE invoice_financings ALTER COLUMN tenor_days DROP DEFAULT;
ALTER TABLE invoice_financings ADD COLUMN IF NOT EXISTS settlement_amount_kobo BIGINT;
ALTER TABLE invoice_financings ADD COLUMN IF NOT EXISTS late_penalty_kobo      BIGINT;
ALTER TABLE invoice_financings ADD COLUMN IF NOT EXISTS client_payable_kobo    BIGINT;
ALTER TABLE invoice_financings ADD COLUMN IF NOT EXISTS client_receivable_kobo BIGINT;

ALTER TABLE loans DROP CONSTRAINT IF EXISTS loans_annual_rate_bps_check;
ALTER TABLE loans ADD  CONSTRAINT loans_annual_rate_bps_check CHECK (annual_rate_bps >= 0);
ALTER TABLE loans DROP CONSTRAINT IF EXISTS loans_status_check;
ALTER TABLE loans ADD  CONSTRAINT loans_status_check
  CHECK (status IN ('active', 'settled', 'settled_shortfall', 'cancelled'));

ALTER TABLE instalments DROP CONSTRAINT IF EXISTS instalments_interest_kobo_check;
ALTER TABLE instalments ADD  CONSTRAINT instalments_interest_kobo_check CHECK (interest_kobo >= 0);

ALTER TABLE invoice_financings DROP CONSTRAINT IF EXISTS invoice_financings_reserve_kobo_check;
ALTER TABLE invoice_financings ADD  CONSTRAINT invoice_financings_reserve_kobo_check CHECK (reserve_kobo >= 0);
ALTER TABLE invoice_financings DROP CONSTRAINT IF EXISTS invoice_financings_discount_fee_kobo_check;
ALTER TABLE invoice_financings ADD  CONSTRAINT invoice_financings_discount_fee_kobo_check CHECK (discount_fee_kobo >= 0);
ALTER TABLE invoice_financings DROP CONSTRAINT IF EXISTS invoice_financings_status_check;
ALTER TABLE invoice_financings ADD  CONSTRAINT invoice_financings_status_check
  CHECK (status IN ('open', 'settled', 'settled_shortfall'));

-- ---------------------------------------------------------------------------
-- FK: loans.id on journal_entries.loan_id (idempotent block)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_journal_entries_loan'
  ) THEN
    ALTER TABLE journal_entries
      ADD CONSTRAINT fk_journal_entries_loan
      FOREIGN KEY (loan_id) REFERENCES loans(id);
  END IF;
END $$;

-- Idempotency check on journal entry references (protects accrual jobs)
CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_unique_ref
  ON journal_entries (reference)
  WHERE reference IS NOT NULL;

-- Schema migration history table for versioned deployment tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  version             TEXT PRIMARY KEY,
  description         TEXT NOT NULL,
  applied_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Indexes for performance
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_journal_entries_loan     ON journal_entries (loan_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_date     ON journal_entries (entry_date);
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry      ON journal_lines   (entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account    ON journal_lines   (account_id);
CREATE INDEX IF NOT EXISTS idx_instalments_loan_due     ON instalments     (loan_id, due_date);
CREATE INDEX IF NOT EXISTS idx_instalments_loan_period  ON instalments     (loan_id, period_number);
CREATE INDEX IF NOT EXISTS idx_payments_loan            ON payments        (loan_id, payment_date);
CREATE INDEX IF NOT EXISTS idx_payment_allocs_payment   ON payment_allocations (payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_allocs_instalment ON payment_allocations (instalment_id);

-- ---------------------------------------------------------------------------
-- Helper view: trial balance
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW trial_balance AS
SELECT
  a.code,
  a.name,
  a.type,
  COALESCE(SUM(jl.debit_kobo),  0) AS total_debit,
  COALESCE(SUM(jl.credit_kobo), 0) AS total_credit,
  COALESCE(SUM(jl.debit_kobo),  0) - COALESCE(SUM(jl.credit_kobo), 0) AS net
FROM accounts a
LEFT JOIN journal_lines jl ON jl.account_id = a.id
GROUP BY a.id, a.code, a.name, a.type
ORDER BY a.type, a.code;
