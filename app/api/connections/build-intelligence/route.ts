/**
 * POST /api/connections/build-intelligence  (CONN-2B)
 *
 * Multi-account financial-INTELLIGENCE build. This is a LAYER-2 operation: it
 * builds derived intelligence (the wealth-history timeline) from transactions
 * that ALREADY exist. It does NOT re-acquire data from a provider, does NOT call
 * accountsGet, does NOT write FinancialAccount.balance, and does NOT touch today's
 * live snapshot (an L3 freshness concern, owned by CONN-3).
 *
 * It reuses the ONE existing reconstruction authority —
 * `regenerateWealthHistoryForAccounts` (already multi-account) — over the owner's
 * accounts for the selected connections. No new engine, no second authority, no
 * `refreshMultipleAccounts`. Owner-scoped, rate-limited, kill-switch-honest.
 *
 * ── RLS-T2 — THE TWO ROUTE STATEMENTS RUN AS THE CALLER; THE REBUILD DOES NOT ──
 * Both of this handler's own statements are now tenant statements, in TWO short
 * transactions with the rebuild between them. That split is deliberate and not
 * cosmetic: `regenerateWealthHistoryForAccounts` walks every transaction of every
 * named account and rewrites a Space's snapshot series, and `withTenantDb` is a
 * SECURITY BOUNDARY, not a request-lifetime container. Holding an identity-bound
 * transaction open across it would pin a pooled connection for the length of a
 * reconstruction.
 *
 * The rebuild itself stays on its own authority (`lib/snapshots/…` runs as
 * fm_system) and that is correct: it regenerates `SpaceSnapshot` rows for EVERY
 * Space the named accounts reach, including Spaces the caller is not a member of,
 * and `SpaceSnapshot.fm_app_ins` is `"spaceId" IN fm_visible_space_ids()`. The
 * tenant role would be REFUSED LOUDLY there (case 62 of rls-app-acceptance),
 * which is the one asymmetry that makes fm_system the honest client for it rather
 * than a convenience.
 *
 * ⚠️ RESIDUAL, NAMED RATHER THAN DISCOVERED: `AccountConnection.fm_app_sel` is
 * `fm_account_visible("financialAccountId")`, which requires an ACTIVE
 * SpaceAccountLink into a Space the caller is a member of. It has NO
 * `ownerUserId` arm — unlike `FinancialAccount`, which does. So an account the
 * caller OWNS but which is ACTIVE-linked nowhere they can see drops out of the
 * resolution below, and the route answers its existing 400 ("No owned accounts
 * found…") instead of rebuilding it. That is the same narrowing case 70 of
 * rls-app-acceptance already proves and accepts for the investment-import picker
 * — "ownership is not reach" — and it FAILS CLOSED and VISIBLY: the caller is
 * told nothing was rebuilt rather than being told a rebuild happened. Measured on
 * the real dev corpus: 0 of 38 live accounts, and 0 of 38 live connections, lack
 * an ACTIVE link.
 */

