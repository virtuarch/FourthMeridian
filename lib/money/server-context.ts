/**
 * lib/money/server-context.ts
 *
 * MC1 Phase 3 Slice 2 — the SERVER-ONLY conversion-context factory (plan D-5).
 *
 * This is deliberately the one and only module that binds the Prisma-backed
 * FxRate archive (`lib/fx/archive` → `lib/db`) into Phase 2's pure
 * `buildConversionContext`. Everything else in lib/money stays client-safe:
 * client surfaces receive a SerializedConversionContext prop (convert.ts,
 * plan D-6) and never import this file. Importing this module from a client
 * component would pull PrismaClient into the browser bundle — do not.
 *
 * Lifecycle (plan D-5): build per request/invocation, where the data is
 * fetched (route / assembler / snapshot writer). No cross-request cache — the
 * archive is immutable and the prefetch is one indexed query per distinct
 * (currency × date) pair, so rebuilds are cheap and always consistent.
 *
 * NOTE (Slice 2): no product code calls this yet — the identityContext seams
 * are untouched. The flip slices (3–6) adopt it one family at a time.
 */

import { db } from "@/lib/db";
import { fxArchive } from "@/lib/fx/archive";
import { FX_BASE } from "@/lib/fx/config";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { buildConversionContext } from "./context";
import { decideEffectiveCurrency, fxCoverageOf, identityContext, serializeContext, type SerializedConversionContext } from "./convert";
import { revalidateFxIfStale, shouldTrigger, type FxFreshnessGate } from "./fx-freshness";
import type { ConversionContext } from "./types";

export interface SpaceConversionOptions {
  /** Native currencies the caller will convert (nulls and the target are skipped). */
  currencies: readonly (string | null)[];
  /** Valuation dates the caller will use (live = yesterday UTC; rollups = per-row dates; plan D-6 of Phase 2). */
  dates:      readonly string[];
}

// ── Opportunistic FX stale-while-revalidate (free-tier cron compensation) ────
// The scheduled fetch-fx-rates job stays authoritative for cron-capable
// environments (lib/jobs/registry.ts). On the Vercel Hobby tier the single
// daily cron may not reach the 06:30 FX slot, so we additionally kick a
// best-effort background refresh when a conversion is requested against a stale
// archive. See lib/money/fx-freshness.ts for the (pure, injectable) policy.

/** At most one background refresh per window, no matter the request volume. */
const FX_REFRESH_MIN_INTERVAL_MS = 30 * 60 * 1000;
let fxLastRefreshAtMs = 0;
let fxRefreshInFlight = false;

/**
 * Throttled, non-blocking background refresh. Never awaited by any request;
 * never throws into the caller. The job body is dynamic-imported so its
 * provider-env validation stays off this module's load path (mirrors the
 * dynamic imports in lib/jobs/registry.ts).
 */
function triggerBackgroundFxRefresh(): void {
  if (fxRefreshInFlight) return;
  const { fire, lastAtMs } = shouldTrigger(fxLastRefreshAtMs, Date.now(), FX_REFRESH_MIN_INTERVAL_MS);
  if (!fire) return;
  fxLastRefreshAtMs = lastAtMs;
  fxRefreshInFlight = true;
  void (async () => {
    try {
      const { fetchFxRates } = await import("@/jobs/fetch-fx-rates");
      await fetchFxRates();
    } catch (err) {
      console.warn("[fx-swr] opportunistic refresh failed (best-effort):", err);
    } finally {
      fxRefreshInFlight = false;
    }
  })();
}

/** Prisma-backed freshness probes + the throttled trigger. */
const dbFxFreshnessGate: FxFreshnessGate = {
  async hasFreshDay(freshISO) {
    const row = await db.fxRate.findFirst({
      where:  { base: FX_BASE, date: new Date(`${freshISO}T00:00:00Z`) },
      select: { quote: true },
    });
    return row !== null;
  },
  async hasAnyCached() {
    const row = await db.fxRate.findFirst({ select: { quote: true } });
    return row !== null;
  },
  triggerRefresh: triggerBackgroundFxRefresh,
};

/**
 * Fire-and-forget freshness check for a conversion request. Only runs when the
 * request actually needs cross-currency conversion (a native leg other than the
 * target). Never awaited and fully self-contained on error, so it cannot slow
 * or break the conversion it accompanies.
 */
function maybeRevalidateFx(target: string, currencies: readonly (string | null)[]): void {
  const needsConversion = currencies.some((c) => c != null && c !== target);
  if (!needsConversion) return;
  void revalidateFxIfStale(dbFxFreshnessGate).catch((err) => {
    console.warn("[fx-swr] staleness check skipped (best-effort):", err);
  });
}

/**
 * Build the authoritative conversion context for a Space (target = the
 * Space's reporting currency, plan D-1). The caller supplies the Space row
 * (or any object carrying `reportingCurrency`) — this module performs no
 * Space reads itself.
 */
