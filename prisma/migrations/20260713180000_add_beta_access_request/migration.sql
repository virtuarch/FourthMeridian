-- Wave 1 S3 — Beta-access request → approval → invite. Purely additive: 1 enum
-- type + 1 table (BetaAccessRequest) with its unique constraints (email,
-- inviteTokenHash) and the queue index (status, createdAt). No existing row or
-- column is changed; no backfill. Scoped to this slice only — any unrelated
-- drift `prisma migrate diff` might also surface belongs to other slices and is
-- deliberately NOT included here (same convention as
-- 20260713150000_po1_0_platform_access).

-- CreateEnum
CREATE TYPE "BetaAccessRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'REDEEMED');

-- CreateTable
CREATE TABLE "BetaAccessRequest" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "note" TEXT,
    "status" "BetaAccessRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "inviteTokenHash" TEXT,
    "inviteExpiresAt" TIMESTAMP(3),
    "invitedAt" TIMESTAMP(3),
    "redeemedAt" TIMESTAMP(3),
    "redeemedUserId" TEXT,

    CONSTRAINT "BetaAccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BetaAccessRequest_email_key" ON "BetaAccessRequest"("email");

-- CreateIndex
CREATE UNIQUE INDEX "BetaAccessRequest_inviteTokenHash_key" ON "BetaAccessRequest"("inviteTokenHash");

-- CreateIndex
CREATE INDEX "BetaAccessRequest_status_createdAt_idx" ON "BetaAccessRequest"("status", "createdAt");
