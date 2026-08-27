/**
 * lib/crypto/wallet-history-metadata.ts
 *
 * UI-C1 — WHAT A WALLET CARD MAY SAY ABOUT ITS HISTORY.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * The Connections card derived "~N of history available" from the earliest
 * `Transaction` row. Bitcoin writes its movements there, so it showed a figure
 * that happened to be right. Solana and Ethereum write no transactions at all —
 * their history lives on the position spine as reconstructed observations — so
 * both showed nothing, while holding four and nine years of proven quantity
 * history respectively.
 *
 * A card that says nothing about nine years of evidence is not neutral; it reads
 * as "no history", which is the opposite of what the evidence says.
 *
 * ── The authority ───────────────────────────────────────────────────────────
 * `PositionCoverage` — the persisted licence — and nothing else. Not the
 * transaction count, not the account's creation date, not how many
 * reconstruction rows happen to exist, and not a per-chain constant. Those are
 * all proxies that agree with the licence until the day they don't, and each one
 * silently encodes an implementation detail as a claim about evidence.
 *
 * A chain earns a duration by having a licensed interval. That is the same
 * sentence for Bitcoin, Solana, Ethereum and whatever comes next.
 *
 * ── What "history available" MEANS, and what it does not ────────────────────
 * It means PROVEN QUANTITY COVERAGE: for every date in the interval we can say
 * what the wallet held. It does NOT mean every one of those days carries a
 * historical USD price.
 *
 * Ethereum is exactly why the distinction has to be stated. Its quantity is
 * proven back to 2017-10-16, while the price vendor serves a rolling 365 days —
 * so most of that interval has a known quantity and no valuation. Shortening the
 * displayed span to the price window would under-report proven evidence;
 * implying the whole span is valued would over-report it. The card reports the
 * quantity licence, and valuation coverage is a separate question with its own
 * authority (`cryptoValuationStatus`).
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { loadPositionCoverage, licensedInterval } from "./position-coverage";
import { chainSupportsHistory } from "./wallet-sync-dispatch";

type Client = PrismaClient | Prisma.TransactionClient;

export interface WalletHistoryMetadata {
  /** The account this describes. */
  accountId: string;
  /**
   * Start of the licensed quantity interval, or null when nothing is licensed.
   *
   * NULL IS NOT ZERO HISTORY IN DISGUISE — it means no interval is proven, and a
   * consumer must say nothing rather than say "none".
   */
  licensedFromISO: string | null;
  licensedToISO:   string | null;
  /**
   * May this wallet claim imported history at all?
   *
   * Requires BOTH the chain's capability and a licensed interval. A
   * CURRENT_POSITION_SUPPORTED chain has a real current balance and no proven
   * past, and must not claim one however many observations it accumulates.
   */
  claimsHistory: boolean;
}

/**
 * History metadata for wallet accounts, keyed by account id.
 *
 * Accounts whose chain has no history capability are returned with
 * `claimsHistory: false` rather than omitted, so a caller cannot mistake absence
 * of an entry for absence of an answer.
 */
export async function loadWalletHistoryMetadata(
  accounts: readonly { id: string; walletChain: string | null | undefined }[],
  options?: { client?: Client },
): Promise<Map<string, WalletHistoryMetadata>> {
  const out = new Map<string, WalletHistoryMetadata>();
  if (accounts.length === 0) return out;

  const client = options?.client ?? db;
  const coverage = await loadPositionCoverage(client, accounts.map((a) => a.id));

  for (const a of accounts) {
    // Capability FIRST. A licensed interval on a chain that has not earned
    // history support is evidence we have not promised to stand behind, and the
    // card must not advertise it.
    if (!chainSupportsHistory(a.walletChain)) {
      out.set(a.id, { accountId: a.id, licensedFromISO: null, licensedToISO: null, claimsHistory: false });
      continue;
    }
    const interval = coverage.has(a.id) ? licensedInterval(coverage.get(a.id)!) : null;
    out.set(a.id, {
      accountId:       a.id,
      licensedFromISO: interval?.fromISO ?? null,
      licensedToISO:   interval?.toISO ?? null,
      // A COMPLETE-looking coverage with a blocking caveat licenses nothing, and
      // `licensedInterval` has already applied that rule — so this is the
      // licence's own answer, not a second opinion about it.
      claimsHistory:   interval !== null,
    });
  }
  return out;
}

/**
 * The earliest date a wallet's history is licensed from — the value a card's
 * "N of history available" should be measured from.
 *
 * Returns null when nothing is licensed, which a caller must render as silence
 * rather than as a zero-length history.
 */
export function licensedHistoryStart(meta: WalletHistoryMetadata | undefined): Date | null {
  if (!meta || !meta.claimsHistory || meta.licensedFromISO === null) return null;
  return new Date(`${meta.licensedFromISO}T00:00:00.000Z`);
}
