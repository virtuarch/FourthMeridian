/**
 * lib/investments/holding-price-backfill.ts
 *
 * A9 constant-quantity fallback (Schwab-class) — force-backfill historical prices
 * for currently-held equity instruments over a fixed window, so the wealth-regen
 * valuation has prices even when an instrument's only activity is today
 * (holdings-only, no transaction/event history → the normal price-backfill window
 * resolves to null). The equity parallel to lib/crypto/btc-price's
 * backfillBtcPrices, and it keeps the price layer OUT of the regenerate-history
 * binding (which must not import lib/prices directly). Best-effort/dark without a
 * configured vendor (TIINGO_API_KEY); missing-only via priceArchive.
 */

import { backfillPricesForInstruments } from "@/lib/prices/backfill";

export async function backfillHeldInstrumentPrices(
  instrumentIds: string[],
  fromISO:       string,
  toISO:         string,
): Promise<{ planned: number; inserted: number }> {
  if (instrumentIds.length === 0) return { planned: 0, inserted: 0 };
  const r = await backfillPricesForInstruments(instrumentIds, {
    apply:       true,
    forceWindow: { fromISO, toISO },
  });
  return { planned: r.planned, inserted: r.inserted };
}
