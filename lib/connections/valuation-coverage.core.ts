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
  /**
   * TOKEN HOLDINGS (PR-A) — the first day a PRICED wallet token was observed in
   * this Space: token value is included from here; earlier token balances are
   * not reconstructed. Null/absent when no priced token exists.
   */
  tokensTrackedFromISO?: string | null;
}

export function deriveValuationCoverage(
  rows: readonly ValuationCoverageInput[],
  priceFloors: ReadonlyMap<string, string | null>,
  tokensTrackedFromISO: string | null = null,
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
  if (!limits.length && !tokensTrackedFromISO) return null;
  const floors = limits.map((l) => l.pricedFromISO);
  const valuedFromISO = !limits.length ? null : floors.every((f): f is string => f !== null) ? [...floors].sort().at(-1)! : null;
  return { limits, valuedFromISO, ...(tokensTrackedFromISO ? { tokensTrackedFromISO } : {}) };
}

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * The one sentence under the chart, or null. Shown only when PRICES are why the
 * plotted window starts where it does: it starts after the asset's balance start
 * AND no later than its price floor (a later start is the chosen window — e.g.
 * "1 month" — not the price limit). No stored prices at all always qualifies.
 */
export function valuationCoverageNote(cov: ValuationCoverage | null, chartFromISO: string | null): string | null {
  if (!cov || !chartFromISO) return null;
  const relevant = cov.limits.filter((l) => l.balanceFromISO < chartFromISO
    && (l.pricedFromISO === null || chartFromISO <= l.pricedFromISO));
  const parts = relevant.map((l) => l.pricedFromISO
    ? `${l.symbol} balances are known from ${fmtDay(l.balanceFromISO)}, but its historical prices start ${fmtDay(l.pricedFromISO)}`
    : `${l.symbol} balances are known from ${fmtDay(l.balanceFromISO)}, but no historical ${l.symbol} prices are stored yet`);
  const priceNote = parts.length ? `${parts.join("; ")}. Earlier days aren’t valued (never counted as zero), so this history starts later.` : null;
  // TOKEN HOLDINGS (PR-A) — the chart reaches back before token tracking began:
  // those days carry native value only. Said, never filled.
  const tokenNote = cov.tokensTrackedFromISO && chartFromISO < cov.tokensTrackedFromISO
    ? `Token holdings are included from ${fmtDay(cov.tokensTrackedFromISO)}; earlier token balances aren’t proven, so they aren’t counted.`
    : null;
  return [priceNote, tokenNote].filter((x): x is string => x !== null).join(" ") || null;
}
