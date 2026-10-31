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

// ── Holder revaluation over EXISTING rows (2026-10-31, P1) ──────────────────
//
// THE DEFECT (live on Preview, QA Space, 2026-10-31): 31 stored rows
// (2026-09-27..2026-10-27) were written on 10-28 05:16, before the BTC wallet
// was linked (12:55). They hold SOL only (~$76) and are stamped "supported".
// The revaluation above is owed only while valued-from precedes the EARLIEST
// snapshot, and rebuilds only [valued-from, earliest snapshot − 1] — so once the
// prefix was filled the stale interior rows were never revisited, and the chart
// fell from $27,888 to $91 (10-27 stored $76.04; correct $26,793.01).
//
// THE RULE NOW: a holder's revaluation is owed whenever its EVIDENCE changes —
// the licences it holds (native AND token), the price floors serving them, or
// the Spaces it belongs to — and it covers EVERY existing row of those Spaces
// from the earlier of valued-from and the earliest stored row, through today.
// Days that recompute identically are UNCHANGED and not rewritten
// (planDayPersistence), so a re-run churns nothing; days the holder existed on
// but cannot be valued become `unavailable`, never `supported`, never $0.
// Bounded and kill-safe: the window is cut into epoch-anchored blocks, rebuilt
// NEWEST first (the visible cliff first) in batches sized to the time left; a
// block is marked done only AFTER its rebuild returns (a killed run leaves it
// owed), with an attempt cap so a poison block cannot loop. A large window
// progresses across runs.
//
// What this does NOT do: change the evidence key only when it matters. Any
// evidence change (e.g. a lowered floor) re-owes the WHOLE window once; the
// unchanged days recompute UNCHANGED (no writes), so the cost is compute, not
// churn. Narrowing the re-owed range per kind of change is a follow-up.

/** Do not start a price-gap pass or a revaluation batch with less than this left of the wake. */
export const REVALUATION_RESERVE_MS = 60_000;
/**
 * Days per revaluation BLOCK — the unit of the durable "done" marker. Blocks are
 * anchored to a fixed epoch (Mondays from 1970-01-05), so a block's key does not
 * depend on where a holder's window starts or ends. A rebuild covers a BATCH of
 * contiguous blocks sized to the time left (planRevaluationBatch).
 */
export const REVALUATION_BLOCK_DAYS = 7;
/** A block that has failed this many rebuilds is abandoned until the evidence changes (no poison loop). */
export const REVALUATION_MAX_ATTEMPTS = 3;
/** First-batch cost estimate before this run has measured one (conservative: live R1c ≈ 2.8 s/day locally, 3–5× Vercel). */
export const REVALUATION_DEFAULT_MS_PER_DAY = 1_500;
/** Time kept back from a batch's budget: the batch is sized to end this long BEFORE the deadline. */
export const REVALUATION_BATCH_MARGIN_MS = 20_000;
/** Version of the evidence fingerprint; bumping it re-owes every holder once. */
export const REVALUATION_EVIDENCE_VERSION = "v2";

/** One holder whose evidence state owes a revaluation of its Spaces' rows. */
export interface HolderRevaluation {
  accountId: string;
  /** First day to rebuild: min(valued-from, earliest stored row of its Spaces). */
  windowFromISO: string;
  /** max(licence start, price floor) across its native instruments; null when one is unpriced. */
  valuedFromISO: string | null;
  /** The durable key of this evidence state (block keys extend it). */
  evidenceKey: string;
}

/** FNV-1a 32-bit, hex — a stable short digest (pure; no node:crypto in a core). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/**
 * The evidence fingerprint of one holder: every licence it holds (native and
 * token: instrument → licence start), the price floor of each (or "none"), and
 * the Spaces it belongs to. Any change — a licence widening, a new price
 * coverage, a token licence, a new Space link — is a new key, i.e. a new owed
 * revaluation. The same state is the same key, so a re-run owes nothing.
 */
export function revaluationEvidenceKey(args: {
  accountId: string;
  licences: ReadonlyMap<string, string>;
  floors: ReadonlyMap<string, string>;
  spaceIds: readonly string[];
}): string {
  const parts = [...args.licences.keys()].sort().map((id) => `${id}=${args.licences.get(id)}/${args.floors.get(id) ?? "none"}`);
  const spaces = [...new Set(args.spaceIds)].sort().join(",");
  return `revaluation:${REVALUATION_EVIDENCE_VERSION}:${args.accountId}:${fnv1a(`${parts.join(";")}|${spaces}`)}`;
}

