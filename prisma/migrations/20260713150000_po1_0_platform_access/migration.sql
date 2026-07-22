-- PO1.0 — Platform Access Foundation. Purely additive: 3 enum types, 1 table,
-- 1 nullable unique column on Space, and its FK indexes. No existing row or
-- column is changed; no backfill. Scoped to this slice only — the pre-existing
-- MerchantMergeDecision table/enum and PositionObservation index-rename drift
-- that `prisma migrate diff` also surfaces belong to other slices and are
-- deliberately NOT included here (same convention as
-- 20260710101154_add_transfer_evidence).

-- CreateEnum
CREATE TYPE "PlatformArea" AS ENUM ('PLATFORM_OPS', 'SECURITY_OPS', 'GROWTH_REVENUE', 'CUSTOMER_SUCCESS');

-- CreateEnum
CREATE TYPE "PlatformAccessLevel" AS ENUM ('READ', 'WRITE');

-- CreateEnum
CREATE TYPE "PlatformGrantStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- AlterTable
ALTER TABLE "Space" ADD COLUMN     "platformArea" "PlatformArea";

-- CreateTable
CREATE TABLE "PlatformGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "area" "PlatformArea" NOT NULL,
    "level" "PlatformAccessLevel" NOT NULL,
    "status" "PlatformGrantStatus" NOT NULL DEFAULT 'ACTIVE',
    "grantedById" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformGrant_userId_status_idx" ON "PlatformGrant"("userId", "status");

-- CreateIndex
CREATE INDEX "PlatformGrant_area_status_idx" ON "PlatformGrant"("area", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformGrant_userId_area_key" ON "PlatformGrant"("userId", "area");

-- CreateIndex
CREATE UNIQUE INDEX "Space_platformArea_key" ON "Space"("platformArea");

-- AddForeignKey
ALTER TABLE "PlatformGrant" ADD CONSTRAINT "PlatformGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformGrant" ADD CONSTRAINT "PlatformGrant_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformGrant" ADD CONSTRAINT "PlatformGrant_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
