/**
 * lib/crypto/token-valuation.core.ts
 *
 * TOKEN HOLDINGS (PR-A) — THE ONE RULE FOR VALUING A TOKEN ON A DAY.
 *
 * Pure: no Prisma, no DB, no clock, no network.
 *
 * Used by BOTH writers of a day's wallet value, so they cannot disagree:
 *   · the live read (lib/crypto/wallet-current-value → today's snapshot), and
 *   · historical regeneration (lib/snapshots/regenerate-history, days < today).
 *
 * A token counts on day d only when BOTH hold, each on its OWN evidence:
 *
 *   quantity  the token's own latest row on or before d is recent — an OBSERVED
 *             row, or (ERC-20 history) a VERIFIED reconstructed row inside the
 *             token's COMPLETE licence (token-valuation.ts selects them) —
 *             the same freshness rule native wallets use (lib/freshness
 *             `bandForAge`: LIVE or RECENT, i.e. under STALE_AFTER_DAYS). A
 *             fresh native observation never makes a stale token quantity
 *             current, and another customer's fresh quote never does either.
 *   price     a stored USD price SERVING d: a row dated d, else d−1 (the
 *             quote-day fallback, so 00:00 UTC → the first sync of the day does
 *             not drop a token). Same-day RAW_CLOSE before INTRADAY; then the
 *             previous day the same way. Deterministic.
 *
 * Days before tracking began have no observation and contribute nothing — that
 * boundary is disclosed on the Net Worth chart (valuation-coverage.core.ts), not
 * filled. A closed token (latest observation 0) is not a holding. Nothing here
 * ever returns a value of zero for an unknown: unknown is `null`.
 */

import { bandForAge, type FreshnessBand } from "@/lib/freshness/observation";

export interface TokenObservationRow { instrumentId: string; dateISO: string; quantity: number }
export interface TokenPriceRow { instrumentId: string; dateISO: string; basis: "RAW_CLOSE" | "INTRADAY"; priceUsd: number }

export type TokenDayState =
  | "VALUED"          // fresh own quantity × a price serving the day
  | "UNPRICED"        // fresh quantity, no price serving the day — excluded, never 0
  | "STALE"           // the token's own latest observation is too old to speak for the day
  | "CLOSED"          // latest observation is an explicit 0 — not a holding
  | "NO_OBSERVATION"; // tracking had not begun by this day

export interface TokenDayValue {
  instrumentId: string;
  state:        TokenDayState;
  quantity:     number | null;
  observedISO:  string | null;
  priceUsd:     number | null;
  priceDateISO: string | null;
  /** USD; null unless VALUED. */
  valueUsd:     number | null;
}

const dayMs = 86_400_000;
const daysBetween = (fromISO: string, toISO: string) =>
  Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / dayMs);
const minusDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) - dayMs).toISOString().slice(0, 10);

/** Is an observation dated `observedISO` fresh enough to speak for `dISO`? The native band rule. */
export function tokenObservationFresh(observedISO: string, dISO: string): boolean {
  const band: FreshnessBand = bandForAge(daysBetween(observedISO, dISO));
  return band === "LIVE" || band === "RECENT";
}

/** The price serving day d for one instrument, or null. */
export function tokenPriceServing(prices: readonly TokenPriceRow[], dISO: string): TokenPriceRow | null {
  const prev = minusDay(dISO);
  const rank = (p: TokenPriceRow) =>
    p.dateISO === dISO ? (p.basis === "RAW_CLOSE" ? 0 : 1) : p.dateISO === prev ? (p.basis === "RAW_CLOSE" ? 2 : 3) : 9;
  let best: TokenPriceRow | null = null;
  for (const p of prices) {
    if (!(Number.isFinite(p.priceUsd) && p.priceUsd > 0)) continue;
    const r = rank(p);
    if (r === 9) continue;
    if (best === null || r < rank(best)) best = p;
  }
  return best;
}

/** One token on one day. `observations` / `prices` may include other instruments; they are filtered. */
export function tokenValueOnDay(
  instrumentId: string,
  observations: readonly TokenObservationRow[],
  prices: readonly TokenPriceRow[],
  dISO: string,
): TokenDayValue {
  let latest: TokenObservationRow | null = null;
  for (const o of observations) {
    if (o.instrumentId !== instrumentId || o.dateISO > dISO) continue;
    if (latest === null || o.dateISO > latest.dateISO) latest = o;
  }
  const base = { instrumentId, priceUsd: null, priceDateISO: null, valueUsd: null };
  if (latest === null) return { ...base, state: "NO_OBSERVATION", quantity: null, observedISO: null };
  if (!(latest.quantity > 0)) return { ...base, state: "CLOSED", quantity: 0, observedISO: latest.dateISO };
  if (!tokenObservationFresh(latest.dateISO, dISO)) return { ...base, state: "STALE", quantity: latest.quantity, observedISO: latest.dateISO };
  const price = tokenPriceServing(prices.filter((p) => p.instrumentId === instrumentId), dISO);
  if (!price) return { ...base, state: "UNPRICED", quantity: latest.quantity, observedISO: latest.dateISO };
  return {
    instrumentId, state: "VALUED", quantity: latest.quantity, observedISO: latest.dateISO,
    priceUsd: price.priceUsd, priceDateISO: price.dateISO, valueUsd: latest.quantity * price.priceUsd,
  };
}

