-- AlterTable
ALTER TABLE "PlaidItem" ADD COLUMN     "historyBuildDoneDays" INTEGER,
ADD COLUMN     "historyBuildStartedAt" TIMESTAMP(3),
ADD COLUMN     "historyBuildTotalDays" INTEGER;

