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
 *
 * 2026-07-15 — onProgress is optional and defaults to a no-op, same as
 * backfillPricesForInstruments itself; without it, the per-instrument window/
 * chunk plan lines are silently dropped, which is exactly what made the
 * "resume from latest covered" bug (fixed the same day in lib/prices/
 * backfill.ts) invisible until traced against the DB directly. Callers should
 * pass a logger so a future regression is visible in the console output
 * instead of requiring a DB investigation to notice.
 */

import { backfillPricesForInstruments } from "@/lib/prices/backfill";

export async function backfillHeldInstrumentPrices(
  instrumentIds: string[],
  fromISO:       string,
  toISO:         string,
  onProgress?:   (line: string) => void,
): Promise<{ planned: number; inserted: number }> {
  if (instrumentIds.length === 0) return { planned: 0, inserted: 0 };
  const r = await backfillPricesForInstruments(instrumentIds, {
    apply:       true,
    forceWindow: { fromISO, toISO },
    onProgress,
  });
  return { planned: r.planned, inserted: r.inserted };
}
