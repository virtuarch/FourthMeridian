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
 * null-residue pass-through, or a RateMiss; `estimated` distinguishes the
 * honest cases (true) from clean identity (false).
 *
 * V25-FINAL-1 (FX Honesty) — the UNAVAILABLE case (a KNOWN foreign currency
 * with no acceptable rate) no longer relabels the native magnitude as the
 * target currency. `amount` is forced to 0 so the value contributes NOTHING to
 * any target-currency sum (exclusion by construction — the ~20 hand-rolled
 * aggregate consumers become truthful without a per-consumer change), and the
 * real native value is carried on `native` for honest display. This closes the
 * "¥1,000,000 surfaces as $1,000,000 estimated" false-unit hole. The
 * null-residue case (currency unknown) is deliberately NOT excluded — it has no
 * known source currency to mislabel, so it keeps the legacy assume-target
 * passthrough (documented, out of V25-FINAL-1 scope).
 */
export interface ConvertedMoney {
  /**
   * The value denominated in the context target. A REAL converted number for
   * exact/estimated conversions and identity; **`null` for the unavailable case**
   * (known foreign currency, no rate). `null` is deliberately NOT `0`: a value
   * that cannot be expressed in the target currency is not the same financial
   * statement as a value worth zero. The type forces every consumer to decide
   * what an unavailable value means for its surface (exclude + disclose, or show
   * native) rather than silently summing a fake zero. Read `native` for the
   * untouched source value.
   */
  amount:    number | null;
  /** Always the context target — what `amount` is denominated in. */
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
  /**
   * V25-FINAL-1 — present ONLY for the UNAVAILABLE case (known foreign currency,
   * no acceptable rate). When set, `amount` is 0 and this carries the untouched
   * native value so a display surface can honestly show it in its own currency
   * ("¥1,000,000, rate unavailable") instead of a mislabeled target figure or a
   * bare "$0". Absent on every convertible/identity/null-residue result, so the
   * all-USD path serializes byte-identically (the field is simply not emitted).
   */
  native?: { amount: number; currency: string };
}

/** An aggregate in the target currency. `estimated` = any member was estimated (taint propagation). */
export interface ConvertedTotal {
  amount:    number;
  currency:  string;
  estimated: boolean;
  /**
   * V25-CLOSE-3 — stronger than `estimated`. True when AT LEAST ONE member was
   * FX-unavailable (rate missing on a known currency, or null-residue), so the
   * total is known to be incomplete rather than merely converted with a stale
   * rate. `unconverted` implies `estimated`; surfaces render an unmistakable
   * "FX unavailable" note for it rather than the quiet "est." marker. (The
   * per-member distinction lives on ConvertedMoney via `fxDisclosureOf`.)
   */
  unconverted: boolean;
  /**
   * V25-FINAL-1 — how many members were EXCLUDED from `amount` because their
   * (known) currency had no acceptable rate. These contributed 0 to the sum
   * (their native magnitude is never blended in), so `amount` is an honest
   * partial total over the convertible members and `excluded` quantifies the
   * coverage gap for disclosure.
   */
  excluded:  number;
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
