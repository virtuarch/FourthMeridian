-- CreateEnum
CREATE TYPE "PaymentChannel" AS ENUM ('ONLINE', 'IN_STORE', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'ACH', 'WIRE', 'CHECK', 'CASH', 'INTERNAL_TRANSFER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SettlementState" AS ENUM ('PENDING', 'POSTED');

-- CreateEnum
CREATE TYPE "CounterpartyType" AS ENUM ('MERCHANT', 'FINANCIAL_INSTITUTION', 'INCOME_SOURCE', 'PAYMENT_APP', 'MARKETPLACE', 'PAYMENT_TERMINAL', 'UNKNOWN');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "authorizedAt" DATE,
ADD COLUMN     "counterpartyType" "CounterpartyType",
ADD COLUMN     "fxApplied" BOOLEAN,
ADD COLUMN     "paymentChannel" "PaymentChannel",
ADD COLUMN     "paymentMethod" "PaymentMethod",
ADD COLUMN     "pendingTransactionRef" TEXT,
ADD COLUMN     "settlementState" "SettlementState",
ADD COLUMN     "tiFactsVersion" INTEGER;
