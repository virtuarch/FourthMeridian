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
 *   VALUED            closes start on or before its first held day AND reach its
 *                     last held day (within CLOSES_END_TOLERANCE_DAYS) — its held
 *                     period is valued — and, when the close dates are supplied,
 *                     no held day inside them goes unserved (see VALUED_WITH_GAPS);
 *   VALUED_WITH_GAPS  (delta review F3) closes span its held period but leave
 *                     INTERIOR held days that no close serves (the day rule's d /
 *                     d−1): those days are unavailable — LIMITING, disclosed;
 *   VALUED_UNTIL_EARLIER closes stop INSIDE its held period (the shared archive
 *                     ended — another wallet's span, the token went thin, or the
 *                     tail was never fetched): valued only until then — LIMITING
 *                     (delta re-review S1);
 *   VALUED_FROM_LATER closes start INSIDE its held period: valued only from
 *                     there. The native rule (a later price floor ⇒ limited):
 *                     disclosed as `tokenPricesFromISO`, and LIMITING (F4);
 *   NO_MARKET         none of its held days priced, and the vendor said (when
 *                     last asked): not listed, or thin — a LEGITIMATE unpriced
 *                     holding (owner clarification): disclosed and limiting;
 *   EXCLUDED          explicitly classified (tokenValuationExclusion) — never
 *                     valued, never limiting, visible and counted separately;
 *   NOT_VALUED_YET    none of its held days priced, for any other reason —
 *                     never quoted (sold before capture began), closes not yet
 *                     acquired, or closes that begin only AFTER it was last held
 *                     (held only before the vendor's price window — F4).
 *
 * VALUED_FROM_LATER and NOT_VALUED_YET keep the wallet from reading complete.
 * Inputs are read loosely (alias metadata: `quote`, `priceHistory`). A missing
 * price is never $0.
 */
export type ReconstructedTokenValuation = "NEVER_HELD" | "EXCLUDED" | "VALUED" | "VALUED_WITH_GAPS" | "VALUED_FROM_LATER" | "VALUED_UNTIL_EARLIER" | "NO_MARKET" | "NOT_VALUED_YET";

/** Closes may trail the last held day by this much (a daily tail not yet fetched; the day rule's d−1 fallback). */
export const CLOSES_END_TOLERANCE_DAYS = 3;
const minusDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

export interface ReconstructedTokenFacts {
  licence: { fromISO: string; toISO: string };
  /** When it was held (quantity > 0); `toISO` null = still held. Null = never held. */
  held: { fromISO: string; toISO: string | null } | null;
  /** Its first stored historical close (RAW_CLOSE only), or null. */
  closesFromISO: string | null;
  /**
   * Its latest stored historical close — RAW_CLOSE ONLY, the same row kind as
   * `closesFromISO` (delta review F3: a single recent INTRADAY quote must never
   * extend historical close coverage over the days before it). Null when none.
   */
  closesToISO?: string | null;
  /**
   * Every stored RAW_CLOSE date (any order). When supplied, interior held days
   * no close serves make the token VALUED_WITH_GAPS. Absent ⇒ not inspected.
   */
  closeDatesISO?: readonly string[];
}

const plusDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The days it was held, clamped to its licence; null when none lie inside it. */
export function tokenHeldWindow(f: Pick<ReconstructedTokenFacts, "licence" | "held">): { fromISO: string; toISO: string } | null {
  if (!f.held) return null;
  const fromISO = f.held.fromISO > f.licence.fromISO ? f.held.fromISO : f.licence.fromISO;
  const toISO = f.held.toISO === null || f.held.toISO > f.licence.toISO ? f.licence.toISO : f.held.toISO;
  return fromISO > toISO ? null : { fromISO, toISO };
}

/**
 * PURE (delta review F3) — the INTERIOR runs of days in [fromISO, toISO] that lie
 * between two stored closes yet are served by neither (the day rule serves d from
 * a close dated d or d−1). Days before the first / after the last close are the
 * VALUED_FROM_LATER / VALUED_UNTIL_EARLIER questions, not gaps. Sorted.
 */
export function tokenCloseGaps(closeDatesISO: readonly string[], fromISO: string, toISO: string): { fromISO: string; toISO: string }[] {
  const dates = [...new Set(closeDatesISO)].sort();
  const out: { fromISO: string; toISO: string }[] = [];
  for (let i = 0; i + 1 < dates.length; i++) {
    const a = plusDays(dates[i], 2), b = minusDays(dates[i + 1], 1);
    const from = a > fromISO ? a : fromISO, to = b < toISO ? b : toISO;
    if (from <= to) out.push({ fromISO: from, toISO: to });
  }
  return out;
}

export function reconstructedTokenValuation(f: ReconstructedTokenFacts, aliasMetadata: unknown): ReconstructedTokenValuation {
  if (!f.held) return "NEVER_HELD";
  // Owner clarification 2026-10-30 — only an EXPLICIT classification excludes a held token.
  if (tokenValuationExclusion(aliasMetadata)) return "EXCLUDED";
  const w = tokenHeldWindow(f);
  if (!w) return "NEVER_HELD"; // held only outside the licence: no licensed day to value
  const heldFrom = w.fromISO, heldTo = w.toISO;
  const closesTo = f.closesToISO === undefined ? null : f.closesToISO;
  // Closes that END before it was first held value none of its held days either.
  const endsBeforeHeld = closesTo !== null && closesTo < heldFrom;
  if (f.closesFromISO !== null && f.closesFromISO <= heldTo && !endsBeforeHeld) {
    if (f.closesFromISO > heldFrom) return "VALUED_FROM_LATER";
    if (closesTo !== null && closesTo < minusDays(heldTo, CLOSES_END_TOLERANCE_DAYS)) return "VALUED_UNTIL_EARLIER";
    if (f.closeDatesISO && tokenCloseGaps(f.closeDatesISO, heldFrom, heldTo).length > 0) return "VALUED_WITH_GAPS";
    return "VALUED";
  }
  // No close inside its held period: none of its held days is valued.
  return tokenHasNoMarket(aliasMetadata) ? "NO_MARKET" : "NOT_VALUED_YET";
}

/**
 * The vendor said — when last asked — it does not list the token, or lists it
 * below the liquidity floor (thin). A DESCRIPTION of why it is unpriced, used
 * for copy only. Owner clarification 2026-10-30: "no market price" does NOT
 * mean spam or worthless — such a held token is a legitimate unpriced holding
 * and its days are NOT complete valuations. It never excludes on its own.
 */
export function tokenHasNoMarket(aliasMetadata: unknown): boolean {
  const m = (aliasMetadata && typeof aliasMetadata === "object" ? aliasMetadata : {}) as {
    quote?: { outcome?: unknown; pricedAt?: unknown }; priceHistory?: { outcome?: unknown };
  };
  const q = m.quote?.outcome;
  if (q === "THIN") return true;
  if (m.priceHistory?.outcome === "UNLISTED") return true;
  return (q === "UNLISTED" || q === "INVALID") && typeof m.quote?.pricedAt !== "string";
}

/**
 * OWNER CLARIFICATION 2026-10-30 — the ONLY way a HELD token leaves valuation
 * completeness: an EXPLICIT, defensible classification recorded on its alias
 * (`metadata.exclusion = { kind: "SPAM" | "NON_ECONOMIC" | "EXCLUDED", source, atISO }`)
 * by a provider flag, a denylist, or an operator/user decision. NO heuristic
 * lives here, and nothing in the codebase WRITES this field today (no captured
 * provider spam flag, no denylist, no user exclusion exists) — so in practice
 * only NEVER_HELD tokens are excluded. An excluded token stays visible and is
 * counted separately ("N tokens excluded as spam"), never mixed with
 * legitimate unpriced holdings.
 */
export type TokenExclusionKind = "SPAM" | "NON_ECONOMIC" | "EXCLUDED";
export function tokenValuationExclusion(aliasMetadata: unknown): { kind: TokenExclusionKind; source: string } | null {
  const e = (aliasMetadata as { exclusion?: { kind?: unknown; source?: unknown } } | null)?.exclusion;
  // Any non-empty `source` is accepted only because no writer exists yet. The
  // first writer added (provider flag, denylist, operator/user decision) must
  // also fix the allow-list of accepted sources here, so an arbitrary string can
  // never exclude a held token from valuation completeness.
  if (!e || typeof e.source !== "string" || !e.source.trim()) return null; // unattributed ⇒ not a classification
  return e.kind === "SPAM" || e.kind === "NON_ECONOMIC" || e.kind === "EXCLUDED" ? { kind: e.kind, source: e.source } : null;
}

/**
 * OWNER RULING 2026-10-30 — the DAY rule for tokens, matching native's
 * all-or-nothing crypto valuation: a day on which a HELD token (fresh quantity
 * > 0) that has a market lacks a price serving that day (UNPRICED — only a row
 * dated d or d−1 serves d, so one EARLIER price never covers later days) is not
 * a complete valuation day. Regeneration then refuses the day's crypto
 * component exactly as it does for an unpriced native asset (verdict
 * "unavailable"; the stored value preserved, never an understated total, never
 * $0). Only an EXPLICITLY excluded token (tokenValuationExclusion) and a
 * closed (0) token never block — NO_MARKET / thin / unlisted DO block (owner
 * clarification 2026-10-30). A STALE quantity is a quantity question, not a
 * price one, and keeps its existing treatment.
 */
export function tokenDayMissingRequiredPrice(
  tokens: ReadonlyArray<Pick<TokenDayValue, "instrumentId" | "state">>,
  excluded: (instrumentId: string) => boolean,
): boolean {
  return tokens.some((t) => t.state === "UNPRICED" && !excluded(t.instrumentId));
}

/**
 * PR #122 delta review F1 — THE DAY'S HELD-BUT-UNVALUED FACT, independent of
 * today's balance.
 *
 * Regeneration's crypto refusal used to fire only when the wallet's CURRENT
 * (flat) balance was material — so a wallet emptied today whose history held an
 * unpriced token (or an unpriced native asset) refused nothing, and the day's
 * crypto was written as the flat ≈ $0. This answers, from the DAY's own evidence:
 * did the day hold a material asset (an unpriced held token with a market, or a
 * native position the day valuation could not value, or a held token on a day
 * native valuation was refused so tokens never reached the total) that has no
 * value? True ⇒ the day's crypto is "unavailable" — preserved, never $0.
 *
 *   · an EXPLICITLY excluded token never blocks (tokenValuationExclusion);
 *   · a NO_MARKET / thin / unlisted held token DOES block (owner clarification);
 *   · a never-held / closed / not-yet-observed token never blocks;
 *   · a STALE token quantity keeps its existing (quantity) treatment.
 */
export function cryptoDayHeldUnvalued(f: {
  /** The native day valuation (valueCryptoDay), or null when the Space has no crypto account. */
  native: { licensed: boolean; positionCount: number } | null;
  tokens: ReadonlyArray<Pick<TokenDayValue, "instrumentId" | "state">>;
  excluded: (instrumentId: string) => boolean;
}): { tokenPriceMissing: boolean; heldUnvalued: boolean } {
  const tokenPriceMissing = tokenDayMissingRequiredPrice(f.tokens, f.excluded);
  const heldToken = f.tokens.some((t) => (t.state === "VALUED" || t.state === "UNPRICED") && !f.excluded(t.instrumentId));
  const nativeRefused = f.native !== null && !f.native.licensed;
  const nativeHeldUnvalued = nativeRefused && f.native!.positionCount > 0;
  return { tokenPriceMissing, heldUnvalued: tokenPriceMissing || nativeHeldUnvalued || (nativeRefused && heldToken) };
}

/**
 * PR #122 delta re-review F2 — THE BINDING'S WHOLE TOKEN DAY DECISION, pure.
 *
 * Regeneration used to build the gate's token input inline (and only a source
 * regex pinned it). This is that construction, so a behavioural test runs the
 * exact rows → tokens → gate → "may tokens join the total" path the binding
 * runs. `rows` is the shape `loadTokenDayRows` returns (null when the Space has
 * no token rows); `native` is the day's native valuation.
 */
export interface TokenDayRowsLike {
  observationsByAccount: ReadonlyMap<string, readonly TokenObservationRow[]>;
  prices: readonly TokenPriceRow[];
  identity: ReadonlyMap<string, { excluded?: boolean }>;
}
export function cryptoTokenDayDecision(
  native: { licensed: boolean; positionCount: number },
  rows: TokenDayRowsLike | null,
  dISO: string,
): { heldUnvalued: boolean; tokenPriceMissing: boolean; tokensJoin: boolean; valuedTokenUsd: number[] } {
  const tokens: TokenDayValue[] = [];
  const excluded = (id: string) => rows?.identity.get(id)?.excluded === true; // explicit classification only
  if (rows) for (const obs of rows.observationsByAccount.values()) tokens.push(...tokensValueOnDay(obs, rows.prices, dISO).tokens);
  const gate = cryptoDayHeldUnvalued({ native, tokens, excluded });
  // Tokens join the day's total only where native is itself valued and no held token is unpriced.
  const tokensJoin = native.licensed && !gate.tokenPriceMissing;
  const valuedTokenUsd = tokensJoin
    ? tokens.filter((v) => v.state === "VALUED" && v.valueUsd !== null && !excluded(v.instrumentId)).map((v) => v.valueUsd!)
    : [];
  return { ...gate, tokensJoin, valuedTokenUsd };
}

/** Does this state keep the wallet's history from reading complete? */
export function tokenValuationLimits(v: ReconstructedTokenValuation): boolean {
  return v === "NOT_VALUED_YET" || v === "VALUED_FROM_LATER" || v === "VALUED_UNTIL_EARLIER" || v === "VALUED_WITH_GAPS" || v === "NO_MARKET";
}
