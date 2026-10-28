/**
 * lib/prices/price-gap.core.ts
 *
 * PURE. HISTORICAL PRICE-GAP DETECTION (2026-10-28, Workstream D).
 *
 * ── The gap this closes (docs/plans/CRYPTO-HISTORY-AUTONOMY-AUDIT §7) ───────
 * A Solana wallet's balance history was proven back to 2022 while its Space
 * charted 32 days: the shared per-asset RAW_CLOSE archive held 31 days. The
 * archive widened only through sync-crypto's capability pass, and the snapshot
 * regeneration a backfill triggers prices only the window it rebuilds — which
 * the historical-work planner clamps to the EXISTING price floor. Nothing could
 * reach below the floor, so nothing ever did.
 *
 * ── What this decides ───────────────────────────────────────────────────────
 * For each instrument some account holds a balance LICENCE for: does the
 * archive's earliest RAW_CLOSE fall after the earliest licensed day, and can
 * the routed provider serve any of the dates in between? If so, ONE bounded
 * window per INSTRUMENT — the archive is per asset, shared by every customer,
 * so two customers holding the same asset produce one acquisition, never two.
 *
 * Never a price: it plans requests to the canonical acquisition path, which is
 * missing-only, closed-dates-only and never interpolates. A day the provider
 * does not return stays missing, and a missing day refuses valuation.
 *
 * ── valued-from ─────────────────────────────────────────────────────────────
 * The first day an asset's history can be VALUED is the later of the balance
 * licence start and the price floor. Exposed for the UI ("balances from X,
 * prices from Y, valued from Z") as one pure function, so no surface derives it
 * twice.
 */

import { minusDaysISO } from "./config";

/**
 * The first day a held asset's history can be valued: max(balance licence
 * start, earliest RAW_CLOSE). Null when either is unknown — no licence means no
 * quantity, no price means no value; neither is "from the beginning of time".
 */
export function valuedFromISO(balanceLicenceFromISO: string | null, priceFloorISO: string | null): string | null {
  if (!balanceLicenceFromISO || !priceFloorISO) return null;
  return balanceLicenceFromISO > priceFloorISO ? balanceLicenceFromISO : priceFloorISO;
}

/** One account's licensed balance history for one instrument. */
export interface HolderLicence {
  financialAccountId: string;
  instrumentId: string;
  /** First day the account's quantity is licensed (PositionCoverage). */
  licensedFromISO: string;
}

/** What the archive and the price registry say about one instrument. */
export interface InstrumentPriceFacts {
  instrumentId: string;
  /** Earliest stored RAW_CLOSE for the instrument, or null when it has none. */
  earliestRawCloseISO: string | null;
  /**
   * The provider routing would choose, with its DECLARED earliest servable date
   * (CoinGecko Demo: a rolling 365 days). `none` when no configured provider can
   * serve the instrument — nothing may be requested then.
   */
  provider: { kind: "provider"; source: string; floorISO: string } | { kind: "none" };
}

export type PriceGapSkip =
  /** The archive already reaches the earliest licensed day. */
  | "COVERED"
  /** Every missing older day is before the provider's declared window. */
  | "BELOW_PROVIDER_WINDOW"
  /** No configured provider serves this instrument. */
  | "NO_PROVIDER"
  /** Already requested this run from the same day or earlier. */
  | "ALREADY_ATTEMPTED"
  /**
   * DURABLE: the same gap (instrument, same archive floor) was already
   * requested today and the floor did not move — an unfillable gap is asked
   * for at most once per UTC day, not every ~15 minutes.
   */
  | "ALREADY_ATTEMPTED_TODAY"
  /** Over this run's instrument cap — picked up by the next trigger. */
  | "DEFERRED_RUN_CAP";

export type PriceGapDecision =
  | { instrumentId: string; kind: "ACQUIRE"; fromISO: string; toISO: string; neededFromISO: string; holders: number }
  | { instrumentId: string; kind: PriceGapSkip; neededFromISO: string; holders: number };

/**
 * Identity of one gap request for the durable once-a-day marker: the provider,
 * the instrument and the archive floor the gap ends at. A floor that moved is a
 * different gap; the same floor on the same day is the same request.
 */
export function priceGapAttemptKey(source: string, instrumentId: string, earliestRawCloseISO: string | null): string {
  return `price-gap:${source}:${instrumentId}:${earliestRawCloseISO ?? "none"}`;
}

/** Default per-run instrument cap. A crypto wallet holds one native instrument today; tokens are not reconstructed. */
export const DEFAULT_PRICE_GAP_MAX_INSTRUMENTS = 5;

/**
 * Aggregate licences per instrument (earliest licensed day across ALL holders,
 * whoever they belong to) and decide each instrument's acquisition.
 *
 * The window is [max(needed, provider floor), min(day before earliest close,
 * yesterday)]: only dates older than the archive (the gap the planner cannot
 * see), only dates the provider declares it can serve, only closed dates.
 * Deterministic order (instrumentId); at most `maxInstruments` ACQUIRE.
 */
