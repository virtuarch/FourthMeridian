-- Additive enhancement: Plaid account display-name metadata, a dedicated debt
-- profile model, and schema support for syncing Plaid transactions onto
-- FinancialAccount (instead of only the legacy Account model).
--
-- Nothing here is destructive:
--   * All new columns are nullable, no defaults that touch existing rows.
--   * The DebtProfile table is brand new — does not alter FinancialAccount's
--     existing debtSubtype/interestRate/minimumPayment columns.
--   * Transaction.accountId is loosened from required to optional so future
--     Plaid-synced transactions (which only have a FinancialAccount, not a
--     legacy Account) can omit it. Every existing Transaction row already has
--     accountId set, so this is a no-op for current data.

-- ── FinancialAccount: display-name metadata (Goal 1) ─────────────────────────
-- institution already holds the human-readable institution name (e.g. "Chase"),
-- so no separate institutionName column was added.
ALTER TABLE "FinancialAccount" ADD COLUMN "plaidName"    TEXT;
ALTER TABLE "FinancialAccount" ADD COLUMN "officialName" TEXT;
ALTER TABLE "FinancialAccount" ADD COLUMN "displayName"  TEXT;

-- Backfill plaidName from the existing name column so the display-resolution
-- fallback chain (displayName ?? officialName ?? plaidName) works immediately
-- for every pre-existing account, not just newly-imported ones.
UPDATE "FinancialAccount" SET "plaidName" = "name" WHERE "plaidName" IS NULL;

-- ── DebtProfile (Goal 2) ──────────────────────────────────────────────────────
CREATE TABLE "DebtProfile" (
    "id"                 TEXT NOT NULL,
    "financialAccountId" TEXT NOT NULL,
    "apr"                DOUBLE PRECISION,
    "minimumPayment"     DOUBLE PRECISION,
    "dueDay"             INTEGER,
    "statementCloseDay"  INTEGER,
    "promoAprEndDate"    DATE,
    "notes"              TEXT,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DebtProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DebtProfile_financialAccountId_key" ON "DebtProfile"("financialAccountId");
CREATE INDEX "DebtProfile_financialAccountId_idx" ON "DebtProfile"("financialAccountId");

ALTER TABLE "DebtProfile" ADD CONSTRAINT "DebtProfile_financialAccountId_fkey"
    FOREIGN KEY ("financialAccountId") REFERENCES "FinancialAccount"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Transaction: support FinancialAccount-anchored rows (Goal 4) ────────────
ALTER TABLE "Transaction" ALTER COLUMN "accountId" DROP NOT NULL;
ALTER TABLE "Transaction" ADD COLUMN "financialAccountId" TEXT;

CREATE INDEX "Transaction_financialAccountId_idx" ON "Transaction"("financialAccountId");
CREATE INDEX "Transaction_financialAccountId_date_idx" ON "Transaction"("financialAccountId", "date");

ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_financialAccountId_fkey"
    FOREIGN KEY ("financialAccountId") REFERENCES "FinancialAccount"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
