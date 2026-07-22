/**
 * lib/money/convert.ts
 *
 * MC1 Phase 2 Slice 1 — the pure conversion engine (plan §3.2).
 *
 * Doctrine (approved):
 *   - READ-TIME ONLY, ZERO MUTATION: pure functions over values — this module
 *     imports no database, no network, no fx service (types only). Stored
 *     financial facts are never touched.
 *   - NEVER THROW on data conditions (plan D-3): a missing rate never throws.
 *   - FX HONESTY (V25-FINAL-1, supersedes D-3's "never exclude" for the
 *     KNOWN-foreign miss): a KNOWN foreign currency with no acceptable rate is
 *     UNAVAILABLE. It must not be relabeled as the target — "¥1,000,000" must
 *     never surface (or sum) as "$1,000,000 estimated". So convertMoney returns
 *     `amount: 0` (contributes nothing to any target total — exclusion by
 *     construction) with the untouched native value on `native` for honest
 *     display, and `estimated: true` / `conversion: null` so it reads as
 *     "unavailable". Null-residue (currency unknown) is NOT a false unit —
 *     nothing to mislabel — so it keeps the legacy assume-target passthrough.
 *   - NO ROUNDING (plan D-4): full f64 precision end to end; display rounding
 *     belongs to the existing formatting boundary (lib/currency.ts /
 *     lib/format.ts). This module never formats (plan D-5).
 *   - CONVERT-THEN-SUM (plan D-8): each row converts at its OWN valuation
 *     date (plan D-6 — historical FX per row), then sums; any estimated
 *     member taints the aggregate.
 *   - Date validity is the resolver's concern; the identity and pass-through
 *     branches never inspect the date, keeping this module dependency-free.
 *
 * In Phase 2 every context is identityContext(DEFAULT_DISPLAY_CURRENCY), so
 * every call takes the identity or pass-through branches — byte-identical
 * arithmetic to today. Real-rate contexts arrive in Slice 2 (server-side
 * prefetch) and are consumed in anger by Phase 3.
 */

import type { Resolution } from "@/lib/fx/types";
import type { ConversionContext, ConvertedMoney, ConvertedTotal, DatedMoney, FxDisclosure, Money } from "./types";

/**
 * Classify one converted value's honesty (V25-CLOSE-3). PURE — derived entirely
 * from the fields convertMoney already sets, so it introduces NO new FX authority
 * and no math. The distinction it recovers is the one the single `estimated`
 * boolean loses:
 *   - not estimated                     → "exact"      (identity / exact rate)
 *   - estimated AND a rate was applied  → "estimated"  (walked-back / stale)
 *   - estimated AND conversion === null → "unavailable" (no rate applied:
 *                                         a known-currency miss — `amount` is 0
 *                                         and the truth is on `native`; or a
 *                                         null-residue assume-target passthrough)
 */
export function fxDisclosureOf(c: ConvertedMoney): FxDisclosure {
  if (c.amount === null) return "unavailable"; // no valid target-currency value (known-currency miss)
  if (!c.estimated) return "exact";
  return "estimated"; // real rate walked back, OR null-residue assume-target passthrough
}

/**
 * The rate-free context (plan D-2): identity for the target currency,
 * RateMiss for everything else (⇒ native pass-through + `estimated`, per
 * D-3). Synchronous, allocation-cheap, safe in client components — the
 * entire Phase 2 era runs on this.
 */
export function identityContext(target: string): ConversionContext {
  return {
    target,
    resolve: (from, dateISO) => ({ kind: "miss", quote: from, requestedDateISO: dateISO }),
  };
}

/** Convert one monetary fact into the context target as of `dateISO`. Pure; never throws on data. */
export function convertMoney(money: Money, dateISO: string, ctx: ConversionContext): ConvertedMoney {
  // Null-residue (Phase 0 doctrine): denomination never recorded → treat as
  // target, flag estimated. Arithmetic identical to today, provenance-honest.
  if (money.currency == null) {
    return { amount: money.amount, currency: ctx.target, estimated: true, conversion: null };
  }

  // Identity fast path — no resolver call, no metadata, not estimated.
  if (money.currency === ctx.target) {
    return { amount: money.amount, currency: ctx.target, estimated: false, conversion: null };
  }

  const res = ctx.resolve(money.currency, dateISO);

  // RateMiss on a KNOWN foreign currency → UNAVAILABLE (V25-FINAL-1). The native
  // magnitude must NOT be relabeled as the target, and must NOT masquerade as a
  // real zero: `amount` is `null` (there is NO valid target-currency value), and
  // the true value rides on `native` for honest display / evidence. `estimated`
  // stays true and `conversion` null so existing taint checks keep firing.
  if (res.kind === "miss") {
    return {
      amount:     null,
      currency:   ctx.target,
      estimated:  true,
      conversion: null,
      native:     { amount: money.amount, currency: money.currency },
    };
  }

  // The applied rate's true data vintage is the OLDER of the two cross-rate
  // legs (the binding constraint when either leg was walked back).
  const { from: effFrom, to: effTo } = res.effectiveDates;
  const effectiveDateISO = effFrom < effTo ? effFrom : effTo;

  return {
    amount:    money.amount * res.rate, // full precision — no rounding (D-4)
    currency:  ctx.target,
    estimated: res.staleness === "walked-back",
    conversion: {
      rate: res.rate,
      from: money.currency,
      effectiveDateISO,
      staleness: res.staleness,
    },
  };
}

