ALTER TYPE "WorkspaceType" RENAME TO "SpaceType";
ALTER TYPE "WorkspaceCategory" RENAME TO "SpaceCategory";
ALTER TYPE "WorkspaceDashboardTab" RENAME TO "SpaceDashboardTab";
ALTER TYPE "WorkspaceMemberRole" RENAME TO "SpaceMemberRole";
ALTER TYPE "WorkspaceMemberStatus" RENAME TO "SpaceMemberStatus";

ALTER TABLE "Workspace" RENAME TO "Space";
ALTER TABLE "WorkspaceMember" RENAME TO "SpaceMember";
ALTER TABLE "WorkspaceInvite" RENAME TO "SpaceInvite";
ALTER TABLE "WorkspaceGoal" RENAME TO "SpaceGoal";
ALTER TABLE "WorkspaceDashboardSection" RENAME TO "SpaceDashboardSection";
ALTER TABLE "WorkspaceSnapshot" RENAME TO "SpaceSnapshot";

ALTER TABLE "User" RENAME COLUMN "preferredWorkspaceId" TO "preferredSpaceId";
ALTER TABLE "SpaceMember" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "SpaceInvite" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "AiAgent" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "Account" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "DuplicateAccountCandidate" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "SpaceGoal" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "SpaceDashboardSection" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "SpaceSnapshot" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "AiAdvice" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "AuditLog" RENAME COLUMN "workspaceId" TO "spaceId";
ALTER TABLE "FinancialAccount" RENAME COLUMN "ownerWorkspaceId" TO "ownerSpaceId";

ALTER TABLE "Space" RENAME CONSTRAINT "Workspace_pkey" TO "Space_pkey";
ALTER TABLE "SpaceMember" RENAME CONSTRAINT "WorkspaceMember_pkey" TO "SpaceMember_pkey";
ALTER TABLE "SpaceInvite" RENAME CONSTRAINT "WorkspaceInvite_pkey" TO "SpaceInvite_pkey";
ALTER TABLE "SpaceGoal" RENAME CONSTRAINT "WorkspaceGoal_pkey" TO "SpaceGoal_pkey";
ALTER TABLE "SpaceDashboardSection" RENAME CONSTRAINT "WorkspaceDashboardSection_pkey" TO "SpaceDashboardSection_pkey";
ALTER TABLE "SpaceSnapshot" RENAME CONSTRAINT "WorkspaceSnapshot_pkey" TO "SpaceSnapshot_pkey";

-- SpaceMember
ALTER TABLE "SpaceMember" RENAME CONSTRAINT "WorkspaceMember_workspaceId_fkey" TO "SpaceMember_spaceId_fkey";
ALTER TABLE "SpaceMember" RENAME CONSTRAINT "WorkspaceMember_userId_fkey" TO "SpaceMember_userId_fkey";
ALTER TABLE "SpaceMember" RENAME CONSTRAINT "WorkspaceMember_revokedById_fkey" TO "SpaceMember_revokedById_fkey";

-- SpaceInvite
ALTER TABLE "SpaceInvite" RENAME CONSTRAINT "WorkspaceInvite_workspaceId_fkey" TO "SpaceInvite_spaceId_fkey";
ALTER TABLE "SpaceInvite" RENAME CONSTRAINT "WorkspaceInvite_invitedById_fkey" TO "SpaceInvite_invitedById_fkey";
ALTER TABLE "SpaceInvite" RENAME CONSTRAINT "WorkspaceInvite_invitedUserId_fkey" TO "SpaceInvite_invitedUserId_fkey";

-- SpaceGoal
ALTER TABLE "SpaceGoal" RENAME CONSTRAINT "WorkspaceGoal_workspaceId_fkey" TO "SpaceGoal_spaceId_fkey";
ALTER TABLE "SpaceGoal" RENAME CONSTRAINT "WorkspaceGoal_createdByUserId_fkey" TO "SpaceGoal_createdByUserId_fkey";

-- SpaceDashboardSection
ALTER TABLE "SpaceDashboardSection" RENAME CONSTRAINT "WorkspaceDashboardSection_workspaceId_fkey" TO "SpaceDashboardSection_spaceId_fkey";

-- SpaceSnapshot
ALTER TABLE "SpaceSnapshot" RENAME CONSTRAINT "WorkspaceSnapshot_workspaceId_fkey" TO "SpaceSnapshot_spaceId_fkey";

