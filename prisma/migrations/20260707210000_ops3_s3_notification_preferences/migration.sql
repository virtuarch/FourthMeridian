-- OPS-3 S3 — Notification preferences (override rows, default-by-absence) +
-- User.timezone (the one new User column of the initiative — frozen F11).
-- Frozen design: docs/initiatives/ops3/OPS3_IMPLEMENTATION_PLAN.md §2/S3.
-- Additive only: one new table + one nullable column. No backfill by design
-- (absence of a row IS the default). Hand-authored in Prisma's generated
-- conventions (DB1 house precedent); validated by `prisma migrate dev`.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "timezone" TEXT;

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_category_channel_key" ON "NotificationPreference"("userId", "category", "channel");

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