export async function buildSpaceConversionContext(
  space: { reportingCurrency: string },
  opts: SpaceConversionOptions,
): Promise<ConversionContext> {
  // Serve-stale: build from the archive as it is NOW; the freshness check
  // (background, best-effort) never blocks or alters this result.
  maybeRevalidateFx(space.reportingCurrency, opts.currencies);
  return buildConversionContext(
    { target: space.reportingCurrency, currencies: opts.currencies, dates: opts.dates },
    fxArchive,
  );
}

/**
 * Convenience for callers that hold only a spaceId (MC1 Phase 3 Slice 5 —
 * added for the liquidity lens adapter, whose test tripwires forbid it from
 * importing @/lib/db directly; this module is the designated server-only
 * db-adjacent seam). Reads the Space's reportingCurrency and delegates;
 * degrades to the identity context (target = DEFAULT_DISPLAY_CURRENCY) if
 * the Space row vanished mid-request — the same defensive fallback the
 * assembler seams use.
 */
export async function buildSpaceConversionContextById(
  spaceId: string,
  opts: SpaceConversionOptions,
): Promise<ConversionContext> {
  const space = await db.space.findUnique({
    where:  { id: spaceId },
    select: { reportingCurrency: true },
  });
  if (!space) return identityContext(DEFAULT_DISPLAY_CURRENCY);
  return buildSpaceConversionContext(space, opts);
}

// ── V25-CLOSE-3A — reporting-currency failure contract (the ONE canonical path) ──
//
// INVARIANT: a reporting currency is never DISPLAYED as active unless the archive
// can actually satisfy the conversion. When it cannot (every needed pair misses),
// the DISPLAY reverts to USD — the stored Space.reportingCurrency is untouched.
//
// This is the single decision point the display readers share (view-context,
// transactions summary, snapshot reader). It reuses buildSpaceConversionContext +
// fxCoverageOf — NO new FX math, no provider change, no writer change. Writers
// (snapshot regenerate/backfill) keep calling buildSpaceConversionContext directly
// and stay on the intended currency; only DISPLAY reads resolve the effective one.

/** The outcome of resolving a Space's EFFECTIVE display currency (may differ from requested). */
export interface EffectiveSpaceConversion {
  /** What the Space asked to display in (its stored reportingCurrency, or a "view as" target). */
  requested: string;
  /** What the display will ACTUALLY use — requested, or USD when requested is unsatisfiable. */
  effective: string;
  /** True when the display fell back to USD because requested could not be satisfied. */
  reverted:  boolean;
  /** The context for `effective` — safe to serialize/consume; conversions in it resolve. */
  ctx:       ConversionContext;
}

/**
 * Resolve the effective display currency for a Space. Builds the requested
 * context, reads its coverage verdict, and — only when the requested target is
 * wholly unsatisfiable — rebuilds against USD and reports `reverted: true`. USD
 * is the guaranteed floor (base currency; identity for USD-denominated data).
 */
export async function resolveEffectiveSpaceConversion(
  space: { reportingCurrency: string },
  opts: SpaceConversionOptions,
): Promise<EffectiveSpaceConversion> {
  const requested = space.reportingCurrency;
  const ctx = await buildSpaceConversionContext(space, opts);
  const coverage = fxCoverageOf(serializeContext(ctx, opts.currencies, opts.dates));
  const decision = decideEffectiveCurrency(requested, coverage, DEFAULT_DISPLAY_CURRENCY);
  if (!decision.reverted) {
    return { requested, effective: decision.effective, reverted: false, ctx };
  }
  // Fallback: display in USD. Do NOT persist — this is a read-time resolution.
  const usdCtx = await buildSpaceConversionContext(
    { reportingCurrency: decision.effective },
    opts,
  );
  return { requested, effective: decision.effective, reverted: true, ctx: usdCtx };
}

/** Serialized form of {@link resolveEffectiveSpaceConversion} for transport to the client. */
export async function resolveEffectiveSpaceConversionSerialized(
  space: { reportingCurrency: string },
  opts: SpaceConversionOptions,
): Promise<{ requested: string; effective: string; reverted: boolean; moneyCtx: SerializedConversionContext }> {
  const r = await resolveEffectiveSpaceConversion(space, opts);
  return {
    requested: r.requested,
    effective: r.effective,
    reverted:  r.reverted,
    moneyCtx:  serializeContext(r.ctx, opts.currencies, opts.dates),
  };
}

/**
 * MC1 Phase 3 Slice 6 (F-1, approved D-6) — build AND materialize a Space's
 * conversion context for transport to client components as a plain-JSON prop.
 * Client surfaces rehydrate it with rehydrateContext() (lib/money/convert,
 * client-safe) and pass it to their existing classify/rollup calls. All-USD
 * Spaces serialize an EMPTY entry table (identity never calls resolve()), so
 * the prop is a few bytes and the client math is provably identical.
 */
export async function serializeSpaceConversionContext(
  space: { reportingCurrency: string },
  opts: SpaceConversionOptions,
): Promise<SerializedConversionContext> {
  const ctx = await buildSpaceConversionContext(space, opts);
  return serializeContext(ctx, opts.currencies, opts.dates);
}
