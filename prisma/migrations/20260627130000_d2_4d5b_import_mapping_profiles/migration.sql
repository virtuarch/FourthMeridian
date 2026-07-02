-- CreateTable
CREATE TABLE "ImportMappingProfile" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" "ImportSource" NOT NULL,
    "institutionLabel" TEXT,
    "mapping" JSONB NOT NULL,
    "createdByUserId" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportMappingProfile_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "ImportBatch" ADD COLUMN     "mappingProfileId" TEXT,
ADD COLUMN     "resolvedColumnMapping" JSONB;

-- CreateIndex
CREATE INDEX "ImportMappingProfile_spaceId_idx" ON "ImportMappingProfile"("spaceId");

-- CreateIndex
CREATE INDEX "ImportMappingProfile_createdByUserId_idx" ON "ImportMappingProfile"("createdByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportMappingProfile_spaceId_name_key" ON "ImportMappingProfile"("spaceId", "name");

-- CreateIndex
CREATE INDEX "ImportBatch_mappingProfileId_idx" ON "ImportBatch"("mappingProfileId");

-- AddForeignKey
ALTER TABLE "ImportMappingProfile" ADD CONSTRAINT "ImportMappingProfile_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportMappingProfile" ADD CONSTRAINT "ImportMappingProfile_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_mappingProfileId_fkey" FOREIGN KEY ("mappingProfileId") REFERENCES "ImportMappingProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
