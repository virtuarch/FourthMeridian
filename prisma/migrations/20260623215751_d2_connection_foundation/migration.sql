-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('ACTIVE', 'NEEDS_REAUTH', 'ERROR', 'REVOKED');

-- CreateEnum
CREATE TYPE "ProviderType" AS ENUM ('PLAID', 'MANUAL', 'WALLET', 'CSV', 'EXCHANGE', 'BROKERAGE');

-- AlterTable
ALTER TABLE "AccountConnection" ADD COLUMN     "connectionId" TEXT;

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "ProviderType" NOT NULL,
    "externalConnectionId" TEXT,
    "credential" TEXT,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "cursor" TEXT,
    "errorCode" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Connection_userId_idx" ON "Connection"("userId");

-- CreateIndex
CREATE INDEX "Connection_provider_idx" ON "Connection"("provider");

-- CreateIndex
CREATE INDEX "AccountConnection_connectionId_idx" ON "AccountConnection"("connectionId");

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountConnection" ADD CONSTRAINT "AccountConnection_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
