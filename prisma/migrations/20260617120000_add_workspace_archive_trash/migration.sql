-- Add archive and soft-delete (trash) timestamps to Workspace.
-- Mirrors the existing WorkspaceGoal lifecycle pattern:
--   archivedAt set  -> hidden from normal nav, fully intact, restorable.
--   deletedAt  set  -> moved to trash, hidden from normal nav, restorable
--                      until permanently deleted.
-- Purely additive — both columns are nullable, no backfill required, no
-- existing rows are affected (every existing Workspace is implicitly
-- "active": archivedAt IS NULL AND deletedAt IS NULL).
ALTER TABLE "Workspace" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "Workspace" ADD COLUMN "deletedAt"  TIMESTAMP(3);

-- Indexes for default workspace list/switcher queries, which filter on
-- both columns being NULL, and for the Archive/Bin page's trash + archived
-- views, which filter on each column being NOT NULL.
CREATE INDEX "Workspace_archivedAt_idx" ON "Workspace"("archivedAt");
CREATE INDEX "Workspace_deletedAt_idx" ON "Workspace"("deletedAt");
