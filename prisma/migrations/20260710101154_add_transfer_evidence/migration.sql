-- TE1 — provider-neutral transfer evidence (additive, nullable; non-destructive).
-- NOT YET APPLIED to the local dev DB (created with `migrate dev --create-only`).
-- Scoped to this slice only: the MerchantMergeDecision table/enum that the diff
-- also surfaced is PRE-EXISTING schema drift (defined in schema.prisma without its
-- own migration) and is deliberately excluded here — it is not part of this slice.

-- CreateEnum
CREATE TYPE "TransferRail" AS ENUM ('PAYMENT_APP');

-- CreateEnum
CREATE TYPE "TransferMovementForm" AS ENUM ('CASH');

-- CreateEnum
CREATE TYPE "TransferVenueClass" AS ENUM ('DEPOSITORY', 'BROKERAGE', 'EXCHANGE');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "transferRail" "TransferRail",
ADD COLUMN     "transferMovementForm" "TransferMovementForm",
ADD COLUMN     "transferVenueClass" "TransferVenueClass",
ADD COLUMN     "transferEvidenceConfidence" DOUBLE PRECISION,
ADD COLUMN     "transferEvidenceReason" TEXT,
ADD COLUMN     "transferEvidenceSource" TEXT,
ADD COLUMN     "transferEvidenceVersion" TEXT;
