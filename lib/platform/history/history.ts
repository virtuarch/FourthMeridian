/**
 * lib/platform/history/history.ts  (OPS-5 S7)
 *
 * THE single Operational History authority: `getOperationalHistory`. It resolves
 * a time selection (mirroring Financial time — the SAME asOf/compareTo/window
 * contract, no second date authority), runs every registered source over the
 * window and at the as-of / compare-to points, and assembles the ONE canonical
 * OperationalHistoryResult with an honest `Completeness` (worst tier across
 * sources). It performs NO health/freshness/execution logic of its own — the
 * sources reuse the live engines. Every source is best-effort (a source failure
 * degrades to `unknown`, never fabricates or breaks the whole read).
 *
 * PURE CORE + INJECTED I/O: the real db-backed readers are built here; tests pass
 * fakes. No writes, no new tables — history is reconstructed from existing ledgers.
 */

import "server-only";
import { db } from "@/lib/db";
import { FX_BASE, SUPPORTED_QUOTES } from "@/lib/fx/config";
import { loadRecentAlertRuns } from "@/lib/alerts/run";
import type { Completeness } from "@/lib/perspective-engine/types";
import {
  OPERATIONAL_HISTORY_SOURCES,
  worstTier,
  type HistoryReaders,
  type HistoryJobRun,
  type FxCoverageRow,
  type OperationalHistorySource,
  type OperationalWindow,
} from "@/lib/platform/history/sources";
import type {
  OperationalAsOfState,
  OperationalHistoryResult,
  OperationalHistorySeries,
  OperationalTier,
} from "@/lib/platform/history/types";

/** Default trend look-back (days) when no compareTo is given. */
const DEFAULT_WINDOW_DAYS = 30;

export interface OperationalHistoryArgs {
  /** As-of endpoint (YYYY-MM-DD). Defaults to today (UTC). */
  asOf?: string;
  /** Compare-to date (YYYY-MM-DD) or null. Also the trend window's start. */
  compareTo?: string | null;
  /** Restrict to specific source ids (default: all). */
  sourceIds?: readonly string[];
}

export interface OperationalHistoryDeps {
  now?: Date;
  readers?: HistoryReaders;
  sources?: readonly OperationalHistorySource[];
}

