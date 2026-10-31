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
