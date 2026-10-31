/**
 * lib/entitlements/beta-lifecycle.ts  (BETA LIFECYCLE L1 — read-only)
 *
 * The lifecycle state of the authoritative Beta group, BETA_FULL_ACCESS_V1 —
 * for invitation issuance, which refuses on anything other than "ACTIVE".
 *
 * FRESH OR UNKNOWN. With no client: the shared cached loader's FRESH path
 * (`loadFreshPolicyGroupCatalogue` — a successful read at most 30 s old; never
 * the last-good copy, never the code fallback). With a client: an uncached read
 * through it. Anything that is not a fresh DB read with lifecycle facts — a
 * read failure, a database without the lifecycle migration, a missing Beta row
 * — is "UNKNOWN", which callers treat as closed. Never throws.
 */

import "server-only";
import {
  loadFreshPolicyGroupCatalogue, readPolicyGroupCatalogue, type PolicyGroupCatalogueReadClient,
} from "@/lib/platform/policies/policy-group-catalogue";
import { isCatalogueFreshForBillable } from "./billable-gate-core";
import { BETA_POLICY_GROUP_KEY, isLifecycleState, type PolicyGroupLifecycleState } from "./lifecycle";
import type { PolicyGroupCatalogue } from "./policy-groups";
import { resolveEffectiveEntitlements, type AssignmentFacts } from "./resolve";
import { readPolicyFactsForUsers, type BillableGateDeps, type BillableGateReadClient } from "./billable-gate";

export type BetaLifecycleState = PolicyGroupLifecycleState | "UNKNOWN";

/** PURE — the Beta group's state in a catalogue, or UNKNOWN unless it is a fresh DB read with a Beta row. */
export function betaLifecycleStateOf(catalogue: PolicyGroupCatalogue | null, nowMs: number): BetaLifecycleState {
  if (!isCatalogueFreshForBillable(catalogue, nowMs)) return "UNKNOWN";
  const g = catalogue.groups[BETA_POLICY_GROUP_KEY];
  if (!g || g.source !== "DB" || !isLifecycleState(g.lifecycle)) return "UNKNOWN";
  return g.lifecycle;
}

export async function getBetaLifecycleState(client?: PolicyGroupCatalogueReadClient): Promise<BetaLifecycleState> {
  try {
    const catalogue = client ? await readPolicyGroupCatalogue(client) : await loadFreshPolicyGroupCatalogue();
    return betaLifecycleStateOf(catalogue, Date.now());
  } catch {
    return "UNKNOWN";
  }
}

// ── L2 — the PER-USER lifecycle state (the comms send-time guard's API) ───────

/**
 * One customer's lifecycle state, from THEIR effective policy group — the same
 * resolution the billable gate uses (resolve.ts over a FRESH catalogue).
 * Precedence COST_FREEZE > ENDED > PAUSED > ACTIVE. "UNKNOWN" whenever it cannot
 * be verified: no fresh catalogue, unreadable lifecycle facts, the customer's
 * assignment read failed, or the assignment fails closed (missing / unknown /
 * invalid group under the rollout switch — no group is in force). NEVER
 * defaults to ACTIVE: callers treat UNKNOWN as closed.
 */
export type UserLifecycleState = "ACTIVE" | "PAUSED" | "ENDED" | "COST_FREEZE" | "UNKNOWN";

/** PURE — the state for one customer's facts. */
export function userLifecycleStateOf(
  assignment: AssignmentFacts | null,
  catalogue: PolicyGroupCatalogue | null,
  opts: { failClosed: boolean; nowMs: number },
): UserLifecycleState {
  if (!isCatalogueFreshForBillable(catalogue, opts.nowMs)) return "UNKNOWN";
  const e = resolveEffectiveEntitlements(assignment, undefined, { failClosed: opts.failClosed, catalogue });
  if (e.failClosed) return "UNKNOWN";
  switch (e.lifecycleRestriction) {
    case "COST_FREEZE": return "COST_FREEZE";
    case "BETA_ENDED": return "ENDED";
    case "BETA_PAUSED": return "PAUSED";
    case "POLICY_UNAVAILABLE": return "UNKNOWN";
    default: return e.lifecycle === "ACTIVE" ? "ACTIVE" : "UNKNOWN";
  }
}

/**
 * BATCH — every requested user's state with ONE catalogue read and ONE
 * assignment query (the shared read of billableAllowedForUsers). Every id is
 * in the map. Never throws: a failed read ⇒ UNKNOWN for everyone.
 */
export async function getBetaLifecycleStatesForUsers(
  userIds: readonly string[],
  client?: BillableGateReadClient,
  deps: BillableGateDeps = {},
): Promise<Map<string, UserLifecycleState>> {
  const ids = [...new Set(userIds)];
  const out = new Map<string, UserLifecycleState>();
  if (ids.length === 0) return out;
  const facts = await readPolicyFactsForUsers(ids, client, deps);
  for (const id of ids) {
    out.set(id, facts === null ? "UNKNOWN"
      : userLifecycleStateOf(facts.assignments.get(id) ?? null, facts.catalogue, { failClosed: facts.failClosed, nowMs: facts.nowMs }));
  }
  return out;
}

/** One customer's state (see getBetaLifecycleStatesForUsers). Never throws. */
export async function getBetaLifecycleStateForUser(
  userId: string,
  client?: BillableGateReadClient,
  deps: BillableGateDeps = {},
): Promise<UserLifecycleState> {
  return (await getBetaLifecycleStatesForUsers([userId], client, deps)).get(userId) ?? "UNKNOWN";
}
