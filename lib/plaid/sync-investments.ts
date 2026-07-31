/**
 * lib/plaid/sync-investments.ts
 *
 * PROV-3 — the ONE investments-ingest orchestration for a Plaid item.
 *
 * Extracted from the ~80-line block hand-copied into exchangeToken.ts (initial
 * link) and refresh.ts (ongoing refresh). The leaf primitives it sequences were
 * already single-owned (deriveInvestmentsConsent, capturePositionObservations,
 * syncCurrentHoldings, ingestInvestmentEvents); this consolidates the SCAFFOLDING
 * — consent handling, the holdings call, the per-account filter + resolve, and
 * the observation→holdings→events sequence + ADDITIONAL_CONSENT_REQUIRED catch —
 * so the two entry points cannot drift again.
 *
 * ── What this owns vs what the entry points keep (PROV doctrine) ─────────────
 * OWNS: consent derive+persist, investmentsHoldingsGet, per-account resolve,
 *       observation, holdings reconciliation, event ingest, consent-error catch.
 * KEEPS (caller): the retry ENVELOPE around the whole item, locking, health
 *       reporting, snapshot regeneration, and how the returned count is named
 *       (holdingsImported vs holdingsUpdated). This is a shared STAGE, not a
 *       merged entrypoint — exchange and refresh remain independent operations.
 *
 * ── Two drifts, resolved canonically (were accidental, now deliberate) ──────
 *  • DRIFT-1 (consent persistence). exchange wrote the derived consent
 *    unconditionally; refresh change-detected against the stored value and
 *    logged the transition. CANONICAL: change-detect + log. At initial link the
 *    stored value is null, so any derived non-null value IS a change and is
 *    seeded + logged as "unknown → X" — identical DB end-state to exchange's old
 *    unconditional seed, minus redundant writes on a re-link where consent is
 *    unchanged. Pure observability delta on the link path (a transition log
 *    instead of exchange's old "skipping holdings import" phrasing).
 *  • DRIFT-2 (retry). refresh wrapped investmentsHoldingsGet in withPlaidRetry;
 *    exchange called it bare. CANONICAL: always retry. This closes the link-path
 *    transient-failure gap (a Plaid hiccup at link no longer silently skips
 *    holdings until the next refresh). More resilient; identical outputs on
 *    success.
 */

import type { AccountBase, Item } from "plaid";
import { PlaidInvestmentsConsent } from "@prisma/client";
import { db } from "@/lib/db";
import { plaidClient } from "@/lib/plaid/client";
import { withPlaidRetry } from "@/lib/plaid/retry";
import { getPlaidErrorCode, plaidErrorSummary } from "@/lib/plaid/errors";
import { deriveInvestmentsConsent } from "@/lib/plaid/investmentsConsent";
import { resolvePlaidAccountByExternalId } from "@/lib/accounts/reconcile";
import { capturePositionObservations, investmentObservationsEnabled } from "@/lib/investments/position-capture";
import { syncCurrentHoldings } from "@/lib/investments/sync-current-holdings";
import type { AccountCoverageFact } from "@/lib/plaid/refresh-execution-types";
import {
  ingestInvestmentEvents, investmentEventsEnabled,
  recordDisabledInvestmentEventCoverage,
} from "@/lib/investments/investment-event-ingest";

const LOG = "[plaid-investments]";

export interface SyncInvestmentsParams {
  /** Decrypted Plaid access token for the item. */
  accessToken: string;
  /** Our internal PlaidItem.id (primary key), not Plaid's item_id. */
  plaidItemId: string;
  /** Human label for logs (institutionName). */
  institutionName: string;
  /** The investment-type accounts from this item's accountsGet payload. */
  investmentAccounts: AccountBase[];
  /** The raw Item from accountsGet, for consent derivation (DTM products). */
  item: Item;
  /**
   * The consent value currently stored on the PlaidItem, for change-detection.
   * null at initial link (brand-new item) or for a pre-DTM item never probed.
   */
  storedConsent: PlaidInvestmentsConsent | null;
}

