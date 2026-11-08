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

import { debtTypeLabel, liabilityKind, PLAID_LIMIT_DISCRIMINATED_SUBTYPES, type LiabilityKindInput } from "@/lib/debt/liability-kind";

/**
 * THE date liquid net worth stopped subtracting installment loans (owner
 * decision 2026-11-08). DOCUMENTATION AND LABEL ONLY (Mortgage F1b, S2 ruling):
 * no code path decides a row's basis from a date. A stored row's basis is read
 * from the row itself (`liquidNetWorthRowBasis`: `SpaceSnapshot.installmentDebt`
 * recorded ⇒ new basis), because a regeneration can put a row dated before this
 * on the new basis and a frozen observation dated after it never changes.
 */
export const LIQUID_NW_INSTALLMENT_EXCLUSION_FROM = "2026-11-08";

/** The wealth-breakdown label for that part. */
export const LIQUID_NW_DEFINITION_CHANGE_LABEL =
  `Definition change — installment loans no longer subtracted (from ${LIQUID_NW_INSTALLMENT_EXCLUSION_FROM})`;

/** The chart annotation label at that date. */
export const LIQUID_NW_DEFINITION_CHANGE_MARKER = "Definition change";

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
  // A limit-discriminated Plaid subtype ("home equity": HELOC vs closed-end
  // loan) whose row did not CARRY the limit (field absent — e.g. a privacy tier
  // that withholds it) has no evidence either way: unknown ⇒ counted, so a
  // HELOC is never dropped from liquid NW for want of its limit.
  const ps = a.providerSubtype?.trim().toLowerCase();
  if (!a.debtSubtype?.trim() && ps && PLAID_LIMIT_DISCRIMINATED_SUBTYPES.has(ps) && a.creditLimit === undefined) return "COUNTED";
  return liabilityKind({ ...a, type: a.type ?? "debt" }) === "installment" ? "EXCLUDED_INSTALLMENT" : "COUNTED";
}

/** True when the liability is excluded from liquid net worth. */
export function isExcludedFromLiquidNetWorth(a: LiabilityKindInput): boolean {
  return liquidNetWorthTreatment(a) === "EXCLUDED_INSTALLMENT";
}

/**
 * The in-sentence name of an EXCLUDED installment loan ("mortgage", "auto
 * loan", …). THE label source is `debtTypeLabel` (lib/debt/liability-kind.ts);
 * this only lower-cases its first letter for use mid-sentence ("Excludes:
 * mortgage, auto loan") — an all-caps acronym ("HELOC") is left alone.
 */
export function installmentLoanLabel(a: LiabilityKindInput): string {
  return inSentence(debtTypeLabel(a));
}

