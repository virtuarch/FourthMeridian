/**
 * GET  /api/platform/platform-ops/provider-cleanup   — what Plaid still owes us
 * POST /api/platform/platform-ops/provider-cleanup   — retry ONE item's cleanup
 *
 * The operator surface for the provider-cleanup lifecycle f339e57 made durable.
 * Before it, a failed `itemRemove` left the item REVOKED and therefore invisible
 * to every `status: ACTIVE` work-list in the repository, while the Item kept
 * existing at Plaid, kept emitting webhooks and — per the vendored SDK, for
 * Transactions/Liabilities/Investments — KEPT BILLING. That is what stranded
 * seven live Items on 2026-07-22. The obligation is now recorded; this makes it
 * VISIBLE, so an operator does not have to remember to run
 * `npm run plaid:cleanup-orphans` to find out.
 *
 * ⚠️ THE TWO STATES ARE REPORTED SEPARATELY AND NEVER CONFLATED.
 *   productStatus          PlaidItem.status (REVOKED) — the customer's view
 *   provider cleanup       newest marker UNCONFIRMED / CONFIRMED — ours
 * `status === REVOKED` is NOT evidence of provider cleanup, and the vacuous
 * check that assumed it was is the defect f339e57 repaired. Nothing in this
 * file infers cleanup from status, including the POST's success condition.
 *
 * AUTHORIZATION
 *   GET  requirePlatformAccess("PLATFORM_OPS", "READ")        — as every other
 *        Platform Ops read widget.
 *   POST requireFreshPlatformAccess("PLATFORM_OPS", "WRITE")  — as the existing
 *        per-connection operator actions (resync, request-reauth). An operator,
 *        not the owner, so it is NOT userId-scoped; READ → 403.
 *
 * ⚠️ THE ACTION ADDS NO AUTHORITY AND NO SEMANTICS. It calls
 * `disconnectPlaidItemIfOrphaned` — the single canonical revocation path, which
 * all five runtime call sites and three scripts already share — and then RE-READS
 * the durable marker to decide what to report. It does not re-implement the
 * classifier, does not widen `ITEM_NOT_FOUND` / `INVALID_ACCESS_TOKEN`
 * semantics, does not touch `PlaidItem.status` itself, and is MANUAL: there is
 * no scheduled retry, deliberately, because the `ITEM_NOT_FOUND`
 * success-equivalence is a repo assertion the vendored SDK does not confirm and
 * an unbounded loop on an unconfirmable code is the one shape to avoid.
 *
 * AUTHORITY — `systemDb` (fm_system), never `db`. An operator reads across all
 * tenants with no user identity to bind, so there is no tenant phase this could
 * belong to; fm_system is NOBYPASSRLS and reaches each tenant through explicit
 * role-scoped policies, which is strictly narrower than the migration
 * principal. A first version used `db` and `audit-db-authority` refused it
 * (ratchet 185 → 187) — correctly, so the authority was fixed rather than the
 * baseline widened.
 *
 * PRIVACY — operational metadata only, matching connection-diagnostics' binding
 * boundary: item id, institution label, an opaque owner reference, timestamps,
 * counts, and the provider's own error code. No access token, no email, no
 * financial content, in responses or in audit metadata.
 */

import { NextRequest, NextResponse } from "next/server";
import { systemDb } from "@/lib/db";
import { requirePlatformAccess, requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { AuditAction } from "@/lib/audit-actions";
import { redactedErrorForLog } from "@/lib/plaid/errors";
import { disconnectPlaidItemIfOrphaned } from "@/lib/plaid/disconnect";
import {
  getProviderCleanupStatus,
  isProviderCleanupOwed,
  type ProviderCleanupStatus,
} from "@/lib/platform/plaid/provider-cleanup";

export const runtime = "nodejs";

export type PlatformProviderCleanupResponse = ProviderCleanupStatus;

export async function GET() {
  const [, err] = await requirePlatformAccess("PLATFORM_OPS", "READ");
  if (err) return err;
  return NextResponse.json(await getProviderCleanupStatus());
}

export type ProviderCleanupRetryResponse = {
  plaidItemId: string;
  /** THE SUCCESS CONDITION: the newest provider-cleanup marker is CONFIRMED. */
  confirmed: boolean;
  /** True when the obligation remains after the attempt. */
  stillOwed: boolean;
  /** Present when the retry could not even be attempted. */
  skipped?: "NOT_OWED" | "ITEM_GONE";
};

export async function POST(req: NextRequest) {
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "WRITE");
  if (err) return err;

  const body = (await req.json().catch(() => null)) as { plaidItemId?: unknown } | null;
  const plaidItemId = typeof body?.plaidItemId === "string" ? body.plaidItemId : null;
  if (!plaidItemId) {
    return NextResponse.json({ error: "plaidItemId is required." }, { status: 400 });
  }

  // ⚠️ ONLY AN ITEM THAT IS ACTUALLY OWED. This is not a general "revoke this
  // item" lever — that would be a new destructive capability wearing a cleanup
  // label. The gate is the durable marker, read before anything happens.
  if (!(await isProviderCleanupOwed(plaidItemId))) {
    return NextResponse.json(
      { plaidItemId, confirmed: false, stillOwed: false, skipped: "NOT_OWED" } satisfies ProviderCleanupRetryResponse,
      { status: 409 },
    );
  }

  const item = await systemDb.plaidItem.findUnique({ where: { id: plaidItemId }, select: { id: true, institutionName: true, userId: true } });
  if (!item) {
    // The marker outlives its item by design; there is nothing left to revoke.
    return NextResponse.json(
      { plaidItemId, confirmed: false, stillOwed: true, skipped: "ITEM_GONE" } satisfies ProviderCleanupRetryResponse,
      { status: 409 },
    );
  }

  // The canonical path. It re-counts live connections itself, so a retry on an
  // item that has since been re-linked correctly declines — which is why this
  // route does not pre-judge that condition either.
  try {
    await disconnectPlaidItemIfOrphaned(plaidItemId);
  } catch (e) {
    // A throw here is a DB/decrypt failure, not a provider refusal: the provider
    // outcome is swallowed and classified inside that function by design. The
    // obligation therefore stands, and the re-read below is what says so.
    console.error(`[platform-ops] provider-cleanup retry failed for item ${plaidItemId}:`, redactedErrorForLog(e));
  }

  // ⚠️ RE-READ DURABLE STATE. Not the action's return value (it returns void by
  // design), and emphatically NOT `PlaidItem.status`, which
  // `disconnectPlaidItemIfOrphaned` writes REVOKED whatever Plaid answered.
  const stillOwed = await isProviderCleanupOwed(plaidItemId);

  await systemDb.auditLog.create({
    data: {
      userId:             item.userId,
      action:             AuditAction.PLAID_ITEM_REVOCATION_RETRY_REQUESTED,
      performedByAdminId: auth.user.id,
      metadata: {
        provider:    "PLAID",
        plaidItemId,
        institution: item.institutionName,
        // The outcome as the MARKER sees it, which is the only honest reading.
        outcome:     stillOwed ? "STILL_UNCONFIRMED" : "CONFIRMED",
      },
    },
  });

  return NextResponse.json(
    { plaidItemId, confirmed: !stillOwed, stillOwed } satisfies ProviderCleanupRetryResponse,
  );
}
