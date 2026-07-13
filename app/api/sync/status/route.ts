/**
 * GET /api/sync/status
 *
 * D2.x Slice 3 — provider-agnostic, read-only sync-status contract for the
 * Connections experience. Returns the caller's connections with a normalized
 * state derived purely from PlaidItem fields (no SyncJob):
 * `syncIncompleteAt !== null` on an ACTIVE item means first-run history is
 * still importing / awaiting resume (see lib/sync/status.ts).
 *
 * Provider-agnostic by design: today it enumerates PlaidItem rows and reports
 * provider="PLAID", but the { building, connections[] } envelope is the read
 * half of the future Sync Center and extends to wallets / CSV / other
 * providers without a contract change.
 *
 * Security: filtered by the session user; selects only safe fields.
 * `syncIncompleteAt` is selected solely to derive state and is NEVER returned
 * to the client (buildSyncStatus omits it).
 */

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { PlaidItemStatus } from "@prisma/client";
import { buildSyncStatus, finalizeSyncStatus } from "@/lib/sync/status";
import { loadWalletSyncConnections } from "@/lib/sync/wallet-connections";

export const dynamic = "force-dynamic";

export async function GET() {
  const [user, err] = await requireUser();
  if (err) return err;

  const items = await db.plaidItem.findMany({
    where:  { userId: user.id, status: { not: PlaidItemStatus.REVOKED } },
    select: {
      id:                 true,
      institutionName:    true,
      status:             true,
      syncIncompleteAt:   true, // used for derivation only — never returned
      lastSyncedAt:       true,
      errorCode:          true,
      investmentsConsent: true, // → client-safe `investments` capability only
    },
    orderBy: { createdAt: "asc" },
  });

  // Include WALLET connections so polling never drops wallet cards (they carry
  // the same ids the server-rendered account map is keyed on).
  const wallet = await loadWalletSyncConnections(user.id);

  return NextResponse.json(
    finalizeSyncStatus([...buildSyncStatus(items).connections, ...wallet.connections]),
  );
}
