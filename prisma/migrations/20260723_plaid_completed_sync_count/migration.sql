-- AlterTable
ALTER TABLE "PlaidItem" ADD COLUMN     "completedSyncCount" INTEGER NOT NULL DEFAULT 0;


-- Backfill: every EXISTING item has already finished whatever import it was
-- going to do, so mark it settled (2). Without this the next routine sync of a
-- long-established connection would increment 0 -> 1, read as "first run not
-- finished", and flip a working card back to "importing".
UPDATE "PlaidItem" SET "completedSyncCount" = 2;