/** Every token instrument present in `observations`, valued on day d. Sorted by instrument id. */
export function tokensValueOnDay(
  observations: readonly TokenObservationRow[],
  prices: readonly TokenPriceRow[],
  dISO: string,
): { totalUsd: number; tokens: TokenDayValue[] } {
  // Grouped once per call (identical result): each token scans only its own rows,
  // which keeps a long regeneration window linear in the rows, not tokens × rows.
  const obsBy = new Map<string, TokenObservationRow[]>();
  for (const o of observations) (obsBy.get(o.instrumentId) ?? obsBy.set(o.instrumentId, []).get(o.instrumentId)!).push(o);
  const pricesBy = new Map<string, TokenPriceRow[]>();
  for (const p of prices) (pricesBy.get(p.instrumentId) ?? pricesBy.set(p.instrumentId, []).get(p.instrumentId)!).push(p);
  const ids = [...obsBy.keys()].sort();
  const tokens = ids.map((id) => tokenValueOnDay(id, obsBy.get(id)!, pricesBy.get(id) ?? [], dISO));
  return { totalUsd: tokens.reduce((s, t) => s + (t.valueUsd ?? 0), 0), tokens };
}

/** The window of rows a caller must read to value day d (observations: freshness horizon; prices: d−1..d). */
export function tokenReadWindow(fromISO: string, toISO: string, staleAfterDays: number): { observationsFromISO: string; pricesFromISO: string; toISO: string } {
  const obsFrom = new Date(Date.parse(`${fromISO}T00:00:00Z`) - staleAfterDays * dayMs).toISOString().slice(0, 10);
  return { observationsFromISO: obsFrom, pricesFromISO: minusDay(fromISO), toISO };
}

// ── Reconstructed tokens: are their historical days valued? (PR #122 review B1, re-review F2/F4) ──

/**
 * A token with LICENSED reconstructed history (SPL / ERC-20 history), held now
 * or long since exited, is in one of five valuation states for its history.
 * `held` is when it was actually held (quantity > 0), clamped to the licence;
 * `closesFromISO` is its first stored historical close (RAW_CLOSE), or null.
 *
 *   NEVER_HELD        no positive balance ever (e.g. zero-value spam transfers):
 *                     nothing to value — never probed, never counted (F2);
 *   VALUED            closes start on or before its first held day — its held
 *                     period is valued (a still-held token's newest days by the
 *                     day rule as usual);
 *   VALUED_FROM_LATER closes start INSIDE its held period: valued only from
 *                     there. The native rule (a later price floor ⇒ limited):
 *                     disclosed as `tokenPricesFromISO`, and LIMITING (F4);
 *   NO_MARKET         none of its held days priced, and the vendor said (when
 *                     last asked): not listed, or thin — never valued;
 *   NOT_VALUED_YET    none of its held days priced, for any other reason —
 *                     never quoted (sold before capture began), closes not yet
 *                     acquired, or closes that begin only AFTER it was last held
 *                     (held only before the vendor's price window — F4).
 *
 * VALUED_FROM_LATER and NOT_VALUED_YET keep the wallet from reading complete.
 * Inputs are read loosely (alias metadata: `quote`, `priceHistory`). A missing
 * price is never $0.
 */
export type ReconstructedTokenValuation = "NEVER_HELD" | "VALUED" | "VALUED_FROM_LATER" | "NO_MARKET" | "NOT_VALUED_YET";

export interface ReconstructedTokenFacts {
  licence: { fromISO: string; toISO: string };
  /** When it was held (quantity > 0); `toISO` null = still held. Null = never held. */
  held: { fromISO: string; toISO: string | null } | null;
  closesFromISO: string | null;
}

export function reconstructedTokenValuation(f: ReconstructedTokenFacts, aliasMetadata: unknown): ReconstructedTokenValuation {
  if (!f.held) return "NEVER_HELD";
  const heldFrom = f.held.fromISO > f.licence.fromISO ? f.held.fromISO : f.licence.fromISO;
  const heldTo = f.held.toISO === null || f.held.toISO > f.licence.toISO ? f.licence.toISO : f.held.toISO;
  if (heldFrom > heldTo) return "NEVER_HELD"; // held only outside the licence: no licensed day to value
  if (f.closesFromISO !== null) {
    if (f.closesFromISO <= heldFrom) return "VALUED";
    if (f.closesFromISO <= heldTo) return "VALUED_FROM_LATER";
    // Closes begin only after it was last held: none of its held days is valued.
  }
  const m = (aliasMetadata && typeof aliasMetadata === "object" ? aliasMetadata : {}) as {
    quote?: { outcome?: unknown; pricedAt?: unknown }; priceHistory?: { outcome?: unknown };
  };
  const q = m.quote?.outcome;
  if (q === "THIN") return "NO_MARKET";
  if (m.priceHistory?.outcome === "UNLISTED") return "NO_MARKET";
  if ((q === "UNLISTED" || q === "INVALID") && typeof m.quote?.pricedAt !== "string") return "NO_MARKET";
  return "NOT_VALUED_YET";
}

/** Does this state keep the wallet's history from reading complete? */
export function tokenValuationLimits(v: ReconstructedTokenValuation): boolean {
  return v === "NOT_VALUED_YET" || v === "VALUED_FROM_LATER";
}
