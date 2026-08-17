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
import { excludeCanonicalAccounts } from "@/lib/investments/canonical-precedence.core";

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
 * counts.
 *
 * REVIEW-3 (matrix row 26) — CANONICAL WINS, converged with the AI assembler.
 * P2-6 writes BTC wallet balances onto the PositionObservation spine, so a
 * wallet can be present in BOTH sources. This merge previously applied the
 * OPPOSITE precedence to the AI's (it dropped the CANONICAL row and kept the
 * legacy one), so Export and the AI could disagree about the same wallet. Both
 * consumers now share the ONE rule in
 * lib/investments/canonical-precedence.core.ts: every canonical row is kept
 * (value/FX/completeness already computed on the spine), and a bridge position
 * survives ONLY when the canonical seam has no row for that custody account —
 * the bridge is a fallback, never an override. Pure — the caller supplies the
 * rows and the Space reporting currency. P2-6 completion: drop the crypto args
 * and this becomes a passthrough.
 */
export function mergeSpaceExportHoldings(args: {
  canonicalRows:     readonly CurrentPositionRow[];
  cryptoPositions:   readonly LegacyCryptoPosition[];
  spaceId:           string;
  reportingCurrency: string;
}): ExportHolding[] {
  const { canonicalRows, cryptoPositions, spaceId, reportingCurrency } = args;
  const canonicalAccountIds = new Set(canonicalRows.map((r) => r.accountId));
  const out: ExportHolding[] = [];
  for (const row of canonicalRows) {
    out.push(toExportHoldingFromPosition(row, spaceId));
  }
  // Canonical wins — the SAME shared rule the AI binding applies
  // (excludeCanonicalCryptoAccounts in lib/ai/assemblers/holdings-core.ts).
  for (const c of excludeCanonicalAccounts(cryptoPositions, canonicalAccountIds)) {
    out.push(toExportHoldingFromLegacyCrypto(c, spaceId, reportingCurrency));
  }
  return out;
}
