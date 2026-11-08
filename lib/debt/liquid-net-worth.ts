/**
 * lib/debt/liquid-net-worth.ts
 *
 * Mortgage F1 — OWNER DECISION 2026-11-08 (approved):
 *   "Exclude mortgages and other long-term installment liabilities from liquid
 *    net worth. Keep all liabilities in total net worth. Clearly explain the
 *    difference in the UI and Platform AI. Do not misrepresent liquid net worth
 *    as debt-free wealth."
 *
 * THE one answer to "does this liability count against LIQUID net worth?".
 * Every liquid-net-worth path (snapshot fields, the Hero-basis split, the lens
 * root, the wealth drivers, the AI assemblers, the UI copy) reads it from here.
 *
 * Classification is `liabilityKind` (lib/debt/liability-kind.ts) and nothing
 * else — no file keeps its own subtype list for this decision:
 *
 *   installment (mortgage, auto, student, personal installment, closed-end
 *                home-equity loan, …)              ⇒ EXCLUDED from liquid NW
 *   revolving   (credit card, HELOC with a limit,
 *                line of credit, overdraft)        ⇒ COUNTED in liquid NW
 *   unknown     (no FM debtSubtype and no known
 *                Plaid subtype — e.g. a manual debt) ⇒ COUNTED, and disclosed.
 *
 * UNKNOWN IS COUNTED (S2 recommendation, adopted): excluding a debt we cannot
 * classify could only ever RAISE liquid net worth, so an unclassified
 * liability stays subtracted and the surface says so. Liquid net worth is
 * therefore never overstated by a classification gap.
 *
 * Total net worth is untouched: every liability, of every kind, still
 * subtracts from it.
 *
 * Pure: no DB, no server-only imports (client components import it).
 */

import { liabilityKind, type LiabilityKindInput } from "@/lib/debt/liability-kind";

/** The definition every surface (UI + AI) states beside a liquid-net-worth figure. */
export const LIQUID_NET_WORTH_DEFINITION =
  "Liquid net worth excludes mortgages and other long-term loans; total net worth includes all debts.";

/** The honesty rule the AI must keep: excluded loans are still owed. */
export const LIQUID_NET_WORTH_NOT_DEBT_FREE =
  "Liquid net worth is not debt-free wealth: excluded loans are still owed and are subtracted in total net worth.";

/** Short formula label (lens root / drill-down). */
export const LIQUID_NET_WORTH_FORMULA = "Cash + Savings − Debt (excluding installment loans)";

export type LiquidNetWorthTreatment = "COUNTED" | "EXCLUDED_INSTALLMENT";

/** A liability row as every liquid-NW caller holds it. */
export interface LiquidNetWorthLiability extends LiabilityKindInput {
  type: string;
  balance: number;
  valuationUnknown?: boolean;
}

/**
 * Whether ONE liability counts against liquid net worth. Installment ⇒
 * excluded; revolving and unknown ⇒ counted (unknown conservatively).
 */
export function liquidNetWorthTreatment(a: LiabilityKindInput): LiquidNetWorthTreatment {
  return liabilityKind({ ...a, type: a.type ?? "debt" }) === "installment" ? "EXCLUDED_INSTALLMENT" : "COUNTED";
}

/** True when the liability is excluded from liquid net worth. */
export function isExcludedFromLiquidNetWorth(a: LiabilityKindInput): boolean {
  return liquidNetWorthTreatment(a) === "EXCLUDED_INSTALLMENT";
}

// Plain-English names for an excluded installment loan. Keyed by the SAME
// evidence liabilityKind reads (FM debtSubtype first, then Plaid subtype); a
// key missing here only changes the WORD ("loan"), never the classification.
const DEBT_SUBTYPE_LABEL: Record<string, string> = {
  mortgage: "mortgage", auto_loan: "auto loan", student_loan: "student loan", personal_loan: "personal loan",
};
const PLAID_SUBTYPE_LABEL: Record<string, string> = {
  mortgage: "mortgage", auto: "auto loan", student: "student loan", consumer: "personal loan",
  "home equity": "home equity loan", construction: "construction loan",
  business: "business loan", commercial: "business loan",
};

