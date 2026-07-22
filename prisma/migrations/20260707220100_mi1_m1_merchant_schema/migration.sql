-- MI1 M1 — Merchant Intelligence additive schema foundation.
-- Additive and behavior-neutral: three new tables, four new enums, three new
-- nullable Transaction columns (two SetNull FKs), and their indexes. Nothing
-- reads or writes any of this yet (write-time resolution = M4, backfill = M3/M4,
-- corrections = M5, read cutover = M6). categorySource is nullable with NO
-- default (null = "pre-MI row, provenance unknown" — the MC1 Phase 0 doctrine).
-- No MerchantAsset table, no blob storage, no Plaid capture wiring.
-- See docs/initiatives/mi1/MI1_M0_RATIFICATION_2026-07-07.md.

-- CreateEnum
CREATE TYPE "CategorySource" AS ENUM ('PLAID_PFC', 'USER_RULE', 'GLOBAL_CATALOG', 'PFC_SPEND_BUCKET', 'USER_OVERRIDE', 'LEGACY');

-- CreateEnum
CREATE TYPE "MerchantRuleScope" AS ENUM ('USER', 'SPACE');

-- CreateEnum
CREATE TYPE "MerchantAliasSource" AS ENUM ('PLAID', 'IMPORT', 'USER');

-- CreateEnum
CREATE TYPE "MerchantEnrichmentSource" AS ENUM ('PLAID_COUNTERPARTY', 'COINBASE', 'SECURITY_METADATA', 'EXTERNAL_PROVIDER');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "categoryRuleId" TEXT,
ADD COLUMN     "categorySource" "CategorySource",
ADD COLUMN     "merchantId" TEXT;

-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "canonicalKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "plaidEntityId" TEXT,
    "defaultCategory" "TransactionCategory",
    "website" TEXT,
    "logoUrl" TEXT,
    "enrichmentSource" "MerchantEnrichmentSource",
    "enrichmentConfidence" DOUBLE PRECISION,
    "enrichedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantAlias" (
    "id" TEXT NOT NULL,
    "aliasKey" TEXT NOT NULL,
    "sample" TEXT,
    "source" "MerchantAliasSource" NOT NULL,
    "merchantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantRule" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "category" "TransactionCategory" NOT NULL,
    "scope" "MerchantRuleScope" NOT NULL,
    "ownerUserId" TEXT,
    "spaceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_canonicalKey_key" ON "Merchant"("canonicalKey");

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_plaidEntityId_key" ON "Merchant"("plaidEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantAlias_aliasKey_key" ON "MerchantAlias"("aliasKey");

-- CreateIndex
CREATE INDEX "MerchantAlias_merchantId_idx" ON "MerchantAlias"("merchantId");

-- CreateIndex
CREATE INDEX "MerchantRule_merchantId_idx" ON "MerchantRule"("merchantId");

-- CreateIndex
CREATE INDEX "MerchantRule_ownerUserId_idx" ON "MerchantRule"("ownerUserId");

-- CreateIndex
CREATE INDEX "MerchantRule_spaceId_idx" ON "MerchantRule"("spaceId");

-- CreateIndex
CREATE INDEX "Transaction_merchantId_idx" ON "Transaction"("merchantId");

-- CreateIndex
CREATE INDEX "Transaction_categoryRuleId_idx" ON "Transaction"("categoryRuleId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_categoryRuleId_fkey" FOREIGN KEY ("categoryRuleId") REFERENCES "MerchantRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantAlias" ADD CONSTRAINT "MerchantAlias_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantRule" ADD CONSTRAINT "MerchantRule_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
