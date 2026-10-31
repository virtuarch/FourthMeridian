/**
 * lib/jobs/skip-label.ts  (BETA LIFECYCLE L2 — how a SKIPPED job run is worded)
 *
 * A run is SKIPPED when a cost freeze or a plan restriction refused its work
 * (summary `outcome: "SKIPPED"`, `skipReason: "BILLABLE_<reason>"`, see
 * lib/jobs/health.ts). Operator surfaces show a HUMAN label derived from the
 * reason — never the raw code, and never "cost freeze" for a restriction that
 * is not one. An ADMISSION_ skip is "Skipped (admission)": it covers maintenance
 * AND an unreadable control plane. Pure and client-safe.
 */

export type SkipKind = "COST_FREEZE" | "POLICY_UNAVAILABLE" | "PLAN_RESTRICTION" | "ACTIVATION_DISABLED" | "ADMISSION_DENIED" | "UNSPECIFIED";

export function skipKindOf(skipReason: string | null | undefined): SkipKind {
  if (!skipReason) return "UNSPECIFIED";
  // Comms Center B2 — the automation executor held by the activation hard gate (not a plan restriction).
  if (skipReason === "ACTIVATION_DISABLED_PENDING_HARDENING") return "ACTIVATION_DISABLED";
  // Comms Center B2 hardening A5 — platform admission (maintenance / an unreadable control plane) refused the pass.
  if (skipReason.startsWith("ADMISSION_")) return "ADMISSION_DENIED";
  const r = skipReason.startsWith("BILLABLE_") ? skipReason.slice("BILLABLE_".length) : skipReason;
  if (r === "COST_FREEZE") return "COST_FREEZE";
  if (r === "POLICY_UNAVAILABLE") return "POLICY_UNAVAILABLE";
  return "PLAN_RESTRICTION";
}

const LABEL: Record<SkipKind, string> = {
  COST_FREEZE: "Skipped (cost freeze)",
  POLICY_UNAVAILABLE: "Skipped (policy unavailable)",
  PLAN_RESTRICTION: "Skipped (plan restriction)",
  ACTIVATION_DISABLED: "Skipped (activation disabled)",
  ADMISSION_DENIED: "Skipped (admission)",
  UNSPECIFIED: "Skipped",
};

const REASON: Record<SkipKind, string> = {
  COST_FREEZE: "A cost freeze is in force — the work was refused before any vendor call",
  POLICY_UNAVAILABLE: "The cost policy could not be verified — the work was refused before any vendor call (fail closed)",
  PLAN_RESTRICTION: "Every customer this run would bill is paused, ended or not entitled — nothing was started",
  ACTIVATION_DISABLED: "Automation activation is disabled pending hardening — an ACTIVE automation was found and nothing was sent",
  ADMISSION_DENIED: "Platform admission refused the work (maintenance, or a control-plane setting that cannot be read) — nothing was sent",
  UNSPECIFIED: "The work was refused before any vendor call",
};

/** "Skipped (cost freeze)" / "Skipped (policy unavailable)" / "Skipped (plan restriction)". */
export function skipLabel(skipReason: string | null | undefined): string {
  return LABEL[skipKindOf(skipReason)];
}

/** One plain sentence explaining the skip (never the raw code). */
export function skipReasonText(skipReason: string | null | undefined): string {
  return REASON[skipKindOf(skipReason)];
}
