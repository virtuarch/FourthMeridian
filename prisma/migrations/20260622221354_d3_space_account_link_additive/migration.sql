-- CreateEnum
CREATE TYPE "SpaceAccountLinkKind" AS ENUM ('HOME', 'SHARED');

-- CreateTable
CREATE TABLE "SpaceAccountLink" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "financialAccountId" TEXT NOT NULL,
    "kind" "SpaceAccountLinkKind" NOT NULL,
    "addedByUserId" TEXT NOT NULL,
    "visibilityLevel" "VisibilityLevel" NOT NULL DEFAULT 'FULL',
    "status" "ShareStatus" NOT NULL DEFAULT 'ACTIVE',
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpaceAccountLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SpaceAccountLink_spaceId_status_idx" ON "SpaceAccountLink"("spaceId", "status");

-- CreateIndex
CREATE INDEX "SpaceAccountLink_financialAccountId_status_idx" ON "SpaceAccountLink"("financialAccountId", "status");

-- CreateIndex
CREATE INDEX "SpaceAccountLink_financialAccountId_kind_idx" ON "SpaceAccountLink"("financialAccountId", "kind");

-- CreateIndex
CREATE INDEX "SpaceAccountLink_addedByUserId_idx" ON "SpaceAccountLink"("addedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "SpaceAccountLink_spaceId_financialAccountId_key" ON "SpaceAccountLink"("spaceId", "financialAccountId");

-- AddForeignKey
ALTER TABLE "SpaceAccountLink" ADD CONSTRAINT "SpaceAccountLink_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpaceAccountLink" ADD CONSTRAINT "SpaceAccountLink_financialAccountId_fkey" FOREIGN KEY ("financialAccountId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpaceAccountLink" ADD CONSTRAINT "SpaceAccountLink_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpaceAccountLink" ADD CONSTRAINT "SpaceAccountLink_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
