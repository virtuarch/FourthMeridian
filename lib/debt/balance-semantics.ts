/**
 * lib/debt/balance-semantics.ts
 *
 * THE canonical authority for interpreting a raw signed liability balance.
 *
 * ── The sign convention (canonical, unchanged by this module) ────────────────
 * Raw liability balance is stored using the provider/canonical convention:
 *
 *   POSITIVE  → debt OWED by the user to the issuer        (balance =  1000)
 *   ZERO      → settled; the account exists, nothing owed   (balance =     0)
 *   NEGATIVE  → a CREDIT balance in the user's favour —     (balance =  -100)
 *               the issuer owes the user (overpayment,
 *               statement credit, refund, charge reversal)
 *
 * This is Plaid's `balances.current` convention for credit/loan accounts, which
 * lib/plaid/exchangeToken.ts and lib/plaid/refresh.ts ingest UNMODIFIED. This
 * module does NOT normalise, migrate, or rewrite stored balances — it is the one
 * place that says what an already-correct stored number MEANS.
 *
 * ── Why this module exists (V25-SIDE-1) ─────────────────────────────────────
 * The stored sign was always right; the INTERPRETATION was re-derived inline by
 * every consumer, four contradictory ways at once — `Math.max(0, b)` in the
 * classifier, `Math.abs(b)` in the debt lens and the AI annotations, a raw
 * unclamped sum in the section renderers, and `filter(b > 0)` in the workspace
 * widgets (which additionally erased paid-off accounts from the UI). The same
 * card was simultaneously $0 of debt, +$124 of debt, −$124 of debt, and
 * nonexistent. This module ends that: consumers ASK, they do not re-derive.
 *
 * ── Account identity is NOT this module's concern ────────────────────────────
 * Whether a row is a debt account is `type === "debt"` and is owned by
 * lib/account-classifier.ts (`classifyAccounts` / `accountTier`). That
 * membership is STRUCTURAL and must never depend on the balance: a paid-off
 * credit card is still a credit card. Nothing here decides membership.
 *
 * ── Currency ────────────────────────────────────────────────────────────────
 * These helpers take a plain number and are currency-agnostic, so they compose
 * with the money layer in EITHER order: FX rates are positive, so sign (and
 * therefore the clamp) is preserved by conversion, making clamp-then-convert
 * and convert-then-clamp arithmetically identical. Callers that already convert
 * should apply these to the CONVERTED amount (matching the existing
 * "convert-then-clamp" note in lib/account-classifier.ts). An FX-UNAVAILABLE
 * balance is `null` under V25-FINAL-1 and must be EXCLUDED by the caller before
 * it reaches here — never coerced to 0, which would read as "settled".
 *
 * PURE: no Prisma, no React, no provider, no clock, no I/O. Deterministic.
 */

/** The three canonical states of a liability account. */
export type LiabilityState =
  /** Positive balance — the user owes the issuer. */
  | "owed"
  /** Exactly zero — the account is live and nothing is owed (paid off). */
  | "settled"
  /** Negative balance — the issuer owes the user (credit in their favour). */
  | "credit";

/**
 * Current outstanding debt OWED by the user, from a raw signed liability
 * balance. A credit balance is ZERO debt — never negative debt (which would
 * make totals nonsensical) and never its absolute magnitude (which would invent
 * phantom debt out of money the user is owed).
 *
 * This is the figure every "how much do I owe" metric must use: total debt,
 * interest principal, APR weighting, utilisation numerator, payoff obligation.
 */
export function amountOwed(balance: number): number {
  return Math.max(balance, 0);
}

/**
 * Credit held in the user's favour with the issuer, as a POSITIVE magnitude.
 * Zero for an ordinary (owed or settled) liability.
 *
 * Presentation-facing: this is the number a row renders as "$124.04 credit".
 * It is deliberately NOT an asset — see the net-worth note on `liabilityState`.
 */
export function creditBalance(balance: number): number {
  return Math.max(-balance, 0);
}

/**
 * Classify a raw signed liability balance into its canonical state.
 *
 * Net-worth policy (unchanged by V25-SIDE-1, and deliberately conservative):
 * a "credit" state contributes ZERO to liabilities and ZERO to assets. An
 * issuer credit is not a general-purpose asset — it is only spendable at that
 * one issuer — so it is shown on the account row and excluded from net worth.
 * `classifyAccounts` has always floored liabilities at zero, so stored
 * snapshots already agree with this and require no migration.
 */
export function liabilityState(balance: number): LiabilityState {
  if (balance > 0) return "owed";
  if (balance < 0) return "credit";
  return "settled";
}

/**
 * True when this liability carries real outstanding debt — the single predicate
 * for "does this account participate in debt payoff".
 *
 * Payoff targeting (snowball / avalanche / planner ordering) MUST gate on this:
 * ranking by `Math.abs(balance)` makes an overpaid card the SMALLEST balance and
 * therefore the recommended first snowball target, i.e. advising the user to pay
 * off a card that already owes them money.
 *
 * NOTE this is a DEBT-EXPOSURE predicate, never a MEMBERSHIP predicate — it must
 * not be used to decide whether an account appears in the Debt workspace.
 */
export function hasOutstandingDebt(balance: number): boolean {
  return balance > 0;
}
