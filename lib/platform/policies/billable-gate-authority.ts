/**
 * lib/platform/policies/billable-gate-authority.ts  (BETA LIFECYCLE L1)
 *
 * The DEFAULT read authority of the billable gate (lib/entitlements/billable-gate.ts):
 * fm_system. The gate's callers are mostly jobs, the Plaid webhook and other
 * work with NO tenant phase, and it must read another customer's assignment
 * (a job dispatching for many users, a Space's owner). A product route that
 * already holds the customer's tenant phase may pass that instead — the
 * customer may read their own CustomerPolicyAssignment under RLS.
 *
 * Narrowest opening: one function, no argument, returning the client typed as
 * the gate's two reads (assignments by user id, a Space's ACTIVE OWNER ids).
 */

import "server-only";
import { systemDb } from "@/lib/db";
import type { BillableGateReadClient } from "@/lib/entitlements/billable-gate";

export function billableGateSystemClient(): BillableGateReadClient {
  return systemDb as unknown as BillableGateReadClient;
}
