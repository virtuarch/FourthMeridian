/**
 * lib/investments/legacy-crypto-holdings.ts
 *
 * TEMPORARY crypto-only compatibility read — DELETE at P2-6.
 *
 * P2-5 cut the data Export off the general legacy `Holding` read model onto the
 * canonical `getCurrentPositions()` seam. That seam is fed by the
 * PositionObservation spine, which today covers Plaid / brokerage positions
 * (lib/investments/position-capture.ts `capturePositionObservations`) but NOT
 * self-custody crypto wallets: lib/crypto/btc-sync.ts `writeBtcHolding` still
 * writes a wallet's BTC position ONLY as a legacy `Holding` row, never a
 * PositionObservation. A purely canonical export would therefore silently drop
 * crypto until the crypto spine writer (P2-6) lands.
 *
 * This module is the narrow, isolated bridge that keeps crypto visible in the
 * meantime. It reads ONLY self-custody wallet Holdings — `financialAccount.
 * walletChain != null`, the exact set btc-sync writes. That set has, by
 * construction, NO PositionObservation, so these rows can never overlap the
 * canonical `getCurrentPositions` rows (no double counting) and this path can
 * never return a Plaid / brokerage position. Visibility is the same FULL-only
 * per-item DETAIL predicate (TRANSACTION_DETAIL_VISIBILITY) the canonical seam
 * and getHoldings enforce — a BALANCE_ONLY / SUMMARY_ONLY / revoked / deleted
 * account exposes nothing.
 *
 * P2-6 handoff: once crypto positions flow through PositionObservation /
 * getCurrentPositions, DELETE this file and its single call site in
 * lib/export/assemble.ts. The source-scan guard in lib/export/holdings.test.ts
 * pins that Export's ONLY remaining legacy `Holding` reader is this crypto-only
 * path — nothing else.
 */

import "server-only";
import { ShareStatus, type Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { TRANSACTION_DETAIL_VISIBILITY } from "@/lib/ai/visibility";

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * One self-custody wallet position, straight off the legacy `Holding` row. Values
 * are native / quote currency (e.g. USD for a BTC wallet) — this bridge performs
 * NO valuation or FX of its own; it is a passthrough, not a second authority.
 */
export interface LegacyCryptoPosition {
  /** Legacy Holding row id — the export's stable per-row dedup key for crypto. */
  holdingId:          string;
  financialAccountId: string;
  symbol:             string | null;
  name:               string | null;
  quantity:           number | null;
  /** Native / quote-currency unit price (Holding.price). */
  price:              number | null;
  /** Value in the native / quote currency (Holding.value). */
  value:              number | null;
  /** ISO code of `price` / `value` (the quote currency; null residue possible). */
  currency:           string | null;
  isCash:             boolean;
}

/**
 * The FULL-visible self-custody wallet positions for a Space, read from legacy
 * `Holding`. See the module header — crypto-only, disjoint from the canonical
 * position spine, removed at P2-6.
 */
export async function readLegacyCryptoWalletPositions(
  scope:   { spaceId: string },
  client:  Client = db,
): Promise<LegacyCryptoPosition[]> {
  const rows = await client.holding.findMany({
    where: {
      financialAccountId: { not: null },
      financialAccount: {
        deletedAt:   null,
        // Self-custody wallets ONLY. Plaid / brokerage accounts never carry a
        // walletChain, so this can never surface a non-crypto position, and the
        // wallet set has no PositionObservation, so it can never double-count a
        // canonical getCurrentPositions row.
        walletChain: { not: null },
        // Same per-item DETAIL gate (FULL) as getCurrentPositions / getHoldings.
        spaceAccountLinks: {
          some: {
            spaceId:         scope.spaceId,
            status:          ShareStatus.ACTIVE,
            visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY },
          },
        },
      },
    },
    select: {
      id: true, financialAccountId: true, symbol: true, name: true,
      quantity: true, price: true, value: true, currency: true, isCash: true,
    },
  });

  return rows.map((r) => ({
    holdingId:          r.id,
    financialAccountId: r.financialAccountId as string,
    symbol:             r.symbol,
    name:               r.name,
    quantity:           r.quantity,
    price:              r.price,
    value:              r.value,
    currency:           r.currency ?? null,
    isCash:             r.isCash,
  }));
}
