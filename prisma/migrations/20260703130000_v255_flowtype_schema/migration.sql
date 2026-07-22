-- CreateEnum
CREATE TYPE "FlowType" AS ENUM ('SPENDING', 'INCOME', 'REFUND', 'DEBT_PAYMENT', 'TRANSFER', 'INVESTMENT', 'FEE', 'INTEREST', 'ADJUSTMENT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "FlowDirection" AS ENUM ('INFLOW', 'OUTFLOW', 'INTERNAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "FlowClassificationReason" AS ENUM ('PLAID_PFC_DETAILED', 'PLAID_PFC_PRIMARY', 'CATEGORY_FLOW_VALUE', 'CATEGORY_INVESTMENT_VALUE', 'ACCOUNT_TYPE_CONTEXT', 'SIGN_DEFAULT_SPENDING', 'SIGN_DEFAULT_INFLOW', 'AMBIGUOUS_UNKNOWN');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "classificationConfidence" DOUBLE PRECISION,
ADD COLUMN     "classificationReason" "FlowClassificationReason",
ADD COLUMN     "classifierVersion" INTEGER,
ADD COLUMN     "counterpartyAccountId" TEXT,
ADD COLUMN     "flowDirection" "FlowDirection",
ADD COLUMN     "flowType" "FlowType",
ADD COLUMN     "merchantEntityId" TEXT,
ADD COLUMN     "pfcConfidenceLevel" TEXT,
ADD COLUMN     "pfcDetailed" TEXT,
ADD COLUMN     "pfcPrimary" TEXT;

-- CreateIndex
CREATE INDEX "Transaction_financialAccountId_flowType_date_idx" ON "Transaction"("financialAccountId", "flowType", "date");

-- CreateIndex
CREATE INDEX "Transaction_flowType_date_idx" ON "Transaction"("flowType", "date");

-- CreateIndex
CREATE INDEX "Transaction_counterpartyAccountId_idx" ON "Transaction"("counterpartyAccountId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_counterpartyAccountId_fkey" FOREIGN KEY ("counterpartyAccountId") REFERENCES "FinancialAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
