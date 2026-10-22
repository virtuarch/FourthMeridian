-- DB-009 (2026-10-22) — four missing operational indexes. Additive only.
--   PlaidItem(syncIncompleteAt)      resume-stale-imports scans it every 5 minutes
--   SyncIssue(plaidItemId, resolved) open issues per Item
--   SpaceGoal(deletedAt)             dropped earlier and never re-added (model kept pending Agent G)
--   UserSession(revokedAt)           the retention reaper (revoked > 30 days)
CREATE INDEX "PlaidItem_syncIncompleteAt_idx" ON "PlaidItem"("syncIncompleteAt");
CREATE INDEX "SpaceGoal_deletedAt_idx" ON "SpaceGoal"("deletedAt");
CREATE INDEX "SyncIssue_plaidItemId_resolved_idx" ON "SyncIssue"("plaidItemId", "resolved");
CREATE INDEX "UserSession_revokedAt_idx" ON "UserSession"("revokedAt");
