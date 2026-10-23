/**
 * lib/crypto/crypto-close-coverage.ts
 *
 * CRYPTO-LATCH-1 — PRICE ARCHIVE MAINTENANCE IS A PREREQUISITE, NOT A
 * CONSEQUENCE OF SUCCESSFUL VALUATION.
 *
 * ── The latch this module exists to break (incident 2026-10-01) ─────────────
 * BTC's valuation reads the RAW_CLOSE archive with a 7-day walk-back
 * (`readCryptoUsdWindows`, `DEFAULT_MAX_STALE_DAYS`). The only code that
 * REFRESHED that archive was `backfillHeldInstrumentPrices`, reached from the
 * wealth-history regeneration — and BOTH of its call sites gate on
 * `outcomeRevalued`:
 *
 *     app/api/accounts/[id]/sync/route.ts   (manual refresh)
 *     lib/crypto/wallet-refresh.ts → jobs/sync-crypto.ts   (scheduled sweep)
 *
 * `outcomeRevalued` is false exactly when the valuation was UNAVAILABLE. So a
 * failed valuation closed the gate on its own repair: once the newest close
 * aged past the walk-back, every BTC refresh was unpriced FOREVER, by Refresh
 * and by cron alike. Measured: the newest close was 2026-09-20, the walk-back
 * still reached it on 09-27 and missed it on 09-28, and every BTC refresh from
 * 09-28 to 10-01 reported UNAVAILABLE in 29–36 ms without one network call.
 *
 * It was broken, on 2026-10-01, by a SOLANA sync — because ETH and SOL carry no
 * `valuation` field at all, so `undefined !== "UNAVAILABLE"` made
 * `outcomeRevalued` accidentally true for them, their wealth regeneration ran,
 * and `backfillHeldInstrumentPrices` prices every HELD instrument, Bitcoin
 * included. A BTC-only holder had no such accident available and could not
 * recover at all.
 *
 * ── What this module is ─────────────────────────────────────────────────────
 * The answer to ONE question — "can the RAW_CLOSE archive serve a valuation for
 * this asset on this date?" — and, when it cannot, a BOUNDED repair of exactly
 * the window the walk-back looks at. Nothing here decides a price, and nothing
 * here values anything: it makes the archive able to answer, then lets the
 * existing valuation reader answer.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 *   · It does NOT widen `maxStaleDays`. The tolerance is a declared property of
 *     the valuation; hiding a gap behind a longer walk-back is not a repair.
 *   · It does NOT read, consume or promote INTRADAY. The incident's archive held
 *     an INTRADAY quote for the very day the valuation refused, at $84,406, and
 *     consuming it would have "fixed" the symptom by destroying the distinction
 *     between a dated close and a live quote (4752ec2, 493d3a3). RAW_CLOSE in,
 *     RAW_CLOSE out.
 *   · It does NOT fabricate, interpolate or carry a close. It asks the canonical
 *     acquisition path for real vendor rows and reports what came back.
 *   · It does NOT mint an Instrument. Resolution is the READ-ONLY
 *     `lookupCryptoInstrumentId`; an asset with no instrument is reported, never
 *     created, because a maintenance read has no business making an identity
 *     claim (the same reasoning as crypto-price-window.ts).
 *
 * ── Why it reuses backfillPricesForInstruments rather than fetching ─────────
 * Because that module is already the ONE acquisition implementation, and it
 * already has every property this repair needs: coverage-driven planning (so an
 * INTERIOR gap is planned like any other), missing-only, insert-only, idempotent,
 * closed-dates-only, no interpolation, provider outcomes classified, and a fully
 * covered instrument costing zero network calls. Writing a second fetcher here
 * would create a second price authority — the exact defect V26-PRICE-3 removed.
 */