function todayISO(now: Date): string {
  return now.toISOString().slice(0, 10);
}
function minusDaysISO(dateISO: string, days: number): string {
  return new Date(Date.parse(`${dateISO}T00:00:00.000Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

// ── Real db-backed readers (the ONLY I/O; a fake replaces this in tests) ─────────

function realReaders(now: Date): HistoryReaders {
  return {
    now,
    async jobRunsInWindow(from, to) {
      const rows = await db.jobRun.findMany({
        where: { startedAt: { gte: from, lte: to } },
        orderBy: { startedAt: "desc" },
        select: { jobName: true, startedAt: true, status: true, completedAt: true, durationMs: true, trigger: true, errorSummary: true },
      });
      return rows as HistoryJobRun[];
    },
    async jobRunsAsOf(jobName, asOf, take) {
      const rows = await db.jobRun.findMany({
        where: { jobName, startedAt: { lte: asOf } },
        orderBy: { startedAt: "desc" },
        take,
        select: { jobName: true, startedAt: true, status: true, completedAt: true, durationMs: true, trigger: true, errorSummary: true },
      });
      return rows as HistoryJobRun[];
    },
    alertRuns: (limit) => loadRecentAlertRuns(limit),
    async fxCoverageInWindow(from, to) {
      const rows = await db.fxRate.findMany({
        where: { base: FX_BASE, fetchedAt: { gte: from, lte: to } },
        select: { date: true, quote: true, fetchedAt: true },
      });
      // Group per archive date: earliest fetchedAt + count of supported quotes.
      const supported = new Set<string>(SUPPORTED_QUOTES);
      const byDate = new Map<string, { fetchedAt: Date; quotes: Set<string> }>();
      for (const r of rows) {
        const dateISO = r.date.toISOString().slice(0, 10);
        const e = byDate.get(dateISO) ?? { fetchedAt: r.fetchedAt, quotes: new Set<string>() };
        if (r.fetchedAt < e.fetchedAt) e.fetchedAt = r.fetchedAt;
        if (supported.has(r.quote)) e.quotes.add(r.quote);
        byDate.set(dateISO, e);
      }
      const out: FxCoverageRow[] = [...byDate.entries()].map(([dateISO, e]) => ({ dateISO, fetchedAt: e.fetchedAt, observedUnits: e.quotes.size }));
      out.sort((a, b) => a.fetchedAt.getTime() - b.fetchedAt.getTime());
      return out;
    },
    async fxNewestAsOf(asOf) {
      const newest = await db.fxRate.findFirst({
        where: { base: FX_BASE, date: { lte: asOf } },
        orderBy: { date: "desc" },
        select: { date: true },
      });
      if (!newest) return null;
      const onDate = await db.fxRate.findMany({ where: { base: FX_BASE, date: newest.date }, select: { quote: true } });
      const supported = new Set<string>(SUPPORTED_QUOTES);
      const observedUnits = new Set(onDate.map((r) => r.quote).filter((q) => supported.has(q))).size;
      return { dateISO: newest.date.toISOString().slice(0, 10), observedUnits };
    },
  };
}

// ── The authority ─────────────────────────────────────────────────────────────────

export async function getOperationalHistory(
  args: OperationalHistoryArgs = {},
  deps: OperationalHistoryDeps = {},
): Promise<OperationalHistoryResult> {
  const now = deps.now ?? new Date();
  const readers = deps.readers ?? realReaders(now);
  const allSources = deps.sources ?? OPERATIONAL_HISTORY_SOURCES;
  const sources = args.sourceIds ? allSources.filter((s) => args.sourceIds!.includes(s.id)) : allSources;

  const asOf = args.asOf ?? todayISO(now);
  const compareTo = args.compareTo ?? null;
  const window: OperationalWindow = { from: compareTo ?? minusDaysISO(asOf, DEFAULT_WINDOW_DAYS), to: asOf };

  // Each source, best-effort (a failure → an `unknown` state / empty series).
  const states: OperationalAsOfState[] = [];
  const compareStates: OperationalAsOfState[] = [];
  const series: OperationalHistorySeries[] = [];

  for (const source of sources) {
    states.push(await safeAsOf(source, readers, asOf));
    if (compareTo) compareStates.push(await safeAsOf(source, readers, compareTo));
    for (const s of await safeSeries(source, readers, window)) series.push(s);
  }

  const tiers: OperationalTier[] = [...states.map((s) => s.tier), ...series.map((s) => s.trust)];
  const worst = tiers.length ? worstTier(tiers) : "unknown";
  const completeness: Completeness = {
    tier: worst,
    conflict: false,
    reason:
      worst === "observed"
        ? "every operational state read directly from an append-only ledger"
        : worst === "derived"
          ? "some states reconstructed by the live engines at the as-of date (observed rows, derived verdict)"
          : "some operational history is not covered by the ledgers for this period",
  };

  return {
    asOf, compareTo, window,
    states,
    compareStates: compareTo ? compareStates : null,
    series,
    completeness,
    checkedAt: now.toISOString(),
  };
}

async function safeAsOf(source: OperationalHistorySource, readers: HistoryReaders, at: string): Promise<OperationalAsOfState> {
  try {
    return await source.readAsOf(readers, at);
  } catch (e) {
    console.warn(`[history] source "${source.id}" readAsOf failed (non-fatal):`, e);
    return { sourceId: source.id, label: source.label, at, tier: "unknown", status: "unknown", summary: "history unavailable for this source", value: null };
  }
}
async function safeSeries(source: OperationalHistorySource, readers: HistoryReaders, window: OperationalWindow): Promise<OperationalHistorySeries[]> {
  try {
    return await source.readSeries(readers, window);
  } catch (e) {
    console.warn(`[history] source "${source.id}" readSeries failed (non-fatal):`, e);
    return [];
  }
}