-- Other tables
ALTER TABLE "AiAgent" RENAME CONSTRAINT "AiAgent_workspaceId_fkey" TO "AiAgent_spaceId_fkey";
ALTER TABLE "AiAdvice" RENAME CONSTRAINT "AiAdvice_workspaceId_fkey" TO "AiAdvice_spaceId_fkey";
ALTER TABLE "AuditLog" RENAME CONSTRAINT "AuditLog_workspaceId_fkey" TO "AuditLog_spaceId_fkey";
ALTER TABLE "Account" RENAME CONSTRAINT "Account_workspaceId_fkey" TO "Account_spaceId_fkey";
ALTER TABLE "FinancialAccount" RENAME CONSTRAINT "FinancialAccount_ownerWorkspaceId_fkey" TO "FinancialAccount_ownerSpaceId_fkey";

ALTER INDEX "WorkspaceMember_workspaceId_userId_key" RENAME TO "SpaceMember_spaceId_userId_key";
ALTER INDEX "WorkspaceInvite_workspaceId_invitedUserId_key" RENAME TO "SpaceInvite_spaceId_invitedUserId_key";
ALTER INDEX "WorkspaceDashboardSection_workspaceId_key_key" RENAME TO "SpaceDashboardSection_spaceId_key_key";
ALTER INDEX "WorkspaceSnapshot_workspaceId_date_key" RENAME TO "SpaceSnapshot_spaceId_date_key";
ALTER INDEX "AiAgent_workspaceId_key" RENAME TO "AiAgent_spaceId_key";

-- Space
ALTER INDEX "Workspace_type_idx" RENAME TO "Space_type_idx";
ALTER INDEX "Workspace_isPublic_idx" RENAME TO "Space_isPublic_idx";
ALTER INDEX "Workspace_archivedAt_idx" RENAME TO "Space_archivedAt_idx";
ALTER INDEX "Workspace_deletedAt_idx" RENAME TO "Space_deletedAt_idx";

-- SpaceMember
ALTER INDEX "WorkspaceMember_workspaceId_idx" RENAME TO "SpaceMember_spaceId_idx";
ALTER INDEX "WorkspaceMember_userId_idx" RENAME TO "SpaceMember_userId_idx";
ALTER INDEX "WorkspaceMember_workspaceId_status_idx" RENAME TO "SpaceMember_spaceId_status_idx";

-- SpaceInvite
ALTER INDEX "WorkspaceInvite_invitedUserId_idx" RENAME TO "SpaceInvite_invitedUserId_idx";
ALTER INDEX "WorkspaceInvite_workspaceId_idx" RENAME TO "SpaceInvite_spaceId_idx";

-- SpaceGoal
ALTER INDEX "WorkspaceGoal_workspaceId_status_idx" RENAME TO "SpaceGoal_spaceId_status_idx";
ALTER INDEX "WorkspaceGoal_workspaceId_category_idx" RENAME TO "SpaceGoal_spaceId_category_idx";
ALTER INDEX "WorkspaceGoal_workspaceId_goalType_idx" RENAME TO "SpaceGoal_spaceId_goalType_idx";

-- SpaceDashboardSection
ALTER INDEX "WorkspaceDashboardSection_workspaceId_tab_idx" RENAME TO "SpaceDashboardSection_spaceId_tab_idx";
ALTER INDEX "WorkspaceDashboardSection_workspaceId_enabled_idx" RENAME TO "SpaceDashboardSection_spaceId_enabled_idx";

-- SpaceSnapshot
ALTER INDEX "WorkspaceSnapshot_workspaceId_date_idx" RENAME TO "SpaceSnapshot_spaceId_date_idx";

-- Other tables
ALTER INDEX "AiAgent_workspaceId_idx" RENAME TO "AiAgent_spaceId_idx";
ALTER INDEX "AiAdvice_workspaceId_generatedAt_idx" RENAME TO "AiAdvice_spaceId_generatedAt_idx";
ALTER INDEX "AuditLog_workspaceId_createdAt_idx" RENAME TO "AuditLog_spaceId_createdAt_idx";
ALTER INDEX "Account_workspaceId_idx" RENAME TO "Account_spaceId_idx";
ALTER INDEX "Account_workspaceId_type_idx" RENAME TO "Account_spaceId_type_idx";
ALTER INDEX "DuplicateAccountCandidate_workspaceId_status_idx" RENAME TO "DuplicateAccountCandidate_spaceId_status_idx";
ALTER INDEX "FinancialAccount_ownerWorkspaceId_idx" RENAME TO "FinancialAccount_ownerSpaceId_idx";