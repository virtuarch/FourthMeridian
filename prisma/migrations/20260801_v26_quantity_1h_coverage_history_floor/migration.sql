-- AlterTable
ALTER TABLE "InvestmentEventCoverage" ADD COLUMN     "earliestReturnedDate" DATE,
ADD COLUMN     "latestReturnedDate" DATE,
ADD COLUMN     "paginationReconciled" BOOLEAN NOT NULL DEFAULT false;