/** "mortgage" / "auto loan" / … — the name of an EXCLUDED installment loan. */
export function installmentLoanLabel(a: LiabilityKindInput): string {
  const ds = a.debtSubtype?.trim().toLowerCase();
  if (ds) return DEBT_SUBTYPE_LABEL[ds] ?? "loan";
  const ps = a.providerSubtype?.trim().toLowerCase();
  return (ps && PLAID_SUBTYPE_LABEL[ps]) || "loan";
}

/**
 * The amount of a classification's debt that counts against liquid net worth:
 * every liability owed EXCEPT installment loans. `totalInstallmentLiabilities`
 * absent (a hand-built total, a caller without kind evidence) ⇒ 0 excluded, i.e.
 * the conservative all-debt figure — never an invented exclusion.
 */
export function liquidNetWorthDebt(c: { totalLiabilities: number; totalInstallmentLiabilities?: number }): number {
  const excluded = typeof c.totalInstallmentLiabilities === "number" && Number.isFinite(c.totalInstallmentLiabilities)
    ? Math.min(Math.max(c.totalInstallmentLiabilities, 0), c.totalLiabilities)
    : 0;
  return c.totalLiabilities - excluded;
}

export interface LiquidNetWorthBasis {
  /** LIQUID_NET_WORTH_DEFINITION, verbatim. */
  definition: string;
  /** LIQUID_NET_WORTH_NOT_DEBT_FREE, verbatim. */
  notDebtFree: string;
  /** Distinct names of the installment loans excluded, in first-seen order ("mortgage", "auto loan"). */
  excludedKinds: string[];
  /** How many liabilities were excluded as installment loans. */
  excludedCount: number;
  /** How many liabilities of UNKNOWN kind were counted (conservatively). */
  unknownKindCount: number;
  /** "Excludes: mortgage, auto loan" — null when nothing was excluded. */
  excludedNote: string | null;
  /** The unknown-kind disclosure — null when none. */
  unknownKindNote: string | null;
}

/** "Excludes: mortgage, auto loan" — or null when the list is empty. */
export function excludedKindsNote(kinds: readonly string[]): string | null {
  return kinds.length > 0 ? `Excludes: ${kinds.join(", ")}` : null;
}

/** The disclosure for liabilities whose kind could not be determined. */
export function unknownKindNote(n: number): string | null {
  if (n <= 0) return null;
  return `Includes ${n === 1 ? "a debt" : `${n} debts`} of unknown type, so liquid net worth is not overstated`;
}

/**
 * Describe how a set of accounts was treated for liquid net worth — what the UI
 * names and what the AI is told. Non-debt rows are ignored. A row with no value
 * (`valuationUnknown`) is still named when it is an installment loan: its kind
 * is known even though its balance is not.
 */
export function liquidNetWorthBasis(accounts: ReadonlyArray<LiquidNetWorthLiability>): LiquidNetWorthBasis {
  const kinds: string[] = [];
  let excludedCount = 0;
  let unknownKindCount = 0;
  for (const a of accounts) {
    if (a.type !== "debt") continue;
    const kind = liabilityKind(a);
    if (kind === "installment") {
      excludedCount++;
      const label = installmentLoanLabel(a);
      if (!kinds.includes(label)) kinds.push(label);
    } else if (kind === "unknown") {
      unknownKindCount++;
    }
  }
  return {
    definition: LIQUID_NET_WORTH_DEFINITION,
    notDebtFree: LIQUID_NET_WORTH_NOT_DEBT_FREE,
    excludedKinds: kinds,
    excludedCount,
    unknownKindCount,
    excludedNote: excludedKindsNote(kinds),
    unknownKindNote: unknownKindNote(unknownKindCount),
  };
}

