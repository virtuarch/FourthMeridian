-- CreateEnum
CREATE TYPE "MemoryKind" AS ENUM ('INTENTION', 'ASSUMPTION', 'CHECKPOINT');

-- CreateEnum
CREATE TYPE "MemoryStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'RETIRED');

-- CreateTable
CREATE TABLE "SpaceMemory" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "kind" "MemoryKind" NOT NULL,
    "subject" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "statedAs" TEXT NOT NULL,
    "statedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliesFrom" TIMESTAMP(3),
    "appliesTo" TIMESTAMP(3),
    "status" "MemoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "supersedesId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpaceMemory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SpaceMemory_supersedesId_key" ON "SpaceMemory"("supersedesId");

-- CreateIndex
CREATE INDEX "SpaceMemory_spaceId_ownerUserId_kind_status_idx" ON "SpaceMemory"("spaceId", "ownerUserId", "kind", "status");

-- CreateIndex
CREATE INDEX "SpaceMemory_spaceId_ownerUserId_subject_statedAt_idx" ON "SpaceMemory"("spaceId", "ownerUserId", "subject", "statedAt");

-- AddForeignKey
ALTER TABLE "SpaceMemory" ADD CONSTRAINT "SpaceMemory_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpaceMemory" ADD CONSTRAINT "SpaceMemory_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpaceMemory" ADD CONSTRAINT "SpaceMemory_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "SpaceMemory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

