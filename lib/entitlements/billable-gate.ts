/**
 * lib/entitlements/billable-gate.ts  (BETA LIFECYCLE L1 — the billable gate API)
 *
 * The ONE question every new billable / metered operation asks before it
 * starts: is this customer's policy group frozen, paused or ended, is the
 * policy readable, and are they entitled to it at all? The decision itself is
 * pure (billable-gate-core.ts — read it for the order); this module does the
 * reads:
 *
 *   · the policy-group catalogue through `loadFreshPolicyGroupCatalogue` — a
 *     successful read at most 30 s old, NEVER the last-good copy or the code
 *     fallback; anything else ⇒ POLICY_UNAVAILABLE (fail closed for billable,
 *     while sign-in and reads keep using the ordinary cached loader);
 *   · the customer's CustomerPolicyAssignment (one row, or one query for a batch);
 *   · for Space-scoped work with no user, the Space's ACTIVE OWNER members.
 *
 * SCOPE. Per customer. `userId` wins when given (the actor causes and is billed
 * for the operation — AI chat in a shared Space bills the asker). With only a
 * `spaceId`, the bill goes to the Space's single ACTIVE OWNER (billedOwnerOf);
 * a Space with none or several ⇒ NO_OWNER for metered work.
 *
 * NEVER THROWS. A failed read is POLICY_UNAVAILABLE for metered work and
 * allowed for data access. The rollout switch (env.isPolicyAssignmentFailClosed)
 * applies exactly as in resolve.ts.
 *
 * NOT WIRED YET (L1): no route or job calls this module in this change; the
 * enforcement wiring is a later PR. Existing entitlement consumers already see
 * the lifecycle through resolve.ts.
 */

import "server-only";
import { env } from "@/lib/env";
import { loadFreshPolicyGroupCatalogue } from "@/lib/platform/policies/policy-group-catalogue";
import {
  billedOwnerOf, decideBillable, OPERATION_CLASS,
  type BillableDecision, type BillableOperation,
} from "./billable-gate-core";
import type { AssignmentFacts } from "./resolve";
import type { PolicyGroupCatalogue } from "./policy-groups";

export type { BillableDecision, BillableDenialReason, BillableOperation } from "./billable-gate-core";

interface AssignmentRow {
  userId: string;
  policyGroup: string;
  overlay: string | null;
  assignedAt: Date;
  assignedById: string | null;
  aiDailyUsdAllowanceOverride?: number | null;
}

/** The gate's reads (systemDb, a tenant transaction or a test fake satisfies it). */
export interface BillableGateReadClient {
  customerPolicyAssignment: {
    findUnique(args: { where: { userId: string } }): Promise<AssignmentRow | null>;
    findMany(args: { where: { userId: { in: string[] } } }): Promise<AssignmentRow[]>;
  };
  spaceMember: {
    findMany(args: { where: { spaceId: string; role: "OWNER"; status: "ACTIVE" }; select: { userId: true }; take: number }): Promise<{ userId: string }[]>;
  };
}

/** Test seams (production passes none). */
export interface BillableGateDeps {
  loadCatalogue?: () => Promise<PolicyGroupCatalogue | null>;
  now?: () => number;
  failClosed?: boolean;
}

async function defaultClient(): Promise<BillableGateReadClient> {
  const { billableGateSystemClient } = await import("@/lib/platform/policies/billable-gate-authority");
  return billableGateSystemClient();
}

const toFacts = (r: AssignmentRow | null | undefined): AssignmentFacts | null => r ? {
  policyGroup: r.policyGroup, overlay: r.overlay, assignedAt: r.assignedAt, assignedById: r.assignedById,
  aiDailyUsdAllowanceOverride: r.aiDailyUsdAllowanceOverride ?? null,
} : null;

async function safeCatalogue(load: () => Promise<PolicyGroupCatalogue | null>): Promise<PolicyGroupCatalogue | null> {
  try { return await load(); } catch { return null; }
}

