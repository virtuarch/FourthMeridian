-- OPS-2 S5 — cascade corrections (deletion safety).
--
-- Two FK flips, ratified in docs/initiatives/ops2/OPS2_S5_DELETION_INVENTORY.md:
--
--   1. SpaceGoal.createdByUserId       required + ON DELETE CASCADE
--                                    → nullable + ON DELETE SET NULL
--      A goal created in a SHARED Space is the Space's data — deleting the
--      creator must never destroy other members' goals/contributions/check-ins.
--
--   2. SpaceAccountLink.addedByUserId  required + ON DELETE CASCADE
--                                    → nullable + ON DELETE SET NULL
--      SAL doctrine is revoke-don't-delete; a hard cascade on the adder's
--      deletion would orphan accounts (incl. HOME links) other members rely on.
--
-- Metadata-only in Postgres: DROP NOT NULL rewrites no rows; the FK action
-- change is a constraint swap. No backfill — existing rows keep their real
-- user ids. Behavior-neutral for live code: both columns are always written
-- at creation and no code path deletes users today. Defense in depth ahead of
-- the S7 deletion pipeline.

-- AlterTable
ALTER TABLE "SpaceGoal" ALTER COLUMN "createdByUserId" DROP NOT NULL;

-- DropForeignKey
ALTER TABLE "SpaceGoal" DROP CONSTRAINT "SpaceGoal_createdByUserId_fkey";

-- AddForeignKey
ALTER TABLE "SpaceGoal" ADD CONSTRAINT "SpaceGoal_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "SpaceAccountLink" ALTER COLUMN "addedByUserId" DROP NOT NULL;

-- DropForeignKey
ALTER TABLE "SpaceAccountLink" DROP CONSTRAINT "SpaceAccountLink_addedByUserId_fkey";

-- AddForeignKey
ALTER TABLE "SpaceAccountLink" ADD CONSTRAINT "SpaceAccountLink_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
