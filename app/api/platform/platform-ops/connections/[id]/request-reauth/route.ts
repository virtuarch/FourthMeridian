/**
 * POST /api/platform/platform-ops/connections/[id]/request-reauth  (PO-4A)
 *
 * Operator asks the customer to reconnect ONE Plaid connection. This means
 * "ask the customer to reauthorize", NOT "remove the connection".
 *
 * It marks the item NEEDS_REAUTH via the single health chokepoint
 * (setPlaidItemHealth) — which lights the EXISTING owner-facing reconnect flow
 * (ReconnectAccountButton renders on account.needsReauth) and records the
 * durable PLAID_ITEM_STATUS_CHANGED transition — then pings the owner
 * (notifyItemSyncFailed, suppress-deduped). It NEVER calls plaidClient.itemRemove
 * and never touches item_id / cursor continuity: update-mode reconnect preserves
 * them, and removal is irreversible.
 *
 * AUTHORIZATION: requireFreshPlatformAccess("PLATFORM_OPS", "WRITE"). READ → 403.
 * AUDIT: CONNECTION_REAUTH_REQUESTED { connectionId, provider, institution } with
 * performedByAdminId. Operational metadata only.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PlaidItemStatus } from "@prisma/client";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { AuditAction } from "@/lib/audit-actions";
import { setPlaidItemHealth } from "@/lib/connections/health-transitions";
import { notifyItemSyncFailed } from "@/lib/plaid/sync-notifications";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "WRITE");
  if (err) return err;

  const { id } = await ctx.params;

  const item = await db.plaidItem.findUnique({
    where:  { id },
    select: { id: true, status: true, institutionName: true },
  });
  if (!item) {
    return NextResponse.json({ error: "Connection not found." }, { status: 404 });
  }
  // A revoked item is gone at Plaid — the customer must re-add it, not reauthorize.
  if (item.status === PlaidItemStatus.REVOKED) {
    return NextResponse.json(
      { error: "This connection is revoked — the customer must re-add it." },
      { status: 409 },
    );
  }

  // Mark NEEDS_REAUTH (the single chokepoint; records the transition on change) —
  // this lights the existing owner reconnect prompt. NEVER itemRemove.
  await setPlaidItemHealth(item.id, { status: PlaidItemStatus.NEEDS_REAUTH });
  await notifyItemSyncFailed(item.id);

  await db.auditLog.create({
    data: {
      // No userId: the target is the connection (institution), not a user;
      // surfaced via metadata. performedByAdminId is the acting operator.
      performedByAdminId: auth.user.id,
      action:             AuditAction.CONNECTION_REAUTH_REQUESTED,
      metadata:           { connectionId: item.id, provider: "PLAID", institution: item.institutionName },
    },
  });

  return NextResponse.json({ ok: true });
}
