/**
 * lib/export/holdings.ts  (P2-5)
 *
 * PURE projection of investment positions into the export DTO. No DB, no clock —
 * unit-testable in isolation (lib/export/holdings.test.ts). Two sources, one shape:
 *
 *   1. `toExportHoldingFromPosition` — a canonical current-position row
 *      (getCurrentPositions). This is the authority: value/FX/completeness all
 *      already computed. Native value stays in the export's `value`/`currency`
 *      (preserving the pre-P2-5 native-currency contract) and the FX-converted
 *      figure is ADDED as `reportingValue` in the Space reporting currency.
 *
 *   2. `toExportHoldingFromLegacyCrypto` — a self-custody wallet position off the
 *      legacy `Holding` bridge (lib/investments/legacy-crypto-holdings.ts). Native
 *      (quote) value only; `reportingValue` is null because this bridge performs
 *      no FX of its own. Removed with the bridge at P2-6.
 *
 * Doctrine: an unvalued position is retained with a null value — NEVER 0. Nulls
 * flow through to blank CSV cells (lib/export/csv.ts).
 */

import type { CurrentPositionRow } from "@/lib/investments/current-positions-core";
import type { LegacyCryptoPosition } from "@/lib/investments/legacy-crypto-holdings";
import type { ExportHolding } from "@/lib/export/types";

/** Canonical current-position row → export holding (native value + added reporting value). */
export function toExportHoldingFromPosition(row: CurrentPositionRow, spaceId: string): ExportHolding {
  return {
    id:                `${row.accountId}:${row.instrumentId}`,
    accountId:         row.accountId,
    symbol:            row.symbol,
    name:              row.name,
    quantity:          row.quantity,
    // NATIVE (quote) currency figures — preserves the pre-P2-5 `value`-in-`currency`
    // contract. `reportingValue` below is the additive FX-converted figure.
    price:             row.nativePrice,
    value:             row.nativeValue,
    currency:          row.currency,
    reportingValue:    row.reportingValue,
    reportingCurrency: row.reportingCurrency,
    costBasis:         row.costBasis,
    isCash:            row.isCash,
    spaceId,
    source:            "canonical",
  };
}

/**
 * Legacy self-custody wallet position → export holding. Native/quote value only;
 * `reportingValue` is null (no FX in the bridge). `reportingCurrency` is carried
 * for column consistency with canonical rows. P2-6 removes this path.
 */
export function toExportHoldingFromLegacyCrypto(
  pos:               LegacyCryptoPosition,
  spaceId:           string,
  reportingCurrency: string,
): ExportHolding {
  return {
    id:                pos.holdingId,
    accountId:         pos.financialAccountId,
    symbol:            pos.symbol,
    name:              pos.name,
    quantity:          pos.quantity,
    price:             pos.price,
    value:             pos.value,
    currency:          pos.currency,
    reportingValue:    null,
    reportingCurrency,
    costBasis:         null,
    isCash:            pos.isCash,
    spaceId,
    source:            "crypto-compat",
  };
}

/**
 * Merge one Space's canonical positions and its crypto-bridge positions into the
 * export holdings, keeping the two sources DISJOINT BY ACCOUNT so nothing double
 * counts. Wallet accounts belong entirely to the crypto bridge until P2-6 — the
 * observation backfill (scripts/backfill-position-observations.ts) can mint a
 * PositionObservation from a wallet's `Holding`, which would otherwise let the
 * same wallet surface through BOTH paths, so canonical rows for any wallet account
 * are dropped here. Pure — the caller supplies the rows and the Space
 * reporting currency. P2-6: drop the crypto args and this becomes a passthrough.
 */
export function mergeSpaceExportHoldings(args: {
  canonicalRows:     readonly CurrentPositionRow[];
  cryptoPositions:   readonly LegacyCryptoPosition[];
  spaceId:           string;
  reportingCurrency: string;
}): ExportHolding[] {
  const { canonicalRows, cryptoPositions, spaceId, reportingCurrency } = args;
  const walletAccountIds = new Set(cryptoPositions.map((c) => c.financialAccountId));
  const out: ExportHolding[] = [];
  for (const row of canonicalRows) {
    if (walletAccountIds.has(row.accountId)) continue; // owned by the crypto bridge
    out.push(toExportHoldingFromPosition(row, spaceId));
  }
  for (const c of cryptoPositions) {
    out.push(toExportHoldingFromLegacyCrypto(c, spaceId, reportingCurrency));
  }
  return out;
}
