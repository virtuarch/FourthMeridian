/**
 * POST /api/plaid/investments/enable
 *
 * Connection-specific "Enable Investments" completion. Called by the client
 * AFTER the user has granted Investments consent for a single Item via Plaid
 * Link update mode (link token minted with
 * `additional_consented_products: [investments]` — see
 * app/api/plaid/link-token/route.ts). The access_token is unchanged by that
 * flow; this endpoint simply runs the EXISTING holdings refresh so the newly
 * consented holdings are imported immediately.
 *
 * Body: { plaidItemId: string }
 *
 * Why a dedicated route rather than POST /api/plaid/refresh:
 *   /api/plaid/refresh enforces a 60-minute per-Item manual-refresh cooldown
 *   (lib/plaid/refreshCooldown.ts). A user who refreshed within the last hour
 *   and then enables Investments would be blocked (429), so consent would
 *   succeed with no holdings fetch — violating "holdings refresh runs after
 *   consent succeeds". This route calls refreshPlaidItem() directly (the same
 *   pipeline), gated instead by a light per-user rate limit. It is only ever
 *   reachable after a completed Link update-mode session, so it is not a
 *   poll-spam vector.
 *
 * Invariants honored:
 *   - Ownership + ACTIVE checked before any Plaid call.
 *   - No duplicate Item created (refreshPlaidItem targets the existing Item).
 *   - refreshPlaidItem re-derives consent from fresh accountsGet, flips
 *     CONSENT_REQUIRED → ENABLED, and imports holdings (lib/plaid/refresh.ts).
 *   - Existing transaction access / sync is untouched (the same refresh runs
 *     the existing cursor-based transaction sync as one of its steps).
 *   - No access token is exposed to the client.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { withApiHandler, getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";
import { PlaidInvestmentsConsent, PlaidItemStatus } from "@prisma/client";
import { refreshPlaidItem } from "@/lib/plaid/refresh";
import { classifyPlaidErrorForHealth, redactedErrorForLog } from "@/lib/plaid/errors";
import { notifyItemSyncFailed } from "@/lib/plaid/sync-notifications";
import { setPlaidItemHealth } from "@/lib/connections/health-transitions";
import { withPlaidItemSyncLock } from "@/lib/plaid/sync-lock";
import { limitByUser } from "@/lib/rate-limit";

interface EnableBody {
  plaidItemId?: string;
}

export const POST = withApiHandler(async (req: NextRequest) => {
  const [user, err] = await requireUser();
  if (err) return err;

  // Each call triggers a full Plaid refresh (external API + DB writes). A
  // legitimate user enables Investments on a handful of connections, not
  // dozens in fifteen minutes.
  const limited = await limitByUser(user.id, "plaid-investments-enable", { limit: 10, windowSec: 900 });
  if (limited) return limited;

  const body = (await req.json().catch(() => ({}))) as EnableBody;
  if (!body.plaidItemId) {
    return NextResponse.json({ error: "Missing plaidItemId" }, { status: 400 });
  }

  const item = await db.plaidItem.findFirst({
    where:  { id: body.plaidItemId, userId: user.id, status: PlaidItemStatus.ACTIVE },
    select: { id: true, investmentsConsent: true },
  });
  if (!item) {
    return NextResponse.json({ error: "Plaid item not found" }, { status: 404 });
  }

  // Defensive guard — the UI only offers this action where the Item supports
  // Investments (capability "available"). Never run it for an Item Plaid has
  // told us does not support Investments.
  if (item.investmentsConsent === PlaidInvestmentsConsent.UNSUPPORTED) {
    return NextResponse.json({ error: "Investments not supported for this connection" }, { status: 400 });
  }

  let holdingsUpdated = 0;
  // F1 (2026-07-14) — same shared syncLockedAt guard the webhook/connect
  // pipeline uses, so enabling Investments (which fires this route's
  // refreshPlaidItem call at nearly the same instant Plaid sends a HOLDINGS
  // webhook for the same item — connections-weirdness investigation §4.1(b))
  // can never run concurrently with that webhook's sync.
  try {
    const lockResult = await withPlaidItemSyncLock(item.id, () => refreshPlaidItem(item.id));
    if (!lockResult.ok) {
      return NextResponse.json({ error: "A sync is already in progress for this connection — try again shortly." }, { status: 409 });
    }
    holdingsUpdated = lockResult.result.holdingsUpdated;
  } catch (e) {
    console.error(`[POST /api/plaid/investments/enable] refresh failed for PlaidItem ${item.id}:`, redactedErrorForLog(e));
    const health = classifyPlaidErrorForHealth(e);
    if (health) {
      // CH-2 chokepoint (previously a direct db.plaidItem.update here — §5.1
      // of the connections-weirdness investigation: this failure path
      // bypassed the durable transition-history record).
      await setPlaidItemHealth(item.id, { status: health.status, errorCode: health.errorCode });
      await notifyItemSyncFailed(item.id);
    }
    return NextResponse.json({ error: "Failed to import investment holdings" }, { status: 500 });
  }

  // Re-read the consent flag refreshPlaidItem persisted — ENABLED once consent
  // was actually granted (holdings import path), else unchanged.
  const updated = await db.plaidItem.findUnique({
    where:  { id: item.id },
    select: { investmentsConsent: true },
  });

  await db.auditLog.create({
    data: {
      userId:    user.id,
      action:    AuditAction.PLAID_REFRESH,
      metadata:  {
        trigger:            "investments-enable",
        plaidItemId:        item.id,
        holdingsUpdated,
        investmentsConsent: updated?.investmentsConsent ?? null,
      },
      ipAddress: getClientIp(req),
    },
  });

  return NextResponse.json({
    ok:                 true,
    holdingsUpdated,
    investmentsConsent: updated?.investmentsConsent ?? null,
  });
}, "POST /api/plaid/investments/enable");
