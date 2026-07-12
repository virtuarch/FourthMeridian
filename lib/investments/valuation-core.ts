/**
 * lib/investments/valuation-core.ts
 *
 * A8-4 — PURE historical investment valuation. No DB, no clock, no network: the
 * arithmetic + precedence + trust-propagation of point-in-time valuation, so it
 * fixture-tests without `prisma generate`. The DB binding (valuation.ts) does the
 * batched reads and calls these functions.
 *
 *   value(instrument, D) = quantityAsOf(D) × priceAsOf(D) × fxAsOf(D)
 *
 * with observed institution facts taking precedence where the data earned them.
 * Every factor carries its own canonical trust tier; the result tier is the
 * WORST contributor (worstTier, the A5-S1 helper — never re-derived). A missing
 * price never fabricates a number: the position stays, its value is null, its
 * tier is `incomplete`. A partial portfolio is never presented as the whole.
 *
 * Precedence for one (account, instrument, date):
 *   1. resolved row carries a defensible institutionValue → that IS the native
 *      valuation (tier observed); FX may still degrade the reporting figure.
 *   2. else carries a defensible institutionPrice → quantity × institutionPrice
 *      (tier observed), preserving the institution price's own as-of date.
 *   3. else → quantity (A4 as-of) × market price (A8 service) × FX; tier =
 *      worst(quantity, price, FX).
 *   Cash instruments: unit price 1 in native currency; never a market lookup.
 */

import { convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";
import { worstTier } from "@/lib/perspective-engine/completeness";
import type { CompletenessTier } from "@/lib/perspective-engine/types";
import type { PriceResolution } from "@/lib/prices/types";
import { daysBetweenISO } from "@/lib/prices/config";

/** Which anchor produced the native value (provenance for the UI/tests). */
export type ValuationBasis =
  | "institution-value" // observed institution_value fact
  | "institution-price" // quantity × observed institution_price
  | "cash"              // cash position: unit price 1
  | "raw-close"         // A8 market close (RAW_CLOSE); basis string kept verbatim below
  | "adjusted-close"
  | "nav"
  | "intraday"
  | "crypto-daily"
  | null;               // unvalued

/** The pure inputs the binding resolves for one (account, instrument) at asOf. */
export interface InstrumentValuationInput {
  instrumentId: string;
  accountId:    string;
  /** Resolved quantity as-of (A4 read path). null ⇒ no holdings coverage ≤ asOf. */
  quantity:     number | null;
  /** The resolved position row's date (YYYY-MM-DD), or null when uncovered. */
  quantityDate: string | null;
  /** Trust tier of the resolved quantity (from resolvePositionAsOf). */
  quantityTier: CompletenessTier;
  /** Cash position ⇒ unit price 1, never a market lookup. */
  isCash:       boolean;
  /** Native (quote) currency of the value/price. null ⇒ null-residue (FX estimates). */
  nativeCurrency: string | null;
  /** Observed institution facts on the resolved row (null on derived rows). */
  institutionValue:     number | null;
  institutionPrice:     number | null;
  institutionPriceDate: string | null;
  /** A8 market-price resolution for the compute path (null for cash / not looked up). */
  price: PriceResolution | null;
  /** Reconstruction conflict flag — surfaced, never silently averaged. */
  conflicted: boolean;
}

/** One instrument's valuation at asOf. Serialisable. */
export interface InstrumentValuation {
  instrumentId: string;
  accountId:    string;
  quantity:     number | null;
  /** Native unit price used (null for the institution-value anchor / unvalued). */
  nativePrice:  number | null;
  /** Value in the native/quote currency (null ⇒ unvalued). */
  nativeValue:  number | null;
  /** Value converted into the reporting currency (null ⇒ unvalued). */
  reportingValue: number | null;
  currency:         string | null; // native
  reportingCurrency: string;
  quantityTier: CompletenessTier;
  priceTier:    CompletenessTier;
  fxTier:       CompletenessTier;
  overallTier:  CompletenessTier;
  basisUsed:    ValuationBasis;
  priceDate:    string | null;
  staleDays:    number | null;
  /** Deterministic, name-free explanation. */
  reason:       string;
  conflicted:   boolean;
}

/** Map an A8 PriceBasis string to the ValuationBasis label. */
function basisLabel(basis: string): ValuationBasis {
  switch (basis) {
    case "RAW_CLOSE":      return "raw-close";
    case "ADJUSTED_CLOSE": return "adjusted-close";
    case "NAV":            return "nav";
    case "INTRADAY":       return "intraday";
    case "CRYPTO_DAILY":   return "crypto-daily";
    default:               return "raw-close";
  }
}

/**
 * Value one instrument at asOf. Pure. FX is applied at `asOf` via convertMoney
 * (walked-back ⇒ estimated, already-ratified semantics); the reporting currency
 * is ctx.target.
 */
export function valueInstrumentAsOf(
  input: InstrumentValuationInput,
  asOf: string,
  ctx: ConversionContext,
): InstrumentValuation {
  const reportingCurrency = ctx.target;

  const base = {
    instrumentId: input.instrumentId,
    accountId:    input.accountId,
    quantity:     input.quantity,
    currency:     input.nativeCurrency,
    reportingCurrency,
    quantityTier: input.quantityTier,
    conflicted:   input.conflicted,
  };

  /** Convert a native value into the reporting currency at asOf; derive the FX tier. */
  const toReporting = (nativeValue: number): { reportingValue: number; fxTier: CompletenessTier } => {
    const c = convertMoney({ amount: nativeValue, currency: input.nativeCurrency }, asOf, ctx);
    return { reportingValue: c.amount, fxTier: c.estimated ? "estimated" : "observed" };
  };

  /** Shape an unvalued (incomplete) result — position retained, value null. */
  const unvalued = (reason: string): InstrumentValuation => ({
    ...base,
    nativePrice: null, nativeValue: null, reportingValue: null,
    priceTier: "incomplete", fxTier: "unknown", overallTier: "incomplete",
    basisUsed: null, priceDate: null, staleDays: null, reason,
  });

  // ── Precedence 1: observed institution value ──────────────────────────────
  if (input.institutionValue != null && Number.isFinite(input.institutionValue)) {
    const { reportingValue, fxTier } = toReporting(input.institutionValue);
    const overallTier = worstTier([input.quantityTier, "observed", fxTier]);
    return {
      ...base,
      nativePrice: input.institutionPrice ?? null,
      nativeValue: input.institutionValue,
      reportingValue,
      priceTier: "observed", fxTier, overallTier,
      basisUsed: "institution-value",
      priceDate: input.institutionPriceDate ?? input.quantityDate,
      staleDays: 0,
      reason: `Valued from the institution-reported value as of ${input.quantityDate ?? asOf}.`,
    };
  }

  // ── Precedence 2: observed institution price × quantity ───────────────────
  if (
    input.institutionPrice != null && Number.isFinite(input.institutionPrice) &&
    input.quantity != null
  ) {
    const nativeValue = input.quantity * input.institutionPrice;
    const { reportingValue, fxTier } = toReporting(nativeValue);
    const staleDays = input.institutionPriceDate ? daysBetweenISO(input.institutionPriceDate, asOf) : null;
    const overallTier = worstTier([input.quantityTier, "observed", fxTier]);
    return {
      ...base,
      nativePrice: input.institutionPrice, nativeValue, reportingValue,
      priceTier: "observed", fxTier, overallTier,
      basisUsed: "institution-price",
      priceDate: input.institutionPriceDate,
      staleDays,
      reason: `Valued at the institution-reported price${input.institutionPriceDate ? ` as of ${input.institutionPriceDate}` : ""}.`,
    };
  }

  // ── Cash instrument: unit price 1 in native currency ──────────────────────
  if (input.isCash) {
    if (input.quantity == null) return unvalued(`No cash balance on or before ${asOf}.`);
    const { reportingValue, fxTier } = toReporting(input.quantity);
    const overallTier = worstTier([input.quantityTier, "observed", fxTier]);
    return {
      ...base,
      nativePrice: 1, nativeValue: input.quantity, reportingValue,
      priceTier: "observed", fxTier, overallTier,
      basisUsed: "cash", priceDate: input.quantityDate, staleDays: 0,
      reason: `Cash valued at its balance${input.nativeCurrency ? ` in ${input.nativeCurrency}` : ""}.`,
    };
  }

  // ── Precedence 3: quantity × market price × FX ────────────────────────────
  if (input.quantity == null) {
    return unvalued(`No holdings history on or before ${asOf}.`);
  }
  if (!input.price || input.price.kind === "miss") {
    const reason = input.price && input.price.kind === "miss"
      ? input.price.reason
      : `No market price available for ${asOf}.`;
    // Keep the resolved quantity visible on an unvalued row.
    return { ...unvalued(reason), quantity: input.quantity };
  }

  const p = input.price; // ResolvedPrice
  const nativeValue = input.quantity * p.price;
  const { reportingValue, fxTier } = toReporting(nativeValue);
  const overallTier = worstTier([input.quantityTier, p.tier, fxTier]);
  return {
    ...base,
    nativePrice: p.price,
    nativeValue,
    reportingValue,
    currency: input.nativeCurrency ?? p.currency,
    priceTier: p.tier, fxTier, overallTier,
    basisUsed: basisLabel(p.basis as unknown as string),
    priceDate: p.effectiveDateISO,
    staleDays: p.staleDays,
    reason: p.staleDays === 0
      ? `Valued at the ${p.effectiveDateISO} market close.`
      : `Valued at the ${p.effectiveDateISO} close (nearest within ${p.staleDays} day${p.staleDays === 1 ? "" : "s"}).`,
  };
}

// ── Portfolio ─────────────────────────────────────────────────────────────────

export interface UnvaluedPosition {
  instrumentId: string;
  accountId:    string;
  quantity:     number | null;
  quantityTier: CompletenessTier;
  reason:       string;
}

/** A shaped portfolio valuation — a partial subtotal is NEVER presented as whole. */
export interface InvestmentValuationView {
  asOf:              string;
  reportingCurrency: string;
  /** Σ reportingValue over VALUED components only — explicitly a subtotal. */
  valuedSubtotal:    number;
  valuedCount:       number;
  unvaluedCount:     number;
  unvalued:          UnvaluedPosition[];
  components:        InstrumentValuation[];
  /** Overall = worst contributing tier; conflict OR'd from reconstruction summaries. */
  completeness: {
    tier:     CompletenessTier;
    conflict: boolean;
    reason:   string;
    /** Per-instrument tier detail, never collapsed away. */
    byInstrument: Record<string, CompletenessTier>;
  };
}

/**
 * Aggregate per-instrument valuations into a shaped portfolio view. Overall tier
 * is the worst contributor (incomplete whenever any held instrument is
 * unvalued); conflict is the OR of the components'. The valued subtotal and the
 * unvalued remainder are always separate — a caller can never mistake the
 * subtotal for the full portfolio value (the pixel rule).
 */
export function valuePortfolioAsOf(
  components: readonly InstrumentValuation[],
  asOf: string,
  reportingCurrency: string,
): InvestmentValuationView {
  let valuedSubtotal = 0;
  let valuedCount = 0;
  const unvalued: UnvaluedPosition[] = [];
  const byInstrument: Record<string, CompletenessTier> = {};

  for (const c of components) {
    byInstrument[c.instrumentId] = worstTier([byInstrument[c.instrumentId] ?? "observed", c.overallTier]);
    if (c.reportingValue != null) {
      valuedSubtotal += c.reportingValue;
      valuedCount++;
    } else {
      unvalued.push({
        instrumentId: c.instrumentId, accountId: c.accountId,
        quantity: c.quantity, quantityTier: c.quantityTier, reason: c.reason,
      });
    }
  }

  const tier = components.length === 0 ? "unknown" : worstTier(components.map((c) => c.overallTier));
  const conflict = components.some((c) => c.conflicted);
  const reason = unvalued.length > 0
    ? `${unvalued.length} of ${components.length} holdings could not be valued for ${asOf}; the total shown is a partial subtotal.`
    : conflict
      ? "All holdings valued, but at least one position has a reconstruction conflict — review before trusting the total."
      : `All ${components.length} holdings valued for ${asOf}.`;

  return {
    asOf,
    reportingCurrency,
    valuedSubtotal,
    valuedCount,
    unvaluedCount: unvalued.length,
    unvalued,
    components: [...components],
    completeness: { tier, conflict, reason, byInstrument },
  };
}