import { PriceBasis } from "@prisma/client";
import { db } from "@/lib/db";
import { priceArchive } from "@/lib/prices/archive";
import { minusDaysISO, yesterdayUTCISO } from "@/lib/prices/config";
import { nearestOnOrBefore } from "@/lib/data/nearest-on-or-before";
import { backfillPricesForInstruments } from "@/lib/prices/backfill";
import { lookupCryptoInstrumentId, CRYPTO_CLOSE_MAX_STALE_DAYS } from "./crypto-price-window";
import type { CryptoAsset } from "@/lib/investments/crypto-instrument";

/**
 * Why a coverage check ended. Every value is a STATED outcome — there is no
 * fall-through, because "we did not look" and "we looked and it is fine" must
 * never be the same answer to an operator.
 */
export type CryptoCloseCoverageStatus =
  /** A usable close already reached `asOfISO`. No network call was made. */
  | "COVERED"
  /** The archive could not serve it, a bounded repair ran, and now it can. */
  | "REPAIRED"
  /** A repair ran and the archive STILL cannot serve it (vendor had nothing). */
  | "UNRESOLVED"
  /** No canonical Instrument for this asset — nothing to acquire against. */
  | "NO_INSTRUMENT"
  /** The repair itself threw (provider/transport). The archive is unchanged. */
  | "FAILED";

export interface CryptoCloseCoverage {
  assetKey: string;
  status:   CryptoCloseCoverageStatus;
  /** The walk-back window examined, always stated so a decision is explainable. */
  fromISO:  string;
  toISO:    string;
  /** The newest usable close found AFTER any repair; null when none reached. */
  closeDateISO: string | null;
  /** RAW_CLOSE rows written by the repair. 0 for COVERED (no repair ran). */
  inserted: number;
  /** True when a vendor request was actually issued. COVERED ⇒ false. */
  attemptedRepair: boolean;
  /** Human-facing reason for every non-COVERED status. */
  reason?:  string;
  /** The repair's own clock, for stage accounting. Absent when none ran. */
  startedAt?:  Date;
  durationMs?: number;
}

/**
 * The three outside facts this module needs, injectable so the whole decision
 * matrix is unit-testable with no database and no network — the same seam idiom
 * as `BtcSyncDeps` and `WalletRefreshDeps`.
 *
 * ⚠️ `readCloses` MUST read basis RAW_CLOSE. The seam exists to remove the
 * database, never to let a caller substitute a different basis: the production
 * implementation below pins `PriceBasis.RAW_CLOSE`, and a test that passed
 * INTRADAY rows through here would be testing a system that does not exist.
 */
export interface CryptoCloseCoverageDeps {
  /** READ-ONLY canonical instrument resolution. Never mints. */
  lookupInstrumentId: (asset: CryptoAsset) => Promise<string | null>;
  /** RAW_CLOSE rows for one instrument over an inclusive ISO date range. */
  readCloses: (instrumentId: string, fromISO: string, toISO: string) => Promise<{ dateISO: string; price: number }[]>;
  /** The canonical acquisition path. Returns rows written. */
  acquire: (instrumentId: string, fromISO: string, toISO: string) => Promise<{ inserted: number; detail: string }>;
}

/** Production deps: the real archive, the real read-only lookup, the real acquisition. */
export function defaultCloseCoverageDeps(
  onProgress?: (line: string) => void,
): CryptoCloseCoverageDeps {
  return {
    lookupInstrumentId: (asset) => lookupCryptoInstrumentId(asset, db),
    readCloses: async (instrumentId, fromISO, toISO) =>
      // BASIS IS PINNED HERE. RAW_CLOSE, never INTRADAY — the incident's archive
      // held an INTRADAY quote for the very day the valuation refused, and
      // consuming it would have destroyed the distinction between a dated close
      // and a live quote (4752ec2, 493d3a3).
      (await priceArchive.readRange?.([instrumentId], PriceBasis.RAW_CLOSE, fromISO, toISO)) ?? [],
    acquire: async (instrumentId, fromISO, toISO) => {
      const r = await backfillPricesForInstruments([instrumentId], {
        apply:       true,
        forceWindow: { fromISO, toISO },
        onProgress,
      });
      const outcomes = Object.entries(r.outcomes).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(",");
      return { inserted: r.inserted, detail: `${r.inserted} row(s) written, outcomes ${outcomes || "none"}` };
    },
  };
}

