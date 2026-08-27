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
 * ── UI-C2 — TWO BOUNDS, BECAUSE THEY ANSWER TWO QUESTIONS ───────────────────
 * The licence says how far back a QUANTITY CLAIM is defensible. It does not say
 * when the wallet started being a wallet, and conflating them produced a card
 * announcing "~8 years 10 months of history" for an account first funded in
 * 2021: Ethereum's proof floors at the Byzantium block (2017-10-16) and proves,
 * correctly, that the account held exactly nothing for the 1,289 days between.
 *
 * So the metadata carries both, and the card reads the second:
 *
 *   licensedFromISO  the proof's reach — including proven ZERO. Never truncated
 *                    for presentation; the reconstruction legitimately depends
 *                    on being able to anchor at an empty account.
 *   activityFromISO  the earliest date the wallet is evidenced to have HELD
 *                    something. What a person means by "history".
 *
 * Bitcoin and Solana were both first funded on the day their coverage begins, so
 * the two bounds coincide and the old card was right by coincidence — which is
 * exactly why a third chain was needed to notice.
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
   * UI-C2 — the earliest date this wallet is evidenced to have HELD SOMETHING.
   *
   * Distinct from `licensedFromISO`, and the distinction is the whole point of
   * this field. Ethereum's reconstruction proves, correctly and usefully, that
   * the account held exactly nothing from 2017-10-16 — the Byzantium block the
   * proof floors at — until it was first funded on 2021-04-27. That is 1,289
   * days of mathematically valid coverage over an account that did not yet
   * exist in any sense the owner would recognise.
   *
   * Bitcoin and Solana never exposed the difference: both were first funded on
   * the same day their coverage begins, so a card measuring from the licence was
   * right by coincidence for as long as those were the only two chains.
   *
   * NULL when nothing non-zero has ever been observed — a wallet proven empty
   * has coverage and no history, and the card must say nothing rather than
   * report the length of the proof.
   */
  activityFromISO: string | null;
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

  // UI-C2 — the earliest NON-ZERO observation per account, in one grouped read.
  // A zero quantity is a real, evidenced fact about a date; it is simply not
  // evidence that the wallet was in use, which is what the card's claim is about.
  const firstActivity = new Map<string, string>();
  for (const g of await client.positionObservation.groupBy({
    by:    ["financialAccountId"],
    where: {
      financialAccountId: { in: accounts.map((a) => a.id) },
      supersededById: null, deletedAt: null,
      NOT: { quantity: 0 },
    },
    _min: { date: true },
  })) {
    if (g._min.date) firstActivity.set(g.financialAccountId, g._min.date.toISOString().slice(0, 10));
  }

  for (const a of accounts) {
    // Capability FIRST. A licensed interval on a chain that has not earned
    // history support is evidence we have not promised to stand behind, and the
    // card must not advertise it.
    if (!chainSupportsHistory(a.walletChain)) {
      out.set(a.id, {
        accountId: a.id, activityFromISO: null,
        licensedFromISO: null, licensedToISO: null, claimsHistory: false,
      });
      continue;
    }
    const interval = coverage.has(a.id) ? licensedInterval(coverage.get(a.id)!) : null;
    out.set(a.id, {
      accountId:       a.id,
      // Bounded by the licence: evidence outside a proven interval is not a
      // claim we may make, however non-zero it is.
      activityFromISO: clampToInterval(firstActivity.get(a.id) ?? null, interval),
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

/**
 * UI-C2 — the date a card should measure "history available" FROM.
 *
 * The activity start, never the proof floor. "We can prove you held zero since
 * 2017" and "you have wallet history since 2017" are different sentences, and
 * only the first one is true of an account that was first funded in 2021.
 *
 * Null when the wallet has never held anything, which a caller renders as
 * silence — a wallet proven empty has coverage and nothing to say about history.
 * The proof itself is untouched and still available via `licensedHistoryStart`
 * for surfaces that genuinely want the reconstruction's reach.
 */
export function walletActivityStart(meta: WalletHistoryMetadata | undefined): Date | null {
  if (!meta || !meta.claimsHistory || meta.activityFromISO === null) return null;
  return new Date(`${meta.activityFromISO}T00:00:00.000Z`);
}

/** Keep a date inside the licensed interval, or drop it when unlicensed. */
function clampToInterval(
  dateISO: string | null,
  interval: { fromISO: string; toISO: string } | null,
): string | null {
  if (dateISO === null || interval === null) return null;
  if (dateISO < interval.fromISO || dateISO > interval.toISO) return null;
  return dateISO;
}
