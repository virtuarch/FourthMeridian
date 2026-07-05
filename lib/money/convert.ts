/**
 * lib/money/convert.ts
 *
 * MC1 Phase 2 Slice 1 — the pure conversion engine (plan §3.2).
 *
 * Doctrine (approved):
 *   - READ-TIME ONLY, ZERO MUTATION: pure functions over values — this module
 *     imports no database, no network, no fx service (types only). Stored
 *     financial facts are never touched.
 *   - NEVER EXCLUDE, NEVER THROW on data conditions (plan D-3): a missing
 *     rate or a null-residue currency passes the NATIVE amount through with
 *     `estimated: true` — today's blended behavior made honest.
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
import type { ConversionContext, ConvertedMoney, ConvertedTotal, DatedMoney, Money } from "./types";

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

  // RateMiss → native amount, flagged (plan D-3: never exclude, never throw).
  if (res.kind === "miss") {
    return { amount: money.amount, currency: ctx.target, estimated: true, conversion: null };
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
 */
export function convertAndSum(items: readonly DatedMoney[], ctx: ConversionContext): ConvertedTotal {
  let amount = 0;
  let estimated = false;
  for (const it of items) {
    const c = convertMoney(it.money, it.dateISO, ctx);
    amount += c.amount;
    estimated = estimated || c.estimated;
  }
  return { amount, currency: ctx.target, estimated };
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
