/**
 * jobs/fetch-fx-rates.ts
 *
 * MC1 Phase 1 Slice 4 — daily FX rate fetch job body. Invoked by the Vercel
 * Cron route (app/api/jobs/fetch-fx-rates/route.ts), and callable manually
 * (same body the backfill script exercises per-date, minus range logic).
 *
 * Behavior (plan §3.4):
 *   - Target = the previous closed UTC day (the newest date the append-only
 *     archive accepts; plan D4/D8).
 *   - Fetch ONLY the quotes still missing for that date — a re-run (or a day
 *     already topped up by the backfill) is a network-free no-op.
 *   - One pass through the provider failover chain (plan D2) — no retries
 *     beyond failover; the next day's run and the backfill script are the
 *     self-healing mechanisms for a fully-failed day.
 *   - BETA LIFECYCLE L2: the GLOBAL cost freeze refuses the run first
 *     (summary outcome SKIPPED). An unfrozen run then re-checks the previous
 *     FX_CATCH_UP_DAYS closed days for missing quotes (bounded catch-up), so a
 *     frozen week is recovered automatically; older gaps need the backfill script.
 *   - All writes via fxArchive.writeBatch (insert-only, skipDuplicates,
 *     closed-dates-only). No conversion, no consumers.
 */

import { db } from "@/lib/db";
import { fxArchive } from "@/lib/fx/archive";
import { fetchDay } from "@/lib/fx/fetch";
import { createFxRegistry, defaultFxRegistry } from "@/lib/fx/registry";
import { createFrankfurterAdapter, FRANKFURTER_SOURCE } from "@/lib/fx/providers/frankfurter";
import type { FxRegistry } from "@/lib/fx/types";
import { SUPPORTED_QUOTES, toISODateUTC, yesterdayUTCISO } from "@/lib/fx/config";
import { todayUTCISO } from "@/lib/time/clock";
import { readGlobalCostFreeze, type GlobalCostFreezeReader } from "@/lib/platform/cost-freeze";
import { billableSkipCode, type BillableSkipCode } from "@/lib/entitlements/billable-gate-core";

export interface FetchFxRatesResult {
  dateISO:        string;
  /** Winning provider, "none" (all providers failed / no banking data), or "skipped" (already covered). */
  source:         string;
  missingBefore:  number;
  inserted:       number;
  /** Per-adapter notes from the failover walk (empty when skipped). */
  notes:          string[];
  /**
   * BETA LIFECYCLE L2 — the billable skip code when the GLOBAL cost freeze (or
   * an unreadable flag) refused the run. `source` is "skipped"; nothing is
   * written. Cached rates stay readable.
   */
  billableRestricted?: BillableSkipCode;
  /**
   * BETA LIFECYCLE L2 — the JobRun summary convention (lib/jobs/health.ts):
   * "SKIPPED" when refused (job health shows the run as `skipped`, never a
   * success), "COMPLETE" otherwise.
   */
  outcome: "COMPLETE" | "SKIPPED";
  skipReason?: BillableSkipCode;
  /**
   * BETA LIFECYCLE L2 — earlier closed days (≤ FX_CATCH_UP_DAYS back) that were
   * still missing quotes and were filled by this run: a day skipped while
   * frozen is recovered by the first unfrozen run, bounded.
   */
  caughtUp: { dateISO: string; inserted: number }[];
  /** BETA LIFECYCLE L2 — set when a frozen run used the allowlisted FREE provider (once per day). */
  freeExemption?: { source: string; inserted: number };
}

/** BETA LIFECYCLE L2 — how many closed days before yesterday a run re-checks for missing quotes (bounded catch-up). */
export const FX_CATCH_UP_DAYS = 7;

