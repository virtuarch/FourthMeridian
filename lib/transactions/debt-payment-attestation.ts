/**
 * lib/transactions/debt-payment-attestation.ts
 *
 * v2.6-DEBT-1 — THE debt-payment admission rule. Pure, zero imports.
 *
 * Its own module because the two authorities that need it would otherwise form
 * a cycle: `debt-payment-authority.ts` imports `classifyLiquidity`, and
 * `liquidity.ts` is where membership is actually decided and so must consult the
 * rule. One definition, both consumers, no cycle.
 */

/**
 * v2.6-DEBT-1 — DOES THE EVIDENCE POSITIVELY ATTEST A DEBT DESTINATION?
 *
 * The membership rule, stated once:
 *
 *   A row belongs in Debt Payments only when the transfer authority POSITIVELY
 *   attests the destination — an OWNED LIABILITY counterparty, or a proven
 *   liability destination TYPE. Silence, ambiguity, provider categorisation,
 *   descriptor text, institution names and "nothing contradicted it" never
 *   admit a row.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 *
 * `classifyLiquidity` used to divert a DEBT_PAYMENT row only when the
 * destination was KNOWN and NOT a liability. An UNKNOWN destination fell
 * through and was counted, at confidence 1. That is admission by ABSENCE OF
 * CONTRADICTION, and absence of contradiction is not evidence.
 *
 * Three live rows ($6,500) were counted on that basis while the transfer
 * authority had returned UNRESOLVED_TRANSFER / CANDIDATES_SPAN_TYPES for them —
 * "several possible destinations of different kinds". The authority said it did
 * not know; the liquidity axis heard yes. Their stored `flowType = DEBT_PAYMENT`
 * came from a provider category derived from descriptor text, which is exactly
 * the evidence this codebase has spent an arc refusing to treat as fact
 * (v2.6-TRUTH-3, TRUTH-8, TRUTH-9).
 *
 * ── Attestation is MEMBERSHIP, not NAMING ───────────────────────────────────
 *
 * `typeProven` is a real attestation and admits the row. 15 live rows are
 * attested at the TYPE level without a nameable account — the user paid two
 * cards on the same day for the same amount, so no evidence distinguishes them.
 * Those are debt payments and stay counted; they appear under "Debt account not
 * determined". Naming the creditor is a separate axis (`attributeCreditor`) and
 * can never remove a payment from the total.
 */
export function isDebtPaymentAttested(e: {
  /** Tier of the resolved counterparty, from the canonical tier resolver. */
  counterpartyTier: string | null | undefined;
  /** The transfer authority's destination verdict for this row. */
  transferMaturity: string | null | undefined;
}
): boolean {
  // The destination IS an owned liability account — the strongest evidence.
  if (e.counterpartyTier === "liability") return true;
  // The authority proved the destination TYPE is a liability, without being able
  // to name which account. A weaker claim, still a positive one.
  if (e.transferMaturity === "DEBT_PAYMENT") return true;
  // Everything else — UNRESOLVED_TRANSFER, an unknown counterparty, a provider
  // category, a descriptor that reads like a card payment — is not evidence.
  return false;
}