/**
 * Does this holder's persisted state call for a revaluation of its Spaces'
 * existing rows, and from when? Null when it holds no licence or its Spaces hold
 * no row yet (the initial build is the normal path's). An unpriced native
 * instrument does NOT excuse it: its existing rows must still be re-decided, and
 * the day rule refuses them (`unavailable`) rather than leave them "supported".
 */
export function holderRevaluationFor(args: {
  accountId: string;
  /** Native price-blocking licences (instrument → start): valued-from. */
  nativeLicences: ReadonlyMap<string, string>;
  /** Every licence (native + token): the fingerprint. */
  allLicences: ReadonlyMap<string, string>;
  floors: ReadonlyMap<string, string>;
  /** Earliest stored row per Space the holder is ACTIVE in (absent ⇒ no rows). */
  snapshotMinBySpace: ReadonlyMap<string, string>;
  spaceIds: readonly string[];
}): HolderRevaluation | null {
  if (args.allLicences.size === 0) return null;
  const mins = args.spaceIds.map((s) => args.snapshotMinBySpace.get(s)).filter((d): d is string => !!d);
  if (mins.length === 0) return null;
  const earliestRow = mins.reduce((m, d) => (d < m ? d : m));
  let valued: string | null = null;
  let unpriced = false;
  for (const [id, lic] of args.nativeLicences) {
    const v = valuedFromISO(lic, args.floors.get(id) ?? null);
    if (v === null) { unpriced = true; continue; }
    if (valued === null || v > valued) valued = v;
  }
  if (unpriced) valued = null;
  const windowFromISO = valued !== null && valued < earliestRow ? valued : earliestRow;
  return {
    accountId: args.accountId, windowFromISO, valuedFromISO: valued,
    evidenceKey: revaluationEvidenceKey({ accountId: args.accountId, licences: args.allLicences, floors: args.floors, spaceIds: args.spaceIds }),
  };
}

/** One epoch-anchored block of a holder's revaluation window (clipped to the window). */
export interface RevaluationBlock { fromISO: string; toISO: string; key: string }

const EPOCH_MONDAY_MS = Date.UTC(1970, 0, 5);
const DAY_MS = 86_400_000;
const dayIndex = (iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - EPOCH_MONDAY_MS) / DAY_MS);
const isoOfIndex = (i: number) => new Date(EPOCH_MONDAY_MS + i * DAY_MS).toISOString().slice(0, 10);

/**
 * [fromISO, toISO] as REVALUATION_BLOCK_DAYS blocks on the fixed epoch grid,
 * NEWEST first (the rows a reader sees first). The key names the block's GRID
 * start, so it is stable however the window's own start or end moves.
 */
export function revaluationBlocks(evidenceKey: string, fromISO: string, toISO: string, blockDays = REVALUATION_BLOCK_DAYS): RevaluationBlock[] {
  if (fromISO > toISO) return [];
  const size = Math.max(1, Math.floor(blockDays));
  const first = dayIndex(fromISO), last = dayIndex(toISO);
  const out: RevaluationBlock[] = [];
  for (let start = Math.floor(first / size) * size; start <= last; start += size) {
    const lo = Math.max(start, first), hi = Math.min(start + size - 1, last);
    out.push({ fromISO: isoOfIndex(lo), toISO: isoOfIndex(hi), key: `${evidenceKey}:${isoOfIndex(start)}` });
  }
  return out.reverse();
}

/**
 * The next rebuild: from the NEWEST owed block, the contiguous run of owed
 * blocks (newest first) whose day count fits `maxDays` — always at least one
 * block, so progress is guaranteed. Null when nothing is owed.
 *
 * `isolate(b)` — a block that must be rebuilt ALONE (it was in a batch that did
 * not complete): it is never joined to a batch, so a failure is charged to it
 * and only it — one bad day never burns its neighbours' attempts.
 */
export function planRevaluationBatch(
  owedNewestFirst: readonly RevaluationBlock[], maxDays: number, isolate: (b: RevaluationBlock) => boolean = () => false,
): { fromISO: string; toISO: string; blocks: RevaluationBlock[] } | null {
  if (owedNewestFirst.length === 0) return null;
  const blocks = [owedNewestFirst[0]];
  let days = dayIndex(blocks[0].toISO) - dayIndex(blocks[0].fromISO) + 1;
  for (let i = 1; i < owedNewestFirst.length && !isolate(blocks[0]); i++) {
    const b = owedNewestFirst[i];
    if (isolate(b)) break;
    const n = dayIndex(b.toISO) - dayIndex(b.fromISO) + 1;
    if (dayIndex(b.toISO) !== dayIndex(blocks[blocks.length - 1].fromISO) - 1 || days + n > maxDays) break;
    blocks.push(b); days += n;
  }
  return { fromISO: blocks[blocks.length - 1].fromISO, toISO: blocks[0].toISO, blocks };
}