/**
 * BETA LIFECYCLE L2 — THE ONE ALLOWLISTED FREE-PROVIDER EXEMPTION (owner ruling
 * 2026-10-31: a free fallback may continue during a Cost Freeze only when
 * PROVEN free, non-billable and bounded; otherwise serve the cache).
 *
 * Frankfurter (api.frankfurter.dev, lib/fx/providers/frankfurter.ts):
 *   · NO credential: `createFrankfurterAdapter()` takes no key and sends no
 *     auth header — there is no account for a charge to land on;
 *   · a PUBLIC, unauthenticated endpoint serving the ECB's published reference
 *     rates (open source; no plan, no metering, no usage-based pricing);
 *   · BOUNDED: at most ONE fetch per UTC day while frozen (claimed atomically
 *     on the shared usage ledger before the call), yesterday only — no catch-up.
 * The paid primary (Open Exchange Rates, key-metered via OXR_APP_ID) is NEVER
 * in the frozen registry, whatever the environment holds. Only a DECLARED
 * freeze (COST_FREEZE) uses the exemption; an UNREADABLE freeze flag
 * (POLICY_UNAVAILABLE) serves the cache only (fail closed).
 */
export const FREE_FX_EXEMPTION = Object.freeze({
  source: FRANKFURTER_SOURCE,
  evidence: "keyless public endpoint (ECB reference rates); no credential, no plan, no metering",
  maxFetchesPerDayWhileFrozen: 1,
});

/** The registry a frozen run may use: the allowlisted free provider ONLY (never the paid primary). */
export function freezeExemptFxRegistry(): FxRegistry {
  return createFxRegistry([createFrankfurterAdapter()]);
}

/** Usage-ledger coordinates of the once-per-day claim (ApiUsageCounter; no migration). */
export const FREE_FX_EXEMPTION_LEDGER = { provider: "FRANKFURTER", metric: "freeze-exemption", unit: "calls" } as const;

/**
 * Claim today's single frozen-period fetch: an atomic increment, allowed only
 * when it is the FIRST today. Any failure ⇒ not claimed (serve the cache).
 */
async function claimFreeExemption(dayISO: string): Promise<boolean> {
  try {
    const { systemDb } = await import("@/lib/db");
    const day = new Date(`${dayISO}T00:00:00Z`);
    const row = await systemDb.apiUsageCounter.upsert({
      where:  { provider_metric_unit_day: { ...FREE_FX_EXEMPTION_LEDGER, day } },
      create: { ...FREE_FX_EXEMPTION_LEDGER, day, count: BigInt(1) },
      update: { count: { increment: BigInt(1) } },
      select: { count: true },
    });
    return Number(row.count) === 1;
  } catch (e) {
    console.warn("[fx-cron] free-provider exemption claim failed; serving the cache:", e instanceof Error ? e.message : String(e));
    return false;
  }
}

export interface FetchFxRatesDeps {
  costFreeze?: GlobalCostFreezeReader;
  /** Test seam: today's frozen-period claim (default: the ledger increment). */
  claimFreeExemption?: (dayISO: string) => Promise<boolean>;
  /** Test seam: the clock for "today" (default: now). */
  todayISO?: () => string;
}

export async function fetchFxRates(deps: FetchFxRatesDeps = {}): Promise<FetchFxRatesResult> {
  const dateISO = yesterdayUTCISO();
  const r = await fetchFxRatesFor(dateISO, deps);
  if (r.outcome === "SKIPPED") return r;
  // BETA LIFECYCLE L2 — bounded catch-up: days a freeze (or an outage) left
  // without quotes, oldest last-week first. Each is the same missing-only,
  // network-free-when-covered fetch as yesterday's.
  const caughtUp: FetchFxRatesResult["caughtUp"] = [];
  const base = Date.parse(`${dateISO}T00:00:00Z`);
  for (let back = FX_CATCH_UP_DAYS; back >= 1; back--) {
    const d = toISODateUTC(new Date(base - back * 86_400_000));
    const c = await fetchFxRatesFor(d, deps, { costFreezeChecked: true });
    if (c.inserted > 0) caughtUp.push({ dateISO: d, inserted: c.inserted });
  }
  return { ...r, caughtUp };
}

