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
 * AUDIT: CONNECTION_REAUTH_REQUESTED { connectionId, provider, institution,
 * outcome, statusChanged, notice, incidentId? } with performedByAdminId.
 * Operational metadata only.
 *
 * RESPONSE (Incident detail v1 — honest, never a bare ok): `{ outcome,
 * statusChanged, notice }` where outcome is created | suppressed_duplicate |
 * marked_not_notified | no_change (lib/platform/incidents/action-context.ts).
 * A deduped notice is reported as suppressed_duplicate, not as "sent".
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PlaidItemStatus } from "@prisma/client";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { AuditAction } from "@/lib/audit-actions";
import { recordOperatorAction } from "@/lib/audit";
import { operatorActorFrom } from "@/lib/platform/operator-actor";
import { setPlaidItemHealth } from "@/lib/connections/health-transitions";
import { notifyItemSyncFailedWithOutcome } from "@/lib/plaid/sync-notifications";
import { incidentBelongsToItem } from "@/lib/platform/incidents/intelligence";
import { incidentAuditDetail, incidentIdFromSearch, verifiedIncidentId, reauthRequestOutcome } from "@/lib/platform/incidents/action-context";
import { limitByKey, limitByUser } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** SEC-PLAT-2 — notification bounds (see the POST body). */
const REAUTH_PER_OPERATOR_PER_HOUR = 20;
const REAUTH_PER_ITEM_PER_DAY = 3;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "WRITE");
  if (err) return err;

  // SEC-PLAT-2 — every accepted call NOTIFIES A CUSTOMER, so it is bounded twice:
  // per operator (a stuck button or a compromised WRITE session cannot fan out
  // notifications across the fleet) and, below, per connection (one customer is
  // never nagged more than a few times a day).
  const limitedOperator = await limitByUser(auth.user.id, "platform-reauth-request", { limit: REAUTH_PER_OPERATOR_PER_HOUR, windowSec: 3600 });
  if (limitedOperator) return limitedOperator;

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

  const limitedItem = await limitByKey(item.id, "platform-reauth-item", { limit: REAUTH_PER_ITEM_PER_DAY, windowSec: 86_400 });
  if (limitedItem) return limitedItem;

  // S2 R2 — the incident id rides the audit ONLY when verified: it exists and names THIS connection.
  const incidentId = await verifiedIncidentId(incidentIdFromSearch(req.nextUrl.searchParams), item.id, incidentBelongsToItem);

  // Mark NEEDS_REAUTH (the single chokepoint; records the transition on change) —
  // this lights the existing owner reconnect prompt. NEVER itemRemove.
  const statusChanged = item.status !== PlaidItemStatus.NEEDS_REAUTH;
  await setPlaidItemHealth(item.id, { status: PlaidItemStatus.NEEDS_REAUTH });
  const notice = await notifyItemSyncFailedWithOutcome(item.id);
  const outcome = reauthRequestOutcome(statusChanged, notice);

  // P1 — the operator-action chokepoint: target = the PLAID_ITEM (no USER
  // subject); performedByAdminId is the acting operator; institution is a label.
  await recordOperatorAction(db, {
    actor:  operatorActorFrom(auth, "PLATFORM_OPS"),
    action: AuditAction.CONNECTION_REAUTH_REQUESTED,
    target: { kind: "PLAID_ITEM", id: item.id },
    result: "SUCCESS",
    detail: {
      connectionId: item.id, provider: "PLAID", institution: item.institutionName,
      outcome, statusChanged, notice, ...incidentAuditDetail(incidentId),
    },
  });

  return NextResponse.json({ outcome, statusChanged, notice });
}
