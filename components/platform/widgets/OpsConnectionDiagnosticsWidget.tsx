"use client";

/**
 * components/platform/widgets/OpsConnectionDiagnosticsWidget.tsx  (CONN-2F)
 *
 * Operator per-connection diagnostics — lets a support operator answer "a user's
 * financial picture is wrong; which layer failed?" by inspecting a connection's
 * acquisition (L1), intelligence build (L2), and freshness (L3) side by side.
 *
 * Read-only, metadata only: status, health, counts, timestamps, institution
 * label, owner email (the support identifier). NO balances, NO transaction
 * amounts. Backed by GET /api/platform/platform-ops/connection-diagnostics
 * (requirePlatformAccess PLATFORM_OPS READ). Reuses the same pure derivations as
 * the customer surface — no new financial authority.
 */

import { useMemo, useState } from "react";
import { Stethoscope } from "lucide-react";
import { PlatformWidgetCard, WidgetMessage, useWidgetFetch, timeAgo, type PlatformSection } from "@/components/platform/widget-kit";
import { RightPanel, PanelHeader, PanelContent } from "@/components/atlas/panels";
import type { ConnectionDiagnosticsResponse } from "@/app/api/platform/platform-ops/connection-diagnostics/route";
import type { ConnectionDiagnostic } from "@/lib/platform/connection-diagnostics";

const HEALTH_LABEL: Record<string, string> = {
  HEALTHY: "Healthy", STALE: "Stale", DEGRADED: "Degraded",
  NEEDS_REAUTH: "Action required", ERROR: "Error", REVOKED: "Revoked",
};
const SYNC_LABEL: Record<string, string> = {
  IMPORTING: "Importing", READY: "Ready", ACTION_REQUIRED: "Action required",
};
const INTEL_LABEL: Record<string, string> = {
  READY: "Built", REBUILDING: "Building", NOT_READY: "Not started",
};

function fmt(iso: string | null): string {
  return iso ? `${timeAgo(iso)} ago` : "—";
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className="text-right text-[var(--text-primary)]">{value}</span>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-t border-[var(--border-hairline)] pt-3 first:border-t-0 first:pt-0">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{title}</p>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

export function OpsConnectionDiagnosticsWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<ConnectionDiagnosticsResponse>(
    "/api/platform/platform-ops/connection-diagnostics",
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const connections = useMemo(() => data?.connections ?? [], [data]);
  const selected = useMemo<ConnectionDiagnostic | null>(
    () => connections.find((c) => c.id === selectedId) ?? null,
    [connections, selectedId],
  );

  return (
    <PlatformWidgetCard label={section.label} icon={Stethoscope}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : connections.length === 0 ? (
        <p className="text-xs text-[var(--text-secondary)]">No connections to diagnose.</p>
      ) : (
        <ul className="-mx-1 divide-y divide-[var(--border-hairline)]">
          {connections.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setSelectedId(c.id)}
                className="flex w-full items-center justify-between gap-2 px-1 py-2 text-left transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--meridian-400)]"
              >
                <span className="min-w-0 truncate text-xs text-[var(--text-primary)]">
                  {c.source} <span className="text-[var(--text-muted)]">· {c.owner}</span>
                </span>
                <span className="shrink-0 text-[11px] text-[var(--text-secondary)]">
                  {HEALTH_LABEL[c.healthState] ?? c.healthState}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <RightPanel open={selected != null} onClose={() => setSelectedId(null)} ariaLabel="Connection diagnostics">
        {selected && (
          <>
            <PanelHeader eyebrow="Connection diagnostics" title={selected.source} />
            <PanelContent>
              <div className="flex flex-col gap-3 text-xs">
                <Group title="Connection">
                  <Row label="Owner" value={selected.owner} />
                  <Row label="Source" value={selected.source} />
                  <Row label="Provider" value={selected.provider} />
                  <Row label="Status" value={selected.status} />
                  <Row label="Health" value={HEALTH_LABEL[selected.healthState] ?? selected.healthState} />
                </Group>

                <Group title="Data acquisition">
                  <Row label="Last acquired" value={fmt(selected.acquisition.lastAcquiredAt)} />
                  <Row label="Transactions" value={selected.acquisition.transactionCount} />
                  <Row label="Latest transaction" value={selected.acquisition.latestTransactionDate ? new Date(selected.acquisition.latestTransactionDate).toLocaleDateString() : "—"} />
                  <Row label="Sync status" value={SYNC_LABEL[selected.acquisition.syncStatus] ?? selected.acquisition.syncStatus} />
                  {selected.acquisition.errorCode && <Row label="Error" value={selected.acquisition.errorCode} />}
                </Group>

                <Group title="Financial intelligence">
                  <Row label="Status" value={INTEL_LABEL[selected.intelligence.status] ?? selected.intelligence.status} />
                  <Row label="Last built" value={fmt(selected.intelligence.lastBuiltAt)} />
                  <Row label="Accounts covered" value={selected.intelligence.accountsCovered} />
                  <Row label="Available history" value={selected.intelligence.availableHistory} />
                </Group>

                <Group title="Current freshness">
                  <Row label="Latest snapshot" value={selected.freshness.latestSnapshotDate ? new Date(selected.freshness.latestSnapshotDate).toLocaleDateString() : "—"} />
                  <p className="text-[11px] leading-snug text-[var(--text-muted)]">
                    Freshness is snapshot recency (CONN-3), not rebuilt intelligence. A stale snapshot with built intelligence points to a freshness issue, not acquisition.
                  </p>
                </Group>
              </div>
            </PanelContent>
          </>
        )}
      </RightPanel>
    </PlatformWidgetCard>
  );
}