async function fetchFxRatesFor(dateISO: string, deps: FetchFxRatesDeps, opts: { costFreezeChecked?: boolean } = {}): Promise<FetchFxRatesResult> {
  if (opts.costFreezeChecked) return fetchOneDay(dateISO);

  // BETA LIFECYCLE L2 — before the archive read and any vendor call (Open
  // Exchange Rates is key-metered; the free fallback is blocked too: default
  // to blocking, owner ruling 2026-10-31).
  const freeze = await (deps.costFreeze ?? readGlobalCostFreeze)();
  if (freeze.frozen) {
    const code = billableSkipCode(freeze.reason!);
    // THE ALLOWLISTED FREE EXEMPTION — a DECLARED freeze only; once per day; free provider only.
    if (freeze.reason === "COST_FREEZE") {
      const today = (deps.todayISO ?? (() => todayUTCISO()))();
      if (await (deps.claimFreeExemption ?? claimFreeExemption)(today)) {
        const r = await fetchOneDay(dateISO, freezeExemptFxRegistry());
        console.log(`[fx-cron] ${dateISO}: cost freeze — paid FX SKIPPED (${code}); free exemption (${FREE_FX_EXEMPTION.source}) stored ${r.inserted} row(s).`);
        return { ...r, billableRestricted: code, outcome: "SKIPPED", skipReason: code, freeExemption: { source: FREE_FX_EXEMPTION.source, inserted: r.inserted } };
      }
    }
    console.log(`[fx-cron] ${dateISO}: global cost freeze (${freeze.state}) — SKIPPED (${code}); no vendor call, nothing written. ` +
      `The first unfrozen run re-checks the last ${FX_CATCH_UP_DAYS} days; older gaps need scripts/backfill-fx-rates.ts.`);
    return { dateISO, source: "skipped", missingBefore: 0, inserted: 0, notes: [], billableRestricted: code, outcome: "SKIPPED", skipReason: code, caughtUp: [] };
  }
  return fetchOneDay(dateISO);
}

async function fetchOneDay(dateISO: string, registry: FxRegistry = defaultFxRegistry()): Promise<FetchFxRatesResult> {

  const existing = await db.fxRate.findMany({
    where:  { base: "USD", date: new Date(`${dateISO}T00:00:00Z`) },
    select: { quote: true },
  });
  const have = new Set(existing.map((r) => r.quote));
  const missing = SUPPORTED_QUOTES.filter((q) => !have.has(q));

  if (missing.length === 0) {
    console.log(`[fx-cron] ${dateISO}: fully covered (${have.size} quotes) — no fetch needed`);
    return { dateISO, source: "skipped", missingBefore: 0, inserted: 0, notes: [], outcome: "COMPLETE", caughtUp: [] };
  }

  const day = await fetchDay(dateISO, registry, missing);

  if (day.source === null) {
    // No retry beyond the failover chain — tomorrow's run / the backfill
    // script self-heal the gap (append-only archive, skip-if-present).
    console.warn(`[fx-cron] ${dateISO}: no provider produced data — ${day.notes.join(" | ")}`);
    return { dateISO, source: "none", missingBefore: missing.length, inserted: 0, notes: day.notes, outcome: "COMPLETE", caughtUp: [] };
  }

  const res = await fxArchive.writeBatch(day.source, day.rates);
  console.log(
    `[fx-cron] ${toISODateUTC(new Date(`${dateISO}T00:00:00Z`))}: stored ${res.inserted}/${res.attempted} row(s) ` +
    `from ${day.source} (${missing.length} quote(s) were missing)`,
  );
  return { dateISO, source: day.source, missingBefore: missing.length, inserted: res.inserted, notes: day.notes, outcome: "COMPLETE", caughtUp: [] };
}
