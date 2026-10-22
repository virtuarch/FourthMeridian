-- IDEMP-002 (2026-10-22) — the account-purge CLAIM.
-- Additive, nullable, no backfill, no index: one timestamp that exactly one
-- process-deletions worker sets through a conditional UPDATE
-- (deletionScheduledAt <= now AND purgeStartedAt IS NULL) before it touches
-- anything irreversible. A row still present with a claim older than the
-- stale window is re-claimable, so a crashed worker never strands a user.
-- fm_app already holds UPDATE on "User" (self-row policy); the purge runs
-- under the system principal. No grant or policy change.
ALTER TABLE "User" ADD COLUMN "purgeStartedAt" TIMESTAMP(3);
