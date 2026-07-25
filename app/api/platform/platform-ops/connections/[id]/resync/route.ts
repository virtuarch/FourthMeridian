/**
 * POST /api/platform/platform-ops/connections/[id]/resync  (PO-4A)
 *
 * Operator-triggered resync of ONE customer Plaid connection. `id` is the
 * connection-health row id, which for a PLAID source IS the PlaidItem.id.
 *
 * REUSES the existing per-item sync path — NO second engine:
 *   withPlaidItemSyncLock(id, () => syncTransactionsForItem(id))
 * exactly as jobs/sync-banks.ts runs it per item. So this respects the same
 * per-item lock (an in-flight sync is coalesced, not raced) and the same manual
 * cooldown (checkManualRefreshCooldown / markManualRefreshed) the owner Refresh
 * uses. On failure it classifies + records health via setPlaidItemHealth and
 * pings the owner — identical to the cron.
 *
 * AUTHORIZATION: requireFreshPlatformAccess("PLATFORM_OPS", "WRITE") — an
 * operator, not the owner, so it is NOT userId-scoped. READ → 403.
 * AUDIT: CONNECTION_RESYNC_TRIGGERED { connectionId, provider, institution,
 * outcome } with performedByAdminId. Metadata is operational only — counts of
 * rows touched, never any transaction/balance/holding content.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PlaidItemStatus } from "@prisma/client";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { AuditAction } from "@/lib/audit-actions";
import { withPlaidItemSyncLock, type SyncLockResult } from "@/lib/plaid/sync-lock";
import { syncTransactionsForItem } from "@/lib/plaid/syncTransactions";
import { runFullRefresh, recordAdmissionDenial } from "@/lib/plaid/refresh-execution";
import { admitOperationalWork } from "@/lib/platform/admission/facts";
import { classifyPlaidErrorForHealth } from "@/lib/plaid/errors";
import { setPlaidItemHealth } from "@/lib/connections/health-transitions";
import { notifyItemSyncFailed } from "@/lib/plaid/sync-notifications";
import { checkManualRefreshCooldown, markManualRefreshed } from "@/lib/plaid/refreshCooldown";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [auth, err] = await requireFreshPlatformAccess("PLATFORM_OPS", "WRITE");
  if (err) return err;

  const { id } = await ctx.params;

  const item = await db.plaidItem.findUnique({
    where:  { id },
    select: { id: true, status: true, institutionName: true, lastManualRefreshAt: true },
  });
  if (!item) {
    return NextResponse.json({ error: "Connection not found." }, { status: 404 });
  }
  // A dead-credential item cannot sync — steer to reauthorization instead.
  if (item.status === PlaidItemStatus.NEEDS_REAUTH || item.status === PlaidItemStatus.REVOKED) {
    return NextResponse.json(
      { error: "This connection needs reauthorization before it can sync. Use Request reauthorization." },
      { status: 409 },
    );
  }

  // Respect the existing per-item manual cooldown (60 min) — do not bypass it.
  const cooldown = checkManualRefreshCooldown(item.lastManualRefreshAt);
  if (cooldown.onCooldown) {
    return NextResponse.json(
      { error: "cooldown", retryAfterSeconds: cooldown.retryAfterSeconds },
      { status: 429 },
    );
  }

  const auditResync = (outcome: string, extra: Record<string, unknown> = {}) =>
    db.auditLog.create({
      data: {
        // No userId: a connection action has no USER subject — the target is the
        // connection (institution), surfaced via metadata in the operator feed.
        // performedByAdminId is the acting operator.
        performedByAdminId: auth.user.id,
        action:             AuditAction.CONNECTION_RESYNC_TRIGGERED,
        metadata:           { connectionId: item.id, provider: "PLAID", institution: item.institutionName, outcome, ...extra },
      },
    });

  // ── OPS-2D-3 — ADMISSION ────────────────────────────────────────────────────
  // The operator is authorized (WRITE, checked above) and this item is eligible
  // (status, cooldown, checked above). A fourth, separate question remains: has
  // an operator declared a platform state under which this class of work should
  // not begin? Authorization cannot answer it, and no amount of capability
  // changes the answer — a CONTROL holder who paused ingestion is subject to
  // their own pause.
  //
  // Placed AFTER authorization (an unauthorized caller learns nothing about
  // platform state) and BEFORE the cooldown is consumed and the lock is claimed:
  // work that will not run must not burn the caller's 60-minute cooldown.
  //
  // 503, not 403: this is a platform condition, not a permissions problem, and
  // conflating the two sends operators hunting for grants during an outage.
  const admission = await admitOperationalWork({ work: "REFRESH_EXECUTION" });
  if (admission.decision === "DENY") {
    // Ledgered, not silent — the denial is a first-class execution so the
    // operator's own declaration is visible on the Refresh workspace.
    const { runId } = await recordAdmissionDenial({
      itemId:          item.id,
      trigger:         "OPERATOR",
      profile:         "TRANSACTIONS_ONLY",
      admissionReason: admission.reason!,
    });
    await auditResync("not-admitted", { admissionReason: admission.reason, runId });
    return NextResponse.json(
      {
        error:       "not-admitted",
        reason:      admission.reason,
        message:     admission.label,
        evaluatedAt: admission.evaluatedAt,
        runId,
      },
      { status: 503 },
    );
  }

  await markManualRefreshed(item.id);

  try {
    // OPS-2D-1 — the SAME lock + the SAME body, now inside the canonical
    // execution envelope so an operator resync leaves RefreshExecution evidence
    // like every other refresh. Nothing about the orchestration changed: the
    // lock is still claimed here, the cooldown was already enforced above, and
    // a thrown Plaid error still propagates to the catch below (runFullRefresh
    // records the failure and rethrows the ORIGINAL error).
    //
    // Profile TRANSACTIONS_ONLY, not FULL_REFRESH: this path syncs the
    // transaction cursor and nothing else. Claiming a full refresh would assert
    // balances and holdings were refreshed when they were not.
    type TxResult = Awaited<ReturnType<typeof syncTransactionsForItem>>;
    const lockResult = await runFullRefresh<SyncLockResult<TxResult>>(
      { itemId: item.id, trigger: "OPERATOR", profile: "TRANSACTIONS_ONLY" },
      {
        refresh: async ({ recorder, runId }) => {
          recorder.begin("TRANSACTIONS", "PROVIDER");
          const res = await withPlaidItemSyncLock(item.id, () => syncTransactionsForItem(item.id, { runId }));
          if (!res.ok) {
            recorder.skip("TRANSACTIONS", "PROVIDER", "IN_FLIGHT");
            return res;
          }
          const tx = res.result;
          recorder.succeed("TRANSACTIONS", {
            recordsRead:    tx.added + tx.modified,
            recordsWritten: tx.created + tx.updatedByPlaidId + tx.updatedByFingerprint,
            recordsChanged: tx.added + tx.modified + tx.removed,
          });
          return res;
        },
      },
    );
    if (!lockResult.ok) {
      // A sync is already in flight (cron/webhook/other) — coalesced, not raced.
      return NextResponse.json({ error: "in-flight" }, { status: 409 });
    }
    const r = lockResult.result;
    await auditResync("synced", { added: r.added, modified: r.modified, removed: r.removed });
    return NextResponse.json({
      ok: true,
      outcome: "synced",
      counts: { added: r.added, modified: r.modified, removed: r.removed },
    });
  } catch (e) {
    // Same failure handling as sync-banks: classify → record health → ping owner.
    const health = classifyPlaidErrorForHealth(e);
    if (health) {
      await setPlaidItemHealth(item.id, { status: health.status, errorCode: health.errorCode });
      await notifyItemSyncFailed(item.id);
    }
    await auditResync("failed");
    return NextResponse.json({ error: "Resync failed" }, { status: 500 });
  }
}
