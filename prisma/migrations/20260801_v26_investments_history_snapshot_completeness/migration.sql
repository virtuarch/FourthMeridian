-- AlterTable
ALTER TABLE "SpaceSnapshot" ADD COLUMN     "completenessTier" TEXT,
ADD COLUMN     "contributingComponentCount" INTEGER,
ADD COLUMN     "totalComponentCount" INTEGER;

