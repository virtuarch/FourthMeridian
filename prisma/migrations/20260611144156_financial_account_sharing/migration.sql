-- DropForeignKey
ALTER TABLE "AccountConnection" DROP CONSTRAINT "AccountConnection_connectedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "AccountConnection" DROP CONSTRAINT "AccountConnection_financialAccountId_fkey";

-- DropForeignKey
ALTER TABLE "AccountConnection" DROP CONSTRAINT "AccountConnection_plaidItemDbId_fkey";

-- DropForeignKey
ALTER TABLE "DuplicateAccountCandidate" DROP CONSTRAINT "DuplicateAccountCandidate_accountAId_fkey";

-- DropForeignKey
ALTER TABLE "DuplicateAccountCandidate" DROP CONSTRAINT "DuplicateAccountCandidate_accountBId_fkey";

-- DropForeignKey
ALTER TABLE "DuplicateAccountCandidate" DROP CONSTRAINT "DuplicateAccountCandidate_resolvedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "FinancialAccount" DROP CONSTRAINT "FinancialAccount_ownerUserId_fkey";

-- DropForeignKey
ALTER TABLE "FinancialAccount" DROP CONSTRAINT "FinancialAccount_ownerWorkspaceId_fkey";

-- DropForeignKey
ALTER TABLE "GoalContribution" DROP CONSTRAINT "GoalContribution_financialAccountId_fkey";

-- DropForeignKey
ALTER TABLE "GoalContribution" DROP CONSTRAINT "GoalContribution_goalId_fkey";

-- DropForeignKey
ALTER TABLE "WorkspaceAccountShare" DROP CONSTRAINT "WorkspaceAccountShare_addedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "WorkspaceAccountShare" DROP CONSTRAINT "WorkspaceAccountShare_financialAccountId_fkey";

-- DropForeignKey
ALTER TABLE "WorkspaceAccountShare" DROP CONSTRAINT "WorkspaceAccountShare_revokedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "WorkspaceAccountShare" DROP CONSTRAINT "WorkspaceAccountShare_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "WorkspaceGoal" DROP CONSTRAINT "WorkspaceGoal_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "WorkspaceGoal" DROP CONSTRAINT "WorkspaceGoal_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "WorkspaceMember" DROP CONSTRAINT "WorkspaceMember_revokedById_fkey";

-- AlterTable
ALTER TABLE "AccountConnection" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "FinancialAccount" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "WorkspaceAccountShare" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "WorkspaceGoal" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialAccount" ADD CONSTRAINT "FinancialAccount_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialAccount" ADD CONSTRAINT "FinancialAccount_ownerWorkspaceId_fkey" FOREIGN KEY ("ownerWorkspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountConnection" ADD CONSTRAINT "AccountConnection_financialAccountId_fkey" FOREIGN KEY ("financialAccountId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountConnection" ADD CONSTRAINT "AccountConnection_connectedByUserId_fkey" FOREIGN KEY ("connectedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountConnection" ADD CONSTRAINT "AccountConnection_plaidItemDbId_fkey" FOREIGN KEY ("plaidItemDbId") REFERENCES "PlaidItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceAccountShare" ADD CONSTRAINT "WorkspaceAccountShare_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceAccountShare" ADD CONSTRAINT "WorkspaceAccountShare_financialAccountId_fkey" FOREIGN KEY ("financialAccountId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceAccountShare" ADD CONSTRAINT "WorkspaceAccountShare_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceAccountShare" ADD CONSTRAINT "WorkspaceAccountShare_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateAccountCandidate" ADD CONSTRAINT "DuplicateAccountCandidate_accountAId_fkey" FOREIGN KEY ("accountAId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateAccountCandidate" ADD CONSTRAINT "DuplicateAccountCandidate_accountBId_fkey" FOREIGN KEY ("accountBId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateAccountCandidate" ADD CONSTRAINT "DuplicateAccountCandidate_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceGoal" ADD CONSTRAINT "WorkspaceGoal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceGoal" ADD CONSTRAINT "WorkspaceGoal_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalContribution" ADD CONSTRAINT "GoalContribution_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "WorkspaceGoal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalContribution" ADD CONSTRAINT "GoalContribution_financialAccountId_fkey" FOREIGN KEY ("financialAccountId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
