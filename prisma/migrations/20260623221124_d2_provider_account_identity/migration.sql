-- CreateTable
CREATE TABLE "ProviderAccountIdentity" (
    "id" TEXT NOT NULL,
    "financialAccountId" TEXT NOT NULL,
    "connectionId" TEXT,
    "provider" "ProviderType" NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderAccountIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderAccountIdentity_financialAccountId_idx" ON "ProviderAccountIdentity"("financialAccountId");

-- CreateIndex
CREATE INDEX "ProviderAccountIdentity_connectionId_idx" ON "ProviderAccountIdentity"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderAccountIdentity_provider_externalAccountId_key" ON "ProviderAccountIdentity"("provider", "externalAccountId");

-- AddForeignKey
ALTER TABLE "ProviderAccountIdentity" ADD CONSTRAINT "ProviderAccountIdentity_financialAccountId_fkey" FOREIGN KEY ("financialAccountId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderAccountIdentity" ADD CONSTRAINT "ProviderAccountIdentity_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
