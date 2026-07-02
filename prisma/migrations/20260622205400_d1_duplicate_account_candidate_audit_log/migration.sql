/*
  Warnings:

  - Added the required column `detectionSource` to the `DuplicateAccountCandidate` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "DuplicateDetectionSource" AS ENUM ('PROVIDER_IDENTITY_MATCH', 'FINGERPRINT_MATCH', 'SIBLING_CONSOLIDATION');

-- AlterTable
ALTER TABLE "DuplicateAccountCandidate" ADD COLUMN     "detectionSource" "DuplicateDetectionSource" NOT NULL,
ALTER COLUMN "workspaceId" DROP NOT NULL;
