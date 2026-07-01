/**
 * POST /api/admin/plaid/diagnostics
 *
 * Read-only extended diagnostics for a single PlaidItem.
 * Called by the Admin Providers page diagnostics drawer when a row is expanded.
 *
 * Auth: SYSTEM_ADMIN only (requireSystemAdmin).
 * No Plaid API calls. No DB mutations. No schema changes.
 *
 * Body: { plaidItemId: string }
 *
 * Response shape: DiagnosticsResponse (see type export below).
 *
 * Per-account transaction aggregates (count, min date, max date, pending count)
 * are computed via Prisma aggregate queries, not raw SQL.
 *
 * cursor is intentionally NOT returned — it is an opaque sync token. Only
 * hasCursor (boolean) is returned so the drawer can show "Synced" vs "Never
 * synced" without leaking the cursor value.
 *
 * These diagnostics are intentionally NON-FINANCIAL / operational only. Raw
 * financial values (account balances, transaction amounts) are deliberately
 * excluded from both the query and the response so the admin/provider drawer
 * can surface sync/health state without exposing users' financial data.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSystemAdmin } from "@/lib/session";
import { db } from "@/lib/db";

// ── Response types ────────────────────────────────────────────────────────────

export type DiagnosticsAccount = {
  id:              string;
  name:            string;
  displayName:     string | null;
  officialName:    string | null;
  type:            string;
  mask:            string | null;
  isArchived:      boolean;         // deletedAt !== null
  syncStatus:      string | null;
  txCount:         number;
  pendingCount:    number;
  oldestTxDate:    string | null;   // ISO date string or null
  newestTxDate:    string | null;   // ISO date string or null
  salStatus:       string | null;   // SpaceAccountLink.status (most recent)
  connectionStatus: string | null;  // Connection.status if linked
};

export type DiagnosticsResponse = {
  id:                  string;
  externalItemId:      string;
  institutionName:     string;
  institutionId:       string;
  userId:              string;
  status:              string;
  errorCode:           string | null;
  hasCursor:           boolean;
  lastSyncedAt:        string | null;
  lastManualRefreshAt: string | null;
  createdAt:           string;
  accounts:            DiagnosticsAccount[];
};

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const [, err] = await requireSystemAdmin();
  if (err) return err;

  let plaidItemId: string;
  try {
    const body = await req.json();
    if (!body?.plaidItemId || typeof body.plaidItemId !== "string") {
      return NextResponse.json({ error: "plaidItemId is required" }, { status: 400 });
    }
    plaidItemId = body.plaidItemId;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── Fetch PlaidItem with live AccountConnections ───────────────────────────
  const item = await db.plaidItem.findUnique({
    where: { id: plaidItemId },
    select: {
      id:                  true,
      externalItemId:      true,
      institutionName:     true,
      institutionId:       true,
      userId:              true,
      status:              true,
      errorCode:           true,
      cursor:              true,   // only used for hasCursor check — never returned
      lastSyncedAt:        true,
      lastManualRefreshAt: true,
      createdAt:           true,
      connections: {
        where:   { deletedAt: null },
        select: {
          connectionId: true,
          connection: {
            select: { status: true },
          },
          financialAccount: {
            select: {
              id:           true,
              name:         true,
              displayName:  true,
              officialName: true,
              type:         true,
              mask:         true,
              deletedAt:    true,
              syncStatus:   true,
              spaceAccountLinks: {
                select:  { status: true },
                orderBy: { createdAt: "desc" },
                take:    1,
              },
            },
          },
        },
      },
    },
  });

  if (!item) {
    return NextResponse.json({ error: "PlaidItem not found" }, { status: 404 });
  }

  // ── Per-account transaction aggregates ────────────────────────────────────
  // Run all aggregate queries in parallel to minimise latency.
  const accounts = await Promise.all(
    item.connections.map(async (conn) => {
      const fa = conn.financialAccount;

      const [total, pending, dateAgg] = await Promise.all([
        db.transaction.count({
          where: { financialAccountId: fa.id, deletedAt: null },
        }),
        db.transaction.count({
          where: { financialAccountId: fa.id, deletedAt: null, pending: true },
        }),
        db.transaction.aggregate({
          where:   { financialAccountId: fa.id, deletedAt: null },
          _min:    { date: true },
          _max:    { date: true },
        }),
      ]);

      const salStatus   = fa.spaceAccountLinks[0]?.status ?? null;
      const connStatus  = conn.connection?.status ?? null;

      return {
        id:              fa.id,
        name:            fa.name,
        displayName:     fa.displayName,
        officialName:    fa.officialName,
        type:            fa.type,
        mask:            fa.mask,
        isArchived:      fa.deletedAt !== null,
        syncStatus:      fa.syncStatus,
        txCount:         total,
        pendingCount:    pending,
        oldestTxDate:    dateAgg._min.date ? dateAgg._min.date.toISOString() : null,
        newestTxDate:    dateAgg._max.date ? dateAgg._max.date.toISOString() : null,
        salStatus:       salStatus ? String(salStatus) : null,
        connectionStatus: connStatus ? String(connStatus) : null,
      } satisfies DiagnosticsAccount;
    })
  );

  const response: DiagnosticsResponse = {
    id:                  item.id,
    externalItemId:      item.externalItemId,
    institutionName:     item.institutionName,
    institutionId:       item.institutionId,
    userId:              item.userId,
    status:              item.status,
    errorCode:           item.errorCode,
    hasCursor:           item.cursor !== null,
    lastSyncedAt:        item.lastSyncedAt?.toISOString() ?? null,
    lastManualRefreshAt: item.lastManualRefreshAt?.toISOString() ?? null,
    createdAt:           item.createdAt.toISOString(),
    accounts,
  };

  return NextResponse.json(response);
}
