/**
 * POST /api/platform/customer-success/customers/[userId]/refresh  (P1)
 *
 * OPERATOR "Refresh all" on a customer's behalf: every eligible connected
 * financial authority through the ONE orchestrator (lib/refresh/refresh-all.ts)
 * with authority OPERATOR — the same execution primitives, locks and ledger the
 * customer's own Refresh All uses, a different authority and a different audit
 * (OPERATOR_REFRESH_ALL via recordOperatorAction; no reason required — the
 * action is the reason). Returns the structured per-authority outcomes; nothing
 * is reported as refreshed that was skipped or refused.
 *
 * AUTHORIZATION: requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE").
 */

import { NextRequest, NextResponse } from "next/server";
import { systemDb } from "@/lib/db";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { getRequestMeta } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";
import { recordOperatorAction } from "@/lib/audit";
import { loadEffectiveEntitlements } from "@/lib/entitlements/resolve";
import { refreshAllForUser } from "@/lib/refresh/refresh-all";
import { clientRefreshDeps } from "@/lib/refresh/deps";
import type { RefreshAllReport } from "@/lib/refresh/outcomes";

export const runtime = "nodejs";
/** A full refresh across several authorities can take minutes (Plaid history, wallet reconstruction). */
export const maxDuration = 300;

export type OperatorRefreshAllResponse = RefreshAllReport;

export async function POST(req: NextRequest, ctx: { params: Promise<{ userId: string }> }): Promise<Response> {
  const [auth, err] = await requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE");
  if (err) return err;
  const { userId } = await ctx.params;
  const user = await systemDb.user.findUnique({ where: { id: userId }, select: { id: true, deactivatedAt: true } });
  if (!user) return NextResponse.json({ error: "Customer not found." }, { status: 404 });
  if (user.deactivatedAt) return NextResponse.json({ error: "Customer is deactivated; nothing is refreshed for a deactivated account." }, { status: 409 });

  const meta = getRequestMeta(req);
  const actor = { userId: auth.user.id, via: auth.grant ? ("PLATFORM_GRANT" as const) : ("SYSTEM_ADMIN" as const) };
  const entitlements = await loadEffectiveEntitlements(systemDb, userId);
  // fm_system reads: the operator is acting outside their own tenancy by definition.
  const report = await refreshAllForUser({ userId, authority: "OPERATOR", actor, entitlements }, clientRefreshDeps(systemDb));

  await recordOperatorAction(systemDb, {
    actor: { ...actor, area: "CUSTOMER_SUCCESS" },
    action: AuditAction.OPERATOR_REFRESH_ALL,
    target: { kind: "USER", id: userId },
    result: report.summary.failed > 0 && report.summary.started === 0 ? "FAILURE" : "SUCCESS",
    detail: { summary: report.summary, executionIds: report.outcomes.map((o) => o.executionId).filter((x): x is string => typeof x === "string") },
    ipAddress: meta.ip, userAgent: meta.userAgent,
  });
  return NextResponse.json(report satisfies OperatorRefreshAllResponse);
}
