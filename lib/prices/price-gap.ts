/**
 * lib/prices/price-gap.ts
 *
 * The I/O half of historical price-gap backfill (decisions:
 * ./price-gap.core.ts). Reads balance licences and archive floors, asks the
 * CANONICAL acquisition path (backfillPricesForInstruments — missing-only,
 * insert-only, closed dates, provenance on every row) for the planned windows,
 * and reports what the archive now reaches so the caller can regenerate.
 *
 * It does not regenerate. The caller already owns a regeneration (the Solana
 * worker, the crypto sweep) and calls the canonical planner after this, which
 * MEASURES the newly written closes (PriceObservation.createdAt) and reads the
 * lowered price floor — so the rebuilt window reaches the new dates with no
 * second date authority.
 *
 * Authority: every read goes through the `client` the caller passes (fm_system
 * in the worker). The acquisition itself is the existing shared archive writer.
 *
 * NEVER THROWS. Price maintenance must not fail a backfill or a sweep.
 */

import { AssetClass, PriceBasis, type Prisma, type PrismaClient } from "@prisma/client";
import { licensedInterval } from "@/lib/crypto/position-coverage";
import { NOT_TOKEN_INSTRUMENT } from "@/lib/crypto/token-asset";
import type { ChainCoverage, ChainCoverageCaveat } from "@/lib/crypto/chain-movement";
import { minusDaysISO, yesterdayUTCISO } from "./config";
import { routingKeyFor } from "./coverage-binding.core";
import { resolveProviderForInstrument } from "./registry";
import type { PriceRegistry } from "./types";
import {
  planPriceGaps, priceGapAttemptKey, revaluationOwedFromISO, DEFAULT_PRICE_GAP_MAX_INSTRUMENTS,
  holderRevaluationFor, revaluationBlocks, planRevaluationBatch, REVALUATION_RESERVE_MS, type RevaluationBlock,
  holderContributionSpans, intersectRanges,
  suspectBatchCap, estimateRebuildCost, batchDaysFor,
  REVALUATION_MAX_ATTEMPTS, REVALUATION_DEFAULT_MS_PER_DAY, REVALUATION_BATCH_MARGIN_MS,
  type HolderLicence, type HolderRevaluation, type InstrumentPriceFacts, type PriceGapDecision,
} from "./price-gap.core";

/** ApiUsageCounter vocabulary for the durable once-a-day gap marker (no new table). */
export const PRICE_GAP_ATTEMPT_PROVIDER = "PRICE_GAP";
export const PRICE_GAP_ATTEMPT_UNIT = "attempts";

export * from "./price-gap.core";

type Client = PrismaClient | Prisma.TransactionClient;
const isoOf = (d: Date) => d.toISOString().slice(0, 10);

/** The three outside facts — Prisma below, fakes in tests. */
export interface PriceGapDeps {
  /** Licensed balance intervals of CRYPTO instruments (price-blocking) held by these accounts. */
  licences(accountIds: readonly string[]): Promise<HolderLicence[]>;
  /** Archive floor + routed provider per instrument. */
  priceFacts(instrumentIds: readonly string[]): Promise<Map<string, InstrumentPriceFacts>>;
  /** The canonical acquisition over one window. */
  acquire(instrumentId: string, fromISO: string, toISO: string): Promise<{ inserted: number; detail: string }>;
  /** Of these attempt keys, those already requested on `dayISO` (durable). Optional: absent ⇒ no durable dedup. */
  attemptedOn?(keys: readonly string[], dayISO: string): Promise<Set<string>>;
  /** Record that `key` was requested today (before the request, so a killed run still counts). */
  markAttempted?(key: string): Promise<void>;
}

export interface PriceGapRun {
  decisions: PriceGapDecision[];
  /** Instruments a request was issued for. */
  acquired: number;
  /** RAW_CLOSE rows written. */
  inserted: number;
  failures: number;
  /** Per acquired instrument: the archive floor before and after. */
  instruments: Array<{ instrumentId: string; earliestBeforeISO: string | null; earliestAfterISO: string | null }>;
  /** The earliest date that became priceable this run, or null when nothing moved. */
  newlyPricedFromISO: string | null;
}

/**
 * Detect and fill historical price gaps for the instruments these accounts
 * hold a balance licence for. `attempted` (instrumentId → earliest day asked)
 * is the caller's per-run dedup and is updated in place.
 */
