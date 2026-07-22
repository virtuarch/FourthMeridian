-- PCS-3B: physically retire the legacy `Account` model.
-- All account truth is FinancialAccount + AccountConnection + SpaceAccountLink.
-- Transaction and Holding anchor solely on financialAccountId; the legacy
-- accountId FK columns and the Account table are dropped. Preview/production
-- are reset before launch, so no data-copy/backfill/row-preservation is needed.

-- DropForeignKey
ALTER TABLE "Account" DROP CONSTRAINT "Account_ownerId_fkey";

-- DropForeignKey
ALTER TABLE "Account" DROP CONSTRAINT "Account_plaidItemDbId_fkey";

-- DropForeignKey
ALTER TABLE "Account" DROP CONSTRAINT "Account_spaceId_fkey";

-- DropForeignKey
ALTER TABLE "Holding" DROP CONSTRAINT "Holding_accountId_fkey";

-- DropForeignKey
ALTER TABLE "Transaction" DROP CONSTRAINT "Transaction_accountId_fkey";

-- DropIndex
DROP INDEX "Holding_accountId_idx";

-- DropIndex
DROP INDEX "Holding_accountId_isCash_idx";

-- DropIndex
DROP INDEX "Holding_accountId_symbol_key";

-- DropIndex
DROP INDEX "Transaction_accountId_date_idx";

-- DropIndex
DROP INDEX "Transaction_accountId_idx";

-- AlterTable
ALTER TABLE "Holding" DROP COLUMN "accountId";

-- AlterTable
ALTER TABLE "Transaction" DROP COLUMN "accountId";

-- DropTable
DROP TABLE "Account";