/**
 * Can the RAW_CLOSE archive serve `assetKey` on `asOfISO` within the declared
 * walk-back? A pure read — the same basis, reader and tolerance the valuation
 * itself uses, so this cannot disagree with it.
 *
 * Returns the newest usable close's date, or null when none reached the day.
 */
export async function newestUsableCloseISO(
  asset: CryptoAsset,
  asOfISO: string,
  opts: { maxStaleDays?: number; deps?: CryptoCloseCoverageDeps } = {},
): Promise<{ instrumentId: string | null; closeDateISO: string | null; fromISO: string }> {
  const maxStaleDays = opts.maxStaleDays ?? CRYPTO_CLOSE_MAX_STALE_DAYS;
  const deps = opts.deps ?? defaultCloseCoverageDeps();
  const fromISO = minusDaysISO(asOfISO, maxStaleDays);
  const instrumentId = await deps.lookupInstrumentId(asset);
  if (!instrumentId) return { instrumentId: null, closeDateISO: null, fromISO };

  const rows = await deps.readCloses(instrumentId, fromISO, asOfISO);
  const hit = nearestOnOrBefore(rows, asOfISO, (r) => r.dateISO, { maxStaleDays });
  return { instrumentId, closeDateISO: hit ? hit.dateISO : null, fromISO };
}

/**
 * Ensure the RAW_CLOSE archive can value `asset` on `asOfISO`, repairing a
 * bounded window if it cannot.
 *
 * THE REPAIR WINDOW IS THE WALK-BACK WINDOW, and nothing wider: the valuation
 * only ever looks at [asOf − maxStaleDays, asOf], so acquiring beyond it would
 * be unbounded work that cannot change this run's answer. The upper bound is
 * clamped to YESTERDAY because the archive stores closed dates only
 * (`assertClosedDateISO`) — asking a vendor for today's close is asking for a
 * row the archive would refuse to hold.
 *
 * NEVER THROWS. Archive maintenance must not be able to fail a refresh that
 * successfully read a chain: the caller reports the outcome as its own stage.
 */
