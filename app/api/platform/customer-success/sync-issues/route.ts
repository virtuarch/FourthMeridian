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
import { classifySyncIssue, isActiveIncident, type SyncIssueDomain, type SyncIssueSeverity } from "@/lib/platform/sync-issue-semantics";

export const runtime = "nodejs";

const RECENT_LIMIT = 8;
/** Hard ceiling on the in-memory active scan (see the GET body for why). */
const ACTIVE_SCAN_CAP = 500;

export interface SyncIssueKindCount {
  kind:  string;
  /** Phase 4 — derived, never stored. */
  domain:   string;
  severity: string;
  count: number;
}

export interface SyncIssueRecent {
  id:   string;
  kind: string;
  domain:   string;
  severity: string;
  at:   string; // ISO createdAt
}

export interface PlatformSyncIssuesResponse {
  /**
   * Phase 4 — the count of ACTIVE incidents, not of `resolved: false` rows.
   * Expected tombstones, superseded detector output, orphaned rows and
   * recovered conditions are all excluded; see the GET body.
   */
  unresolvedTotal: number;
  /** True when the active scan hit ACTIVE_SCAN_CAP and totals are a floor. */
  scanTruncated:   boolean;
  byKind:          SyncIssueKindCount[];
  recent:          SyncIssueRecent[];
}

export async function GET() {
  const [, err] = await requirePlatformAccess("CUSTOMER_SUCCESS", "READ");
  if (err) return err;

  // PRE-V26-PLAID-CLOSE Phase 4 — "unresolved" is NOT the same as "active".
  // A REMOVED_TOMBSTONE is expected provider lifecycle, a legacy
  // BALANCE_TX_MISMATCH was produced by a rule that no longer exists, and an
  // issue whose account has since been deleted describes nothing. All three are
  // permanently `resolved: false` yet none is a problem, so counting the boolean
  // alone reported historical evidence as live incidents.
  //
  // Severity/domain/nature are DERIVED (lib/platform/sync-issue-semantics.ts),
  // so this cannot use Prisma groupBy — Postgres cannot group by a Json path.
  // Unresolved rows are fetched under a hard cap and folded in memory. At the
  // volumes this table sees that is cheap; ACTIVE_SCAN_CAP makes the ceiling
  // explicit rather than unbounded, and `scanTruncated` discloses when it bites.
  const unresolved = await db.syncIssue.findMany({
    where:   { resolved: false },
    orderBy: { createdAt: "desc" },
    take:    ACTIVE_SCAN_CAP,
    // `detail` IS selected — read to derive semantics, never echoed back.
    select:  { id: true, kind: true, resolved: true, createdAt: true, provider: true, detail: true, plaidItemId: true, financialAccountId: true },
  });

  // Referent existence in one batched pass (an orphaned row is not active).
  const itemIds = [...new Set(unresolved.map((r) => r.plaidItemId).filter((v): v is string => v !== null))];
  const acctIds = [...new Set(unresolved.map((r) => r.financialAccountId).filter((v): v is string => v !== null))];
  const [items, accounts] = await Promise.all([
    itemIds.length ? db.plaidItem.findMany({ where: { id: { in: itemIds } }, select: { id: true } }) : Promise.resolve([]),
    acctIds.length ? db.financialAccount.findMany({ where: { id: { in: acctIds } }, select: { id: true } }) : Promise.resolve([]),
  ]);
  const liveItems = new Set(items.map((i) => i.id));
  const liveAccts = new Set(accounts.map((a) => a.id));

  const active = unresolved.filter((r) => {
    const namesItem = r.plaidItemId !== null;
    const namesAcct = r.financialAccountId !== null;
    const referentExists =
      (!namesItem && !namesAcct) ||
      (namesItem && liveItems.has(r.plaidItemId!)) ||
      (namesAcct && liveAccts.has(r.financialAccountId!));
    return isActiveIncident({ kind: r.kind, provider: r.provider, detail: r.detail }, { referentExists, resolved: r.resolved });
  });

  const counts = new Map<string, number>();
  for (const r of active) {
    const { domain, severity } = classifySyncIssue({ kind: r.kind, provider: r.provider, detail: r.detail });
    const key = `${severity}:${domain}:${r.kind}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const byKind: SyncIssueKindCount[] = [...counts.entries()]
    .map(([key, count]) => {
      const [severity, domain, kind] = key.split(":");
      return { kind, domain: domain as SyncIssueDomain, severity: severity as SyncIssueSeverity, count };
    })
    .sort((a, b) => b.count - a.count);

  return NextResponse.json({
    unresolvedTotal: active.length,
    scanTruncated:   unresolved.length === ACTIVE_SCAN_CAP,
    byKind,
    recent: active.slice(0, RECENT_LIMIT).map((r) => {
      const { domain, severity } = classifySyncIssue({ kind: r.kind, provider: r.provider, detail: r.detail });
      return { id: r.id, kind: r.kind as string, domain, severity, at: r.createdAt.toISOString() };
    }),
  } satisfies PlatformSyncIssuesResponse);
}
