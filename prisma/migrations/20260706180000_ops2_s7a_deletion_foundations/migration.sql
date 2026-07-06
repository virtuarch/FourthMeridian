-- OPS-2 S7a — account-deletion foundations.
-- Additive only: two nullable columns on "User".
--
-- No backfill: null = not scheduled for deletion for every existing user.
-- Timestamps (not an enum) per the S7 investigation — records WHEN for free
-- and reuses deactivatedAt (S4) as the lockout, so no state-machine column is
-- introduced here. deletionScheduledAt is the login gate's discriminator.
--
-- No index: read only via the unique user row (login / pre-login) in S7a. The
-- cron scan over deletionScheduledAt arrives in S7c and can add its own index
-- then if measured to need one.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deletionRequestedAt" TIMESTAMP(3),
ADD COLUMN     "deletionScheduledAt" TIMESTAMP(3);
