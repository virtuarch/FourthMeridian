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
import { BTC_NATIVE, ETH_NATIVE, SOL_NATIVE } from "./native-asset";
import { NOT_TOKEN_INSTRUMENT } from "./token-asset";
import { reconstructBtcHistoryOrResumable } from "./btc-history-backfill.store";
import { btcSyncHeadOnly } from "./btc-history-backfill";
import { ESPLORA_USAGE_NETWORK, ESPLORA_USAGE_PROVIDER } from "./btc-backfill-worker.core";
import { reconstructSolHistoryResumable } from "./sol-history-backfill.store";
import { syncHeadOnly } from "./sol-history-backfill";
import { reconstructEthHistoryForSync } from "./eth-history-backfill.store";
import { ethWorkerEnabled } from "./eth-history-backfill.core";
import { todayUTCISO } from "@/lib/time/clock";
import { ALCHEMY_USAGE_NETWORK, ALCHEMY_USAGE_PROVIDER, incrementalMeter, recordProviderMeter } from "@/lib/usage/provider-budget";

type HistoryWindow = { accountId: string; windowFromISO: string; windowToISO: string };

/**
 * SHARED PROVIDER BUDGET (2026-10-28) — the SOL and ETH history paths spend the
 * Alchemy key. Every request a run sends is counted by its transport and
 * recorded against the provider's daily budget when the run ends, refused or
 * not — and, since a sync killed mid-run must not spend uncounted requests,
 * also WHILE it sends (every METER_FLUSH_EVERY_CALLS calls / _MS). BTC's
 * resumable backfill reads Esplora, not Alchemy: its requests are recorded
 * under their own provider (ESPLORA), which the BTC worker's own daily cap
 * reads (the wholesale BTC path makes no history requests).
 */
function metered<R>(network: string, run: (meter: Record<string, number>) => Promise<R>): Promise<R> {
  // Crash-safe: flushed while the run sends (provider-budget.core.ts incrementalMeter), and once more at the end.
  const m = incrementalMeter((meter, flushed) => recordProviderMeter(ALCHEMY_USAGE_PROVIDER, network, meter, { flushed }).then(() => {}));
  return run(m.meter).finally(() => m.flush());
}

/** BTC: the same, under its own provider (ESPLORA) — never the Alchemy budget. */
function meteredEsplora<R>(run: (meter: Record<string, number>) => Promise<R>): Promise<R> {
  const m = incrementalMeter((meter, flushed) => recordProviderMeter(ESPLORA_USAGE_PROVIDER, ESPLORA_USAGE_NETWORK, meter, { flushed }).then(() => {}));
  return run(m.meter).finally(() => m.flush());
}

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
  /**
   * ETH, SOL and resumable BTC — what the reconstruction did and the earliest
   * date whose stored quantity changed. Wholesale BTC rebuilds without
   * measuring it, so these stay undefined for it (not measured, never "unchanged").
   */
  mode?: "FULL" | "INCREMENTAL" | "NO_CHANGE";
  impactedFromISO?: string | null;
  fallbackReason?: string;
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
      where:  { financialAccountId: accountId, supersededById: null, deletedAt: null, instrument: NOT_TOKEN_INSTRUMENT },
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
    // BTC: the wholesale reconstruction, unless the wallet's history has been
    // handed to the resumable, checkpointed backfill (btc-history-backfill.ts) —
    // which the sync does when the inline import stops at its 1,000-per-address
    // page budget. Head-only while the background worker carries Bitcoin.
    // Its Esplora requests are recorded under ESPLORA (never the Alchemy budget).
    key === BTC_NATIVE.chain ? (a: HistoryWindow) => meteredEsplora((meter) => reconstructBtcHistoryOrResumable({ ...a, client: db, headOnly: btcSyncHeadOnly(), meter }))
    // SOL: the resumable, checkpointed backfill (sol-history-backfill.ts). The
    // wholesale reconstructSolHistory stopped at 5,000 signatures per run and
    // never resumed; it remains only as the fixture-driven acceptance path.
    : key === SOL_NATIVE.chain ? (a: HistoryWindow) => metered(ALCHEMY_USAGE_NETWORK.SOLANA, (meter) => reconstructSolHistoryResumable({ ...a, client: db, deps: { headOnly: syncHeadOnly(), meter } }))
    // ETH: the incremental path, and on its fallback the inline FULL rebuild —
    // unless the history worker carries Ethereum (ETH_BACKFILL_ENABLED), when a
    // fallback is queued for the worker and nothing is written here
    // (eth-history-backfill.store.ts). Flag off: exactly reconstructEthHistory.
    : key === ETH_NATIVE.chain ? (a: HistoryWindow) => metered(ALCHEMY_USAGE_NETWORK.ETHEREUM, (meter) => reconstructEthHistoryForSync({ ...a, client: db, deferFull: ethWorkerEnabled(), deps: { meter } }))
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
      ...("mode" in result && result.mode
        ? { mode: result.mode, impactedFromISO: result.impactedFromISO ?? null, fallbackReason: "fallbackReason" in result ? result.fallbackReason : undefined }
        : {}),
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
    where: { financialAccountId: accountId, origin: PositionOrigin.DERIVED, deletedAt: null, instrument: NOT_TOKEN_INSTRUMENT },
  });
}
