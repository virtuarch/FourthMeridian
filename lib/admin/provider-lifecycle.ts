/**
 * lib/admin/provider-lifecycle.ts
 *
 * Constants shared between admin API routes and admin client components for
 * the provider lifecycle feature (Expand History, Force Sync, Disconnect).
 *
 * Imported by:
 *   - app/api/admin/plaid/expand-history-token/route.ts (server)
 *   - app/api/admin/plaid/retire-superseded-item/route.ts (server)
 *   - components/admin/ProviderActionsButton.tsx (client)
 *   - components/admin/AdminExpandHistoryFlow.tsx (client)
 *
 * INSTITUTION IDS
 * ---------------
 * Chase (ins_3) and Charles Schwab (ins_12) are confirmed in the Institution
 * Catalog investigation (docs/initiatives/d6/D6_INSTITUTION_CATALOG_INVESTIGATION.md).
 *
 * Robinhood (ins_129562) is confirmed in the historical relink investigation
 * (docs/investigations/HISTORICAL_RELINK_INVESTIGATION.md). Robinhood is
 * BLOCKED from Expand History until Layer 3c (no-mask account matching) is
 * implemented — see D2 Slice investigation §3.3.
 *
 * Eligibility check (EXPAND_HISTORY_BLOCKED_INSTITUTIONS):
 * Rather than maintaining a whitelist (which would require adding AmEx's
 * institution ID once confirmed), we check the blocking case: any institution
 * whose accounts frequently lack a `mask` value and therefore cannot safely
 * pass through resolveAccountByFingerprint. Robinhood is the only known
 * blocked institution today. All others — including AmEx — have masks on all
 * accounts and are safe via the data-driven mask check in the admin page.
 */

/** Robinhood's Plaid institution ID. Blocked from Expand History until
 *  Layer 3c (no-mask account matching) is implemented. */
export const ROBINHOOD_PLAID_INSTITUTION_ID = "ins_129562";

/** Institution IDs blocked from Expand History pending implementation work.
 *  Checked server-side in expand-history-token and client-side in
 *  ProviderActionsButton. */
export const EXPAND_HISTORY_BLOCKED_INSTITUTIONS = new Set([
  ROBINHOOD_PLAID_INSTITUTION_ID,
]);
