/**
 * lib/crypto/historical-crypto-valuation.core.ts
 *
 * V26-S3-DETAIL — THE historical crypto valuation for one day, as POSITIONS.
 *
 * Pure: no Prisma, no DB, no clock, no network.
 *
 * ── Why this was extracted ───────────────────────────────────────────────────
 * Snapshot regeneration valued the day's crypto inline, as a single total, and
 * nothing else could reproduce it. A drill-down therefore had two bad options:
 * recompute crypto its own way (a second engine, guaranteed to disagree
 * eventually) or read the stored column and present it as an unexplained lump.
 *
 * The arithmetic is trivial — native quantity × the day's price — so the value
 * of extracting it is not the sum. It is that the SAME call produces the total
 * the snapshot stores AND the per-position breakdown a user can inspect, so the
 * two can never describe different portfolios.
 *
 * ── What this does NOT decide ────────────────────────────────────────────────
 * Whether the day may be valued at all. Two independent licences gate that and
 * both live with their own authorities:
 *   · a PRICE must have reached the day (the archive's answer);
 *   · the constant-quantity carry must be licensed — which since S1 also
 *     requires the wallet's movement ledger to reconcile.
 * The caller resolves both and passes the verdict in. An unlicensed day yields
 * NO positions and NO total, never a carried balance.
 */

/** One crypto account's native holding, as the caller already has it. */
export interface CryptoAccountBalance {
  financialAccountId: string;
  name:               string;
  /** Native units (BTC). Null/0 ⇒ nothing held. */
  nativeBalance:      number | null;
  /** Chain symbol for display; the price is supplied per unit of it. */
  symbol:             string;
}

/** One crypto position on one date, explained. */
export interface CryptoPositionValuation {
  financialAccountId: string;
  accountName:        string;
  symbol:             string;
  quantity:           number;
  /** Native-currency (USD) unit price used. */
  unitPrice:          number;
  /** quantity × unitPrice, in the price's currency (USD). */
  nativeValue:        number;
}

export interface CryptoDayValuation {
  /** Empty when the day is not licensed — never a zero-valued position. */
  positions: CryptoPositionValuation[];
  /** Σ nativeValue. Meaningful only when `licensed`. */
  nativeTotal: number;
  /** How many crypto positions EXISTED on this day (the denominator's share). */
  positionCount: number;
  licensed: boolean;
  /** Coded reason when not licensed. */
  refusal: "NO_PRICE" | "QUANTITY_UNLICENSED" | null;
}

export interface CryptoDayInput {
  accounts: readonly CryptoAccountBalance[];
  /** The day's price per native unit, or null when none reached the day. */
  unitPrice: number | null;
  /** Did the constant-quantity carry licence (incl. ledger completeness) pass? */
  quantityLicensed: boolean;
  /** Below this, a balance is not a position. Mirrors the crypto materiality floor. */
  materialityEpsilon?: number;
}

const DEFAULT_MATERIALITY = 0;

/**
 * Value every crypto account on one day. Total and deterministic; never throws.
 *
 * Positions are emitted in account-id order so the breakdown and the total are
 * built in one pass, in one order, and cannot describe different sets.
 *
 * A wallet with no material balance is not a position and is absent from BOTH
 * the count and the total — it is not a zero-valued holding, it is not a
 * holding.
 */
export function valueCryptoDay(input: CryptoDayInput): CryptoDayValuation {
  const eps = input.materialityEpsilon ?? DEFAULT_MATERIALITY;
  const held = [...input.accounts]
    .filter((a) => Math.abs(a.nativeBalance ?? 0) > eps)
    .sort((a, b) => a.financialAccountId.localeCompare(b.financialAccountId));

  if (input.unitPrice == null || !Number.isFinite(input.unitPrice) || input.unitPrice <= 0) {
    return { positions: [], nativeTotal: 0, positionCount: held.length, licensed: false, refusal: "NO_PRICE" };
  }
  if (!input.quantityLicensed) {
    return { positions: [], nativeTotal: 0, positionCount: held.length, licensed: false, refusal: "QUANTITY_UNLICENSED" };
  }

  const positions = held.map((a) => {
    const quantity = a.nativeBalance ?? 0;
    return {
      financialAccountId: a.financialAccountId,
      accountName:        a.name,
      symbol:             a.symbol,
      quantity,
      unitPrice:          input.unitPrice!,
      nativeValue:        quantity * input.unitPrice!,
    };
  });

  return {
    positions,
    nativeTotal:   positions.reduce((n, p) => n + p.nativeValue, 0),
    positionCount: positions.length,
    licensed:      true,
    refusal:       null,
  };
}
