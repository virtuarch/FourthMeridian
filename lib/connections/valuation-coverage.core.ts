/**
 * lib/connections/valuation-coverage.core.ts  (owner requirement 2026-10-28 — honest history)
 *
 * Why a Space's Net Worth history starts where it does, when the reason is
 * PRICES rather than balances. A wallet's balance history can be proven back
 * years (PositionCoverage) while the stored daily USD closes for its asset
 * start much later (PriceObservation RAW_CLOSE): days before the price floor
 * refuse — they are never valued at zero and never extrapolated — so the chart
 * starts at the floor. This states that gap, per asset, from persisted facts.
 *
 * Dates and asset symbols only: no quantity, price, value or account id leaves.
 * An asset whose prices reach back to (or before) its balance history is not a
 * limit and is not mentioned.
 */

export interface ValuationCoverageInput {
  /** Asset symbol, e.g. "SOL". */
  symbol: string;
  instrumentId: string;
  /** Coverage start of the licensed balance interval (YYYY-MM-DD), or null if unbounded/unproven. */
  balanceFromISO: string | null;
}

export interface ValuationCoverageLimit {
  symbol: string;
  /** Earliest proven balance day for this asset in the Space. */
  balanceFromISO: string;
  /** Earliest stored daily close; null = no historical prices stored yet. */
  pricedFromISO: string | null;
}

export interface ValuationCoverage {
  /** Assets whose balance history starts before their stored prices, by symbol. */
  limits: ValuationCoverageLimit[];
  /** The latest price floor among the limits — the first day every limited asset can be valued; null if any has none. */
  valuedFromISO: string | null;
}

export function deriveValuationCoverage(
  rows: readonly ValuationCoverageInput[],
  priceFloors: ReadonlyMap<string, string | null>,
): ValuationCoverage | null {
  const bySymbol = new Map<string, ValuationCoverageLimit>();
  for (const r of rows) {
    if (!r.balanceFromISO) continue;
    const priced = priceFloors.get(r.instrumentId) ?? null;
    if (priced !== null && priced <= r.balanceFromISO) continue;
    const prev = bySymbol.get(r.symbol);
    if (!prev) { bySymbol.set(r.symbol, { symbol: r.symbol, balanceFromISO: r.balanceFromISO, pricedFromISO: priced }); continue; }
    if (r.balanceFromISO < prev.balanceFromISO) prev.balanceFromISO = r.balanceFromISO;
  }
  const limits = [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  if (!limits.length) return null;
  const floors = limits.map((l) => l.pricedFromISO);
  const valuedFromISO = floors.every((f): f is string => f !== null) ? [...floors].sort().at(-1)! : null;
  return { limits, valuedFromISO };
}

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * The one sentence under the chart, or null. Shown only when the plotted window
 * starts on/after a limited asset's balance start (otherwise the gap is not why
 * this chart starts where it does).
 */
export function valuationCoverageNote(cov: ValuationCoverage | null, chartFromISO: string | null): string | null {
  if (!cov || !chartFromISO) return null;
  const relevant = cov.limits.filter((l) => l.balanceFromISO < chartFromISO);
  if (!relevant.length) return null;
  const parts = relevant.map((l) => l.pricedFromISO
    ? `${l.symbol} balances are known from ${fmtDay(l.balanceFromISO)}, but its historical prices start ${fmtDay(l.pricedFromISO)}`
    : `${l.symbol} balances are known from ${fmtDay(l.balanceFromISO)}, but no historical ${l.symbol} prices are stored yet`);
  return `${parts.join("; ")}. Earlier days aren’t valued (never counted as zero), so this history starts later.`;
}
