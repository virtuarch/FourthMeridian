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
  holderRevaluationFor, revaluationBlocks, planRevaluationBatch, REVALUATION_RESERVE_MS,
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
    const out: HolderRevaluation[] = [];
    for (const accountId of accounts) {
      const h = holderRevaluationFor({
        accountId, nativeLicences: byAccount(native, accountId), allLicences: byAccount(all, accountId), floors, snapshotMinBySpace,
        spaceIds: links.filter((l) => l.financialAccountId === accountId).map((l) => l.spaceId),
      });
      if (h) out.push(h);
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
  /** Rebuild attempts recorded per block key (any day). Optional: absent ⇒ no attempt cap. */
  attemptsOf?(keys: readonly string[]): Promise<Map<string, number>>;
  /** Count one rebuild attempt of a block — BEFORE the rebuild, so a killed run still counts. */
  markAttempt?(key: string): Promise<void>;
  /** Regenerate one account's wealth history over [fromISO, toISO] — existing rows included. */
  regenerate(accountId: string, fromISO: string, toISO: string): Promise<void>;
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
  /** Blocks abandoned after REVALUATION_MAX_ATTEMPTS failed rebuilds (until the evidence changes). */
  abandonedBlocks: number;
  failures: number;
  /** The gap pass itself was skipped: too little wake time left. */
  skippedForTime: boolean;
}

/** Each holder's blocks still owed: not done, and not abandoned at the attempt cap. */
async function owedBlocks(deps: Pick<RevaluationDeps, "revaluedAlready" | "attemptsOf">, holders: HolderRevaluation[], todayISO: string) {
  const plans = holders.map((h) => ({ h, blocks: revaluationBlocks(h.evidenceKey, h.windowFromISO, todayISO) }));
  const keys = plans.flatMap((p) => p.blocks.map((b) => b.key));
  const done = keys.length > 0 ? await deps.revaluedAlready(keys) : new Set<string>();
  const notDone = keys.filter((k) => !done.has(k));
  const tries = deps.attemptsOf && notDone.length > 0 ? await deps.attemptsOf(notDone) : new Map<string, number>();
  return plans.map((p) => {
    const open = p.blocks.filter((b) => !done.has(b.key));
    const live = open.filter((b) => (tries.get(b.key) ?? 0) < REVALUATION_MAX_ATTEMPTS);
    return { h: p.h, live, abandoned: open.length - live.length, tries };
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
  /** First batch's cost estimate (default REVALUATION_DEFAULT_MS_PER_DAY); later batches use what this run measured. */
  msPerDay?: number;
  log?: (line: string) => void;
}): Promise<RevaluationRun> {
  const run: RevaluationRun = { priceGaps: null, owed: 0, revalued: 0, chunksRebuilt: 0, deferred: 0, alreadyRevalued: 0, abandonedBlocks: 0, failures: 0, skippedForTime: false };
  const log = args.log ?? (() => {});
  const cap = Math.max(0, Math.floor(args.maxAccounts ?? DEFAULT_REVALUATION_MAX_ACCOUNTS));
  const left = () => args.deadlineMs - args.deps.now();
  const todayISO = args.todayISO ?? minusDaysISO(yesterdayUTCISO(), -1);
  let msPerDay = Math.max(1, args.msPerDay ?? REVALUATION_DEFAULT_MS_PER_DAY);
  if (args.accountIds.length === 0) return run;
  if (left() < REVALUATION_RESERVE_MS) { run.skippedForTime = true; return run; }
  try {
    run.priceGaps = await args.deps.acquireGaps(args.accountIds);
    const holders = (await args.deps.owed(args.accountIds)).sort((a, b) => a.accountId.localeCompare(b.accountId));
    if (holders.length === 0) return run;
    let started = 0;
    for (const { h, live, abandoned } of await owedBlocks(args.deps, holders, todayISO)) {
      run.abandonedBlocks += abandoned;
      if (live.length === 0) { run.alreadyRevalued++; continue; }
      run.owed++;
      if (started >= cap || left() < REVALUATION_RESERVE_MS) { run.deferred++; continue; }
      started++;
      let failed = false;
      let queue = live;
      while (queue.length > 0) {
        if (left() < REVALUATION_RESERVE_MS) break;
        const maxDays = Math.floor((left() - REVALUATION_BATCH_MARGIN_MS) / msPerDay);
        const batch = planRevaluationBatch(queue, maxDays)!;
        queue = queue.filter((b) => !batch.blocks.includes(b));
        for (const b of batch.blocks) await args.deps.markAttempt?.(b.key).catch(() => {});
        const t0 = args.deps.now();
        try {
          await args.deps.regenerate(h.accountId, batch.fromISO, batch.toISO);
          // DONE only now: a rebuild that never returned (killed) leaves its blocks owed.
          for (const b of batch.blocks) await args.deps.markRevalued(b.key).catch(() => {});
          run.chunksRebuilt += batch.blocks.length;
          const days = Math.round((Date.parse(batch.toISO) - Date.parse(batch.fromISO)) / 86_400_000) + 1;
          msPerDay = Math.max(1, (args.deps.now() - t0) / days);
        } catch (e) {
          failed = true;
          log(`revaluation ${h.accountId} ${batch.fromISO}..${batch.toISO} failed (non-fatal; retried next run, at most ${REVALUATION_MAX_ATTEMPTS} attempts): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (failed) run.failures++;
      else if (queue.length > 0) run.deferred++;
      else run.revalued++;
    }
  } catch (e) {
    run.failures++;
    log(`revaluation pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
  return run;
}

/** Rebuild-attempt counter unit (beside the "done" marker unit) on the same usage table. */
export const REVALUATION_TRY_UNIT = "revaluation_tries";

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
      if (keys.length === 0) return new Map();
      const rows = await client.apiUsageCounter.groupBy({
        by: ["metric"], where: { provider: REVALUATION_ATTEMPT_PROVIDER, unit: REVALUATION_TRY_UNIT, metric: { in: [...keys] } }, _sum: { count: true },
      });
      return new Map(rows.map((r) => [r.metric, Number(r._sum.count ?? 0)]));
    },
    async markAttempt(key) {
      const { recordApiUsage } = await import("@/lib/usage/record");
      await recordApiUsage(REVALUATION_ATTEMPT_PROVIDER, key, REVALUATION_TRY_UNIT, 1);
    },
    async regenerate(accountId, fromISO, toISO) {
      const { resolveHistoricalWorkWindow } = await import("@/lib/snapshots/historical-work-window");
      const { regenerateWealthHistoryForAccounts } = await import("@/lib/snapshots/regenerate-history");
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
