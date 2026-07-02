/**
 * lib/plaid/investmentsConsent.ts
 *
 * Derives a PlaidItem's Investments consent state from the `item` object
 * Plaid returns on accountsGet — data both refresh (lib/plaid/refresh.ts)
 * and link-time import (lib/plaid/exchangeToken.ts) already fetch, so this
 * costs zero extra API calls.
 *
 * Why: link tokens are created with products=[transactions] only (AmEx
 * compat — see app/api/plaid/link-token/route.ts), so under Data
 * Transparency Messaging no Item has Investments consent at link time and
 * investmentsHoldingsGet fails with ADDITIONAL_CONSENT_REQUIRED. That is
 * expected, not an error. The derived state is persisted to
 * PlaidItem.investmentsConsent and gates the holdings step. Full flow:
 * docs/investigations/PLAID_INVESTMENTS_CONSENT_INVESTIGATION.md.
 */

import { Item as PlaidItemData, Products } from "plaid";
import { PlaidInvestmentsConsent } from "@prisma/client";

/**
 * Returns the consent state derivable from accountsGet's `item` payload, or
 * null when it can't be determined from metadata alone (pre-DTM Items have
 * no consented_products — those get one investmentsHoldingsGet probe, whose
 * outcome is persisted by the caller instead).
 */
export function deriveInvestmentsConsent(
  item: PlaidItemData
): PlaidInvestmentsConsent | null {
  const consented = item.consented_products;
  // Pre-DTM Item — consent list absent/empty; metadata is inconclusive.
  if (!consented || consented.length === 0) return null;

  if (consented.includes(Products.Investments)) {
    return PlaidInvestmentsConsent.ENABLED;
  }

  // DTM Item without Investments consent. Distinguish "user just hasn't
  // consented" from "Plaid doesn't offer Investments for this Item at all".
  const supported =
    item.available_products.includes(Products.Investments) ||
    item.billed_products.includes(Products.Investments) ||
    (item.products?.includes(Products.Investments) ?? false);

  return supported
    ? PlaidInvestmentsConsent.CONSENT_REQUIRED
    : PlaidInvestmentsConsent.UNSUPPORTED;
}
