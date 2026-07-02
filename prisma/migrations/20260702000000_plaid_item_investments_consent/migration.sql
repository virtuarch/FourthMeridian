-- Plaid Investments consent handling.
-- Additive, nullable — null means "unknown / never derived". Populated lazily
-- by the next refresh (or at link time) from accountsGet's item metadata, or
-- by a one-time probe for pre-DTM Items. Gates investmentsHoldingsGet so an
-- Item without Investments consent is never repeatedly called against Plaid
-- (ADDITIONAL_CONSENT_REQUIRED). See
-- docs/investigations/PLAID_INVESTMENTS_CONSENT_INVESTIGATION.md.

-- CreateEnum
CREATE TYPE "PlaidInvestmentsConsent" AS ENUM ('ENABLED', 'CONSENT_REQUIRED', 'UNSUPPORTED');

-- AlterTable
ALTER TABLE "PlaidItem" ADD COLUMN "investmentsConsent" "PlaidInvestmentsConsent";
