-- D11 (Phase 2 schema modernization): close out the Holding -> Account legacy
-- FK gap and add FinancialAccount.createdByUserId.
--
-- Nothing here is destructive:
--   * Holding.accountId is loosened from required to optional, mirroring the
--     same Transaction.accountId change already shipped in
--     20260616000000_account_metadata_debt_profile_and_tx_sync. Every
--     existing Holding row already has accountId set, so this is a no-op for
--     current data.
--   * Holding.financialAccountId is new and nullable — exactly one of
--     accountId / financialAccountId is expected to be set per row going
--     forward, same dual-FK pattern as Transaction.
--   * FinancialAccount.createdByUserId is new and nullable, backfilled below.
--     Stays nullable (not required) — additive only, never blocks an insert.

-- ── Holding: support FinancialAccount-anchored rows ──────────────────────────
ALTER TABLE "Holding" ALTER COLUMN "accountId" DROP NOT NULL;
ALTER TABLE "Holding" ADD COLUMN "financialAccountId" TEXT;

CREATE INDEX "Holding_financialAccountId_idx" ON "Holding"("financialAccountId");
CREATE INDEX "Holding_financialAccountId_isCash_idx" ON "Holding"("financialAccountId", "isCash");
CREATE UNIQUE INDEX "Holding_financialAccountId_symbol_key" ON "Holding"("financialAccountId", "symbol");

ALTER TABLE "Holding" ADD CONSTRAINT "Holding_financialAccountId_fkey"
    FOREIGN KEY ("financialAccountId") REFERENCES "FinancialAccount"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── FinancialAccount: human-accountable creator, independent of ownerType ──
ALTER TABLE "FinancialAccount" ADD COLUMN "createdByUserId" TEXT;

CREATE INDEX "FinancialAccount_createdByUserId_idx" ON "FinancialAccount"("createdByUserId");

ALTER TABLE "FinancialAccount" ADD CONSTRAINT "FinancialAccount_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: USER-owned accounts default to their existing owner. SPACE-owned
-- accounts have no ownerUserId by design (visibility, not accountability —
-- see the AccountOwnerType enum), so fall back to the earliest
-- AccountConnection's connectedByUserId, the only other recorded "who
-- connected this" signal today. Rows with neither (not expected in practice —
-- every FinancialAccount is created alongside an AccountConnection) are left
-- NULL rather than guessed at.
UPDATE "FinancialAccount" fa
SET "createdByUserId" = COALESCE(
    fa."ownerUserId",
    (
        SELECT ac."connectedByUserId"
        FROM "AccountConnection" ac
        WHERE ac."financialAccountId" = fa."id"
        ORDER BY ac."createdAt" ASC
        LIMIT 1
    )
)
WHERE fa."createdByUserId" IS NULL;