export interface SyncInvestmentsResult {
  /** inserted + updated + unchanged Holding rows across all investment accounts. */
  holdingsSynced: number;
  /** The consent value in effect after this run (persisted). */
  consent: PlaidInvestmentsConsent | null;
  /**
   * DF-2B — canonical FinancialAccount ids the holdings stage GENUINELY
   * processed this run (resolved + ran syncCurrentHoldings). Empty when no
   * investment accounts, no holdings, or holdings were consent-skipped. Coarse
   * coverage evidence for RefreshEndpointResult — NOT a per-account outcome
   * (present ≠ updated; empty ≠ uncovered).
   */
  processedAccountIds: string[];
  /**
   * DF-2E — per-account coverage for the HOLDINGS stage: each resolved
   * investment account synced (COVERED, freshness advanced) or resolved with no
   * holdings (SKIPPED / NO_HOLDINGS). Empty when holdings were not callable
   * (consent) or no investment accounts.
   */
  accountCoverage: AccountCoverageFact[];
}

/**
 * Consent-gated investments ingest for one Plaid item. Best-effort by contract:
 * a holdings/observation/event failure NEVER throws to the caller — it is caught,
 * the consent state is updated where informative, and the function returns the
 * holdings synced so far. Callers must not depend on it throwing.
 */
