/**
 * lib/transactions/coverage-note.ts  (TX-2A)
 *
 * The PURE honesty-copy resolver for transaction-coverage awareness. TX-2 bounded
 * the shared transaction read to the most-recent `limit` rows and rides a
 * `truncated` sentinel on the payload; TX-2A surfaces that state so a workspace
 * never *appears* complete when its transaction population is intentionally
 * capped. This module owns only the WORDING — no React, no loader import, no
 * financial-domain dependency — so the "no indicator under the cap" invariant is a
 * pure unit test and the presentation layer stays a thin wrapper.
 *
 * It changes NO calculation. The message is rendered ALONGSIDE the charts/totals,
 * which continue to fold over exactly the rows they were given (TX-2 semantics).
 */

export type CoverageVariant = "browse" | "history";

/** The workspace-safe view of the loader's boundary — deliberately free of raw
 *  loader vocabulary ("limit + 1"): a workspace understands "coverage incomplete",
 *  not "the query fetched a sentinel row". */
export interface TransactionsCoverage {
  truncated: boolean;
  /** The cap that produced the truncation (for honest copy: "the most recent N"). */
  limit?: number;
}

/**
 * The honest coverage line for a surface, or `null` when there is nothing to say
 * (not truncated ⇒ the population is complete ⇒ NO indicator). `browse` is the
 * Transactions-tab phrasing ("showing the most recent N"); `history` is the muted
 * completeness caveat for a historical/derived view (Cash Flow / Liquidity).
 */
export function coverageMessage(
  coverage: TransactionsCoverage | null | undefined,
  variant: CoverageVariant = "browse",
): string | null {
  if (!coverage?.truncated) return null;
  if (variant === "history") {
    return "Historical view is based on available transaction history. Some older transactions are not included.";
  }
  return coverage.limit != null
    ? `Showing the most recent ${coverage.limit.toLocaleString("en-US")} transactions.`
    : "Showing your most recent transactions.";
}
