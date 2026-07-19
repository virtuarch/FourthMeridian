/**
 * POST /api/connections/[id]/disconnect  (CONN-4A)
 *
 * Connection-level DISCONNECT (Model A — stop syncing, PRESERVE history). Soft-
 * disconnects ALL of a connection's accounts together: soft-delete accounts +
 * connections, revoke ACTIVE SpaceAccountLinks, regenerate today's snapshot, and
 * revoke provider access (Plaid itemRemove) when the item is orphaned. It NEVER
 * hard-deletes data and does NOT touch historical snapshots (deferred). Reconnect
 * revives the same rows (identity/fingerprint) — no duplicate accounts.
 *
 * `id` = SyncConnection.id (PlaidItem.id for Plaid, Connection.id for wallet).
 * Owner-gated: only the connection's owner (PlaidItem.userId / Connection.userId)
 * may disconnect it — a shared-space member with mere visibility cannot.
 *
 * Reuses the ONE disconnect primitive (lib/accounts/disconnect.ts) — no second
 * engine — and the existing AuditLog pattern (CONNECTION_DISCONNECTED).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { getClientIp } from "@/lib/api";
import { AuditAction } from "@/lib/audit-actions";
import { disconnectAccounts } from "@/lib/accounts/disconnect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing connection id" }, { status: 400 });

  const [user, err] = await requireUser();
  if (err) return err;

  // Resolve the connection's OWNED, live financial accounts (Plaid OR wallet).
  // Ownership is enforced through the connection→user relation — the caller can
  // only ever disconnect their own connection's accounts.
  const links = await db.accountConnection.findMany({
    where: {
      deletedAt:        null,
      financialAccount: { deletedAt: null },
      OR: [
        { plaidItemDbId: id, plaidItem: { userId: user.id } },
        { connectionId:  id, connection: { userId: user.id } },
      ],
    },
    select: {
      financialAccountId: true,
      plaidItemDbId:      true,
      plaidItem:  { select: { institutionName: true } },
      connection: { select: { provider: true } },
    },
  });

  if (links.length === 0) {
    // Not owned, unknown, or already disconnected.
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  const faIds = [...new Set(links.map((l) => l.financialAccountId))];
  const isPlaid = links.some((l) => l.plaidItemDbId === id);
  const institution = links.find((l) => l.plaidItem?.institutionName)?.plaidItem?.institutionName
    ?? (isPlaid ? "connection" : "Self-custody wallet");
  const provider = isPlaid ? "PLAID" : (links.find((l) => l.connection?.provider)?.connection?.provider ?? "WALLET");

  // The ONE disconnect primitive — soft-delete + revoke SALs + today-snapshot +
  // orphan-gated Plaid itemRemove. Non-destructive, reversible.
  const result = await disconnectAccounts(faIds, user.id);

  await db.auditLog.create({
    data: {
      userId:    user.id,
      action:    AuditAction.CONNECTION_DISCONNECTED,
      metadata:  { institution, provider, accountCount: result.disconnectedAccountIds.length },
      ipAddress: getClientIp(req),
    },
  });

  return NextResponse.json({ ok: true, disconnectedAccounts: result.disconnectedAccountIds.length });
}