export async function ensureCryptoCloseCoverage(
  asset: CryptoAsset,
  asOfISO: string,
  opts: {
    maxStaleDays?: number;
    onProgress?: (line: string) => void;
    deps?: CryptoCloseCoverageDeps;
    /** Test seam for the closed-date clamp. Production reads the real clock. */
    yesterdayISO?: string;
  } = {},
): Promise<CryptoCloseCoverage> {
  const maxStaleDays = opts.maxStaleDays ?? CRYPTO_CLOSE_MAX_STALE_DAYS;
  const deps = opts.deps ?? defaultCloseCoverageDeps(opts.onProgress);
  const base = { assetKey: asset.assetKey, inserted: 0, attemptedRepair: false } as const;

  const before = await newestUsableCloseISO(asset, asOfISO, { maxStaleDays, deps });
  const fromISO = before.fromISO;

  if (!before.instrumentId) {
    return {
      ...base, status: "NO_INSTRUMENT", fromISO, toISO: asOfISO, closeDateISO: null,
      reason: `no canonical Instrument for ${asset.symbol} (${asset.assetKey}) — nothing to acquire against`,
    };
  }
  // THE HAPPY PATH COSTS NOTHING. A covered archive issues no vendor request,
  // which is what makes this safe to call on every refresh.
  if (before.closeDateISO !== null) {
    return { ...base, status: "COVERED", fromISO, toISO: asOfISO, closeDateISO: before.closeDateISO };
  }

  // ── Bounded repair ────────────────────────────────────────────────────────
  // Clamped to yesterday: the archive holds CLOSED dates only.
  const yesterday = opts.yesterdayISO ?? yesterdayUTCISO();
  const repairToISO = asOfISO <= yesterday ? asOfISO : yesterday;
  if (repairToISO < fromISO) {
    return {
      ...base, status: "UNRESOLVED", fromISO, toISO: asOfISO, closeDateISO: null,
      reason: `no closed date in the walk-back window (${fromISO}..${asOfISO})`,
    };
  }

  const startedAt = new Date();
  const t0 = Date.now();
  try {
    const r = await deps.acquire(before.instrumentId, fromISO, repairToISO);
    const durationMs = Date.now() - t0;
    // RE-READ THROUGH THE SAME READER. Rows written is not the question — a
    // vendor can insert rows that still do not reach `asOfISO`. The only honest
    // test of a repair is to ask the valuation's own reader again.
    const after = await newestUsableCloseISO(asset, asOfISO, { maxStaleDays, deps });
    if (after.closeDateISO !== null) {
      return {
        ...base, status: "REPAIRED", fromISO, toISO: repairToISO,
        closeDateISO: after.closeDateISO, inserted: r.inserted, attemptedRepair: true,
        startedAt, durationMs,
      };
    }
    return {
      ...base, status: "UNRESOLVED", fromISO, toISO: repairToISO, closeDateISO: null,
      inserted: r.inserted, attemptedRepair: true, startedAt, durationMs,
      reason:
        `the price archive has no ${asset.symbol} close in ${fromISO}..${repairToISO} ` +
        `after acquisition (${r.detail})`,
    };
  } catch (e) {
    return {
      ...base, status: "FAILED", fromISO, toISO: repairToISO, closeDateISO: null,
      attemptedRepair: true, startedAt, durationMs: Date.now() - t0,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Did this coverage outcome leave the archive able to value the asset? */
export function coverageCanValue(c: CryptoCloseCoverage): boolean {
  return c.status === "COVERED" || c.status === "REPAIRED";
}

/**
 * CRYPTO-LATCH-1 — THE EXPLICIT, SCHEDULED MAINTENANCE LIFECYCLE.
 *
 * Every crypto native asset some live wallet actually HOLDS, checked (and
 * repaired if short) as of `asOfISO`. Called from the scheduled sweep BEFORE any
 * wallet is touched, so archive freshness is a maintenance concern in its own
 * right rather than a side effect of some wallet's valuation having succeeded.
 *
 * ── Why this exists even though the price authority self-repairs ────────────
 * The lazy repair inside BTC's close authority (btc-sync.ts) guarantees
 * RECOVERY: press Refresh and the archive is mended. This guarantees the archive
 * is mended BEFORE anyone presses anything — so the ordinary case is a covered
 * archive and a priced wallet, and the lazy path is the safety net rather than
 * the mechanism. The incident is the argument for having both: the lazy repair
 * alone would still have let a wallet sit unpriced until someone noticed.
 *
 * HELD, not "all chains we support": acquiring closes for an asset nobody owns
 * spends vendor budget to answer a question no valuation asks. This mirrors the
 * wealth-regeneration rule — "Bitcoin is included because it is held, not
 * because it is Bitcoin".
 *
 * NEVER THROWS. Maintenance that can fail a sweep is worse than a stale archive.
 */
export async function maintainHeldCryptoCloseCoverage(
  asOfISO: string,
  opts: { maxStaleDays?: number; onProgress?: (line: string) => void } = {},
): Promise<CryptoCloseCoverage[]> {
  const { nativeAssetForChain } = await import("./native-asset");
  let chains: { walletChain: string | null }[] = [];
  try {
    chains = await db.financialAccount.findMany({
      where:  { walletChain: { not: null }, deletedAt: null },
      select: { walletChain: true },
      distinct: ["walletChain"],
    });
  } catch {
    return [];
  }
  const assets = [...new Map(
    chains
      .map((c) => nativeAssetForChain(c.walletChain))
      .filter((a): a is NonNullable<typeof a> => a !== null)
      .map((a) => [a.assetKey, a] as const),
  ).values()].sort((a, b) => a.assetKey.localeCompare(b.assetKey));

  const out: CryptoCloseCoverage[] = [];
  for (const asset of assets) {
    out.push(await ensureCryptoCloseCoverage(asset, asOfISO, opts));
  }
  return out;
}
