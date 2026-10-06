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

/** Does Plaid's own product metadata say this Item offers Investments at all? */
export function offersInvestments(item: PlaidItemData): boolean {
  return item.available_products.includes(Products.Investments)
    || item.billed_products.includes(Products.Investments)
    || (item.products?.includes(Products.Investments) ?? false);
}

/**
 * The consent state to act on, given what is stored and what accountsGet says.
 *
 * ⚠️ CONSENT IS NOT SUPPORT. We request Investments consent at Link
 * (additional_consented_products), so `consented_products` lists Investments
 * even for an institution that offers no Investments product. Derivation alone
 * then says ENABLED, the holdings call fails PRODUCTS_NOT_SUPPORTED on every
 * refresh, and the card said "Investments synced" for an Item whose holdings
 * were never synced (Preview Sandbox, First Platypus Bank - OAuth, 2026-10-06).
 * The endpoint's answer is stored as UNSUPPORTED (sync-investments.ts) and
 * outranks consent metadata; only Plaid's product lists can re-promote it.
 *
 * Returns null when metadata is inconclusive (pre-DTM) — the caller keeps the
 * stored value, exactly as deriveInvestmentsConsent's contract.
 */
export function reconcileInvestmentsConsent(
  stored: PlaidInvestmentsConsent | null,
  item: PlaidItemData,
): PlaidInvestmentsConsent | null {
  const derived = deriveInvestmentsConsent(item);
  if (stored === PlaidInvestmentsConsent.UNSUPPORTED && derived === PlaidInvestmentsConsent.ENABLED && !offersInvestments(item)) {
    return PlaidInvestmentsConsent.UNSUPPORTED;
  }
  return derived;
}
