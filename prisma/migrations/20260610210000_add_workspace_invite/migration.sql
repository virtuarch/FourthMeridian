-- AlterTable: add isPublic and description to Workspace
ALTER TABLE "Workspace" ADD COLUMN "description" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "isPublic" BOOLEAN NOT NULL DEFAULT false;

-- CreateEnum: InviteStatus
CREATE TYPE "InviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- CreateTable: WorkspaceInvite
CREATE TABLE "WorkspaceInvite" (
    "id"            TEXT NOT NULL,
    "workspaceId"   TEXT NOT NULL,
    "invitedById"   TEXT NOT NULL,
    "invitedUserId" TEXT NOT NULL,
    "role"          "WorkspaceMemberRole" NOT NULL DEFAULT 'MEMBER',
    "status"        "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"     TIMESTAMP(3),

    CONSTRAINT "WorkspaceInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceInvite_workspaceId_invitedUserId_key" ON "WorkspaceInvite"("workspaceId", "invitedUserId");
CREATE INDEX "WorkspaceInvite_invitedUserId_idx" ON "WorkspaceInvite"("invitedUserId");
CREATE INDEX "WorkspaceInvite_workspaceId_idx" ON "WorkspaceInvite"("workspaceId");
CREATE INDEX "Workspace_isPublic_idx" ON "Workspace"("isPublic");

-- AddForeignKey
ALTER TABLE "WorkspaceInvite" ADD CONSTRAINT "WorkspaceInvite_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkspaceInvite" ADD CONSTRAINT "WorkspaceInvite_invitedById_fkey"
    FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkspaceInvite" ADD CONSTRAINT "WorkspaceInvite_invitedUserId_fkey"
    FOREIGN KEY ("invitedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
