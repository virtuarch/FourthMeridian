-- OPS-1 S2b — email verification seam (STORED-BUT-NOT-CONSUMED).
-- Additive only: three nullable columns on "User" + a unique index on the
-- token, mirroring the existing password-reset token columns.
--
-- BACKFILL (grandfathering): every existing user is set to verified
-- (emailVerifiedAt = now()) so that no current account is ever treated as
-- unverified once an enforcement gate lands in a later slice. Only NEW signups
-- (created after this migration) start unverified.
--
-- Nothing reads these columns in S2b — the register route writes a token and
-- sends a verification email, but no verify/resend route or login gate exists
-- yet. See docs/initiatives/ops1/ for the S2b scope.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "emailVerificationToken" TEXT,
ADD COLUMN     "emailVerificationExpiry" TIMESTAMP(3);

-- Backfill: grandfather all existing users as verified.
UPDATE "User" SET "emailVerifiedAt" = CURRENT_TIMESTAMP WHERE "emailVerifiedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_emailVerificationToken_key" ON "User"("emailVerificationToken");
