-- DropForeignKey
ALTER TABLE "WorkspaceDashboardSection" DROP CONSTRAINT "WorkspaceDashboardSection_workspaceId_fkey";

-- AlterTable
ALTER TABLE "WorkspaceDashboardSection" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "WorkspaceDashboardSection" ADD CONSTRAINT "WorkspaceDashboardSection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
