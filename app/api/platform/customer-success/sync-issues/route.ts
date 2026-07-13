/**
 * GET /api/platform/customer-success/sync-issues
 *
 * PO1.4 — sync-issue triage summary for the `cs_sync_issues` widget.
 *
 * AUTHORIZATION: requirePlatformAccess("CUSTOMER_SUCCESS", "READ").
 *
 * `SyncIssue.detail` (a JSON blob carrying merchant/amount/date/balance figures
 * and provider-internal ids) is NEVER selected and NEVER returned — the same
 * hard precedent lib/activity/normalize-sync-issue.ts and the space activity
 * route enforce structurally. Every query below selects only non-financial
 * fields ({id, kind, resolved, createdAt}) or aggregates count.
 *
 * This is deliberately the first PLATFORM-WIDE SyncIssue read: every other
 * consumer scopes by a specific Space's linked financialAccountIds; a Customer
 * Success operator needs the cross-user picture, the same posture as PO1.1's
 * sec_audit_feed / sec_sessions. Aggregate + kinds + a short recent list only.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePlatformAccess } from "@/lib/platform/authorize";

export const runtime = "nodejs";

const RECENT_LIMIT = 8;

export interface SyncIssueKindCount {
  kind:  string;
  count: number;
}

export interface SyncIssueRecent {
  id:   string;
  kind: string;
  at:   string; // ISO createdAt
}

export interface PlatformSyncIssuesResponse {
  unresolvedTotal: number;
  byKind:          SyncIssueKindCount[];
  recent:          SyncIssueRecent[];
}

export async function GET() {
  const [, err] = await requirePlatformAccess("CUSTOMER_SUCCESS", "READ");
  if (err) return err;

  const [unresolvedTotal, grouped, recent] = await Promise.all([
    db.syncIssue.count({ where: { resolved: false } }),
    db.syncIssue.groupBy({
      by:      ["kind"],
      where:   { resolved: false },
      _count:  { _all: true },
    }),
    db.syncIssue.findMany({
      where:   { resolved: false },
      orderBy: { createdAt: "desc" },
      take:    RECENT_LIMIT,
      // detail deliberately NOT selected — never reaches the response.
      select:  { id: true, kind: true, resolved: true, createdAt: true },
    }),
  ]);

  const byKind: SyncIssueKindCount[] = grouped
    .map((g) => ({ kind: g.kind as string, count: g._count._all }))
    .sort((a, b) => b.count - a.count);

  return NextResponse.json({
    unresolvedTotal,
    byKind,
    recent: recent.map((r) => ({ id: r.id, kind: r.kind as string, at: r.createdAt.toISOString() })),
  } satisfies PlatformSyncIssuesResponse);
}
