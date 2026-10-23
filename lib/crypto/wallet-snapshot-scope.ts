/**
 * lib/crypto/wallet-snapshot-scope.ts — WHICH accounts' TODAY snapshot a wallet
 * sync must regenerate.
 *
 * Lives outside wallet-sync-dispatch on purpose: the dispatcher performs no DB
 * access of its own (pinned), and deciding the regeneration scope needs one
 * read. The dispatcher reports the facts (`outcomeRevalued`, `outcomeRequoted`);
 * this module turns them into account ids for the route and the sweep.
 */

import "server-only";
import { db } from "@/lib/db";
import { outcomeRevalued, outcomeRequoted, type WalletSyncOutcome } from "@/lib/crypto/wallet-sync-dispatch";

/**
 * Every active wallet on the given chains — the holders of those chains' native
 * assets, whose TODAY snapshot must follow a changed quote. A quote is shared
 * across users and Spaces; regenerating only the synced account would leave
 * every other holder's headline priced at the previous quote while its account
 * read shows the new one.
 */
export async function activeWalletAccountIdsForChains(chains: readonly string[]): Promise<string[]> {
  const keys = [...new Set(chains.map((c) => c.trim().toUpperCase()).filter(Boolean))];
  if (keys.length === 0) return [];
  const rows = await db.financialAccount.findMany({
    where:  { walletChain: { in: keys }, deletedAt: null },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * The accounts whose TODAY snapshot this run must regenerate: the synced
 * account when it produced new valuation evidence, plus every holder of a
 * re-quoted asset. One rule for the manual route and the sweep.
 */
export async function snapshotAccountsForOutcome(outcome: WalletSyncOutcome): Promise<string[]> {
  const ids = new Set<string>(outcomeRevalued(outcome) ? [outcome.accountId] : []);
  if (outcomeRequoted(outcome)) for (const id of await activeWalletAccountIdsForChains([outcome.chain])) ids.add(id);
  return [...ids];
}