/** "Auto loan" → "auto loan"; "HELOC" stays "HELOC". */
export function inSentence(label: string): string {
  return /^[A-Z]{2,}\b/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
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

/**
 * Mortgage F1b — THE value every snapshot writer stores in
 * `SpaceSnapshot.installmentDebt`: the installment debt `liquidNetWorthDebt`
 * excluded (≥ 0, ≤ totalLiabilities). 0 when nothing was excluded — a recorded
 * zero, which is what puts the row on the new basis.
 */
export function excludedInstallmentDebt(c: { totalLiabilities: number; totalInstallmentLiabilities?: number }): number {
  return Math.max(c.totalLiabilities - liquidNetWorthDebt(c), 0);
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
    const kind = isExcludedFromLiquidNetWorth(a) ? "installment" : liabilityKind(a) === "installment" ? "unknown" : liabilityKind(a);
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

// ── Stored-row identity + basis (SpaceSnapshot) ──────────────────────────────
//
// Mortgage F1b (S2 ruling, required before Production and before any Preview
// regeneration) — `SpaceSnapshot.installmentDebt` (nullable, no default, no
// backfill) records the installment debt a row EXCLUDED from netLiquid. It is
// written on every NEW row by every snapshot writer, so a row's liquid-NW BASIS
// is a fact stored on the row, never inferred from its date:
//
//   installmentDebt NOT NULL ⇒ NEW basis: netLiquid = cash + savings − debt + installmentDebt
//                                (EXACT identity, 0 ≤ installmentDebt ≤ debt)
//   installmentDebt NULL     ⇒ legacy row: the BOUNDED identity
//                                cash + savings − debt ≤ netLiquid ≤ cash + savings
//                              and the OLD basis (installments subtracted) — unless
//                              the row's own identity PROVES it excluded debt
//                              (netLiquid above cash + savings − debt): only F1 code
//                              writes that, so such a row (written between F1 and
//                              this column) is on the new basis with the recovered
//                              amount. A NULL row that excluded nothing is OLD.

/** A stored row's liquid-NW basis. */
export type LiquidNetWorthRowBasis = "INSTALLMENTS_SUBTRACTED" | "INSTALLMENTS_EXCLUDED";

/** The stored columns the basis and identity are read from. `installmentDebt` absent/null ⇒ legacy row. */
export interface StoredLiquidRow {
  cash: number; savings: number; debt: number; netLiquid: number;
  installmentDebt?: number | null;
}

/** Tolerance below which a recovered exclusion is rounding noise, not evidence. */
const RECOVERY_EPSILON = 0.005;

/** True when the row RECORDED its installment debt (the column is non-null and finite). */
export function hasRecordedInstallmentDebt(v: { installmentDebt?: number | null }): v is { installmentDebt: number } {
  return typeof v.installmentDebt === "number" && Number.isFinite(v.installmentDebt);
}

/** The exclusion a row's aggregates imply: netLiquid − (cash + savings − debt), cent-rounded. */
function recoveredExclusion(v: StoredLiquidRow): number {
  return Math.round((v.netLiquid - (v.cash + v.savings - v.debt)) * 100) / 100;
}

/**
 * THE per-row basis. Recorded column ⇒ INSTALLMENTS_EXCLUDED. Legacy NULL ⇒
 * INSTALLMENTS_SUBTRACTED unless the row's identity proves an exclusion (see the
 * section header). Never a date comparison.
 */
export function liquidNetWorthRowBasis(v: StoredLiquidRow): LiquidNetWorthRowBasis {
  if (hasRecordedInstallmentDebt(v)) return "INSTALLMENTS_EXCLUDED";
  return recoveredExclusion(v) > RECOVERY_EPSILON ? "INSTALLMENTS_EXCLUDED" : "INSTALLMENTS_SUBTRACTED";
}

/**
 * The installment debt a stored row excluded from netLiquid: the recorded
 * column when present, else recovered by subtraction (0 on an old-basis row).
 */
export function storedExcludedInstallmentDebt(v: StoredLiquidRow): number {
  return hasRecordedInstallmentDebt(v) ? v.installmentDebt : recoveredExclusion(v);
}

/**
 * The stored-row netLiquid identity. EXACT when the row recorded
 * `installmentDebt` (netLiquid = cash + savings − debt + installmentDebt, and
 * 0 ≤ installmentDebt ≤ debt); the legacy RANGE `cash + savings − debt ≤
 * netLiquid ≤ cash + savings` when it did not. Null when it holds (within
 * `tol`), else the violation text.
 */
export function netLiquidIdentityViolation(v: StoredLiquidRow, tol: number): string | null {
  if (hasRecordedInstallmentDebt(v)) {
    if (v.installmentDebt < -tol) return "installmentDebt < 0";
    if (v.installmentDebt > Math.max(v.debt, 0) + tol) return "installmentDebt > debt";
    if (Math.abs(v.netLiquid - (v.cash + v.savings - v.debt + v.installmentDebt)) > tol) {
      return "netLiquid != cash + savings − debt + installmentDebt";
    }
    return null;
  }
  const excluded = v.netLiquid - (v.cash + v.savings - v.debt);
  if (excluded < -tol) return "netLiquid < cash + savings − debt";
  if (excluded > Math.max(v.debt, 0) + tol) return "netLiquid > cash + savings (excludes more debt than exists)";
  return null;
}

/**
 * The note the AI snapshot (history) section carries beside every `netLiquid`.
 * Each point carries its own `netLiquidBasis` (read from the stored row, never
 * from its date): a change between points on different bases includes the
 * definition change, which is not movement — the model must not narrate it.
 */
export const NET_LIQUID_HISTORY_AI_NOTE =
  `${LIQUID_NET_WORTH_DEFINITION} \`netLiquid\` does NOT subtract installment loans (mortgage, auto, student, personal installment); ` +
  "credit cards, lines of credit and debts of unknown type ARE subtracted. " +
  `${LIQUID_NET_WORTH_NOT_DEBT_FREE} ` +
  "Each point's `netLiquidBasis` says which definition THAT point was recorded on: INSTALLMENTS_EXCLUDED is the current " +
  "definition above; INSTALLMENTS_SUBTRACTED is the previous definition (recorded before the change, it also subtracted " +
  "installment loans). A change in netLiquid between points on different bases includes that definition change, which is " +
  "not money gained or debt repaid — do not describe it as movement; compare like with like.";

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

// ── The definition change between two stored rows (per-row basis) ───────────

/**
 * The part of a liquid-NW change (compare → asOf) between two stored rows that
 * is the F1 DEFINITION CHANGE, not movement. Decided by the two rows' BASES
 * (`liquidNetWorthRowBasis`), never their dates:
 *
 *   same basis              ⇒ 0 (the change is exact movement)
 *   old compare → new asOf  ⇒ + asOf's installment debt (no longer subtracted)
 *   new compare → old asOf  ⇒ − compare's installment debt
 *
 * The amount is always the NEW-basis row's installment debt: an old-basis row
 * never recorded its own, so installment paydown inside a cross-basis window
 * stays inside this part's complement rather than being invented.
 */
export function liquidNetWorthDefinitionChange(compare: StoredLiquidRow, asOf: StoredLiquidRow): number {
  const from = liquidNetWorthRowBasis(compare);
  const to = liquidNetWorthRowBasis(asOf);
  if (from === to) return 0;
  return to === "INSTALLMENTS_EXCLUDED"
    ? Math.max(storedExcludedInstallmentDebt(asOf), 0)
    : -Math.max(storedExcludedInstallmentDebt(compare), 0);
}

/**
 * The liquid-NW chart annotation(s): one marker at each FIRST new-basis point
 * that follows an old-basis point in the plotted series (Liquid NW series
 * only). Per-row basis, never a date constant. `points` are oldest-first.
 */
export function liquidNetWorthChartMarkers(
  metric: string,
  points: ReadonlyArray<{ date: string; liquidBasisPrevious?: true }>,
): { date: string; label: string }[] {
  if (metric !== "liquidNetWorth") return [];
  const out: { date: string; label: string }[] = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i - 1].liquidBasisPrevious && !points[i].liquidBasisPrevious) {
      out.push({ date: points[i].date, label: LIQUID_NW_DEFINITION_CHANGE_MARKER });
    }
  }
  return out;
}

/**
 * The liability-kind evidence a DEBT row carries into classifyAccounts (null
 * when unset) — the history writer's day rows use this; today's writer
 * (lib/snapshots/space-accounts.ts) emits the same fields, so a mortgage is
 * classified identically on both paths. Non-debt rows get nothing (a cash row's
 * subtype is not forwarded by the history writer — out of F1's scope).
 */
export function liabilityKindEvidence(a: { type: string; debtSubtype?: string | null; providerSubtype?: string | null; creditLimit?: number | null }):
  { debtSubtype?: string | null; providerSubtype?: string | null; creditLimit?: number | null } {
  return a.type === "debt"
    ? { debtSubtype: a.debtSubtype ?? null, providerSubtype: a.providerSubtype ?? null, creditLimit: a.creditLimit ?? null }
    : {};
}
