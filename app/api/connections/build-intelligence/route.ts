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
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
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
  const links = await db.accountConnection.findMany({
    where: {
      deletedAt: null,
      financialAccount: { deletedAt: null },
      OR: [
        { plaidItemDbId: { in: ids }, plaidItem: { userId: user.id } },
        { connectionId:  { in: ids }, connection: { userId: user.id } },
      ],
    },
    select: { financialAccountId: true, plaidItemDbId: true, connectionId: true },
  });

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
  await db.auditLog.createMany({
    data: [...byConn.entries()].map(([connectionId, e]) => ({
      userId:   user.id,
      action:   AuditAction.CONNECTION_INTELLIGENCE_REBUILT,
      metadata: { connectionId, provider: e.provider, fromDate, toDate },
    })),
  });

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
