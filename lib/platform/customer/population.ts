/**
 * lib/platform/customer/population.ts  (Platform Intelligence — "active" vocabulary, ENGINEERING part)
 *
 * THE ONE PLACE the Platform names WHO is counted. Spec:
 * docs/plans/PLATFORM-INTELLIGENCE.md, 'Definitions of "active" (inventory
 * 2026-11-03)' — the canonical vocabulary rows "Open account" and "Customer".
 *
 *   Open account   `deactivatedAt IS NULL`. Pending deletion also stamps
 *                  `deactivatedAt` (app/api/user/delete/route.ts sets both), so
 *                  an account scheduled for deletion is NOT open either.
 *   Customer       `role = USER` — exactly as every count reads it today.
 *
 * PENDING OWNER DECISIONS — NOTHING HERE DECIDES THEM. Four predicates depend
 * on owner rulings that have not been made (the doc's decision split):
 *
 *   OD-1  the window that defines an engaged customer for unit economics
 *   OD-2  whether operators count as customers (SYSTEM_ADMIN is already out by
 *         role; role-USER PlatformGrant holders are IN, as today)
 *   OD-3  whether an account deactivated / scheduled for deletion NOW still
 *         counts in a window in which it was engaged (today: it does)
 *   OD-4  whether test / internal accounts are marked and excluded (today: no
 *         flag exists, nothing is excluded)
 *
 * Each is a NAMED policy below whose only variant is `status: "UNDECIDED"`, and
 * every predicate that depends on one takes it as an injected argument that
 * defaults to it. UNDECIDED keeps today's behaviour exactly — populations and
 * numbers are unchanged. `onlyUndecided` accepts only that status, so recording
 * a ruling (widening `status`) fails the typecheck at every site that must
 * handle it: a decision cannot be adopted silently. Surfaces that show an affected count
 * say the definition is pending (`pendingDefinitionNote`).
 *
 * CENSUS PIN (population.test.ts): no Platform reader restates the open-account
 * predicate inline (`deactivatedAt: null`); new copies fail the test.
 *
 * Pure and import-free: safe for client and server.
 */

// ── The owner decisions (all UNDECIDED) ──────────────────────────────────────

export type PopulationDecisionId = "OD-1" | "OD-2" | "OD-3" | "OD-4";

export interface UndecidedPopulationPolicy<Id extends PopulationDecisionId = PopulationDecisionId> {
  readonly decision: Id;
  readonly status: "UNDECIDED";
  /** A short noun phrase for captions ("who counts as an operator"). */
  readonly subject: string;
  /** The question the owner has to answer. */
  readonly question: string;
  /** What the code does until then — today's behaviour, unchanged. */
  readonly interim: string;
}

/** OD-1 — which window defines an engaged customer for unit economics. */
export const ECONOMICS_WINDOW_POLICY: UndecidedPopulationPolicy<"OD-1"> = {
  decision: "OD-1", status: "UNDECIDED",
  subject: "the window that defines an engaged customer for unit economics",
  question: "Calendar cycle to date, or the trailing 30 UTC days (Engaged MAU)? Does a second cost-per-customer figure survive?",
  interim: "the calendar cycle to date (UTC month), as today",
};

/** OD-2 — do operators count as customers. */
export const OPERATOR_EXCLUSION_POLICY: UndecidedPopulationPolicy<"OD-2"> = {
  decision: "OD-2", status: "UNDECIDED",
  subject: "whether operators count as customers",
  question: "Do SYSTEM_ADMIN accounts and role-USER PlatformGrant holders using personal Spaces count as customers?",
  interim: "role USER counts (SYSTEM_ADMIN excluded by role; role-USER grant holders included), as today",
};

/** OD-3 — does an account deactivated now still count in a window it was engaged in. */
export const DEACTIVATED_IN_WINDOW_POLICY: UndecidedPopulationPolicy<"OD-3"> = {
  decision: "OD-3", status: "UNDECIDED",
  subject: "whether a now-deactivated account counts in a window it was engaged in",
  question: "Does an account deactivated or scheduled for deletion now still count in a window in which it was engaged?",
  interim: "it still counts (engagement counts carry no account-state filter), as today",
};

