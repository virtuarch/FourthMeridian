"use client";

/**
 * components/platform/widgets/CsSyncIssuesWidget.tsx  (PO1.4 · cs_sync_issues)
 *
 * Sync-issue triage, over GET /api/platform/customer-success/sync-issues
 * (requirePlatformAccess CUSTOMER_SUCCESS READ). Unresolved count + breakdown by
 * kind + a short recent-unresolved list. Never renders SyncIssue.detail (the
 * route never returns it).
 */

import { LifeBuoy } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  useWidgetFetch,
  timeAgo,
  type PlatformSection,
} from "../widget-kit";
import type { PlatformSyncIssuesResponse } from "@/app/api/platform/customer-success/sync-issues/route";

/** "BALANCE_TX_MISMATCH" → "Balance tx mismatch". Display only. */
function humanizeKind(kind: string): string {
  const s = kind.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function CsSyncIssuesWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<PlatformSyncIssuesResponse>("/api/platform/customer-success/sync-issues");

  return (
    <PlatformWidgetCard label={section.label} icon={LifeBuoy}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <WidgetStat value={data.unresolvedTotal} label="Unresolved sync issues" />
          {data.unresolvedTotal === 0 ? (
            <p className="text-xs text-[var(--text-secondary)] mt-1">No unresolved sync issues.</p>
          ) : (
            <>
              {data.byKind.length > 0 && (
                <ul className="flex flex-col gap-1 mt-1">
                  {data.byKind.map((k) => (
                    <li key={k.kind} className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-[var(--text-secondary)] truncate">{humanizeKind(k.kind)}</span>
                      <span className="text-[var(--text-primary)] tabular-nums shrink-0">{k.count}</span>
                    </li>
                  ))}
                </ul>
              )}
              {data.recent.length > 0 && (
                <p className="text-[10px] text-[var(--text-muted)] mt-1">
                  Most recent: {humanizeKind(data.recent[0].kind)} · {timeAgo(data.recent[0].at)} ago
                </p>
              )}
            </>
          )}
        </>
      )}
    </PlatformWidgetCard>
  );
}
