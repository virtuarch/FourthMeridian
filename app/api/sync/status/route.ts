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
import { loadConnectionsSyncStatus } from "@/lib/connections/space-data";
import { withTenantDb } from "@/lib/db/tenant-context";

export const dynamic = "force-dynamic";

/** Same read as the Connections page; same ceiling. */
const SYNC_STATUS_PHASE_TIMEOUT_MS = 15_000;

export async function GET() {
  const [user, err] = await requireUser();
  if (err) return err;

  // PCS-2 — one shared assembly (Plaid + WALLET) with the first render, so the
  // poll can never derive state differently. WALLET connections are included so
  // polling never drops wallet cards (same ids the account map is keyed on).
  //
  // RLS-PREP-C — the poll runs on the tenant role, in one phase, like the page.
  return NextResponse.json(await withTenantDb(
    user.id, (tx) => loadConnectionsSyncStatus(tx, user.id), { timeout: SYNC_STATUS_PHASE_TIMEOUT_MS }));
}