import { NextRequest, NextResponse } from "next/server";
import { withTenantDb } from "@/lib/db/tenant-context";
import { requireUser } from "@/lib/session";
import { limitByUser } from "@/lib/rate-limit";
import { AuditAction } from "@/lib/audit-actions";
import {
  regenerateWealthHistoryForAccounts,
  maxAvailableWealthWindow,
  wealthRegenerationEnabled,
} from "@/lib/snapshots/regenerate-history";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const [user, err] = await requireUser();
  if (err) return err;

  const limited = await limitByUser(user.id, "connection-rebuild", { limit: 10, windowSec: 3600 });
  if (limited) return limited;

  const body = await req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(body?.connectionIds)
    ? [...new Set((body.connectionIds as unknown[]).filter((x): x is string => typeof x === "string"))]
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "Select at least one connection to rebuild." }, { status: 400 });
  }

  // Resolve the OWNER's financial accounts for the selected connections (Plaid or
  // wallet). Ownership is enforced through the connection→user relation, so a
  // caller can only ever rebuild their own connections' accounts.
  //
  // RLS-T2 — and it is now enforced TWICE, by two independent mechanisms. The
  // `userId` arms below are the application's own predicate; `PlaidItem` and
  // `Connection` both carry `userId = current_fm_user_id()` policies, so as the
  // tenant a foreign item is not a row this statement can reach even with the
  // arm removed. One short transaction: the rebuild is deliberately outside it.
  const links = await withTenantDb(user.id, (tx) => tx.accountConnection.findMany({
    where: {
      deletedAt: null,
      financialAccount: { deletedAt: null },
      OR: [
        { plaidItemDbId: { in: ids }, plaidItem: { userId: user.id } },
        { connectionId:  { in: ids }, connection: { userId: user.id } },
      ],
    },
    select: { financialAccountId: true, plaidItemDbId: true, connectionId: true },
  }));

  // connectionId (= SyncConnection.id) → { provider, faIds }.
  const byConn = new Map<string, { provider: "PLAID" | "WALLET"; faIds: Set<string> }>();
  for (const l of links) {
    const isPlaid = !!l.plaidItemDbId && ids.includes(l.plaidItemDbId);
    const connId = isPlaid ? l.plaidItemDbId! : l.connectionId && ids.includes(l.connectionId) ? l.connectionId : null;
    if (!connId) continue;
    const entry = byConn.get(connId) ?? { provider: isPlaid ? "PLAID" : "WALLET", faIds: new Set<string>() };
    entry.faIds.add(l.financialAccountId);
    byConn.set(connId, entry);
  }

  const faIds = [...new Set([...byConn.values()].flatMap((e) => [...e.faIds]))];
  if (faIds.length === 0) {
    return NextResponse.json({ error: "No owned accounts found for the selected connections." }, { status: 400 });
  }

  // Kill-switch honesty: never silently no-op. If wealth regeneration is disabled,
  // say so rather than claim a rebuild happened.
  if (!wealthRegenerationEnabled()) {
    return NextResponse.json({ rebuilt: false, enabled: false });
  }

  // Window: the MAX-available intelligence window (earliest transaction →
  // yesterday) — the SAME helper the initial connect (backgroundHistorySync A9)
  // uses, so recovery and initial build produce identical intelligence. Today's
  // live row is frozen (owned by regenerateSpaceSnapshot, L3 — never touched here).
  const { fromDate, toDate } = await maxAvailableWealthWindow(faIds);

  // The ONE reconstruction authority — reused, not duplicated.
  const spacesTouched = await regenerateWealthHistoryForAccounts(faIds, { fromDate, toDate });

  // Record WHEN each connection's intelligence was rebuilt — keeps
  // lastReconstructedAt + diagnostics honest across manual rebuilds.
  //
  // RLS-T2 — the caller's OWN audit rows, written as the caller, in a second
  // short transaction AFTER the rebuild rather than one held across it.
  // `AuditLog.fm_app_ins` is WITH CHECK (true) (§18 — ninety independent writers
  // and no spaceId in the shared shape helper), and every row here carries
  // `userId: user.id`, so nothing is being written on anyone else's behalf.
  await withTenantDb(user.id, (tx) => tx.auditLog.createMany({
    data: [...byConn.entries()].map(([connectionId, e]) => ({
      userId:   user.id,
      action:   AuditAction.CONNECTION_INTELLIGENCE_REBUILT,
      metadata: { connectionId, provider: e.provider, fromDate, toDate },
    })),
  }));

  return NextResponse.json({
    rebuilt:            true,
    enabled:            true,
    connectionsRebuilt: byConn.size,
    accountsRebuilt:    faIds.length,
    spacesTouched:      spacesTouched.length,
    fromDate,
    toDate,
  });
}
