-- Add soft-delete and archive timestamps to WorkspaceGoal
ALTER TABLE "WorkspaceGoal" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "WorkspaceGoal" ADD COLUMN "deletedAt"  TIMESTAMP(3);

-- Index for efficient trash cleanup cron queries
CREATE INDEX "WorkspaceGoal_deletedAt_idx" ON "WorkspaceGoal"("deletedAt");

-- Add preferred workspace preference to User (soft ref — no FK)
ALTER TABLE "User" ADD COLUMN "preferredWorkspaceId" TEXT;
