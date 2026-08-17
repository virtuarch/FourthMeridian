/**
 * lib/investments/canonical-precedence.core.ts
 *
 * REVIEW-3 (matrix row 26) — THE ONE dedup rule for a wallet that is present on
 * BOTH the canonical position spine (PositionObservation → getCurrentPositions)
 * and the transitional legacy `Holding` bridge
 * (lib/investments/legacy-crypto-holdings.ts).
 *
 * RULE — CANONICAL WINS. The legacy bridge is a FALLBACK only, for a custody
 * account the canonical seam has no observation for. A wallet already on the
 * spine is supplied ONCE, by canonical; a wallet not yet on the spine is
 * supplied ONCE, by the bridge. The dedup boundary is the FinancialAccount
 * (custody) identity, NOT the asset symbol: two DIFFERENT BTC wallets both
 * remain valid positions, but the SAME wallet must never be counted from both
 * sources.
 *
 * Before this module the two consumers applied OPPOSITE precedence — the data
 * Export dropped canonical rows (legacy won) while the AI assembler dropped
 * bridge rows (canonical won) — so Export and the AI could disagree about the
 * same wallet. Both now converge here:
 *   - lib/ai/assemblers/holdings-core.ts (`excludeCanonicalCryptoAccounts`)
 *   - lib/export/holdings.ts             (`mergeSpaceExportHoldings`)
 *
 * PURE — no DB, no clock, fixture-testable, importable from both the pure AI
 * core and the pure export projection without dragging in a Prisma client.
 */

/**
 * Drop legacy-bridge positions whose custody account is ALREADY represented on
 * the canonical position spine (canonical wins). The caller supplies the
 * canonical account-id set from `getCurrentPositions().rows`.
 */
export function excludeCanonicalAccounts<T extends { financialAccountId: string }>(
  bridgePositions:     readonly T[],
  canonicalAccountIds: ReadonlySet<string>,
): T[] {
  return bridgePositions.filter((p) => !canonicalAccountIds.has(p.financialAccountId));
}
