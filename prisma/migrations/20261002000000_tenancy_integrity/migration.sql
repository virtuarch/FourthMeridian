-- RLS-0 — TENANCY INTEGRITY PREREQUISITES
--
-- Three schema facts that make an RLS `WITH CHECK` policy ambiguous or unsafe.
-- Authority: docs/plans/POSTGRES-RLS-ARCHITECTURE-INVESTIGATION.md §22, §15.4.
--
-- This migration deliberately does NOT backfill anything. A NULL tenant key is
-- not a value to invent — if one exists, the right answer is to stop and find
-- out how it got there, not to guess a tenant. Each ALTER therefore fails loudly
-- on a row it cannot justify, which is the intended behaviour.

-- ── 1. Transaction.financialAccountId ────────────────────────────────────────
-- The highest-volume, most sensitive table in the schema carried a NULLABLE
-- tenant FK. Under RLS a NULL makes the ownership EXISTS evaluate FALSE, so such
-- a row would be invisible to everyone INCLUDING its owner, and un-insertable
-- under WITH CHECK. Measured: 0 such rows. Closing the shape before the policy
-- lands means the policy cannot change behaviour for a case the schema still
-- permits.
--
-- No writer anywhere in the repository sets this column to NULL: every one of
-- the seven create sites supplies it, and the two update sites set a non-null
-- value.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "Transaction" WHERE "financialAccountId" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION
      'RLS-0 refused: % Transaction row(s) have a NULL financialAccountId. These rows have no derivable tenant. Investigate their origin before enabling RLS; do not backfill.', n;
  END IF;
END $$;

ALTER TABLE "Transaction" ALTER COLUMN "financialAccountId" SET NOT NULL;

-- ── 2. Holding.financialAccountId ────────────────────────────────────────────
-- Same hazard, on position values. Measured: 0 such rows, one production writer
-- (lib/investments/sync-current-holdings.ts), which appends the column AFTER the
-- row spread so it cannot be clobbered.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "Holding" WHERE "financialAccountId" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION
      'RLS-0 refused: % Holding row(s) have a NULL financialAccountId.', n;
  END IF;
END $$;

ALTER TABLE "Holding" ALTER COLUMN "financialAccountId" SET NOT NULL;

-- ── 3. MerchantRule — the scope/key correspondence ───────────────────────────
-- `scope` (USER | SPACE) declares WHICH of two nullable columns carries the
-- tenant, and nothing enforced the correspondence. Four states were
-- representable; two of them are tenant-less, and a tenant-less rule can
-- reclassify another tenant's transactions through Transaction.categoryRuleId.
--
-- An RLS policy cannot be written coherently over a column pair whose meaning is
-- decided by a third column that is not constrained against them. This CHECK is
-- that constraint. The single live writer already satisfies the USER arm
-- exactly, so no behaviour changes.
--
-- FKs on ownerUserId/spaceId are deliberately NOT added here: Prisma does not
-- model them, and introducing database-only foreign keys would register as
-- schema drift in scripts/check-schema-drift.ts. Tracked as a follow-up.
ALTER TABLE "MerchantRule" ADD CONSTRAINT "MerchantRule_scope_key_ck" CHECK (
  (scope = 'USER'  AND "ownerUserId" IS NOT NULL AND "spaceId"     IS NULL) OR
  (scope = 'SPACE' AND "spaceId"     IS NOT NULL AND "ownerUserId" IS NULL)
);
