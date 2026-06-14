-- Add debt-specific fields to FinancialAccount
-- All nullable — existing rows keep NULL until populated via manual entry or provider sync

ALTER TABLE "FinancialAccount" ADD COLUMN "interestRate"   DOUBLE PRECISION;
ALTER TABLE "FinancialAccount" ADD COLUMN "minimumPayment" DOUBLE PRECISION;
ALTER TABLE "FinancialAccount" ADD COLUMN "debtSubtype"    TEXT;
