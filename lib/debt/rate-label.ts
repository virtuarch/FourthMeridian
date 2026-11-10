/**
 * lib/debt/rate-label.ts
 *
 * Mortgage F3 (S2 ruling, item 1) — the ONE name for a liability's interest
 * rate. The label follows the liability KIND (lib/debt/liability-kind.ts), so a
 * Plaid mortgage (debtSubtype null, providerSubtype "mortgage") is never called
 * an "APR":
 *
 *   mortgage (debtType "mortgage" — FM "mortgage" or Plaid "mortgage")  ⇒ "Mortgage rate"
 *   any other installment loan (auto, student, personal, closed-end
 *     home equity, other)                                              ⇒ "Interest rate"
 *   revolving credit (card, line of credit, HELOC, overdraft, …)       ⇒ "APR"
 *   no kind evidence, positive creditLimit (legacy untyped card)       ⇒ "APR"
 *   no kind evidence, no limit                                         ⇒ "Interest rate"
 *
 * "APR" is reserved for revolving credit. An untyped row with a limit is a card
 * by the existing rule F2 leaves to callers (liabilityKind "unknown" ⇒ "a
 * limit-bearing untyped row is a card"); an untyped row without one is not
 * PROVEN revolving, so it gets the neutral "Interest rate" rather than either claim.
 *
 * The debt UI widgets and the AI tool contract (lib/ai/assemblers/accounts.ts)
 * both read this module — the same account carries the same label everywhere.
 *
 * Owner 2026-11-08 — the label follows the fine-grained `debtType`
 * (lib/debt/liability-kind.ts): "Mortgage rate" ONLY for a mortgage; a
 * non-mortgage installment loan reads "Interest rate" (was "Loan rate").
 *
 * Pure: no DB, no server-only imports (client components import it).
 */

import { debtType, kindOfDebtType, type DebtLabelAccess, type LiabilityKindInput } from "@/lib/debt/liability-kind";

export type RateLabel = "Mortgage rate" | "APR" | "Interest rate";

/** True ONLY for a mortgage (the shared classifier; FM's own subtype wins over Plaid's). */
export function isMortgage(a: LiabilityKindInput): boolean {
  return debtType(a) === "mortgage";
}

/** The label for ONE liability's rate. */
export function rateLabel(a: LiabilityKindInput): RateLabel {
  const t = debtType(a);
  switch (kindOfDebtType(t)) {
    case "revolving":   return "APR";
    case "installment": return t === "mortgage" ? "Mortgage rate" : "Interest rate";
    default:            return a.creditLimit != null && a.creditLimit > 0 ? "APR" : "Interest rate";
  }
}

/**
 * S2 PRIVACY P1 — the rate label a VIEWER sees. "Mortgage rate" names the debt
 * type, so a COARSE viewer (balance-only co-member) reads the kind-level label
 * "Interest rate" instead; FINE is `rateLabel` unchanged.
 */
export function viewerRateLabel(a: LiabilityKindInput, access: DebtLabelAccess): RateLabel {
  const l = rateLabel(a);
  return access === "COARSE" && l === "Mortgage rate" ? "Interest rate" : l;
}

/** The same label in running text ("Mortgage rate unknown", "no mortgage rate on file"). */
export function rateLabelInline(a: LiabilityKindInput): string {
  const l = rateLabel(a);
  return l === "APR" ? "APR" : l.toLowerCase();
}

/** `viewerRateLabel` in running text ("interest rate unknown"). */
export function viewerRateLabelInline(a: LiabilityKindInput, access: DebtLabelAccess): string {
  const l = viewerRateLabel(a, access);
  return l === "APR" ? "APR" : l.toLowerCase();
}

/**
 * The label for a rate BLENDED across several liabilities: "APR" only when every
 * one of them is revolving credit; otherwise the neutral "rate" (a blend of a
 * mortgage rate and a card APR is neither).
 */
export function blendedRateLabel(rows: readonly LiabilityKindInput[]): "APR" | "rate" {
  return rows.length > 0 && rows.every((r) => rateLabel(r) === "APR") ? "APR" : "rate";
}
