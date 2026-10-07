/**
 * POST /api/refresh/all  (P1 — the customer's provider-agnostic "Refresh All")
 *
 * Refresh Fourth Meridian's understanding from EVERY eligible financial
 * authority the caller has connected — Plaid banking and investments, crypto
 * wallets — through the one orchestrator (lib/refresh/refresh-all.ts), and
 * return one structured outcome per authority. Nothing here pretends a provider
 * refreshed when it was skipped (cooldown, in flight) or refused (not
 * refreshable, not admitted, rate-limited).
 *
 * AUTHORITY: the customer's own. Entitlements are read, and every guard write is
 * made, through `withTenantDb` phases (lib/refresh/deps.ts tenantRefreshDeps);
 * the provider primitives run on their own authority outside any phase. The
 * ledger trigger is MANUAL. An operator refreshing on a customer's behalf uses
 * a different route (Customer Success) and the OPERATOR trigger.
 *
 * Per-user backstop: 6 / hour (coarse — the per-authority cooldown and the
 * wallet ceiling are the real limits). 200 with the report in every admitted
 * case; the report says what happened.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { withTenantDb } from "@/lib/db/tenant-context";
import { limitByUser } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";
import { buildAuditData } from "@/lib/audit";
import { loadEffectiveEntitlements } from "@/lib/entitlements/resolve";
import { refreshAllForUser } from "@/lib/refresh/refresh-all";
import { tenantRefreshDeps } from "@/lib/refresh/deps";

export const runtime = "nodejs";
/** Plaid items in series, then wallets in series under a 90 s budget. */
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const [user, err] = await requireUser();
  if (err) return err;

  const limited = await limitByUser(user.id, "refresh-all", { limit: 6, windowSec: 3600 });
  if (limited) return limited;

  const entitlements = await withTenantDb(user.id, (tx) => loadEffectiveEntitlements(tx, user.id));

  const report = await refreshAllForUser(
    { userId: user.id, authority: "USER", entitlements },
    tenantRefreshDeps(user.id),
  );

  // Counts only — no institution names, no amounts (JobRun/AuditLog metadata doctrine).
  await withTenantDb(user.id, (tx) => tx.auditLog.create({
    data: buildAuditData({
      actorId: user.id,
      actorType: "USER",
      action: AuditAction.REFRESH_ALL_REQUESTED,
      result: "SUCCESS",
      metadata: { summary: report.summary, policyGroup: entitlements.policyGroup },
      ipAddress: getClientIp(req),
    }),
  })).catch((e) => console.warn("[refresh-all] audit write failed (non-fatal):", e instanceof Error ? e.message : String(e)));

  return NextResponse.json(report);
}