/** OD-4 — test / internal accounts. */
export const TEST_ACCOUNT_POLICY: UndecidedPopulationPolicy<"OD-4"> = {
  decision: "OD-4", status: "UNDECIDED",
  subject: "whether test and internal accounts are excluded",
  question: "Should a test or internal account be marked (schema + instrumentation), and should it be excluded?",
  interim: "nothing is excluded (no test-account flag exists), as today",
};

export const POPULATION_DECISIONS: readonly UndecidedPopulationPolicy[] = [
  ECONOMICS_WINDOW_POLICY, OPERATOR_EXCLUSION_POLICY, DEACTIVATED_IN_WINDOW_POLICY, TEST_ACCOUNT_POLICY,
];

/**
 * The caption a surface shows beside a count whose population waits on a
 * ruling: "Pending the owner's definition (OD-2, OD-4): whether operators
 * count as customers; whether test and internal accounts are excluded.
 * Counted as today until decided."
 */
export function pendingDefinitionNote(...policies: readonly UndecidedPopulationPolicy[]): string {
  const pending = policies.filter((p) => p.status === "UNDECIDED");
  if (pending.length === 0) return "";
  return `Pending the owner's definition (${pending.map((p) => p.decision).join(", ")}): ${pending.map((p) => p.subject).join("; ")}. Counted as today until decided.`;
}

/**
 * The compile-time tripwire: every policy-dependent predicate passes its policy
 * here. Its parameter accepts ONLY `status: "UNDECIDED"`, so recording a ruling
 * (widening `status`) stops every caller compiling until it handles the ruling.
 */
function onlyUndecided(policy: { readonly status: "UNDECIDED" }): void {
  void policy;
}

// ── Open account ─────────────────────────────────────────────────────────────

/** THE open-account `where` (UserWhereInput fragment): not deactivated, which covers pending deletion. */
export const OPEN_ACCOUNT_WHERE = { deactivatedAt: null };

/** Its complement: deactivated, or pending deletion (which also stamps deactivatedAt). */
export const CLOSED_ACCOUNT_WHERE = { deactivatedAt: { not: null } };

// ── Customer ─────────────────────────────────────────────────────────────────

/** The policies the Customer population depends on (OD-2, OD-4). */
export interface CustomerPopulationPolicy {
  operators: UndecidedPopulationPolicy<"OD-2">;
  testAccounts: UndecidedPopulationPolicy<"OD-4">;
}

export const CUSTOMER_POPULATION_POLICY: CustomerPopulationPolicy = {
  operators: OPERATOR_EXCLUSION_POLICY,
  testAccounts: TEST_ACCOUNT_POLICY,
};

/**
 * The Customer `where` under an injected policy. Every branch is UNDECIDED
 * today and returns role USER exactly; a ruling adds a variant and the switch
 * stops compiling until it is handled here.
 */
export function customerWhere(policy: CustomerPopulationPolicy = CUSTOMER_POPULATION_POLICY): { role: "USER" } {
  onlyUndecided(policy.operators);
  onlyUndecided(policy.testAccounts);
  return { role: "USER" };
}

/** Customer ∧ Open account — the CS / Policies / Security population ("open customer accounts"). */
export function openCustomerWhere(policy: CustomerPopulationPolicy = CUSTOMER_POPULATION_POLICY): { role: "USER"; deactivatedAt: null } {
  return { ...customerWhere(policy), ...OPEN_ACCOUNT_WHERE };
}

/** The default-policy constants the readers spread (same values as the functions). */
export const CUSTOMER_WHERE = customerWhere();
export const OPEN_CUSTOMER_WHERE = openCustomerWhere();

// ── Windows and engaged sets that wait on OD-1 / OD-3 ────────────────────────

/** OD-1 — the instant the economics engagement window opens. UNDECIDED = the cycle start, as today. */
export function economicsEngagementStart(cycleStart: Date, policy: UndecidedPopulationPolicy<"OD-1"> = ECONOMICS_WINDOW_POLICY): Date {
  onlyUndecided(policy);
  return cycleStart;
}

/**
 * OD-3 — the engaged-user set an engagement count keeps. UNDECIDED = every user
 * with a fact in the window, whatever their account state now (as today).
 */
export function engagedPopulation<T>(engaged: Set<T>, policy: UndecidedPopulationPolicy<"OD-3"> = DEACTIVATED_IN_WINDOW_POLICY): Set<T> {
  onlyUndecided(policy);
  return engaged;
}