export function planPriceGaps(args: {
  licences: readonly HolderLicence[];
  facts: ReadonlyMap<string, InstrumentPriceFacts>;
  yesterdayISO: string;
  maxInstruments?: number;
  /** instrumentId → the earliest day already requested this run. */
  attempted?: ReadonlyMap<string, string>;
  /** priceGapAttemptKey values already requested TODAY (durable marker). */
  attemptedToday?: ReadonlySet<string>;
}): PriceGapDecision[] {
  const cap = Math.max(0, Math.floor(args.maxInstruments ?? DEFAULT_PRICE_GAP_MAX_INSTRUMENTS));
  const needed = new Map<string, { fromISO: string; holders: Set<string> }>();
  for (const l of args.licences) {
    const cur = needed.get(l.instrumentId);
    if (!cur) needed.set(l.instrumentId, { fromISO: l.licensedFromISO, holders: new Set([l.financialAccountId]) });
    else {
      if (l.licensedFromISO < cur.fromISO) cur.fromISO = l.licensedFromISO;
      cur.holders.add(l.financialAccountId);
    }
  }

  const out: PriceGapDecision[] = [];
  let acquiring = 0;
  for (const instrumentId of [...needed.keys()].sort()) {
    const { fromISO: neededFromISO, holders: h } = needed.get(instrumentId)!;
    const holders = h.size;
    const facts = args.facts.get(instrumentId);
    const earliest = facts?.earliestRawCloseISO ?? null;
    if (earliest !== null && earliest <= neededFromISO) { out.push({ instrumentId, kind: "COVERED", neededFromISO, holders }); continue; }
    if (!facts || facts.provider.kind === "none") { out.push({ instrumentId, kind: "NO_PROVIDER", neededFromISO, holders }); continue; }

    const beforeArchive = earliest !== null ? minusDaysISO(earliest, 1) : args.yesterdayISO;
    const toISO = beforeArchive < args.yesterdayISO ? beforeArchive : args.yesterdayISO;
    const fromISO = neededFromISO > facts.provider.floorISO ? neededFromISO : facts.provider.floorISO;
    if (fromISO > toISO) { out.push({ instrumentId, kind: "BELOW_PROVIDER_WINDOW", neededFromISO, holders }); continue; }

    const tried = args.attempted?.get(instrumentId);
    if (tried !== undefined && tried <= fromISO) { out.push({ instrumentId, kind: "ALREADY_ATTEMPTED", neededFromISO, holders }); continue; }
    if (args.attemptedToday?.has(priceGapAttemptKey(facts.provider.source, instrumentId, earliest))) {
      out.push({ instrumentId, kind: "ALREADY_ATTEMPTED_TODAY", neededFromISO, holders }); continue;
    }
    if (acquiring >= cap) { out.push({ instrumentId, kind: "DEFERRED_RUN_CAP", neededFromISO, holders }); continue; }
    acquiring++;
    out.push({ instrumentId, kind: "ACQUIRE", fromISO, toISO, neededFromISO, holders });
  }
  return out;
}

// ── Revaluation owed (state-derived, so a lost flag self-heals) ─────────────

/**
 * Does an account's PERSISTED state say its wealth history is owed a
 * revaluation? Its valued-from — the latest, across the price-blocking
 * instruments it holds, of max(licence start, price floor) — is earlier than
 * the earliest snapshot its Spaces hold. Derived from facts on disk, never from
 * a flag, so a flag lost to a race is re-derived on the next run.
 *
 * Returns the day to regenerate from, or null when nothing is owed (no licence,
 * an unpriced instrument, no snapshots yet — the initial build is the normal
 * path's — or snapshots already reach valued-from).
 */
export function revaluationOwedFromISO(args: {
  /** instrumentId → licence start, for this account's price-blocking instruments. */
  licences: ReadonlyMap<string, string>;
  /** instrumentId → earliest RAW_CLOSE (absent ⇒ unpriced). */
  floors: ReadonlyMap<string, string>;
  /** Earliest snapshot day of the account's Spaces (the latest of their per-Space minima), or null. */
  earliestSnapshotISO: string | null;
}): { fromISO: string; floorISO: string } | null {
  if (args.licences.size === 0 || args.earliestSnapshotISO === null) return null;
  let from: string | null = null;
  let floor: string | null = null;
  for (const [instrumentId, lic] of args.licences) {
    const f = args.floors.get(instrumentId) ?? null;
    const v = valuedFromISO(lic, f);
    if (v === null || f === null) return null; // an unpriced blocking instrument values nothing
    if (from === null || v > from) from = v;
    if (floor === null || f > floor) floor = f;
  }
  return from !== null && floor !== null && from < args.earliestSnapshotISO ? { fromISO: from, floorISO: floor } : null;
}
