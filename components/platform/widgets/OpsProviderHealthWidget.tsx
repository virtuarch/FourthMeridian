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

function ProviderCard({ p }: { p: ProviderHealth }) {
  const [open, setOpen] = useState(false);
  const meta = TRUST_META[p.trust];

  return (
    <li className="rounded-[var(--radius-sm)] border" style={{ borderColor: "var(--border-hairline)" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 px-2.5 py-2 text-left"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: meta.color }} aria-hidden />
          <span className="text-xs font-medium text-[var(--text-primary)] truncate">{p.label}</span>
          <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{p.kind}</span>
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          <span className="text-[11px]" style={{ color: meta.color }}>{meta.label}</span>
          <ChevronRight
            size={13}
            className="text-[var(--text-muted)] transition-transform"
            style={{ transform: open ? "rotate(90deg)" : "none" }}
            aria-hidden
          />
        </span>
      </button>

      {open && (
        <div className="px-2.5 pb-2.5 pt-0.5 flex flex-col gap-1 text-[11px]">
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
          {p.notes.length > 0 && (
            <ul className="mt-1 flex flex-col gap-0.5">
              {p.notes.map((n, i) => (
                <li key={i} className="text-[10px] text-[var(--text-muted)] leading-snug">— {n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

export function OpsProviderHealthWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<ProviderHealthResponse>("/api/platform/platform-ops/provider-health");

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
          <ul className="flex flex-col gap-1.5 mt-1">
            {data.providers.map((p) => (
              <ProviderCard key={p.key} p={p} />
            ))}
          </ul>
        </>
      )}
    </PlatformWidgetCard>
  );
}
