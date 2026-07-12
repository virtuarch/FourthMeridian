/**
 * lib/investments/valuation.fixtures.ts
 *
 * A8-4 — shared, DB-free fixtures for the valuation core tests (and any later
 * consumer). Owned here, reused, never forked (the S2 fixture doctrine).
 * Provides input builders, price-resolution builders, and three deterministic
 * ConversionContexts (identity, walked-back/estimated, miss).
 */

import { PriceBasis } from "@prisma/client";
import type { ConversionContext } from "@/lib/money/types";
import type { ResolvedPrice, PriceMiss } from "@/lib/prices/types";
import type { CompletenessTier } from "@/lib/perspective-engine/types";
import type { InstrumentValuationInput } from "./valuation-core";

/** A base valued input (observed quantity, RAW_CLOSE observed price, USD). Override freely. */
export function vInput(over: Partial<InstrumentValuationInput> = {}): InstrumentValuationInput {
  return {
    instrumentId: "inst_1",
    accountId:    "acct_1",
    quantity:     10,
    quantityDate: "2026-06-05",
    quantityTier: "observed",
    isCash:       false,
    nativeCurrency: "USD",
    institutionValue: null,
    institutionPrice: null,
    institutionPriceDate: null,
    price: observedPrice(200),
    conflicted: false,
    ...over,
  };
}

/** An exact-date observed market price (tier observed, staleDays 0). */
export function observedPrice(price: number, over: Partial<ResolvedPrice> = {}): ResolvedPrice {
  return {
    kind: "price", price, currency: "USD", basis: PriceBasis.RAW_CLOSE,
    requestedDateISO: "2026-06-05", effectiveDateISO: "2026-06-05", staleDays: 0,
    tier: "observed", ...over,
  };
}

/** A walked-back market price (tier estimated, staleDays > 0). */
export function estimatedPrice(price: number, staleDays = 2, effectiveDateISO = "2026-06-03"): ResolvedPrice {
  return {
    kind: "price", price, currency: "USD", basis: PriceBasis.RAW_CLOSE,
    requestedDateISO: "2026-06-05", effectiveDateISO, staleDays, tier: "estimated",
  };
}

/** A price miss (beyond staleness / never priced). */
export function priceMiss(reason = "No RAW_CLOSE price within 7 days of 2026-06-05."): PriceMiss {
  return { kind: "miss", instrumentId: "inst_1", basis: PriceBasis.RAW_CLOSE, requestedDateISO: "2026-06-05", reason };
}

/** Identity FX: native === target ⇒ never estimated (convertMoney short-circuits). */
export function identityFxCtx(target = "USD"): ConversionContext {
  return { target, resolve: (from, dateISO) => ({ kind: "miss", quote: from, requestedDateISO: dateISO }) };
}

/**
 * Walked-back FX at a fixed rate: any non-target currency resolves to `rate` with
 * staleness "walked-back" ⇒ convertMoney flags estimated (FX degradation).
 */
export function walkedBackFxCtx(target = "USD", rate = 1.1): ConversionContext {
  return {
    target,
    resolve: (from, dateISO) =>
      from === target
        ? { kind: "rate", rate: 1, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" }
        : { kind: "rate", rate, requestedDateISO: dateISO, effectiveDates: { from: "2026-05-01", to: dateISO }, staleness: "walked-back" },
  };
}

/** Missing FX: every non-target currency is a miss ⇒ native pass-through + estimated. */
export function missingFxCtx(target = "USD"): ConversionContext {
  return { target, resolve: (from, dateISO) => ({ kind: "miss", quote: from, requestedDateISO: dateISO }) };
}

export type { CompletenessTier };
