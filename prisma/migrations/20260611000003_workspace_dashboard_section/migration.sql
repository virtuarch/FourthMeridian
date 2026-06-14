-- Migration part 2 of 2: WorkspaceDashboardSection table (Milestone 3).
-- Depends on 20260611000002 being committed first (enum values must exist).

-- ─────────────────────────────────────────────────────────────────────────────
-- WorkspaceDashboardSection
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "WorkspaceDashboardSection" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "key"         TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "tab"         "WorkspaceDashboardTab" NOT NULL DEFAULT 'OVERVIEW',
  "enabled"     BOOLEAN NOT NULL DEFAULT TRUE,
  "order"       INTEGER NOT NULL DEFAULT 0,
  "config"      JSONB,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceDashboardSection_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "WorkspaceDashboardSection"
  ADD CONSTRAINT "WorkspaceDashboardSection_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE;

ALTER TABLE "WorkspaceDashboardSection"
  ADD CONSTRAINT "WorkspaceDashboardSection_workspaceId_key_key"
    UNIQUE ("workspaceId", "key");

CREATE INDEX IF NOT EXISTS "WorkspaceDashboardSection_workspaceId_tab_idx"
  ON "WorkspaceDashboardSection"("workspaceId", "tab");

CREATE INDEX IF NOT EXISTS "WorkspaceDashboardSection_workspaceId_enabled_idx"
  ON "WorkspaceDashboardSection"("workspaceId", "enabled");