function logReadFailure(what: string, error: unknown): void {
  console.error(`[billable-gate] ${what} read failed; metered work fails closed —`,
    error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : "unknown error");
}

const UNAVAILABLE: BillableDecision = Object.freeze({ allowed: false as const, reason: "POLICY_UNAVAILABLE" as const });
const ALLOWED: BillableDecision = Object.freeze({ allowed: true as const });

/**
 * May this NEW billable operation start? `{ allowed: true }` or the reason it
 * may not. See billable-gate-core.ts for the order.
 */
export async function assertBillableAllowed(
  input: { userId?: string; spaceId?: string; operation: BillableOperation; client?: BillableGateReadClient },
  deps: BillableGateDeps = {},
): Promise<BillableDecision> {
  const onReadFailure = OPERATION_CLASS[input.operation] === "METERED" ? UNAVAILABLE : ALLOWED;
  const failClosed = deps.failClosed ?? env.isPolicyAssignmentFailClosed;
  const now = deps.now ?? Date.now;
  let client: BillableGateReadClient;
  try { client = input.client ?? await defaultClient(); }
  catch (e) { logReadFailure("authority", e); return onReadFailure; }

  let billedUserId: string | null = input.userId ?? null;
  if (billedUserId === null && input.spaceId) {
    try {
      const owners = await client.spaceMember.findMany({ where: { spaceId: input.spaceId, role: "OWNER", status: "ACTIVE" }, select: { userId: true }, take: 2 });
      billedUserId = billedOwnerOf(owners.map((o) => o.userId));
    } catch (e) { logReadFailure("space owner", e); return onReadFailure; }
  }

  const catalogue = await safeCatalogue(deps.loadCatalogue ?? loadFreshPolicyGroupCatalogue);
  let assignment: AssignmentFacts | null = null;
  if (billedUserId !== null) {
    try { assignment = toFacts(await client.customerPolicyAssignment.findUnique({ where: { userId: billedUserId } })); }
    catch (e) { logReadFailure("assignment", e); return onReadFailure; }
  }
  return decideBillable({ operation: input.operation, billedUserId, assignment, catalogue, failClosed, nowMs: now() });
}

/**
 * BATCH (jobs) — the decision for each user, with ONE catalogue read and ONE
 * assignment query. Every requested id is in the map. Never throws: a failed
 * assignment read decides every user as POLICY_UNAVAILABLE (metered).
 */
export async function billableAllowedForUsers(
  userIds: readonly string[],
  operation: BillableOperation,
  client?: BillableGateReadClient,
  deps: BillableGateDeps = {},
): Promise<Map<string, BillableDecision>> {
  const ids = [...new Set(userIds)];
  const out = new Map<string, BillableDecision>();
  if (ids.length === 0) return out;
  const onReadFailure = OPERATION_CLASS[operation] === "METERED" ? UNAVAILABLE : ALLOWED;
  const failClosed = deps.failClosed ?? env.isPolicyAssignmentFailClosed;
  const now = deps.now ?? Date.now;

  let rows: AssignmentRow[];
  let catalogue: PolicyGroupCatalogue | null;
  try {
    const c = client ?? await defaultClient();
    [catalogue, rows] = await Promise.all([
      safeCatalogue(deps.loadCatalogue ?? loadFreshPolicyGroupCatalogue),
      c.customerPolicyAssignment.findMany({ where: { userId: { in: ids } } }),
    ]);
  } catch (e) {
    logReadFailure("batch assignment", e);
    for (const id of ids) out.set(id, onReadFailure);
    return out;
  }
  const byUser = new Map(rows.map((r) => [r.userId, r] as const));
  const nowMs = now();
  for (const id of ids) {
    out.set(id, decideBillable({ operation, billedUserId: id, assignment: toFacts(byUser.get(id)), catalogue, failClosed, nowMs }));
  }
  return out;
}
