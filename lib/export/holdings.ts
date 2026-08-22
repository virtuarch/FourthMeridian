/**
 * lib/export/holdings.ts  (P2-5)
 *
 * PURE projection of investment positions into the export DTO. No DB, no clock —
 * unit-testable in isolation (lib/export/holdings.test.ts). ONE source, one shape
 * (W5 — P2-6 executed):
 *
 *   `toExportHoldingFromPosition` — a canonical current-position row
 *   (getCurrentPositions). This is the authority: value/FX/completeness all
 *   already computed. Native value stays in the export's `value`/`currency`
 *   (preserving the pre-P2-5 native-currency contract) and the FX-converted
 *   figure is ADDED as `reportingValue` in the Space reporting currency.
 *   Crypto wallets arrive through this same seam as spine observations valued
 *   at dated archive prices; the legacy `Holding` bridge and its
 *   `toExportHoldingFromLegacyCrypto` projection were DELETED with it — a
 *   wallet without observations is honestly absent from the export.
 *
 * Doctrine: an unvalued position is retained with a null value — NEVER 0. Nulls
 * flow through to blank CSV cells (lib/export/csv.ts).
 */

import type { CurrentPositionRow } from "@/lib/investments/current-positions-core";
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
 * One Space's canonical positions → export holdings. W5 (P2-6 executed): the
 * crypto-bridge merge this function once performed is gone — its own doc said
 * "P2-6 completion: drop the crypto args and this becomes a passthrough", and
 * it now is one. The name survives so the call site and its test read as the
 * ONE projection point for a Space's positions; the CANONICAL-WINS dedup rule
 * retired with the second source (there is nothing left to deduplicate).
 */
export function mergeSpaceExportHoldings(args: {
  canonicalRows: readonly CurrentPositionRow[];
  spaceId:       string;
}): ExportHolding[] {
  const { canonicalRows, spaceId } = args;
  return canonicalRows.map((row) => toExportHoldingFromPosition(row, spaceId));
}