export async function syncInvestmentsForItem(params: SyncInvestmentsParams): Promise<SyncInvestmentsResult> {
  const { accessToken, plaidItemId, institutionName, investmentAccounts, item, storedConsent } = params;

  let holdingsSynced = 0;
  // DF-2B — accounts the holdings stage genuinely processed (for coverage evidence).
  const processedAccountIds: string[] = [];
  // DF-2E — per-account coverage for this HOLDINGS stage.
  const accountCoverage: AccountCoverageFact[] = [];
  if (investmentAccounts.length === 0) return { holdingsSynced, consent: storedConsent, processedAccountIds, accountCoverage };

  // ── Consent (DRIFT-1: change-detect + log; seeds at link since stored=null) ──
  let consent: PlaidInvestmentsConsent | null = storedConsent;
  const derived = deriveInvestmentsConsent(item);
  if (derived !== null && derived !== storedConsent) {
    await db.plaidItem.update({ where: { id: plaidItemId }, data: { investmentsConsent: derived } });
    console.log(`${LOG} consent ${storedConsent ?? "unknown"} → ${derived} for item ${plaidItemId} ("${institutionName}")`);
  }
  if (derived !== null) consent = derived;

  // null = still unknown (pre-DTM item, never probed) — attempt once below; the
  // outcome is persisted either way, so the probe never repeats.
  const holdingsCallable = consent === null || consent === PlaidInvestmentsConsent.ENABLED;
  if (!holdingsCallable) return { holdingsSynced, consent, processedAccountIds, accountCoverage };

  try {
    // DRIFT-2: always retry.
    const holdingsRes = await withPlaidRetry(
      () => plaidClient.investmentsHoldingsGet({ access_token: accessToken }),
      "investmentsHoldingsGet",
    );
    const { holdings, securities } = holdingsRes.data;
    const secById = Object.fromEntries(securities.map((s) => [s.security_id, s]));
    const payloadComplete = holdingsRes.data.is_investments_fallback_item !== true;

    for (const plaidAcct of investmentAccounts) {
      // DF-2E — resolve identity first so a no-holdings account can be recorded
      // as SKIPPED/NO_HOLDINGS (resolution is a read; no behavior change for
      // accounts that do have holdings).
      const fa = await resolvePlaidAccountByExternalId(plaidAcct.account_id);
      if (!fa) continue; // no FinancialAccount identity to attribute

      const acctHoldings = holdings.filter((h) => h.account_id === plaidAcct.account_id);
      if (!acctHoldings.length) {
        accountCoverage.push({ financialAccountId: fa.id, status: "SKIPPED", reason: "NO_HOLDINGS", freshnessAdvanced: false });
        continue;
      }

      // A1 — dark-write append-only observation from the RAW payload (incl.
      // cash / no-ticker securities the Holding writer skips), BEFORE the
      // Holding reconciliation. Kill-switch gated, best-effort/non-fatal.
      if (investmentObservationsEnabled()) {
        try {
          await capturePositionObservations({
            financialAccountId: fa.id,
            plaidHoldings:      acctHoldings,
            securitiesById:     secById,
            date:               new Date(),
            accountBalance:     plaidAcct.balances.current ?? null,
            accountCurrency:    plaidAcct.balances.iso_currency_code ?? null,
            balanceAsOf:        plaidAcct.balances.last_updated_datetime ? new Date(plaidAcct.balances.last_updated_datetime) : null,
            payloadComplete,
          });
        } catch (obsErr) {
          console.warn(`${LOG} position observation capture failed for account ${fa.id} (non-fatal): ${obsErr instanceof Error ? obsErr.message : obsErr}`);
        }
      }

      // A2 — stable per-holding reconciliation (insert / update-in-place /
      // remove-stale), the shared writer. Cash/no-ticker stay filtered.
      const syncCounts = await syncCurrentHoldings({
        financialAccountId: fa.id,
        plaidHoldings:      acctHoldings,
        securitiesById:     secById,
        accountCurrency:    fa.currency,
        payloadComplete,
      });
      holdingsSynced += syncCounts.inserted + syncCounts.updated + syncCounts.unchanged;
      // DF-2B — this account was genuinely processed by the holdings stage.
      processedAccountIds.push(fa.id);
      // DF-2E — holdings synced → this execution advanced the account's holdings
      // freshness (a fresh observation, even if nothing changed).
      accountCoverage.push({ financialAccountId: fa.id, status: "COVERED", freshnessAdvanced: true });
    }

    // A3 — canonical investment event ingestion (once per item; separate
    // investmentsTransactionsGet call). Kill-switch gated, isolated best-effort.
    // V26-QUANTITY-1E′ — the accounts this item's request covers. Resolved here
    // rather than inside ingestion, which only ever sees accounts that returned
    // a transaction; an investment account with none is exactly the case the
    // coverage ledger has to record.
    const coveredFinancialAccountIds: string[] = [];
    for (const plaidAcct of investmentAccounts) {
      const fa = await resolvePlaidAccountByExternalId(plaidAcct.account_id);
      if (fa) coveredFinancialAccountIds.push(fa.id);
    }

    if (investmentEventsEnabled()) {
      try {
        await ingestInvestmentEvents({ accessToken, plaidItemId, now: new Date(), coveredFinancialAccountIds });
      } catch (evErr) {
        console.warn(`${LOG} investment event ingestion failed for item ${plaidItemId} (non-fatal): ${evErr instanceof Error ? evErr.message : evErr}`);
      }
    } else {
      // A window that was never requested must say so. Silence here would be
      // read downstream as "no movement", which is the defect this ledger closes.
      await recordDisabledInvestmentEventCoverage({
        plaidItemId, coveredFinancialAccountIds, now: new Date(),
      });
    }

    // Unknown (pre-DTM) probe succeeded — remember it.
    if (consent === null) {
      await db.plaidItem.update({ where: { id: plaidItemId }, data: { investmentsConsent: PlaidInvestmentsConsent.ENABLED } });
      consent = PlaidInvestmentsConsent.ENABLED;
    }
  } catch (holdingsErr) {
    if (getPlaidErrorCode(holdingsErr) === "ADDITIONAL_CONSENT_REQUIRED") {
      // Expected for items linked without Investments consent — remember it so
      // the call is skipped until consent is granted via Link update mode.
      await db.plaidItem.update({ where: { id: plaidItemId }, data: { investmentsConsent: PlaidInvestmentsConsent.CONSENT_REQUIRED } });
      consent = PlaidInvestmentsConsent.CONSENT_REQUIRED;
      console.log(`${LOG} item ${plaidItemId} ("${institutionName}") lacks Investments consent — holdings skipped until granted via Link update mode`);
    } else {
      console.warn(`${LOG} investmentsHoldingsGet failed for item ${plaidItemId} (non-fatal): ${plaidErrorSummary(holdingsErr)}`);
    }
  }

  return { holdingsSynced, consent, processedAccountIds, accountCoverage };
}