/**
 * Convert-then-sum (plan D-8): convert each row at its own valuation date,
 * then accumulate in the target currency. `estimated` on the total is the OR
 * of the members (taint propagation) — an aggregate is only exact when every
 * member converted exactly.
 *
 * V25-FINAL-1 — an UNAVAILABLE member (known foreign currency, no rate) now
 * contributes `amount: 0`, so its native magnitude can never inflate the total;
 * `excluded` counts how many were dropped this way, so the caller can disclose
 * that the total is a partial sum over the convertible members.
 */
export function convertAndSum(items: readonly DatedMoney[], ctx: ConversionContext): ConvertedTotal {
  let amount = 0;
  let estimated = false;
  let unconverted = false;
  let excluded = 0;
  for (const it of items) {
    const c = convertMoney(it.money, it.dateISO, ctx);
    // An unavailable member has NO target-currency value: it is EXCLUDED from the
    // partial total (never its native magnitude, never a fake 0) and counted so
    // the caller can disclose the total is incomplete.
    if (c.amount === null) {
      unconverted = true;
      excluded += 1;
      estimated = true; // an incomplete total is at best an estimate
      continue;
    }
    amount += c.amount;
    estimated = estimated || c.estimated;
  }
  return { amount, currency: ctx.target, estimated, unconverted, excluded };
}

// ─── Serialization (MC1 Phase 3 Slice 2, plan D-6) ────────────────────────────
// Client surfaces cannot call the rate service (Phase 2 finding §1.1). Server
// pages build a real context, materialize it into a plain JSON payload, and
// pass it as a prop; the client rehydrates a behaviorally identical context
// with this pure, dependency-free pair. All-USD Spaces serialize an EMPTY
// entry table (identity/pass-through branches never call resolve()).

/** Plain-JSON form of a ConversionContext: the target plus materialized resolutions. */
export interface SerializedConversionContext {
  target:  string;
  entries: Record<string, Resolution>; // key: "from|dateISO"
}

const entryKey = (from: string, dateISO: string): string => `${from}|${dateISO}`;

/**
 * Materialize a context for transport. `currencies`/`dates` enumerate the
 * pairs the client will need (same inputs the server used to build the
 * context); the target itself and nulls are skipped — identity and
 * null-residue never reach resolve(), so an all-USD Space with target USD
 * produces `entries: {}`. Deterministic: same context + same pair lists ⇒
 * byte-identical payload (key order follows the input lists).
 */
export function serializeContext(
  ctx: ConversionContext,
  currencies: readonly (string | null)[],
  dates: readonly string[],
): SerializedConversionContext {
  const entries: Record<string, Resolution> = {};
  const from = [...new Set(currencies.filter((c): c is string => c != null && c !== ctx.target))];
  const uniqueDates = [...new Set(dates)];
  for (const f of from) {
    for (const d of uniqueDates) {
      entries[entryKey(f, d)] = ctx.resolve(f, d);
    }
  }
  return { target: ctx.target, entries };
}

/**
 * V25-CLOSE-3A — the coverage verdict for a whole context, read from the
 * resolution table `buildConversionContext` already produced (via its serialized
 * form). PURE; introduces NO new FX resolution — it counts the hits/misses that
 * were computed once at build time.
 *
 * `satisfiable` is the display-honesty test behind the reporting-currency
 * failure contract: a target is UNSATISFIABLE only when conversions are needed
 * AND every one of them missed (the "€100,000 that is really $100,000" case —
 * the whole display would be native amounts mislabelled as the target). Partial
 * coverage (some pairs resolved) stays satisfiable — those surfaces keep the
 * existing per-value `estimated`/`unavailable` disclosure. An all-identity /
 * all-USD context needs no conversion (`needed === 0`) and is always satisfiable.
 */
export interface FxCoverage {
  /** Distinct (non-target, non-null) currency×date pairs the Space needs converted. */
  needed:      number;
  /** How many of those resolved to a RateMiss (no rate applied). */
  missed:      number;
  /** false only when needed > 0 AND every needed pair missed. */
  satisfiable: boolean;
}

export function fxCoverageOf(s: SerializedConversionContext): FxCoverage {
  const values = Object.values(s.entries);
  const needed = values.length;
  const missed = values.filter((r) => r.kind === "miss").length;
  return { needed, missed, satisfiable: needed === 0 || missed < needed };
}

/** The requested/effective/reverted decision for a display currency. */
export interface EffectiveCurrencyDecision {
  requested: string;
  effective: string;
  reverted:  boolean;
}

/**
 * PURE decision behind the reporting-currency failure contract (V25-CLOSE-3A).
 * Kept separate from the DB-bound context build so it is unit-testable without
 * an archive: given the requested currency and its coverage verdict, decide the
 * effective display currency. Reverts to `fallback` (USD) ONLY when the request
 * is unsatisfiable AND is not already the fallback (nothing better to fall back
 * to ⇒ not a "revert"). Never persists — the caller applies it at read time.
 */
export function decideEffectiveCurrency(
  requested: string,
  coverage: FxCoverage,
  fallback: string,
): EffectiveCurrencyDecision {
  if (coverage.satisfiable || requested === fallback) {
    return { requested, effective: requested, reverted: false };
  }
  return { requested, effective: fallback, reverted: true };
}

/**
 * Rebuild a synchronous ConversionContext from its serialized form. Pure and
 * client-safe; frozen like the server-built original; unserialized pairs
 * resolve to a deterministic RateMiss (⇒ native + estimated downstream) —
 * identical semantics to an unprefetched pair on the server (plan D-6:
 * "identical behavior after rehydration").
 */
export function rehydrateContext(s: SerializedConversionContext): ConversionContext {
  const entries = s.entries;
  return Object.freeze({
    target: s.target,
    resolve(from: string, dateISO: string): Resolution {
      return entries[entryKey(from, dateISO)] ?? { kind: "miss", quote: from, requestedDateISO: dateISO };
    },
  });
}
