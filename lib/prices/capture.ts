/**
 * lib/prices/capture.ts
 *
 * A8-2 — same-day security price capture. Plaid already returns a defensibly
 * dated close (`Security.close_price` + `close_price_as_of`) on every holdings
 * fetch and on the investment-transactions securities payload; both were
 * discarded. This module maps those provider facts to canonical PriceObservation
 * rows (basis RAW_CLOSE, source "plaid") and persists them through the A8-1
 * archive — so historical price coverage accrues from enable-day forward with NO
 * vendor, the A1 "stop the loss" doctrine applied to prices.
 *
 * Honesty rules (each a hard skip, never a fabricated row):
 *   - close_price must be finite and positive.
 *   - the date is `close_price_as_of` ONLY — an absent as-of date is skipped
 *     (never stamp a price with its arrival time; MC1).
 *   - a not-yet-closed date (> yesterday UTC) is skipped — the next capture picks
 *     it up once it is a closed date (append-only archive doctrine).
 *   - an indefensible quote currency is skipped (unknown is better than incorrect).
 *   - an unresolved instrument never reaches here (the caller passes only
 *     resolved instrumentIds).
 *
 * Gated behind SECURITY_PRICES_ENABLED at the call sites (absent ⇒ zero writes,
 * byte-identical existing sync). Best-effort/non-fatal: a capture failure never
 * fails a holdings refresh or event ingestion. Idempotent via the archive's
 * unique key + skipDuplicates (a second refresh adds no duplicate row).
 */

import type { Security } from "plaid";
import { PriceBasis } from "@prisma/client";
import { priceArchive } from "./archive";
import { yesterdayUTCISO } from "./config";
import type { PriceArchive, PriceResult } from "./types";

/** Canonical provider source stamped on captured Plaid prices (provenance, not identity). */
export const PLAID_PRICE_SOURCE = "plaid";

/** Kill switch — absent/false ⇒ no PriceObservation writes from capture at all. */
export function securityPriceCapturesEnabled(): boolean {
  return process.env.SECURITY_PRICES_ENABLED === "true";
}

/** The subset of Plaid Security fields the price mapping reads (no identity/names). */
export type PlaidPricedSecurity = Pick<
  Security,
  "close_price" | "close_price_as_of" | "iso_currency_code" | "unofficial_currency_code"
>;

/**
 * Pure: map a Plaid Security + its resolved canonical instrumentId to a
 * RAW_CLOSE PriceResult, or null when the security carries no defensible dated
 * price. Never dates a price by arrival; never invents a currency.
 */
export function mapPlaidSecurityToPriceResult(
  sec: PlaidPricedSecurity,
  instrumentId: string,
): PriceResult | null {
  const price = sec.close_price;
  if (price == null || !Number.isFinite(price) || price <= 0) return null;

  const asOf = sec.close_price_as_of;
  if (!asOf) return null; // no defensible date — skip (never stamp arrival time)
  const dateISO = asOf.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return null;

  const currency = sec.iso_currency_code ?? sec.unofficial_currency_code ?? null;
  if (!currency) return null; // indefensible denomination — unknown beats incorrect

  return { instrumentId, dateISO, basis: PriceBasis.RAW_CLOSE, price, currency };
}

export interface PriceCaptureMetrics {
  /** Candidates that mapped to a defensible, closed-date, deduped row. */
  attempted: number;
  /** Rows actually inserted (skipDuplicates ⇒ a repeat capture inserts 0). */
  inserted:  number;
  /** Candidates dropped: no price / no date / not yet closed / no currency / duplicate. */
  skipped:   number;
}

/**
 * Provider-neutral: persist captured-price candidates (already resolved to
 * canonical instrumentIds) through the archive. Filters to defensible,
 * closed-date, de-duplicated rows, then one insert-only batch write. Never
 * throws for data conditions — returns metrics; a genuine archive failure is the
 * caller's to catch (both hooks wrap this non-fatally).
 *
 * `now` is injectable so the closed-date boundary is deterministic in tests.
 */
export async function captureSecurityPrices(args: {
  securities: ReadonlyArray<{ instrumentId: string; security: PlaidPricedSecurity }>;
  now?:       Date;
  archive?:   PriceArchive;
}): Promise<PriceCaptureMetrics> {
  const archive = args.archive ?? priceArchive;
  const yesterday = yesterdayUTCISO(args.now ?? new Date());

  const rows: PriceResult[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const { instrumentId, security } of args.securities) {
    const cand = mapPlaidSecurityToPriceResult(security, instrumentId);
    if (!cand) { skipped++; continue; }
    if (cand.dateISO > yesterday) { skipped++; continue; } // not yet a closed date
    const key = `${cand.instrumentId}|${cand.dateISO}|${cand.basis}`;
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    rows.push(cand);
  }

  if (rows.length === 0) return { attempted: 0, inserted: 0, skipped };
  const res = await archive.writeBatch(PLAID_PRICE_SOURCE, rows);
  return { attempted: res.attempted, inserted: res.inserted, skipped };
}
