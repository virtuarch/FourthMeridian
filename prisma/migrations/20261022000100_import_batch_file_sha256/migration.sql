-- IDEMP-001 (2026-10-22) — the CSV/XLSX import idempotency key.
--
-- The runtime audit submitted one 6-row file twice concurrently and got 12
-- rows: the fingerprint dedupe is a READ, not a constraint, so nothing stood
-- between two overlapping requests. Now the route hashes the upload, creates
-- the ImportBatch BEFORE parsing, and the index below refuses the second
-- claim (Postgres 23505 → Prisma P2002 → HTTP 409 with the existing batch id).
--
-- The predicate is the decision: a batch that is PENDING, PROCESSING,
-- COMPLETED or COMPLETED_WITH_ERRORS holds the slot; a ROLLED_BACK or FAILED
-- batch releases it, so a user who rolled back (or whose import failed) can
-- legitimately import the same file again. Legacy rows carry NULL and are
-- outside the predicate — no backfill, no data change. Additive only.
ALTER TABLE "ImportBatch" ADD COLUMN "fileSha256" TEXT;

CREATE UNIQUE INDEX "ImportBatch_account_file_live_key"
  ON "ImportBatch" ("financialAccountId", "fileSha256")
  WHERE "fileSha256" IS NOT NULL
    AND "status" IN ('PENDING', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS');
