"use client";

/**
 * components/platform/widgets/CsSyncIssuesWidget.tsx  (PO1.4 · cs_sync_issues · PO-3A)
 *
 * Sync-issue triage, over GET /api/platform/customer-success/sync-issues
 * (requirePlatformAccess CUSTOMER_SUCCESS READ). PO-3A editorial pass: an
 * unresolved-total Figure, a weight-bar ledger of kinds (each kind's share of the
 * unresolved backlog) that opens a RightPanel showing that kind's recent
 * occurrences. Presentation-only — it renders exactly what the route returns and
 * NEVER SyncIssue.detail (the route never selects it): "who needs attention?"
 * answered by counts + timings, never customer financial content.
 */

import { useState } from "react";
import { LifeBuoy } from "lucide-react";
import { Figure } from "@/components/atlas/Surface";
import {
  PlatformWidgetCard,
  WidgetMessage,
  useWidgetFetch,
  timeAgo,
  type PlatformSection,
} from "../widget-kit";
import { RightPanel, PanelHeader, PanelContent } from "@/components/atlas/panels";
import type { PlatformSyncIssuesResponse } from "@/app/api/platform/customer-success/sync-issues/route";

/** "BALANCE_TX_MISMATCH" → "Balance tx mismatch". Display only. */
function humanizeKind(kind: string): string {
  const s = kind.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function CsSyncIssuesWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<PlatformSyncIssuesResponse>("/api/platform/customer-success/sync-issues");
  const [selectedKind, setSelectedKind] = useState<string | null>(null);

  const maxCount = data ? Math.max(1, ...data.byKind.map((k) => k.count)) : 1;
  const selected = selectedKind && data ? data.byKind.find((k) => k.kind === selectedKind) ?? null : null;
  const selectedRecent = selected && data ? data.recent.filter((r) => r.kind === selected.kind) : [];

  return (
    <PlatformWidgetCard label={section.label} icon={LifeBuoy}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <Figure value={data.unresolvedTotal} size="hero" />
            <span className="text-sm text-[var(--text-secondary)]">unresolved sync issues</span>
          </div>

          {data.unresolvedTotal === 0 ? (
            <p className="text-xs text-[var(--text-secondary)]">Nothing needs attention — no unresolved sync issues.</p>
          ) : (
            <ul className="-mx-1 flex flex-col">
              {data.byKind.map((k) => (
                <li key={k.kind}>
                  <button
                    type="button"
                    onClick={() => setSelectedKind(k.kind)}
                    className="group flex w-full flex-col gap-1 rounded-[var(--radius-sm)] px-1 py-2 text-left transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--meridian-400)]"
                  >
                    <span className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate text-[var(--text-primary)]">{humanizeKind(k.kind)}</span>
                      <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">{k.count}</span>
                    </span>
                    <span className="h-1 w-full overflow-hidden rounded-full" style={{ background: "var(--surface-muted)" }} aria-hidden>
                      <span
                        className="block h-full rounded-full"
                        style={{ width: `${Math.round((k.count / maxCount) * 100)}%`, background: "var(--meridian-400)" }}
                      />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <RightPanel open={selected != null} onClose={() => setSelectedKind(null)} ariaLabel="Sync issue kind detail">
            {selected && (
              <>
                <PanelHeader eyebrow="Sync issue" title={humanizeKind(selected.kind)} />
                <PanelContent>
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-wrap items-baseline gap-x-3">
                      <Figure value={selected.count} size="title" />
                      <span className="text-xs text-[var(--text-secondary)]">unresolved of this kind</span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Recent occurrences</p>
                      {selectedRecent.length === 0 ? (
                        <p className="text-xs text-[var(--text-secondary)]">None in the recent window.</p>
                      ) : (
                        <ul className="flex flex-col gap-1 text-xs">
                          {selectedRecent.map((r) => (
                            <li key={r.id} className="flex items-center justify-between gap-2">
                              <span className="text-[var(--text-secondary)]">Occurred</span>
                              <span className="tabular-nums text-[var(--text-primary)]">{timeAgo(r.at)} ago</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <p className="border-t border-[var(--border-hairline)] pt-3 text-[11px] leading-snug text-[var(--text-muted)]">
                      Counts and timings only — issue detail (merchant, amount, balance) is tenant-scoped customer data
                      and is never surfaced here.
                    </p>
                  </div>
                </PanelContent>
              </>
            )}
          </RightPanel>
        </>
      )}
    </PlatformWidgetCard>
  );
}
