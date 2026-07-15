/**
 * lib/crypto/wallet-position-capture.ts
 *
 * P2-6 — the crypto wallet PositionObservation writer. The A1 analogue for
 * self-custody: a successful wallet balance observation writes ONE OBSERVED
 * `PositionObservation` per (account, canonical-asset-Instrument, date) onto the
 * canonical spine, so `getCurrentPositions()` sees crypto without a legacy
 * `Holding` compatibility reader.
 *
 * Valuation doctrine (P2-6 Part 4): the observation carries QUANTITY ONLY — no
 * institution price/value anchor. Crypto is valued exactly as brokerage positions
 * are in Precedence 3: quantity × the canonical RAW_CLOSE `PriceObservation` (the
 * coingecko series btc-price.ts writes, against the SAME Instrument this resolves)
 * × FX. We do NOT embed a `nativeBalance × wallet-spot` figure as an institution
 * value — that would be a second crypto valuation calculation and would diverge
 * from how Wealth already values crypto (nativeBalance × readBtcUsdAsOf). When no
 * price is available the position is UNVALUED and disclosed, never zeroed
 * (valuation-core honesty). `costBasis` is null unless genuinely known (a balance
 * observation never knows it). This is NOT event-level evidence — no InvestmentEvent
 * is written from a balance (see btc-sync.ts).
 *
 * Zero balance: a wallet that drains to 0 writes an explicit `quantity: 0` OBSERVED
 * row — the same closure doctrine position-capture uses for a disappeared holding;
 * valuation excludes a zero quantity, so the position drops out honestly while its
 * dated zero is recorded.
 *
 * Idempotent: the composite unique (financialAccountId, instrumentId, date, origin,
 * source) makes a same-day re-sync an in-place update, never a duplicate row. Prior
 * days are never rewritten.
 *
 * Gated behind INVESTMENT_OBSERVATIONS_ENABLED (reused from position-capture) —
 * absent/false ⇒ zero spine writes, byte-identical legacy sync. Best-effort/
 * non-fatal by contract: callers wrap this in try/catch (the writeBtcHolding
 * precedent).
 */

import { PositionOrigin, type Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { resolveCryptoInstrumentId, type CryptoAsset } from "@/lib/investments/crypto-instrument";
import { investmentObservationsEnabled } from "@/lib/investments/position-capture";

type Client = PrismaClient | Prisma.TransactionClient;

/** The PositionObservation.source stamped on self-custody wallet observations. */
export const WALLET_POSITION_SOURCE = "wallet";

/** The observed facts a wallet balance supplies — quantity only (no anchors). */
export interface WalletObservedFacts {
  quantity:         number;
  institutionPrice: null;
  institutionValue: null;
  institutionPriceAsOf: null;
  costBasis:        null;
  vestedQuantity:   null;
  currency:         string | null;
  isCash:           false;
}

/**
 * Pure: the observation facts for a wallet balance. Quantity-only — every anchor
 * and cost-basis field is null by construction (a balance observation knows the
 * quantity and the quote currency, nothing more). Exported for unit tests that
 * assert "no institution anchor, no invented cost basis" holds unconditionally.
 */
export function buildWalletObservedFacts(quantity: number, currency: string | null): WalletObservedFacts {
  return {
    quantity,
    institutionPrice:     null,
    institutionValue:     null,
    institutionPriceAsOf: null,
    costBasis:            null,
    vestedQuantity:       null,
    currency,
    isCash:               false,
  };
}

/** Truncate to a UTC date (00:00:00) so all of a day's captures share one key. */
export function normalizeObservationDate(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export interface CaptureWalletPositionParams {
  financialAccountId: string;
  /** The canonical asset held in this wallet (identity resolves to ONE Instrument). */
  asset: CryptoAsset;
  /** Observed quantity in native asset units (e.g. BTC). Zero writes a closure row. */
  quantity: number;
  /** Observation (capture) date — the sync date, NOT a fabricated history date. */
  date: Date;
  client?: Client;
}

export interface CaptureWalletPositionResult {
  written:      boolean; // false ⇒ gate off (no spine write attempted)
  instrumentId: string | null;
}

/**
 * Capture a wallet's current balance as a canonical OBSERVED PositionObservation.
 * Resolves the ONE canonical asset Instrument (shared across every wallet holding
 * the asset), then upserts the dated quantity. Idempotent; gated; the caller wraps
 * it non-fatally.
 */
export async function captureWalletPosition(
  params: CaptureWalletPositionParams,
): Promise<CaptureWalletPositionResult> {
  if (!investmentObservationsEnabled()) return { written: false, instrumentId: null };

  const client = params.client ?? db;
  const date = normalizeObservationDate(params.date);
  const instrumentId = await resolveCryptoInstrumentId(params.asset, { client });
  const facts = buildWalletObservedFacts(params.quantity, params.asset.currency);

  await client.positionObservation.upsert({
    where: {
      financialAccountId_instrumentId_date_origin_source: {
        financialAccountId: params.financialAccountId,
        instrumentId,
        date,
        origin: PositionOrigin.OBSERVED,
        source: WALLET_POSITION_SOURCE,
      },
    },
    create: {
      financialAccountId: params.financialAccountId,
      instrumentId,
      date,
      origin: PositionOrigin.OBSERVED,
      source: WALLET_POSITION_SOURCE,
      ...facts,
    },
    update: facts,
  });

  return { written: true, instrumentId };
}
