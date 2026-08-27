/**
 * lib/crypto/wallet-history-refresh.ts
 *
 * W6f — A SYNC THAT DOES NOT REFRESH HISTORY LEAVES HISTORY WRONG.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * `reconstructSolHistory` and `reconstructBtcHistory` had ZERO production
 * callers. Both were written, tested, run by hand once against the real wallets,
 * and never wired to anything. So pressing Sync updated the current balance and
 * imported new movements into the ledger — and the reconstructed timeline, the
 * coverage licence and every chart drawn from them stayed exactly as they were
 * the day someone last ran the reconstruction manually.
 *
 * Nothing looked broken, which is the problem: a wallet could receive a hundred
 * BTC and the year chart would go on drawing the old quantity, correctly
 * labelled, coverage-licensed, and stale.
 *
 * ── Why this is a REFRESH and not an acquisition ────────────────────────────
 * It decides nothing. It picks the reconstruction that belongs to the chain and
 * hands it a window; every judgement about evidence, reconciliation, coverage
 * and licence stays inside the reconstruction that already owns it.
 *
 * ── Failure must never destroy what is already proven ───────────────────────
 * Both reconstructions refuse BEFORE opening their write transaction, so a
 * refusal writes nothing and the previous rows and licence survive untouched.
 * That is the property this module depends on and asserts: a provider outage
 * during Sync must leave yesterday's proven history exactly where it was, never
 * replace it with a narrower or emptier one.
 *
 * The window is drawn from the account's OWN earliest evidence rather than a
 * fixed lookback, for the same reason: a reconstruction re-runs over its whole
 * range and rewrites the rows it owns, so handing it a short window would
 * silently truncate four years of proven history into one month.
 */

import { db } from "@/lib/db";
import { PositionOrigin } from "@prisma/client";
import { BTC_NATIVE } from "./native-asset";
import { reconstructBtcHistory } from "./btc-history-sync";
import { reconstructSolHistory } from "./sol-history-sync";
import { todayUTCISO } from "@/lib/time/clock";

/** What a refresh did, for the log and for the caller's decision to regenerate. */
export interface WalletHistoryRefresh {
  accountId: string;
  chain:     string;
  /** False when the chain has no reconstruction, or the attempt refused. */
  refreshed: boolean;
  /** Coded refusal from the reconstruction, or a reason this was skipped. */
  reason?:   string;
  rowsWritten?: number;
  /** The window actually handed to the reconstruction. */
  windowFromISO?: string;
  windowToISO?:   string;
}

/**
 * The earliest date this account has ANY evidence for.
 *
 * Both a native movement and a dated position count: the reconstruction may
 * legitimately reach back to whichever is older, and the window must not cut it
 * off. Null when the account has neither, in which case there is nothing to
 * reconstruct and the caller skips.
 */
async function earliestEvidenceISO(accountId: string): Promise<string | null> {
  const [movement, position] = await Promise.all([
    db.transaction.findFirst({
      where:  { financialAccountId: accountId, deletedAt: null },
      orderBy: { date: "asc" },
      select: { date: true },
    }),
    db.positionObservation.findFirst({
      where:  { financialAccountId: accountId, supersededById: null, deletedAt: null },
      orderBy: { date: "asc" },
      select: { date: true },
    }),
  ]);
  const dates = [movement?.date, position?.date].filter((d): d is Date => d != null);
  if (dates.length === 0) return null;
  return new Date(Math.min(...dates.map((d) => d.getTime()))).toISOString().slice(0, 10);
}

/**
 * Re-derive a wallet's historical timeline after a SUCCESSFUL sync.
 *
 * Never throws. A chain with no reconstruction is skipped, not failed — the
 * caller's regeneration decision reads `refreshed`, so a skip cannot be mistaken
 * for a refresh that produced nothing.
 */
export async function refreshWalletHistory(
  accountId: string,
  chain: string | null | undefined,
): Promise<WalletHistoryRefresh> {
  const key = chain?.trim().toUpperCase() ?? "";

  // Chain selection lives here and nowhere above it. A chain without a
  // reconstruction is not a failure: ETH/BNB/AVAX have current positions and no
  // historical licence, exactly as their capability says.
  const run =
    key === BTC_NATIVE.chain ? reconstructBtcHistory
    : key === "SOL"          ? reconstructSolHistory
    : null;
  if (run === null) return { accountId, chain: key, refreshed: false, reason: "chain has no reconstruction" };

  const fromISO = await earliestEvidenceISO(accountId);
  if (fromISO === null) {
    return { accountId, chain: key, refreshed: false, reason: "no dated evidence to reconstruct from" };
  }
  const toISO = todayUTCISO();

  try {
    const result = await run({ accountId, windowFromISO: fromISO, windowToISO: toISO });
    if (!result.ok) {
      // The reconstruction refused and therefore wrote nothing. Whatever was
      // proven before this sync is still proven, and still there.
      return {
        accountId, chain: key, refreshed: false,
        reason: result.refusal ?? result.reason ?? "reconstruction refused",
        windowFromISO: fromISO, windowToISO: toISO,
      };
    }
    return {
      accountId, chain: key, refreshed: true,
      rowsWritten: result.derivedRowsWritten,
      windowFromISO: fromISO, windowToISO: toISO,
    };
  } catch (e) {
    // Defensive: both reconstructions promise not to throw. If one does, Sync
    // must still report its balance honestly rather than 502 on a history step.
    return {
      accountId, chain: key, refreshed: false,
      reason: `reconstruction threw: ${e instanceof Error ? e.message : String(e)}`,
      windowFromISO: fromISO, windowToISO: toISO,
    };
  }
}

/**
 * Does this account hold reconstructed history that a refresh could have moved?
 *
 * Used by the acceptance probes and tests to assert that a refusal preserved the
 * prior timeline rather than emptying it.
 */
export async function countDerivedRows(accountId: string): Promise<number> {
  return db.positionObservation.count({
    where: { financialAccountId: accountId, origin: PositionOrigin.DERIVED, deletedAt: null },
  });
}
