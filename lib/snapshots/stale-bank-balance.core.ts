/**
 * lib/snapshots/stale-bank-balance.core.ts
 *
 * FM-AUDIT-021 — THE ONE rule deciding whether today's LIVE snapshot rests on a
 * stale bank balance. Pure: no Prisma, no DB, no ambient clock (`now` is
 * required, as in the freshness authority it delegates to).
 *
 * ── The defect ────────────────────────────────────────────────────────────────
 * The live writer (lib/snapshots/regenerate.ts) upserts today's row with the
 * schema default `isEstimated=false`: an OBSERVATION. When a bank connection
 * has stopped refreshing (needs a reconnect), its FinancialAccount.balance is
 * the LAST KNOWN figure, yet every crypto sweep and every price job still
 * regenerates today's row from it (jobs/sync-crypto.ts,
 * jobs/fetch-security-prices.ts). The history regenerator's frozen-row guard
 * (regenerate-history.core.ts, `existingIsEstimated === false` ⇒ skip-frozen)
 * then treats each of those days as authoritative forever. After the reconnect
 * the true balances arrive, history cannot revise the stale days, and the
 * net-worth / cash series carries a permanent step on the reconnect day.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 * Nothing here is new vocabulary — every term is borrowed:
 *
 *   stale     lib/freshness/observation.ts — resolveAccountFreshness +
 *             isStaleBand: the observation (provider attestation
 *             `balanceLastUpdatedAt` when present and uncontradicted, else our
 *             ingestion clock `lastUpdated`) is older than STALE_AFTER_DAYS.
 *             UNKNOWN is not stale (that authority's own ruling).
 *   material  lib/freshness/space-freshness.ts — MATERIAL_VALUE_SHARE: the
 *             account holds at least that share of the Space's total |value|.
 *             A zero-balance account is never material.
 *   bank      a provider-FED cash or liability account (checking, savings,
 *             debt). Manual accounts are user estimates with no feed to go
 *             stale (RWA-1) and no reconnect to correct them, so they are out;
 *             investment and crypto have their own valuation rules (the W6b
 *             `cryptoStale` stamp is the crypto counterpart of this one).
 *
 * The writer does NOT refuse the row (W6b precedent: a stale reading is still
 * the best number there is; refusing would discard evidence). It writes the
 * same numbers, marked as an estimate, so the history regenerator is allowed to
 * replace them once real balances arrive.
 */

import { isStaleBand, resolveAccountFreshness } from "@/lib/freshness/observation";
import { MATERIAL_VALUE_SHARE } from "@/lib/freshness/space-freshness";

/** Account types whose balance comes from a bank feed. */
export const BANK_BALANCE_TYPES: readonly string[] = Object.freeze(["checking", "savings", "debt"]);

/** The freshness evidence for one candidate account, as stored. */
export interface BankFreshnessRow {
  id: string;
  type: string;
  syncStatus: string | null;
  /** FinancialAccount.lastUpdated — our ingestion clock. */
  lastUpdated: Date | string | null;
  /** FinancialAccount.balanceLastUpdatedAt — the institution's clock, when sent. */
  balanceLastUpdatedAt: Date | string | null;
}

/** The counted magnitude of one snapshot account. */
export interface CountedAccount {
  id: string;
  /** |counted balance| — the figure the snapshot actually totals. */
  absValue: number;
}

/** True when `row` is a provider-fed bank account (see "bank" above). */
export function isFedBankAccount(row: { type: string; syncStatus: string | null }): boolean {
  return BANK_BALANCE_TYPES.includes(row.type) && row.syncStatus !== "manual";
}

/**
 * The ids of every MATERIAL, STALE, provider-fed bank account among `counted`.
 * Order follows `counted`. Empty ⇒ today's row is an observation, exactly as
 * before FM-AUDIT-021.
 */
export function staleMaterialBankAccountIds(
  counted: readonly CountedAccount[],
  freshness: readonly BankFreshnessRow[],
  now: Date,
): string[] {
  const byId = new Map(freshness.map((r) => [r.id, r]));
  const totalValue = counted.reduce((s, a) => s + a.absValue, 0);
  const floor = totalValue * MATERIAL_VALUE_SHARE;

  const out: string[] = [];
  for (const a of counted) {
    const row = byId.get(a.id);
    if (!row || !isFedBankAccount(row)) continue;
    if (!(a.absValue > 0) || a.absValue < floor) continue;
    const f = resolveAccountFreshness({
      accountId:         row.id,
      ingestedAt:        row.lastUpdated,
      providerBalanceAt: row.balanceLastUpdatedAt,
      balance:           a.absValue,
    }, now);
    if (isStaleBand(f.balance.band)) out.push(a.id);
  }
  return out;
}