export async function acquireHistoricalPriceGaps(args: {
  accountIds: readonly string[];
  deps: PriceGapDeps;
  yesterdayISO?: string;
  maxInstruments?: number;
  attempted?: Map<string, string>;
  log?: (line: string) => void;
}): Promise<PriceGapRun> {
  const run: PriceGapRun = { decisions: [], acquired: 0, inserted: 0, failures: 0, instruments: [], newlyPricedFromISO: null };
  const log = args.log ?? (() => {});
  if (args.accountIds.length === 0) return run;
  try {
    const licences = await args.deps.licences([...new Set(args.accountIds)].sort());
    if (licences.length === 0) return run;
    const instrumentIds = [...new Set(licences.map((l) => l.instrumentId))].sort();
    const facts = await args.deps.priceFacts(instrumentIds);
    const yesterdayISO = args.yesterdayISO ?? yesterdayUTCISO();
    const todayISO = minusDaysISO(yesterdayISO, -1);
    const keyFor = (id: string) => {
      const f = facts.get(id);
      return f && f.provider.kind === "provider" ? priceGapAttemptKey(f.provider.source, id, f.earliestRawCloseISO) : null;
    };
    const keys = instrumentIds.map(keyFor).filter((k): k is string => k !== null);
    const attemptedToday = args.deps.attemptedOn && keys.length > 0 ? await args.deps.attemptedOn(keys, todayISO) : undefined;
    run.decisions = planPriceGaps({
      licences, facts, yesterdayISO,
      maxInstruments: args.maxInstruments ?? DEFAULT_PRICE_GAP_MAX_INSTRUMENTS, attempted: args.attempted, attemptedToday,
    });
    for (const d of run.decisions) {
      if (d.kind !== "ACQUIRE") continue;
      args.attempted?.set(d.instrumentId, d.fromISO);
      const key = keyFor(d.instrumentId);
      if (key && args.deps.markAttempted) await args.deps.markAttempted(key).catch(() => {});
      run.acquired++;
      try {
        const r = await args.deps.acquire(d.instrumentId, d.fromISO, d.toISO);
        run.inserted += r.inserted;
        log(`price gap ${d.instrumentId} ${d.fromISO}..${d.toISO} (${d.holders} holder(s)): ${r.detail}`);
      } catch (e) {
        run.failures++;
        log(`price gap ${d.instrumentId} ${d.fromISO}..${d.toISO}: acquisition failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const acquiredIds = run.decisions.filter((d) => d.kind === "ACQUIRE").map((d) => d.instrumentId);
    if (acquiredIds.length > 0) {
      // RE-READ the floor: rows written is not the question — only what the
      // archive now reaches is. A provider that returned nothing moves nothing.
      const after = await args.deps.priceFacts(acquiredIds);
      for (const id of acquiredIds) {
        const before = facts.get(id)?.earliestRawCloseISO ?? null;
        const now = after.get(id)?.earliestRawCloseISO ?? null;
        run.instruments.push({ instrumentId: id, earliestBeforeISO: before, earliestAfterISO: now });
        if (now !== null && (before === null || now < before)) {
          if (run.newlyPricedFromISO === null || now < run.newlyPricedFromISO) run.newlyPricedFromISO = now;
        }
      }
    }
  } catch (e) {
    run.failures++;
    log(`price gap detection failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
  return run;
}

// ── Read helpers (UI-ready coverage facts) ──────────────────────────────────

/** Earliest stored RAW_CLOSE per instrument. Instruments with none are absent from the map. */
export async function earliestRawCloseByInstrument(client: Client, instrumentIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (instrumentIds.length === 0) return out;
  const rows = await client.priceObservation.groupBy({
    by: ["instrumentId"],
    where: { instrumentId: { in: [...instrumentIds] }, basis: PriceBasis.RAW_CLOSE },
    _min: { date: true },
  });
  for (const r of rows) if (r._min.date) out.set(r.instrumentId, isoOf(r._min.date));
  return out;
}

/**
 * Licensed NATIVE balance intervals, through the ONE licence reader
 * (position-coverage.ts licensedInterval). Token instruments are excluded: a
 * token licence (SPL / ERC-20 history) on an unpriced mint has no price floor,
 * and counting it would leave the whole account with no revaluation floor —
 * native wealth history would never be revalued (token rows are valued by
 * lib/crypto/token-valuation.ts, under their own licences).
 */
export async function cryptoHolderLicences(client: Client, accountIds: readonly string[], opts: { includeTokens?: boolean } = {}): Promise<HolderLicence[]> {
  if (accountIds.length === 0) return [];
  const rows = await client.positionCoverage.findMany({
    // includeTokens — the revaluation FINGERPRINT only (holderRevaluations): a new
    // token licence must re-decide the wallet's rows, but never sets a floor.
    where: { financialAccountId: { in: [...accountIds] }, instrument: opts.includeTokens ? { assetClass: AssetClass.CRYPTO } : { assetClass: AssetClass.CRYPTO, ...NOT_TOKEN_INSTRUMENT } },
    select: { financialAccountId: true, instrumentId: true, kind: true, coveredFromDate: true, coveredToDate: true, caveats: true, source: true },
  });
  const out: HolderLicence[] = [];
  for (const r of rows) {
    const caveats = r.caveats as ChainCoverageCaveat[];
    const coverage: ChainCoverage | null =
      r.kind === "COMPLETE" && r.coveredFromDate && r.coveredToDate
        ? { kind: "COMPLETE", fromISO: isoOf(r.coveredFromDate), toISO: isoOf(r.coveredToDate), source: r.source }
        : r.kind === "PARTIAL"
          ? { kind: "PARTIAL", coveredFromISO: r.coveredFromDate ? isoOf(r.coveredFromDate) : null, coveredToISO: r.coveredToDate ? isoOf(r.coveredToDate) : null, caveats, source: r.source }
          : null;
    const licence = coverage ? licensedInterval(coverage) : null;
    if (licence) out.push({ financialAccountId: r.financialAccountId, instrumentId: r.instrumentId, licensedFromISO: licence.fromISO });
  }
  return out;
}

/** One account whose persisted state says its history is owed a revaluation. */
export interface RevaluationOwed { accountId: string; fromISO: string; floorISO: string; earliestSnapshotISO: string }

/**
 * Accounts (of these) owed a revaluation by PERSISTED state — valued-from
 * earlier than their Spaces' earliest snapshot (price-gap.core.ts
 * revaluationOwedFromISO). Reads only; a lost in-memory flag self-heals here.
 * Never throws (an unreadable state owes nothing this run).
 */
export async function revaluationOwed(client: Client, accountIds: readonly string[]): Promise<RevaluationOwed[]> {
  if (accountIds.length === 0) return [];
  try {
    const licences = await cryptoHolderLicences(client, accountIds);
    if (licences.length === 0) return [];
    const floors = await earliestRawCloseByInstrument(client, [...new Set(licences.map((l) => l.instrumentId))]);
    const accounts = [...new Set(licences.map((l) => l.financialAccountId))].sort();
    const links = await client.spaceAccountLink.findMany({
      where: { financialAccountId: { in: accounts }, status: "ACTIVE" }, select: { financialAccountId: true, spaceId: true },
    });
    const spaceIds = [...new Set(links.map((l) => l.spaceId))];
    const mins = spaceIds.length === 0 ? [] : await client.spaceSnapshot.groupBy({ by: ["spaceId"], where: { spaceId: { in: spaceIds } }, _min: { date: true } });
    const minBySpace = new Map(mins.filter((m) => m._min.date).map((m) => [m.spaceId, isoOf(m._min.date!)]));
    const out: RevaluationOwed[] = [];
    for (const accountId of accounts) {
      // The LATEST per-Space minimum: a Space that starts later than valued-from is owed.
      const starts = links.filter((l) => l.financialAccountId === accountId).map((l) => minBySpace.get(l.spaceId)).filter((d): d is string => !!d);
      const earliestSnapshotISO = starts.length ? starts.reduce((m, d) => (d > m ? d : m)) : null;
      const lic = new Map(licences.filter((l) => l.financialAccountId === accountId).map((l) => [l.instrumentId, l.licensedFromISO] as const));
      const owed = revaluationOwedFromISO({ licences: lic, floors, earliestSnapshotISO });
      if (owed && earliestSnapshotISO) out.push({ accountId, ...owed, earliestSnapshotISO });
    }
    return out;
  } catch (e) {
    console.warn("[price-gap] revaluationOwed failed (non-fatal):", e instanceof Error ? e.message : String(e));
    return [];
  }
}

// ── Bounded revaluation of the holders whose evidence changed ──────────────

export const REVALUATION_ATTEMPT_PROVIDER = "REVALUATION";
/** Accounts revalued per run at most; the rest stay owed (state) and run next time. */
export const DEFAULT_REVALUATION_MAX_ACCOUNTS = 10;

/**
 * Every holder (of these) whose Spaces already hold rows, with its evidence
 * fingerprint and the window its revaluation covers (price-gap.core.ts
 * holderRevaluationFor). Reads only. Whether the fingerprint was already
 * revalued is the caller's marker question. Never throws.
 */
export async function holderRevaluations(client: Client, accountIds: readonly string[]): Promise<HolderRevaluation[]> {
  if (accountIds.length === 0) return [];
  try {
    const all = await cryptoHolderLicences(client, accountIds, { includeTokens: true });
    if (all.length === 0) return [];
    const native = await cryptoHolderLicences(client, accountIds);
    const floors = await earliestRawCloseByInstrument(client, [...new Set(all.map((l) => l.instrumentId))]);
    const accounts = [...new Set(all.map((l) => l.financialAccountId))].sort();
    const links = await client.spaceAccountLink.findMany({
      where: { financialAccountId: { in: accounts }, status: "ACTIVE" }, select: { financialAccountId: true, spaceId: true },
    });
    const spaceIds = [...new Set(links.map((l) => l.spaceId))];
    const mins = spaceIds.length === 0 ? [] : await client.spaceSnapshot.groupBy({ by: ["spaceId"], where: { spaceId: { in: spaceIds } }, _min: { date: true } });
    const snapshotMinBySpace = new Map(mins.filter((m) => m._min.date).map((m) => [m.spaceId, isoOf(m._min.date!)]));
    const byAccount = (rows: HolderLicence[], id: string) => {
      const m = new Map<string, string>();
      for (const l of rows) if (l.financialAccountId === id) { const cur = m.get(l.instrumentId); if (!cur || l.licensedFromISO < cur) m.set(l.instrumentId, l.licensedFromISO); }
      return m;
    };
    // REVIEW #183 P1 — the window is EXACTLY what the canonical rebuild recomputes:
    // from the holder's evidence floor (the planner's own floor reader) to the
    // writable ceiling; and the days it could contribute value are read from its
    // dated positions (never a day it confirmedly held nothing).
    const { resolveEvidenceFloor } = await import("@/lib/snapshots/historical-work-window");
    const { recentWealthWindow } = await import("@/lib/snapshots/regenerate-history");
    const ceilingISO = recentWealthWindow(new Date()).toDate;
    const out: HolderRevaluation[] = [];
    for (const accountId of accounts) {
      const evidenceFloorISO = await resolveEvidenceFloor(client as Parameters<typeof resolveEvidenceFloor>[0], [accountId]);
      const h = holderRevaluationFor({
        accountId, nativeLicences: byAccount(native, accountId), allLicences: byAccount(all, accountId), floors, snapshotMinBySpace,
        spaceIds: links.filter((l) => l.financialAccountId === accountId).map((l) => l.spaceId), evidenceFloorISO, ceilingISO,
      });
      if (!h) continue;
      const obs = await client.positionObservation.findMany({
        where: { financialAccountId: accountId, deletedAt: null, supersededById: null, instrument: { assetClass: AssetClass.CRYPTO },
          date: { lte: new Date(`${ceilingISO}T00:00:00.000Z`) } },
        select: { instrumentId: true, date: true, quantity: true }, orderBy: { date: "asc" },
      });
      out.push({ ...h, contributes: holderContributionSpans(obs.map((o) => ({ instrumentId: o.instrumentId, dateISO: isoOf(o.date), quantity: o.quantity })), h.windowFromISO, ceilingISO) });
    }
    return out;
  } catch (e) {
    console.warn("[price-gap] holderRevaluations failed (non-fatal):", e instanceof Error ? e.message : String(e));
    return [];
  }
}

export interface RevaluationDeps {
  acquireGaps(accountIds: readonly string[]): Promise<PriceGapRun>;
  /** Holders (of these) whose Spaces hold rows, with their evidence key and window (holderRevaluations). */
  owed(accountIds: readonly string[]): Promise<HolderRevaluation[]>;
  /** Of these block keys, those already rebuilt SUCCESSFULLY (the "done" marker). */
  revaluedAlready(keys: readonly string[]): Promise<Set<string>>;
  /** Record a block as done — only AFTER its rebuild returned. */
  markRevalued(key: string): Promise<void>;
  /**
   * Rebuild attempts recorded per block key (any day): `single` — the block
   * rebuilt ALONE (charged against REVALUATION_MAX_ATTEMPTS); `batch` — the block
   * was in a multi-block batch (never charged; it only makes the block rebuild
   * alone next time). Optional: absent ⇒ no attempt cap.
   */
  attemptsOf?(keys: readonly string[]): Promise<Map<string, { single: number; batch: number }>>;
  /**
   * Count one attempt — BEFORE the rebuild, so a killed run still counts. A
   * "dry_*" mark CANCELS one earlier try of that kind: a rebuild that wrote
   * nothing (writes off) is never counted as an attempt (review of #183).
   */
  markAttempt?(key: string, kind: "single" | "batch" | "dry_single" | "dry_batch"): Promise<void>;
  /**
   * OWNER RULING — an ABANDONED block must not keep an understated `supported`
   * row: metadata-only stamp of its ESTIMATE rows (isEstimated=true, the one
   * status column; frozen/observed rows never) to `unavailable`, over the
   * holder's Spaces. Returns rows stamped. Optional: absent ⇒ not stamped.
   */
  markUnavailable?(accountId: string, fromISO: string, toISO: string): Promise<number>;
  /** Regenerate one account's wealth history over [fromISO, toISO] — existing rows included. */
  /**
   * Returns `false` when the rebuild WROTE NOTHING because writes are disabled
   * (the WEALTH_REGENERATION_ENABLED kill switch): its blocks are then never
   * marked done (defence in depth — a dry run must not retire a block).
   */
  regenerate(accountId: string, fromISO: string, toISO: string): Promise<void | false>;
  /**
   * Are snapshot writes enabled (wealthRegenerationEnabled)? Optional: absent ⇒
   * enabled. When false NOTHING runs — no stamp (no rebuild could restore it),
   * no attempt, no marker.
   */
  writesEnabled?(): boolean;
  now(): number;
}

export interface RevaluationRun {
  priceGaps: PriceGapRun | null;
  /** Holders with at least one owed block of their current evidence state (after this run's gap fill). */
  owed: number;
  /** Holders whose every owed block was rebuilt this run. */
  revalued: number;
  /** Blocks rebuilt (and marked done) this run. */
  chunksRebuilt: number;
  /** Owed, not finished this time (cap or wake time) — unmarked blocks stay owed, picked up next run. */
  deferred: number;
  /** Holders whose current evidence state is already fully revalued — not repeated (no churn, no loop). */
  alreadyRevalued: number;
  /** Blocks abandoned after REVALUATION_MAX_ATTEMPTS failed rebuilds (until the evidence changes); their estimate rows are stamped `unavailable`. */
  abandonedBlocks: number;
  /** Estimate rows stamped `unavailable` this run because their block was abandoned. */
  rowsStampedUnavailable: number;
  /** `supported` estimate rows stamped `unavailable` this run because their holder's block is still OWED (restored by its rebuild). */
  rowsStampedPending: number;
  failures: number;
  /** The gap pass itself was skipped: too little wake time left. */
  skippedForTime: boolean;
  /** Snapshot writes are disabled (kill switch): nothing stamped, rebuilt or marked. */
  writesDisabled?: boolean;
}

/** Each holder's blocks still owed: not done, and not abandoned at the attempt cap. */
async function owedBlocks(deps: Pick<RevaluationDeps, "revaluedAlready" | "attemptsOf">, holders: HolderRevaluation[], todayISO: string) {
  const plans = holders.map((h) => ({ h, blocks: revaluationBlocks(h.evidenceKey, h.windowFromISO, h.windowToISO && h.windowToISO < todayISO ? h.windowToISO : todayISO) }));
  const keys = plans.flatMap((p) => p.blocks.map((b) => b.key));
  const done = keys.length > 0 ? await deps.revaluedAlready(keys) : new Set<string>();
  const notDone = keys.filter((k) => !done.has(k));
  const tries = deps.attemptsOf && notDone.length > 0 ? await deps.attemptsOf(notDone) : new Map<string, { single: number; batch: number }>();
  return plans.map((p) => {
    const open = p.blocks.filter((b) => !done.has(b.key));
    const live = open.filter((b) => (tries.get(b.key)?.single ?? 0) < REVALUATION_MAX_ATTEMPTS);
    const abandoned = open.filter((b) => (tries.get(b.key)?.single ?? 0) >= REVALUATION_MAX_ATTEMPTS);
    return { h: p.h, live, abandoned, tries };
  });
}

/**
 * Is any holder (of these) owed revaluation work under its CURRENT evidence?
 * Cheap reads only (no acquisition): the worker asks before its passes so it
 * can reserve the revaluation's slice of the job budget. Never throws.
 */
export async function revaluationPending(deps: Pick<RevaluationDeps, "owed" | "revaluedAlready" | "attemptsOf">, accountIds: readonly string[], todayISO = minusDaysISO(yesterdayUTCISO(), -1)): Promise<boolean> {
  if (accountIds.length === 0) return false;
  try {
    const plans = await owedBlocks(deps, await deps.owed(accountIds), todayISO);
    return plans.some((p) => p.live.length > 0);
  } catch {
    return false;
  }
}

/**
 * After a sweep's ordinary regeneration: fill historical price gaps for these
 * accounts, then revalue every holder whose EVIDENCE state (licences native and
 * token, price floors, Space links) has not yet been revalued — over EVERY
 * existing row of its Spaces from min(valued-from, earliest row) through today,
 * not only the days before the earliest row (the 2026-10-31 stale-interior
 * defect).
 *
 * Bounded and kill-safe: newest block first, in batches of contiguous blocks
 * sized to the time left (measured ms/day, a margin before the deadline). A
 * block is marked DONE only after its rebuild returns; an attempt is counted
 * BEFORE, so a run killed mid-batch leaves the block owed and the next run
 * redoes it, while a block that fails REVALUATION_MAX_ATTEMPTS times is
 * abandoned until the evidence changes (no poison loop). Capped by
 * `maxAccounts`. Rebuilding goes through the canonical regeneration, whose
 * per-day persistence (planDayPersistence) leaves identical days unwritten and
 * frozen rows untouched — so a re-run churns nothing. Never throws.
 */
export async function revalueHoldersAfterPriceGaps(args: {
  accountIds: readonly string[];
  deps: RevaluationDeps;
  deadlineMs: number;
  maxAccounts?: number;
  /** The window's last day (default: today UTC). */
  todayISO?: string;
  /** Prior per-day cost (default REVALUATION_DEFAULT_MS_PER_DAY); this run's measurements refine it (estimateRebuildCost). */
  msPerDay?: number;
  log?: (line: string) => void;
}): Promise<RevaluationRun> {
  const run: RevaluationRun = { priceGaps: null, owed: 0, revalued: 0, chunksRebuilt: 0, deferred: 0, alreadyRevalued: 0, abandonedBlocks: 0,
    rowsStampedUnavailable: 0, rowsStampedPending: 0, failures: 0, skippedForTime: false };
  const log = args.log ?? (() => {});
  const cap = Math.max(0, Math.floor(args.maxAccounts ?? DEFAULT_REVALUATION_MAX_ACCOUNTS));
  const left = () => args.deadlineMs - args.deps.now();
  const todayISO = args.todayISO ?? minusDaysISO(yesterdayUTCISO(), -1);
  const priorMsPerDay = Math.max(1, args.msPerDay ?? REVALUATION_DEFAULT_MS_PER_DAY);
  const observations: Array<{ days: number; ms: number }> = [];
  if (args.accountIds.length === 0) return run;
  if (args.deps.writesEnabled && !args.deps.writesEnabled()) { run.writesDisabled = true; return run; }
  try {
    const stamp = (h: HolderRevaluation, blocks: readonly RevaluationBlock[]) => stampHolderBlocks(args.deps, h, blocks);
    /** Abandoned ⇒ never left `supported`/`none`: stamp its rows `unavailable` (idempotent). */
    const abandon = async (h: HolderRevaluation, blk: RevaluationBlock) => {
      run.abandonedBlocks++;
      const n = await stamp(h, [blk]);
      run.rowsStampedUnavailable += n;
      log(`revaluation ${h.accountId} ${blk.fromISO}..${blk.toISO} ABANDONED after ${REVALUATION_MAX_ATTEMPTS} attempts — estimate rows stamped unavailable (${n})`);
    };
    const readPlans = async () => owedBlocks(args.deps, (await args.deps.owed(args.accountIds)).sort((a, b) => a.accountId.localeCompare(b.accountId)), todayISO);

    // ── 1. STAMP FIRST — DB-only, before the time check and before the paid fetch ──
    // OWNER RULING (live 2026-10-31: 55 ETH-less rows read `supported` while their
    // block waited its turn; review of #183: a time-skipped pass or a failed gap
    // fetch skipped the stamp). A holder whose evidence changed is owed every
    // live block; until a block is rebuilt its rows may omit the holder, so they
    // are stamped `unavailable` now: metadata-only, values preserved, only the
    // (Space, day) rows the holder could contribute to and the rebuild will
    // recompute, idempotent. The rebuild restores them per block.
    let plans = await readPlans();
    for (const p of plans) {
      for (const blk of p.abandoned) await abandon(p.h, blk);
      run.rowsStampedPending += await stamp(p.h, p.live);
    }
    if (left() < REVALUATION_RESERVE_MS) {
      run.skippedForTime = true;
      run.owed = plans.filter((p) => p.live.length > 0).length;
      run.deferred = run.owed;
      return run;
    }
    // ── the PAID price-gap fetch: its failure never undoes the stamp or the rebuild ──
    try {
      run.priceGaps = await args.deps.acquireGaps(args.accountIds);
    } catch (e) {
      run.failures++;
      log(`price-gap fetch failed (non-fatal; revaluation continues on held evidence): ${e instanceof Error ? e.message : String(e)}`);
    }
    if (run.priceGaps?.newlyPricedFromISO) {
      // A lowered floor is new evidence: new keys, newly owed blocks — stamp them before rebuilding.
      const seen = new Set(plans.map((p) => p.h.evidenceKey));
      plans = await readPlans();
      for (const p of plans) if (!seen.has(p.h.evidenceKey)) run.rowsStampedPending += await stamp(p.h, p.live);
    }
    if (plans.length === 0) return run;

    // ── 2. ROUND-ROBIN REBUILD across owed holders ────────────────────────────
    // Live: 12 passes rebuilt only the first holder (accountId order); BTC and ETH
    // got 0 blocks. Now each round gives EVERY active holder one batch, sized to
    // its share of the time left, most-owed first — so every owed holder
    // progresses every pass the reserve allows.
    const owedPlans = plans.filter((p) => p.live.length > 0);
    run.alreadyRevalued = plans.filter((p) => p.live.length === 0 && p.abandoned.length === 0).length;
    run.owed = owedPlans.length;
    owedPlans.sort((a, b) => b.live.length - a.live.length || a.h.accountId.localeCompare(b.h.accountId));
    const active = owedPlans.slice(0, cap).map((p) => ({ ...p, queue: [...p.live], failed: false }));
    run.deferred += owedPlans.length - active.length;
    const batchTries = (k: string, tries: Map<string, { single: number; batch: number }>) => tries.get(k)?.batch ?? 0;
    let progressed = true;
    let stopPass = false; // writes went off: the WHOLE pass stops (never a loop of dry rebuilds)
    let batches = 0; // defensive bound: halving guarantees termination, this guarantees it even if a cap misbehaves
    while (!stopPass && progressed && active.some((x) => x.queue.length > 0) && batches < REVALUATION_MAX_BATCHES_PER_PASS) {
      progressed = false;
      const round = active.filter((x) => x.queue.length > 0);
      for (let i = 0; i < round.length; i++) {
        if (left() < REVALUATION_RESERVE_MS) break;
        if (batches >= REVALUATION_MAX_BATCHES_PER_PASS) break; // checked BEFORE any attempt is charged
        // Writes switched off mid-run ⇒ stop the whole pass BEFORE charging anything.
        if (args.deps.writesEnabled && !args.deps.writesEnabled()) { run.writesDisabled = true; stopPass = true; break; }
        const x = round[i];
        const share = (left() - REVALUATION_BATCH_MARGIN_MS) / (round.length - i);
        const model = estimateRebuildCost(observations, priorMsPerDay);
        const batch = planRevaluationBatch(x.queue, batchDaysFor(share, model), (b) => suspectBatchCap(batchTries(b.key, x.tries)))!;
        x.queue = x.queue.filter((b) => !batch.blocks.includes(b));
        const alone = batch.blocks.length === 1;
        for (const b of batch.blocks) await args.deps.markAttempt?.(b.key, alone ? "single" : "batch").catch(() => {});
        const t0 = args.deps.now();
        progressed = true;
        batches++;
        try {
          const wrote = await args.deps.regenerate(x.h.accountId, batch.fromISO, batch.toISO);
          if (wrote === false) {
            // Writes went off mid-run: a dry run retires nothing and COUNTS for
            // nothing — its attempt is cancelled, the blocks stay owed, and the
            // WHOLE pass stops (no further dry rebuilds).
            for (const b of batch.blocks) await args.deps.markAttempt?.(b.key, alone ? "dry_single" : "dry_batch").catch(() => {});
            run.writesDisabled = true;
            x.queue = [...batch.blocks, ...x.queue];
            stopPass = true;
            break;
          }
          // DONE only now: a rebuild that never returned (killed) leaves its blocks owed.
          for (const b of batch.blocks) await args.deps.markRevalued(b.key).catch(() => {});
          run.chunksRebuilt += batch.blocks.length;
          observations.push({ days: Math.round((Date.parse(batch.toISO) - Date.parse(batch.fromISO)) / 86_400_000) + 1, ms: args.deps.now() - t0 });
        } catch (e) {
          log(`revaluation ${x.h.accountId} ${batch.fromISO}..${batch.toISO} failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
          if (!alone) {
            // Charge nobody yet: narrow the batch (halving) and retry — this run, time permitting.
            for (const b of batch.blocks) x.tries.set(b.key, { single: x.tries.get(b.key)?.single ?? 0, batch: batchTries(b.key, x.tries) + 1 });
            x.queue = [...batch.blocks, ...x.queue];
            continue;
          }
          x.failed = true;
          const b = batch.blocks[0];
          const n = (x.tries.get(b.key)?.single ?? 0) + 1;
          x.tries.set(b.key, { single: n, batch: batchTries(b.key, x.tries) });
          if (n >= REVALUATION_MAX_ATTEMPTS) await abandon(x.h, b);
        }
      }
      if (left() < REVALUATION_RESERVE_MS) break;
    }
    for (const x of active) {
      if (x.failed) run.failures++;
      else if (x.queue.length > 0) run.deferred++;
      else run.revalued++;
    }
  } catch (e) {
    run.failures++;
    log(`revaluation pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
  return run;
}

/** Rebuild calls per pass at most (defensive; normal passes make a handful). */
export const REVALUATION_MAX_BATCHES_PER_PASS = 500;

/** A holder's stamp ranges for these blocks: only the days it COULD contribute value to (never a day it held nothing). */
export function holderStampRanges(h: HolderRevaluation, blocks: readonly RevaluationBlock[]): Array<{ fromISO: string; toISO: string }> {
  return intersectRanges(contiguousRanges(blocks), h.contributes ?? [{ fromISO: h.windowFromISO, toISO: "9999-12-31" }]);
}

/** Metadata-only stamp of a holder's blocks (see markUnavailable). Never throws; returns rows stamped. */
async function stampHolderBlocks(deps: Pick<RevaluationDeps, "markUnavailable">, h: HolderRevaluation, blocks: readonly RevaluationBlock[]): Promise<number> {
  let n = 0;
  for (const r of holderStampRanges(h, blocks)) n += (await deps.markUnavailable?.(h.accountId, r.fromISO, r.toISO).catch(() => 0)) ?? 0;
  return n;
}

/**
 * STAMP ONLY — no rebuild, no vendor call, no usage marker written (reads the
 * markers only). For holders whose rebuild may not run: refused by the billable
 * gate or the global cost freeze (Session 2 ruling 2026-10-31: the stamp is a
 * DB-only status write — values preserved, reversed by the rebuild after
 * unfreeze — and the owner valuation ruling outranks the freeze; only the
 * rebuild's paid fetch is gated). Never throws; returns rows stamped.
 */
export async function stampOwedHolders(
  deps: Pick<RevaluationDeps, "owed" | "revaluedAlready" | "attemptsOf" | "markUnavailable" | "writesEnabled">, accountIds: readonly string[],
  todayISO = minusDaysISO(yesterdayUTCISO(), -1),
): Promise<number> {
  if (accountIds.length === 0 || !deps.markUnavailable) return 0;
  if (deps.writesEnabled && !deps.writesEnabled()) return 0; // no rebuild could restore it
  try {
    let n = 0;
    for (const p of await owedBlocks(deps, await deps.owed(accountIds), todayISO)) n += await stampHolderBlocks(deps, p.h, [...p.live, ...p.abandoned]);
    return n;
  } catch {
    return 0;
  }
}

/** [fromISO, toISO] minus the days `blocked` says are blocked, as ranges. */
export function unblockedRanges(fromISO: string, toISO: string, blocked: (dISO: string) => boolean): Array<{ fromISO: string; toISO: string }> {
  const out: Array<{ fromISO: string; toISO: string }> = [];
  for (let d = fromISO; d <= toISO; d = minusDaysISO(d, -1)) {
    if (blocked(d)) continue;
    const last = out[out.length - 1];
    if (last && minusDaysISO(last.toISO, -1) === d) last.toISO = d; else out.push({ fromISO: d, toISO: d });
  }
  return out;
}

/** Contiguous date ranges of blocks (any order in), oldest first — one stamp write per range. */
function contiguousRanges(blocks: readonly RevaluationBlock[]): Array<{ fromISO: string; toISO: string }> {
  const sorted = [...blocks].sort((a, b) => a.fromISO.localeCompare(b.fromISO));
  const out: Array<{ fromISO: string; toISO: string }> = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && minusDaysISO(last.toISO, -1) === b.fromISO) last.toISO = b.toISO;
    else out.push({ fromISO: b.fromISO, toISO: b.toISO });
  }
  return out;
}

/** Rebuild-attempt counter units (beside the "done" marker unit) on the same usage table. */
export const REVALUATION_TRY_UNIT = "revaluation_tries";
export const REVALUATION_BATCH_TRY_UNIT = "revaluation_batch_tries";
/** Every attempt unit; the dry_* units CANCEL a try whose rebuild wrote nothing. */
export const REVALUATION_TRY_UNITS = {
  single: REVALUATION_TRY_UNIT, batch: REVALUATION_BATCH_TRY_UNIT,
  dry_single: "revaluation_dry_tries", dry_batch: "revaluation_dry_batch_tries",
} as const;

/** Production deps for revalueHoldersAfterPriceGaps over `client` (markers through the one usage writer). */
export function prismaRevaluationDeps(client: Client, opts: { log?: (line: string) => void } = {}): RevaluationDeps {
  return {
    acquireGaps: (ids) => acquireHistoricalPriceGaps({ accountIds: ids, deps: prismaPriceGapDeps(client, { log: opts.log }), log: opts.log }),
    owed: (ids) => holderRevaluations(client, ids),
    async revaluedAlready(keys) {
      if (keys.length === 0) return new Set();
      const rows = await client.apiUsageCounter.findMany({
        where: { provider: REVALUATION_ATTEMPT_PROVIDER, unit: PRICE_GAP_ATTEMPT_UNIT, metric: { in: [...keys] } },
        select: { metric: true },
      });
      return new Set(rows.map((r) => r.metric));
    },
    async markRevalued(key) {
      const { recordApiUsage } = await import("@/lib/usage/record");
      await recordApiUsage(REVALUATION_ATTEMPT_PROVIDER, key, PRICE_GAP_ATTEMPT_UNIT, 1);
    },
    async attemptsOf(keys) {
      const out = new Map<string, { single: number; batch: number }>();
      if (keys.length === 0) return out;
      const units = Object.values(REVALUATION_TRY_UNITS);
      const rows = await client.apiUsageCounter.groupBy({
        by: ["metric", "unit"], where: { provider: REVALUATION_ATTEMPT_PROVIDER, unit: { in: units }, metric: { in: [...keys] } },
        _sum: { count: true },
      });
      for (const r of rows) {
        const cur = out.get(r.metric) ?? { single: 0, batch: 0 };
        const n = Number(r._sum.count ?? 0);
        if (r.unit === REVALUATION_TRY_UNITS.single) cur.single += n;
        else if (r.unit === REVALUATION_TRY_UNITS.batch) cur.batch += n;
        else if (r.unit === REVALUATION_TRY_UNITS.dry_single) cur.single -= n; // a dry rebuild is not an attempt
        else if (r.unit === REVALUATION_TRY_UNITS.dry_batch) cur.batch -= n;
        out.set(r.metric, cur);
      }
      for (const [k, c] of out) out.set(k, { single: Math.max(0, c.single), batch: Math.max(0, c.batch) });
      return out;
    },
    async markAttempt(key, kind) {
      const { recordApiUsage } = await import("@/lib/usage/record");
      await recordApiUsage(REVALUATION_ATTEMPT_PROVIDER, key, REVALUATION_TRY_UNITS[kind], 1);
    },
    async markUnavailable(accountId, fromISO, toISO) {
      // The binding's METADATA-ONLY stamp (regenerate-history.ts metadataOnlyStamps):
      // ONE column, estimate rows only (a frozen/observed row is never touched),
      // no financial field — the stored estimate VALUES are preserved. Rows that
      // claim completeness (`supported`) AND rows asserting none (NULL, read as
      // `none`) qualify; both are restored by a real recompute (planDayPersistence
      // stamp / clearStamp). Per Space, days a membership change blocks are
      // EXCLUDED: the rebuild skips them (no authority), so nothing would restore them.
      //
      // BY DESIGN (review of #183, P3): if the holder is later UNLINKED from a
      // Space, the stamps it left there stay `unavailable`. That is accurate —
      // those stored values omitted a holder that was a member on those days —
      // and the automatic path has no authority over a membership-changed day;
      // only an explicit amendment (Phase 2) may revise and clear them.
      const { loadRevokedLinkWindows } = await import("@/lib/snapshots/regenerate-history");
      const { membershipChangedOn } = await import("@/lib/snapshots/regenerate-history.core");
      const links = await client.spaceAccountLink.findMany({ where: { financialAccountId: accountId, status: "ACTIVE" }, select: { spaceId: true } });
      let count = 0;
      for (const spaceId of [...new Set(links.map((l) => l.spaceId))]) {
        const windows = await loadRevokedLinkWindows(client as Parameters<typeof loadRevokedLinkWindows>[0], spaceId, new Date());
        for (const r of unblockedRanges(fromISO, toISO, (d) => membershipChangedOn(windows, d))) {
          const u = await client.spaceSnapshot.updateMany({
            where: {
              spaceId, isEstimated: true,
              date: { gte: new Date(`${r.fromISO}T00:00:00.000Z`), lte: new Date(`${r.toISO}T00:00:00.000Z`) },
              OR: [{ cryptoValuationStatus: null }, { cryptoValuationStatus: { not: "unavailable" } }],
            },
            data: { cryptoValuationStatus: "unavailable" },
          });
          count += u.count;
        }
      }
      return count;
    },
    writesEnabled: () => process.env.WEALTH_REGENERATION_ENABLED === "true", // = wealthRegenerationEnabled() (no static import of the binding)
    async regenerate(accountId, fromISO, toISO) {
      const { resolveHistoricalWorkWindow } = await import("@/lib/snapshots/historical-work-window");
      const { regenerateWealthHistoryForAccounts, wealthRegenerationEnabled } = await import("@/lib/snapshots/regenerate-history");
      // The binding writes only under this switch (applyWrites): a rebuild now would be a dry run.
      if (!wealthRegenerationEnabled()) return false;
      // The canonical planner, told the batch start as floor and impacted-from
      // (the V26-CAP-1 override) — still intersected with the evidence floor and
      // the writable ceiling — then clamped to the batch. A floor below the
      // archive's is safe: an unpriced day is refused by the day rule (stored
      // value preserved, verdict `unavailable`), never written as $0.
      const plan = await resolveHistoricalWorkWindow({
        financialAccountIds: [accountId], initialBuild: false,
        capabilityOverride: { blockingPriceFloorISO: fromISO, impactedFromISO: fromISO },
      });
      const from = plan.fromDate > fromISO ? plan.fromDate : fromISO;
      const to = plan.toDate < toISO ? plan.toDate : toISO;
      if (from > to) return;
      await regenerateWealthHistoryForAccounts([accountId], { fromDate: from, toDate: to });
    },
    now: Date.now,
  };
}

/** Production deps over `client`, acquiring through the canonical backfill. */
export function prismaPriceGapDeps(client: Client, opts: { registry?: PriceRegistry; log?: (line: string) => void } = {}): PriceGapDeps {
  const registry = async (): Promise<PriceRegistry> => opts.registry ?? (await import("./registry")).defaultPriceRegistry();
  return {
    licences: (ids) => cryptoHolderLicences(client, ids),
    async priceFacts(ids) {
      const [earliest, instruments, reg] = await Promise.all([
        earliestRawCloseByInstrument(client, ids),
        client.instrument.findMany({
          where: { id: { in: [...ids] } },
          select: { id: true, assetClass: true, tickerSymbol: true, marketIdentifierCode: true, currency: true },
        }),
        registry(),
      ]);
      const out = new Map<string, InstrumentPriceFacts>();
      for (const i of instruments) {
        const meta = { instrumentId: i.id, assetClass: String(i.assetClass), tickerSymbol: i.tickerSymbol, marketIdentifierCode: i.marketIdentifierCode, currency: i.currency };
        const res = resolveProviderForInstrument(reg, routingKeyFor(meta, PriceBasis.RAW_CLOSE));
        out.set(i.id, {
          instrumentId: i.id,
          earliestRawCloseISO: earliest.get(i.id) ?? null,
          provider: res.kind === "provider" ? { kind: "provider", source: res.adapter.source, floorISO: res.adapter.historicalDepth } : { kind: "none" },
        });
      }
      return out;
    },
    async attemptedOn(keys, dayISO) {
      const rows = await client.apiUsageCounter.findMany({
        where: { provider: PRICE_GAP_ATTEMPT_PROVIDER, unit: PRICE_GAP_ATTEMPT_UNIT, day: new Date(`${dayISO}T00:00:00.000Z`), metric: { in: [...keys] } },
        select: { metric: true },
      });
      return new Set(rows.map((r) => r.metric));
    },
    async markAttempted(key) {
      const { recordApiUsage } = await import("@/lib/usage/record");
      await recordApiUsage(PRICE_GAP_ATTEMPT_PROVIDER, key, PRICE_GAP_ATTEMPT_UNIT, 1);
    },
    async acquire(instrumentId, fromISO, toISO) {
      const { backfillPricesForInstruments } = await import("./backfill");
      const r = await backfillPricesForInstruments([instrumentId], {
        apply: true, forceWindow: { fromISO, toISO }, registry: await registry(), onProgress: opts.log,
      });
      const outcomes = Object.entries(r.outcomes).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(",");
      return { inserted: r.inserted, detail: `${r.inserted} row(s) written, outcomes ${outcomes || "none"}` };
    },
  };
}
