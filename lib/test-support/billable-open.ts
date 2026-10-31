/**
 * lib/test-support/billable-open.ts  (BETA LIFECYCLE L2 — test-only)
 *
 * The L2 gates in their OPEN state, for tests that exercise something else
 * (budgets, rotation, checkpoints) and must not depend on a policy read. The
 * gates themselves are proved closed by app/api/cost-freeze-enforcement.test.ts
 * and jobs/cost-freeze-jobs.test.ts. ⚠️ Imported by *.test.ts files only.
 */

import type { BillableDecision } from "@/lib/entitlements/billable-gate-core";
import type { GlobalCostFreezeVerdict } from "@/lib/platform/cost-freeze.core";

const OPEN = "ADMIT" as const;
const ALLOWED: BillableDecision = { allowed: true };

/** Every user/account allowed — the batch loader shape. */
export const allowAllBillable = async (ids: readonly string[]): Promise<Map<string, BillableDecision>> =>
  new Map(ids.map((id) => [id, ALLOWED] as const));

export const notFrozen = async (): Promise<GlobalCostFreezeVerdict> => ({ frozen: false, state: "MISSING", reason: null });

/** The history worker's three required L2 gates, open. */
export const OPEN_BACKFILL_GATES = {
  admit: async () => ({ decision: OPEN, reason: null }),
  costFreeze: notFrozen,
  billableAccounts: allowAllBillable,
};
