/**
 * lib/snapshots/crypto-valuation-status.core.ts
 *
 * V26-CRYPTO-STATUS-1 — THE ONE VOCABULARY FOR HISTORICAL CRYPTO AVAILABILITY.
 *
 * Pure: no Prisma, no DB, no clock, no network.
 *
 * ── What the scalar means ────────────────────────────────────────────────────
 * `SpaceSnapshot.cryptoValuationStatus` AUTHORIZES the row's already-persisted
 * `crypto` number. It does not replace it, restate it, or carry a second copy of
 * it. The number stays exactly where it is; this says whether anything may
 * assert it.
 *
 * That separation is deliberate. `SpaceSnapshot.crypto` is NOT NULL DEFAULT 0,
 * so the column itself cannot express "unknown", and writing 0 would assert an
 * absence no evidence supports — the same defect inverted. Until the numeric
 * column can be nullable (a much larger change, since `netWorth` and
 * `totalAssets` are arithmetically composed from it), the honest move is to keep
 * the number and remove its authority.
 *
 * ── Why PERSISTED rather than derived ────────────────────────────────────────
 * The only runtime discriminator available is the price archive's floor, and the
 * floor MOVES. Acquire a paid tier and backfill earlier prices and the floor
 * drops — but acquiring prices does not rewrite snapshots, so every stale row
 * would silently be re-blessed as "supported" while still holding a carried
 * balance. A derived test is therefore unsafe under provider widening, however
 * carefully it is written.
 *
 * A stamped status records what THIS row's valuation actually was, at the moment
 * it was computed, by the writer that computed it. Widening becomes safe by
 * construction: nothing changes until a regeneration re-derives the day, and
 * that regeneration is exactly what stamps `supported`.
 *
 * Nothing here is keyed to BTC, to CoinGecko, to a tier, or to a date.
 *
 * ── Not a Completeness envelope ──────────────────────────────────────────────
 * One scalar on the fact row, per the ratified anti-`FinancialState` ruling and
 * the established pattern (`PositionObservation.completeness`,
 * `PositionReconstruction.completeness`). No JSON, no new table, no reasons
 * array.
 */

/**
 * The STORED vocabulary — exactly what may appear in the column. `null` is a
 * third state and is deliberately NOT a member: it means "never recorded", which
 * is a fact about the row's age, not a classification the writer chose.
 */
export const CRYPTO_VALUATION_STATUSES = ["supported", "unavailable"] as const;
export type CryptoValuationStatus = (typeof CRYPTO_VALUATION_STATUSES)[number];

/**
 * Write-time guard — mirrors `isCompletenessTier`. Every writer routes its value
 * through this so no parallel vocabulary ("SUPPORTED", "ok", "missing") can ever
 * reach the column.
 */
