-- OPS-2 S3a — authenticated email-change seam (request side).
-- Additive only: three nullable columns on "User" + a unique index on the
-- change token, mirroring the existing verification/reset token columns.
--
-- No backfill: these are null for every existing user (no pending change).
-- The address is NOT swapped here — the S3b confirm consumer (a later slice)
-- reads these columns. `pendingEmail` is intentionally NOT unique; final
-- uniqueness is enforced at swap time against the live `email` unique index.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "pendingEmail" TEXT,
ADD COLUMN     "emailChangeToken" TEXT,
ADD COLUMN     "emailChangeExpiry" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "User_emailChangeToken_key" ON "User"("emailChangeToken");
