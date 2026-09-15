/**
 * lib/platform/refresh/inspection.ts  (PLATFORM OPS OBSERVABILITY)
 *
 * ONE execution, inspected: the row seam's detail (execution + stages +
 * provider calls + coverage), the source's LAST SUCCESSFUL execution, and the
 * refresh POLICY in force for its source kind — composed here so the route
 * stays a gate and the panel gets one payload.
 *
 * Reads only through the seams (read-boundary.test.ts): this module touches no
 * ledger table itself. Operator audience only.
 */

import "server-only";
import { db } from "@/lib/db";
import { loadRefreshPolicies } from "@/lib/platform/refresh-policy";
import { getExecutionContext, getRefreshExecutionDetail } from "@/lib/platform/refresh/execution-query";
import type { ExecutionDetailDTO, ExecutionRowDTO } from "@/lib/platform/refresh/execution-query-core";
import { isOverdue } from "@/lib/platform/refresh-policy.core";

export interface ExecutionInspection {
  detail: ExecutionDetailDTO;
  context: {
    lastSucceeded: ExecutionRowDTO | null;
    policy: {
      sourceKind: "BANK" | "WALLET";
      cadence: string;
      expectedEveryHours: number;
      overdueAfterHours: number;
      origin: string;
    };
    /**
     * Whether the source is overdue against its policy, judged from its last
     * successful execution in THIS ledger. Null when no success is recorded —
     * "never succeeded here" is not the same as "overdue".
     */
    overdueAgainstPolicy: boolean | null;
    /** When the source becomes eligible for a scheduled refresh, from its last success + cadence. */
    nextEligibleAt: string | null;
  };
}

export async function inspectExecution(executionId: string, now: Date = new Date()): Promise<ExecutionInspection | null> {
  const detail = await getRefreshExecutionDetail({ audience: "operator", executionId });
  if (!detail) return null;
  const [context, policies] = await Promise.all([getExecutionContext(executionId), loadRefreshPolicies(db)]);
  const kind = detail.execution.sourceKind === "WALLET" ? "WALLET" : "BANK";
  const policy = policies[kind];
  const last = context?.lastSucceeded ?? null;
  const lastAt = last ? new Date(last.startedAt) : null;
  return {
    detail,
    context: {
      lastSucceeded: last,
      policy: {
        sourceKind: kind,
        cadence: policy.cadence,
        expectedEveryHours: policy.expectedEveryHours,
        overdueAfterHours: policy.overdueAfterHours,
        origin: policy.origin,
      },
      overdueAgainstPolicy: lastAt ? isOverdue(lastAt, policy, now) : null,
      nextEligibleAt: lastAt ? new Date(lastAt.getTime() + policy.expectedEveryHours * 3_600_000).toISOString() : null,
    },
  };
}
