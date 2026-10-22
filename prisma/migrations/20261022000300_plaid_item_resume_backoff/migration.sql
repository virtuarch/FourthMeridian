-- IDEMP-007 (2026-10-22) — backoff for the resume-stale-imports backstop.
-- A permanently blocked Item was retried every 5 minutes forever (~3 Plaid
-- calls per attempt). Two additive columns: the count of failed resume
-- attempts since the Item last completed, and the earliest next attempt.
-- Defaults make every existing row "never attempted"; no backfill. PlaidItem
-- grants/policies are unchanged (the job runs as the system principal).
ALTER TABLE "PlaidItem" ADD COLUMN "syncResumeAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PlaidItem" ADD COLUMN "syncResumeNextAt" TIMESTAMP(3);
