-- D2 Step 7B: manual refresh/sync cooldown, scoped to PlaidItem.
-- Additive, nullable — null means "never manually refreshed," i.e. never on
-- cooldown. Distinct from the existing lastSyncedAt column, which is also
-- written by the scheduled sync job and is therefore not safe to gate a
-- manual-only cooldown on.

-- AlterTable
ALTER TABLE "PlaidItem" ADD COLUMN "lastManualRefreshAt" TIMESTAMP(3);
