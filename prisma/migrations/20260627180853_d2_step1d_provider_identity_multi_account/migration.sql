/*
  Warnings:

  - A unique constraint covering the columns `[provider,externalAccountId,financialAccountId]` on the table `ProviderAccountIdentity` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[provider,financialAccountId]` on the table `ProviderAccountIdentity` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "ProviderAccountIdentity_provider_externalAccountId_key";

-- CreateIndex
CREATE UNIQUE INDEX "ProviderAccountIdentity_provider_externalAccountId_financia_key" ON "ProviderAccountIdentity"("provider", "externalAccountId", "financialAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderAccountIdentity_provider_financialAccountId_key" ON "ProviderAccountIdentity"("provider", "financialAccountId");
