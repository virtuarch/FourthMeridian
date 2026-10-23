/**
 * POST /api/plaid/refresh
 *
 * Manual "Refresh" trigger for the caller's Plaid items. The single-item branch
 * runs one item under the canonical execution envelope; the bulk branch is a
 * thin, Plaid-only caller of the provider-agnostic orchestrator
 * (lib/refresh/refresh-all.ts) — the product's "Refresh All" gesture now lives
 * at POST /api/refresh/all. No refresh logic is duplicated here.
 *
 * Body (optional): { plaidItemId?: string }
 *   - plaidItemId provided: refresh only that item (must belong to the caller).
 *   - omitted: refresh every active PlaidItem owned by the caller.
 *
 * One item's failure (e.g. ITEM_LOGIN_REQUIRED) does not block the others —
 * each result is reported individually.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { withTenantDb } from "@/lib/db/tenant-context";
import { withApiHandler, getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";
import { PlaidItemStatus } from "@prisma/client";
import type { RefreshSummary, RefreshItemResult } from "@/lib/plaid/refresh";
// DF-2A — the single-item manual refresh runs under the canonical execution
// authority (opens one immutable RefreshExecution, persists per-stage results,
// derives overall status). Behavior/return value are unchanged; telemetry is
// best-effort and never breaks the refresh.
import { runFullRefresh } from "@/lib/plaid/refresh-execution";
import { classifyPlaidErrorForHealth, redactedErrorForLog } from "@/lib/plaid/errors";
import { notifyItemSyncFailed } from "@/lib/plaid/sync-notifications";
import { setPlaidItemHealth } from "@/lib/connections/health-transitions";
import { withPlaidItemSyncLock } from "@/lib/plaid/sync-lock";
import { checkManualRefreshCooldown, cooldownMsFromMinutes, markManualRefreshed } from "@/lib/plaid/refreshCooldown";
import { loadEffectiveEntitlements } from "@/lib/entitlements/resolve";
import { refreshAllForUser } from "@/lib/refresh/refresh-all";
import { tenantRefreshDeps } from "@/lib/refresh/deps";
import type { RefreshAllReport } from "@/lib/refresh/outcomes";
import { limitByUser } from "@/lib/rate-limit";
import { admitOperationalWork } from "@/lib/platform/admission/facts";

interface RefreshBody {
  plaidItemId?: string;
}

// RLS-PREP-C — this route's OWN reads and writes run on the tenant role.
// `PlaidItem` and `Connection` are user-scoped tables (`"userId" = me`) and
// `AuditLog` inserts are open to fm_app, so each statement the handler issues
// directly is one short `withTenantDb` phase: the lookup that decides WHICH item
// a user may act on is now a database guarantee, not a `where` clause on the
// owner's connection. The provider work those lookups authorise — the sync and
// refresh pipelines in lib/plaid/ — runs on its own authority and is not part of
// this conversion (it interleaves Plaid HTTP with its writes, and a tenant phase
// must never span a network round trip).
export const POST = withApiHandler(async (req: NextRequest) => {
  const [user, err] = await requireUser();
  if (err) return err;

  // OPS-1 S4 — coarse per-user backstop over the per-item cooldown below
  // (the cooldown is per PlaidItem; many items would otherwise multiply it).
  const limited = await limitByUser(user.id, "plaid-refresh", { limit: 20, windowSec: 3600 });
  if (limited) return limited;

  // ── OPS-2D-4 — ADMISSION ────────────────────────────────────────────────────
  // After authorization and the rate limit; BEFORE the cooldown is consumed, the
  // lock is claimed, or any provider call is made. A denial therefore costs the
  // caller nothing: their 60-minute cooldown is intact and they may retry the
  // moment the platform is unpaused.
  //
  // 503, not 403: the caller's permissions are fine — the platform is not
  // accepting this work right now. Returning 403 would send people hunting for
  // access they already have.
  const admission = await admitOperationalWork({ work: "REFRESH_EXECUTION" });
  if (admission.decision === "DENY") {
    return NextResponse.json(
      { error: "not-admitted", reason: admission.reason, message: admission.label,
        evaluatedAt: admission.evaluatedAt },
      { status: 503 },
    );
  }


  // P1 — the manual cooldown is the customer's effective entitlement, not a literal.
  const entitlements = await withTenantDb(user.id, (tx) => loadEffectiveEntitlements(tx, user.id));
  const cooldownMs = cooldownMsFromMinutes(Number(entitlements.dimensions.manualBankRefreshCooldownMinutes.value));

  const body = (await req.json().catch(() => ({}))) as RefreshBody;

  let summary: RefreshSummary;

  if (body.plaidItemId) {
    const requestedItemId = body.plaidItemId;
    const item = await withTenantDb(user.id, (tx) => tx.plaidItem.findFirst({
      where:  { id: requestedItemId, userId: user.id, status: PlaidItemStatus.ACTIVE },
      select: { id: true, lastManualRefreshAt: true },
    }));
    if (!item) {
      return NextResponse.json({ error: "Plaid item not found" }, { status: 404 });
    }

    // D2 Step 7B — manual-refresh cooldown, checked before calling Plaid.
    const cooldown = checkManualRefreshCooldown(item.lastManualRefreshAt, cooldownMs);
    if (cooldown.onCooldown) {
      return NextResponse.json(
        { error: "cooldown", retryAfterSeconds: cooldown.retryAfterSeconds },
        { status: 429 }
      );
    }

    // Marked on every attempt (success or failure) — see D2-7B checklist §5.
    await markManualRefreshed(item.id);

    // F1 (2026-07-14) — same shared syncLockedAt guard the webhook/connect
    // pipeline uses, so a manual "Refresh" can never race a webhook/cron/other
    // manual trigger against this item's cursor. See the connections-weirdness
    // investigation §4.1(d) — a freshly-connected item is off-cooldown, so a
    // user who connects and immediately hits Refresh used to race their own
    // background import.
    try {
      const lockResult = await withPlaidItemSyncLock(item.id, () =>
        runFullRefresh({ itemId: item.id, trigger: "MANUAL", profile: "FULL_REFRESH" }),
      );
      if (!lockResult.ok) {
        return NextResponse.json({ error: "in-flight" }, { status: 409 });
      }
      const r = lockResult.result;
      summary = {
        results:                   [r],
        itemCount:                 1,
        totalAccountsUpdated:      r.accountsUpdated,
        totalHoldingsUpdated:      r.holdingsUpdated,
        totalTransactionsAdded:    r.transactionsAdded,
        totalTransactionsModified: r.transactionsModified,
        totalTransactionsRemoved:  r.transactionsRemoved,
        spacesSnapshotted:     r.spacesSnapshotted,
      };
    } catch (e) {
      console.error(`[POST /api/plaid/refresh] refresh failed for PlaidItem ${item.id}:`, redactedErrorForLog(e));
      const health = classifyPlaidErrorForHealth(e);
      if (health) {
        // CH-2 — live columns (unchanged) + durable transition row only on change.
        await setPlaidItemHealth(item.id, { status: health.status, errorCode: health.errorCode });
        // OPS-3 S5 Wave 3 — ping the owner (suppress-deduped; best-effort).
        await notifyItemSyncFailed(item.id);
      }
      return NextResponse.json({ error: "Refresh failed" }, { status: 500 });
    }
  } else {
    // P1 — THE BULK BRANCH IS A THIN CALLER OF THE ORCHESTRATOR, Plaid-only.
    // The product's "Refresh All" gesture now lives at POST /api/refresh/all
    // (every provider). This branch is kept for callers that still post here
    // without an id: it runs the same decision layer (entitlement cooldown,
    // in-flight lock, admission already checked above) over the caller's Plaid
    // items only and reports in the legacy RefreshSummary shape, with the
    // structured report alongside.
    let plaidSummary: RefreshSummary | null = null;
    const deps = tenantRefreshDeps(user.id);
    const report: RefreshAllReport = await refreshAllForUser(
      { userId: user.id, authority: "USER", entitlements },
      // The orchestrator asks admission itself (one authority, asked once per
      // decision layer); the route-level check above already refused a paused
      // platform before any entitlement read.
      { ...deps, listWallets: async () => [], onPlaidSummary: (sum) => { plaidSummary = sum; } },
    );
    const legacy: RefreshItemResult[] = report.outcomes.map((o) => {
      const r = plaidSummary?.results.find((x) => x.plaidItemId === o.id);
      if (r) return r;
      return {
        plaidItemId: o.id, institution: o.label, ok: o.decision === "STARTED",
        accountsUpdated: 0, holdingsUpdated: 0, transactionsAdded: 0, transactionsModified: 0, transactionsRemoved: 0,
        spacesSnapshotted: [],
        ...(o.reason === "COOLDOWN" ? { skipped: "cooldown" as const, retryAfterSeconds: o.retryAfterSeconds } : {}),
        ...(o.reason === "IN_FLIGHT" ? { skipped: "in-flight" as const } : {}),
        ...(o.decision === "REFUSED" || o.decision === "FAILED" ? { error: o.reason ?? "ERROR" } : {}),
      };
    });
    const base = plaidSummary ?? {
      results: [], itemCount: 0, totalAccountsUpdated: 0, totalHoldingsUpdated: 0,
      totalTransactionsAdded: 0, totalTransactionsModified: 0, totalTransactionsRemoved: 0, spacesSnapshotted: [],
    };
    summary = { ...base, results: legacy, itemCount: legacy.length, ...({ report } as object) } as RefreshSummary;
  }

  await withTenantDb(user.id, (tx) => tx.auditLog.create({
    data: {
      userId:    user.id,
      action:    AuditAction.PLAID_REFRESH,
      metadata:  {
        itemCount:                 summary.itemCount,
        totalAccountsUpdated:      summary.totalAccountsUpdated,
        totalHoldingsUpdated:      summary.totalHoldingsUpdated,
        totalTransactionsAdded:    summary.totalTransactionsAdded,
        totalTransactionsModified: summary.totalTransactionsModified,
        totalTransactionsRemoved:  summary.totalTransactionsRemoved,
        spacesSnapshotted:     summary.spacesSnapshotted.length,
      },
      ipAddress: getClientIp(req),
    },
  }));

  return NextResponse.json({ ok: true, ...summary });
}, "POST /api/plaid/refresh");
