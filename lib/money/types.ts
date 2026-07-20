/**
 * lib/money/types.ts
 *
 * MC1 Phase 2 Slice 1 — money domain types (plan D-1/D-2). Pure types only:
 * no Prisma, no network, no fx-service calls — the ONLY lib/fx dependency is
 * the Resolution type shape (types-only import, erased at compile time).
 * See docs/initiatives/mc1/MC1_PHASE2_READ_TIME_CONVERSION_PLAN.md.
 */

import type { Resolution } from "@/lib/fx/types";

/**
 * A native monetary fact as stored: an amount and the currency it is
 * denominated in. `currency: null` is the Phase 0 null-residue case — a
 * pre-provenance row whose denomination was never recorded (treated as the
 * target currency + `estimated` by convertMoney; plan D-3 / approved).
 */
export interface Money {
  amount:   number;
  currency: string | null;
}

/**
 * The result of converting one Money into the context's target currency.
 * `conversion: null` means no rate was applied — identity (native === target),
 * null-residue pass-through, or a RateMiss pass-through; `estimated`
 * distinguishes the honest cases (true) from clean identity (false).
 */
export interface ConvertedMoney {
  amount:    number;
  /** Always the context target — what the amount is now denominated in. */
  currency:  string;
  /** True when: rate was walked back, rate was missing, or native currency was null-residue. */
  estimated: boolean;
  conversion: null | {
    /** target-per-native rate that was applied. */
    rate:             number;
    /** The native currency the amount was converted from. */
    from:             string;
    /** The archive date the applied rate actually came from (older leg of the cross-rate). */
    effectiveDateISO: string;
    staleness:        "exact" | "walked-back";
    /** Provenance when known (not exposed by the Phase 1 resolver today; reserved). */
    source?:          string;
  };
}

/** An aggregate in the target currency. `estimated` = any member was estimated (taint propagation). */
export interface ConvertedTotal {
  amount:    number;
  currency:  string;
  estimated: boolean;
  /**
   * V25-CLOSE-3 — stronger than `estimated`. True when AT LEAST ONE member was
   * an *unconverted native pass-through* (rate missing or null-residue), i.e. its
   * amount is native units labelled as the target currency and can be wrong by
   * orders of magnitude — not merely converted with a stale rate. `unconverted`
   * implies `estimated`; surfaces render an unmistakable "FX unavailable" note
   * for it rather than the quiet "est." marker. (The per-member distinction lives
   * on ConvertedMoney via `fxDisclosureOf`; this preserves it through the fold.)
   */
  unconverted: boolean;
}

/**
 * How honest a converted value is, derived purely from a ConvertedMoney
 * (`fxDisclosureOf`). Ordered by severity:
 *   - "exact"       — identity or an exact applied rate; show as authoritative.
 *   - "estimated"   — a real rate was applied but walked back in time (stale).
 *   - "unavailable" — NO rate applied; the amount is native units shown as the
 *                     target currency (rate missing or null-residue currency).
 *                     This is the case that must be disclosed unmistakably.
 */
export type FxDisclosure = "exact" | "estimated" | "unavailable";

/**
 * The conversion seam (plan D-2, resolving roadmap open decision #3):
 * a SYNCHRONOUS resolver over pre-fetched rates, because the aggregation
 * functions it feeds (classifyAccounts, flow rollups) are pure/sync and some
 * of their callers are client components. Constructors:
 *   - identityContext(target)      — rate-free, client-safe (convert.ts, this slice)
 *   - buildConversionContext(...)  — async server-side prefetch over lib/fx (Slice 2)
 */
export interface ConversionContext {
  /** The currency every conversion in this context resolves into. */
  readonly target: string;
  /** Resolve native→target as of a date. Returns the fx Resolution VALUE shape — never throws for data conditions. */
  resolve(from: string, dateISO: string): Resolution;
}

/** One row for convertAndSum: a monetary fact plus its valuation date (plan D-6). */
export interface DatedMoney {
  money:   Money;
  dateISO: string;
}
