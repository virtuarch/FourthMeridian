"use client";

/**
 * components/platform/widgets/OpsProviderHealthWidget.tsx  (OPS-5 S3 · ops_provider_health)
 *
 * Provider health, over GET /api/platform/platform-ops/provider-health
 * (requirePlatformAccess PLATFORM_OPS READ). Every external provider is a
 * first-class operational resource with ONE roll-up status (trust) and an
 * EXPANDABLE card exposing the full field set the brief enumerates —
 * availability, last success/failure, quota/remaining, latency, coverage,
 * freshness (consumed from the OPS-5 S1 authority), sync failures, error rate.
 *
 * Aggregate + non-PII only — provider labels, states, dates, counts.
 */

import { useState } from "react";
import { Radio, ChevronRight } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  timeAgo,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import { RightPanel, PanelHeader, PanelContent } from "@/components/atlas/panels";
import type { ProviderHealthResponse } from "@/app/api/platform/platform-ops/provider-health/route";
import type { ProviderHealth, ProviderTrust } from "@/lib/platform/provider-health";

/** Trust → label + dot colour. OPERATIONAL is calm; worse states escalate. */
const TRUST_META: Record<ProviderTrust, { label: string; color: string }> = {
  OPERATIONAL: { label: "Operational", color: "var(--positive-400, #4ade80)" },
  DEGRADED:    { label: "Degraded",    color: "var(--brass-300, #d9b45f)" },
  STALE:       { label: "Stale data",  color: "var(--brass-300, #d9b45f)" },
  FAILING:     { label: "Failing",     color: "var(--danger-400, #f87171)" },
  UNKNOWN:     { label: "Unknown",     color: "var(--text-muted)" },
};

function pct(ratio: number | null): string {
  return ratio == null ? "—" : `${Math.round(ratio * 100)}%`;
}

function latency(ms: number | null): string {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** One labelled field in the expanded detail grid. */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[var(--text-secondary)]">{label}</span>
      <span className="text-[var(--text-primary)] tabular-nums text-right">{value}</span>
    </div>
  );
}

/** The selected provider's full field set — the RightPanel detail body. This is
 *  the same enumeration the inline card used, now rendered as "tell me more about
 *  what I selected" contextual detail. Composes Atlas panel parts; it is not a
 *  bespoke ProviderPanel primitive. */
function ProviderDetail({ p }: { p: ProviderHealth }) {
  const meta = TRUST_META[p.trust];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: meta.color }} aria-hidden />
        <span className="text-sm" style={{ color: meta.color }}>{meta.label}</span>
        <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{p.kind}</span>
      </div>

      <div className="flex flex-col gap-1.5 text-xs">
        <Field label="Availability" value={pct(p.availability)} />
        <Field label="Freshness" value={p.freshness.detail} />
        <Field label="Last success" value={p.lastSuccessAt ? `${timeAgo(p.lastSuccessAt)} ago` : "—"} />
        <Field label="Last failure" value={p.lastFailureAt ? `${timeAgo(p.lastFailureAt)} ago` : "none"} />
        <Field label="Latency" value={latency(p.latencyMs)} />
        <Field label="Error rate" value={pct(p.errorRate)} />
        <Field label="Sync failures" value={`${p.syncFailures}`} />
        <Field
          label="Coverage"
          value={p.coverage != null ? `${p.coverage}${p.coverageUnit ? ` ${p.coverageUnit}` : ""}` : "—"}
        />
        <Field
          label="Quota"
          value={p.quota != null ? `${p.remainingQuota ?? "?"} / ${p.quota}` : "not reported"}
        />
        {(p.callsToday != null || p.calls30d != null) && (
          <Field label="Calls" value={`${p.callsToday ?? 0} today · ${p.calls30d ?? 0} · 30d`} />
        )}
      </div>

      {p.notes.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-[var(--border-hairline)] pt-3">
          {p.notes.map((n, i) => (
            <li key={i} className="text-[11px] leading-snug text-[var(--text-muted)]">— {n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One provider row — the "row → RightPanel detail" idiom (the PO-2 inspection
 *  pattern, matching MembersRoster / CashFlowCategoryLedger). The whole row opens
 *  the detail; the hover accent rail is the "opens a detail" affordance. */
function ProviderRow({ p, onOpen }: { p: ProviderHealth; onOpen: () => void }) {
  const meta = TRUST_META[p.trust];
  // Reliability bar — availability is an honest ratio the read-model already
  // computes (succeeded/decided runs); null when there's nothing to measure, in
  // which case the bar is omitted rather than shown as 0% (which would read as a
  // fabricated failure). Tone follows the provider's trust roll-up.
  const availPct = p.availability == null ? null : Math.round(p.availability * 100);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="group relative flex w-full flex-col gap-1.5 overflow-hidden px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--meridian-400)]"
      >
        <span
          aria-hidden
          className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-[var(--meridian-400)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
        <span className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: meta.color }} aria-hidden />
            <span className="truncate text-xs font-medium text-[var(--text-primary)]">{p.label}</span>
            <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{p.kind}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {availPct != null && <span className="text-[11px] tabular-nums text-[var(--text-secondary)]">{availPct}%</span>}
            <span className="text-[11px]" style={{ color: meta.color }}>{meta.label}</span>
            <ChevronRight size={13} className="text-[var(--text-muted)]" aria-hidden />
          </span>
        </span>
        {availPct != null && (
          <span className="h-1 w-full overflow-hidden rounded-full" style={{ background: "var(--surface-muted)" }} aria-hidden>
            <span className="block h-full rounded-full" style={{ width: `${availPct}%`, background: meta.color }} />
          </span>
        )}
      </button>
    </li>
  );
}

export function OpsProviderHealthWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<ProviderHealthResponse>("/api/platform/platform-ops/provider-health");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = selectedKey ? data?.providers.find((p) => p.key === selectedKey) ?? null : null;

  const operational = data?.counts.OPERATIONAL ?? 0;
  const total = data ? data.providers.length : 0;
  const unhealthy = total - operational;

  return (
    <PlatformWidgetCard label={section.label} icon={Radio}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : data.providers.length === 0 ? (
        <p className="text-xs text-[var(--text-secondary)]">No providers registered.</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <WidgetStat value={operational} label="Operational" />
            <WidgetStat value={unhealthy} label="Needs attention" />
            <WidgetStat value={total} label="Providers" />
          </div>
          <ul className="-mx-2 divide-y divide-[var(--border-hairline)]">
            {data.providers.map((p) => (
              <ProviderRow key={p.key} p={p} onOpen={() => setSelectedKey(p.key)} />
            ))}
          </ul>

          {/* Detail — the selected provider's full field set (read-only). No
              operator actions in this slice (resync/force-refresh is PO-3/PO-4). */}
          <RightPanel open={selected != null} onClose={() => setSelectedKey(null)} ariaLabel="Provider detail">
            {selected && (
              <>
                <PanelHeader eyebrow="Provider" title={selected.label} />
                <PanelContent>
                  <ProviderDetail p={selected} />
                </PanelContent>
              </>
            )}
          </RightPanel>
        </>
      )}
    </PlatformWidgetCard>
  );
}