// ── Stored-row identity (SpaceSnapshot) ──────────────────────────────────────
//
// `SpaceSnapshot` stores `debt` (ALL liabilities) and `netLiquid`, but no
// installment column. The installment debt a row excluded is therefore
// RECOVERED by subtraction, exactly like the unstored real-asset component
// (`derivedRealAssets`), and BOUNDED rather than equated:
//
//   excluded = netLiquid − (cash + savings − debt),   0 ≤ excluded ≤ debt
//
// Rows written before Mortgage F1 have excluded = 0 (they subtracted all debt)
// and still satisfy the bound — the old identity is the special case. A row
// outside the bound (netLiquid below cash + savings − debt, or above
// cash + savings) is a contradiction, as before.

/** The installment debt a stored row excluded from netLiquid (≥ 0 after rounding noise), recovered by subtraction. */
export function storedExcludedInstallmentDebt(v: { cash: number; savings: number; debt: number; netLiquid: number }): number {
  return Math.round((v.netLiquid - (v.cash + v.savings - v.debt)) * 100) / 100;
}

/**
 * The stored-row netLiquid identity, bounded: `cash + savings − debt ≤ netLiquid
 * ≤ cash + savings` (within `tol`). Null when it holds, else the violation text.
 */
export function netLiquidIdentityViolation(
  v: { cash: number; savings: number; debt: number; netLiquid: number },
  tol: number,
): string | null {
  const excluded = v.netLiquid - (v.cash + v.savings - v.debt);
  if (excluded < -tol) return "netLiquid < cash + savings − debt";
  if (excluded > Math.max(v.debt, 0) + tol) return "netLiquid > cash + savings (excludes more debt than exists)";
  return null;
}

/**
 * The note the AI snapshot (history) section carries beside every `netLiquid`.
 * Rows recorded before F1 subtracted every debt; a jump between such a row and
 * a later one is a definition change, not movement — the model must not narrate
 * it as one.
 */
export const NET_LIQUID_HISTORY_AI_NOTE =
  `${LIQUID_NET_WORTH_DEFINITION} \`netLiquid\` does NOT subtract installment loans (mortgage, auto, student, personal installment); ` +
  "credit cards, lines of credit and debts of unknown type ARE subtracted. " +
  `${LIQUID_NET_WORTH_NOT_DEBT_FREE} ` +
  "Points recorded before 2026-11-08 may still subtract installment loans; a rise in netLiquid that matches an installment balance " +
  "between such a point and a later one is that definition change, not money gained — do not describe it as movement.";

/**
 * The one UI sentence beside a liquid-net-worth figure: the definition, then
 * the excluded loans by name ("Excludes: mortgage, auto loan."), then the
 * unknown-kind disclosure. Never phrased as debt-free.
 */
export function liquidNetWorthNoteText(basis: Pick<LiquidNetWorthBasis, "excludedNote" | "unknownKindNote"> | null | undefined): string {
  const parts = [LIQUID_NET_WORTH_DEFINITION];
  if (basis?.excludedNote) parts.push(`${basis.excludedNote}.`);
  if (basis?.unknownKindNote) parts.push(`${basis.unknownKindNote}.`);
  return parts.join(" ");
}

/**
 * The liquid-net-worth block the AI accounts section carries (AiLiquidNetWorth
 * in lib/ai/types.ts) — built here, from the SAME rows and classification the
 * section's totals come from, so the model receives the figure, the definition,
 * the not-debt-free rule and the excluded loans by name together.
 *
 * Hero basis: UNRESTRICTED cash (`totalLiquid`) minus liquid-NW debt.
 */
export function aiLiquidNetWorth(
  accounts: ReadonlyArray<LiquidNetWorthLiability>,
  c: { totalLiquid: number; totalLiabilities: number; totalInstallmentLiabilities?: number },
): {
  amount: number; definition: string; notDebtFree: string;
  excludedInstallmentDebt: number; excludedKinds: string[]; unknownKindLiabilityCount: number;
} {
  const basis = liquidNetWorthBasis(accounts);
  const debt = liquidNetWorthDebt(c);
  return {
    amount:                    c.totalLiquid - debt,
    definition:                basis.definition,
    notDebtFree:               basis.notDebtFree,
    excludedInstallmentDebt:   c.totalLiabilities - debt,
    excludedKinds:             basis.excludedKinds,
    unknownKindLiabilityCount: basis.unknownKindCount,
  };
}
