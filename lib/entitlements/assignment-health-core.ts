/**
 * lib/entitlements/assignment-health-core.ts  (owner ruling, 2026-10-30 — pure)
 *
 * WHICH CUSTOMERS HAVE A MISSING OR INVALID POLICY-GROUP ASSIGNMENT — the pure
 * fold behind the Platform Ops Attention item and the `policy-assignment-invalid`
 * alert rule. One authority, two consumers, so the attention row and the alert
 * can never disagree about who is affected.
 *
 *   UNASSIGNED            a USER-role account with no CustomerPolicyAssignment row
 *   UNKNOWN_POLICY_GROUP  an assignment row whose policyGroup is not in POLICY_GROUPS
 *
 * `enforced` is the rollout switch (POLICY_ASSIGNMENT_FAIL_CLOSED=enforce): when
 * on, these customers are FAIL CLOSED right now (paid features refused); when
 * off they still resolve to the Beta default, and the operator sees the exposure
 * BEFORE the switch is turned on.
 *
 * IDENTITY MINIMISATION: a customer is named only by the opaque reference every
 * operator surface uses (`user …abc123` — lib/platform/ai/spend-health.ts
 * opaqueUserRef; pinned equal in fail-closed.test.ts). Never an email, a name,
 * a username or a whole id. The unknown key text IS shown: it is a catalogue
 * key an operator wrote, not customer data, and the operator needs it to fix
 * the row.
 *
 * PURE: no DB, no clock read (`now` is a parameter), no I/O.
 */

import type { FailClosedReason } from "./resolve";

/** Customers listed per read (attention rows / alert breaches); the counts are always exact. */
export const POLICY_ASSIGNMENT_ISSUE_CAP = 25;

/** The longest unknown-key text carried (a key is short; anything longer is cut, never trusted). */
const UNKNOWN_KEY_MAX = 64;

/** The opaque per-customer reference — the same format as opaqueUserRef (spend-health.ts). */
export function customerRef(userId: string): string {
  return `user …${userId.slice(-6)}`;
}

export interface PolicyAssignmentIssue {
  /** Opaque `user …abc123` — never an email, name or whole id. */
  ref: string;
  reason: FailClosedReason;
  /** The unknown key as stored (cut to 64 chars) for UNKNOWN_POLICY_GROUP; null for UNASSIGNED. */
  unknownKey: string | null;
  /** Since when: the assignment's assignedAt (unknown) or the account's createdAt (unassigned). */
  since: string | null;
}

export interface PolicyAssignmentHealth {
  checkedAt: string;
  /** The rollout switch: true ⇒ these customers are fail-closed now. */
  enforced: boolean;
  /** Exact counts. */
  unassigned: number;
  unknown: number;
  total: number;
  /** Oldest first, at most `cap`. */
  items: readonly PolicyAssignmentIssue[];
  cap: number;
  /** True when `total` exceeds the listed items. */
  truncated: boolean;
}

export interface PolicyAssignmentFacts {
  unassignedCount: number;
  unassignedRows: readonly { userId: string; createdAt: Date | null }[];
  unknownCount: number;
  unknownRows: readonly { userId: string; policyGroup: string; assignedAt: Date | null }[];
  enforced: boolean;
}

export function buildPolicyAssignmentHealth(facts: PolicyAssignmentFacts, now: Date, cap: number = POLICY_ASSIGNMENT_ISSUE_CAP): PolicyAssignmentHealth {
  const issues: PolicyAssignmentIssue[] = [
    ...facts.unknownRows.map((r) => ({
      ref: customerRef(r.userId), reason: "UNKNOWN_POLICY_GROUP" as const,
      unknownKey: r.policyGroup.slice(0, UNKNOWN_KEY_MAX), since: r.assignedAt?.toISOString() ?? null,
    })),
    ...facts.unassignedRows.map((r) => ({
      ref: customerRef(r.userId), reason: "UNASSIGNED" as const, unknownKey: null, since: r.createdAt?.toISOString() ?? null,
    })),
  ];
  issues.sort((a, b) => {
    if (a.since && b.since) { const t = a.since.localeCompare(b.since); if (t !== 0) return t; }
    else if (a.since) return -1;
    else if (b.since) return 1;
    return a.ref.localeCompare(b.ref);
  });
  const unassigned = Math.max(0, Math.floor(facts.unassignedCount));
  const unknown = Math.max(0, Math.floor(facts.unknownCount));
  const total = unassigned + unknown;
  const items = issues.slice(0, Math.max(0, cap));
  return { checkedAt: now.toISOString(), enforced: facts.enforced, unassigned, unknown, total, items, cap, truncated: total > items.length };
}

/** One operator sentence per issue: what is wrong, what it means now, and where it is fixed. */
export function describePolicyAssignmentIssue(i: PolicyAssignmentIssue, enforced: boolean): string {
  const what = i.reason === "UNASSIGNED"
    ? "No policy-group assignment recorded"
    : `Assigned policy group "${i.unknownKey ?? ""}" is not in the catalogue`;
  const now = enforced
    ? "fail closed: new AI requests, manual refresh and new connections are refused (login, existing data, reading the Brief and exports still work)"
    : "resolving to the Beta default today; this customer will fail closed when POLICY_ASSIGNMENT_FAIL_CLOSED=enforce";
  return `${what} — ${now}. Fix: Customer Success › Customers, search "${i.ref}", assign a valid policy group (access recovers on the next request).`;
}