export function isCryptoValuationStatus(value: unknown): value is CryptoValuationStatus {
  return (
    typeof value === "string" &&
    (CRYPTO_VALUATION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Normalise a value on its way to the database: a member passes through,
 * anything else becomes `null`. Unrecorded is always a safe state — it resolves
 * to `legacy-unrecorded` and is NOT automatically trusted — whereas a malformed
 * string that slipped through would be. Total, never throws.
 */
export function toStoredCryptoValuationStatus(value: unknown): CryptoValuationStatus | null {
  return isCryptoValuationStatus(value) ? value : null;
}

/**
 * A crypto component at or below this is "no crypto", not an unvalued one.
 * The SAME epsilon the Investments series uses (see portfolio-series.ts), kept
 * here so the read boundary and the series cannot drift apart.
 */
export const CRYPTO_MATERIALITY_EPSILON = 0.5;

/**
 * The RESOLVED state every consumer sees. Strictly richer than the stored
 * vocabulary: it folds in observation and materiality, which are properties of
 * the row rather than of the writer's decision.
 *
 *   observed          — an OBSERVED row (isEstimated === false). Its crypto is a
 *                       real balance observation and is trusted unconditionally,
 *                       whatever the status column says. This is what protects
 *                       the frozen rows in other users' Spaces from any
 *                       date-based rule.
 *   supported         — estimated, and the writer valued crypto from licensed
 *                       quantity × historical price.
 *   unavailable       — estimated, a material holding existed, and historical
 *                       valuation was refused or impossible.
 *   legacy-unrecorded — estimated, status never recorded, material crypto. NOT
 *                       automatically trusted: the row predates this scalar and
 *                       nothing attests to how its number was produced.
 *   none              — no material crypto. A legitimate zero.
 */
export type CryptoValuationState =
  | "observed"
  | "supported"
  | "unavailable"
  | "legacy-unrecorded"
  | "none";

export interface CryptoValuationInput {
  /** The row's persisted crypto component. */
  crypto: number;
  /** The row's isEstimated flag. False ⇒ an observation. */
  isEstimated: boolean;
  /** The persisted status column, or null when never recorded. */
  cryptoValuationStatus: string | null;
}

/**
 * Resolve one row's crypto state. Total and deterministic.
 *
 * ORDER IS LOAD-BEARING. Observation is checked FIRST, before status and before
 * materiality, so an observed row can never be invalidated by a missing status
 * or by any rule about dates. Materiality is checked before the legacy fallback
 * so a Space with no crypto is never described as "unrecorded".
 *
 * Deliberately does NOT consult a price floor, a provider, or a calendar. Those
 * move; this must not.
 */
export function resolveCryptoValuationState(input: CryptoValuationInput): CryptoValuationState {
  const { crypto, isEstimated, cryptoValuationStatus } = input;

  // 1 — an observation is trusted unconditionally.
  if (isEstimated === false) return "observed";

  const material = Number.isFinite(crypto) && Math.abs(crypto) > CRYPTO_MATERIALITY_EPSILON;

  // 2/3 — the writer recorded what it did.
  if (cryptoValuationStatus === "supported")   return material ? "supported" : "none";
  if (cryptoValuationStatus === "unavailable") return "unavailable";

  // 5 — no material crypto is a legitimate zero, recorded or not.
  if (!material) return "none";

  // 4 — material crypto with no recorded status: not automatically trusted.
  return "legacy-unrecorded";
}

/**
 * May this row's crypto number be asserted as a value?
 *
 * `observed`, `supported` and `none` are assertable — `none` because zero IS the
 * evidenced answer there. `unavailable` and `legacy-unrecorded` are not.
 */
export function isCryptoAssertable(state: CryptoValuationState): boolean {
  return state === "observed" || state === "supported" || state === "none";
}

/**
 * Is this row's ASSET SIDE contaminated by an unassertable crypto component?
 *
 * `netWorth` and `totalAssets` are arithmetically composed WITH `crypto`, so an
 * unassertable component does not merely make the crypto slice wrong — it makes
 * both derived totals wrong, and by no small margin. Measured on this database:
 * the unassertable component is 41.7%–99.9% of `totalAssets` across the affected
 * rows, averaging 53.5%.
 *
 * That is why consumers of those totals must REFUSE the point rather than label
 * it. A caveat attached to a figure that is 99.9% fabricated is a disclaimer on
 * fiction, not a qualification of a measurement.
 *
 * Components that never touched crypto — cash, savings, debt, netLiquid — remain
 * valid on the same row and stay available to Liquidity and Debt.
 */
export function isAssetSideContaminated(state: CryptoValuationState): boolean {
  return !isCryptoAssertable(state);
}

/** Stable machine-readable reason for a refusal. Null when nothing is refused. */
export function cryptoUnavailableReason(state: CryptoValuationState): string | null {
  if (state === "unavailable") {
    return "HISTORICAL_CRYPTO_VALUATION_UNAVAILABLE";
  }
  if (state === "legacy-unrecorded") {
    return "HISTORICAL_CRYPTO_VALUATION_UNRECORDED";
  }
  return null;
}
