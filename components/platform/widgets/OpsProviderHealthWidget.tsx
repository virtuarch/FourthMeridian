"use client";

/**
 * components/platform/widgets/OpsProviderHealthWidget.tsx  (OPS-5 S3 · ops_provider_health · UX-P1 table)
 *
 * Provider health as a TABLE, one row per provider AUTHORITY:
 *   Provider | Status | Data freshness | Last success | Threshold | Affected connections | Action
 * Plaid and Open Exchange Rates come from GET /platform-ops/provider-health
 * (their trust vocabulary, through provider-view.ts); Resend from
 * GET /platform-ops/email-health as a separately-labelled delivery authority;
 * OpenAI as an Unavailable row because no PLATFORM_OPS route exposes an AI
 * provider authority. Vocabularies are never merged and availability is never
 * invented — a cell that cannot speak says why.
 *
 * A provider-health row opens the RightPanel with the full field set the
 * OPS-5 S3 brief enumerates (read-only). Aggregate + non-PII only.
 */

import { useState, type ReactNode } from "react";
import { Radio, ChevronRight } from "lucide-react";
import { WidgetMessage, useWidgetFetch, type PlatformSection } from "../widget-kit";
import { DistributionBar, Provenance, SectionSurface, ToneBadge, TwoLine, Unavailable } from "../platform-surface";
import { RightPanel, PanelHeader, PanelContent } from "@/components/atlas/panels";
import { resolvePlatformDestination } from "@/lib/platform/workspaces";
import type { ProviderHealthResponse } from "@/app/api/platform/platform-ops/provider-health/route";
import type { EmailHealthResponse } from "@/app/api/platform/platform-ops/email-health/route";
import type { ProviderHealth } from "@/lib/platform/provider-health";
import { agoWords, fmtUtcInstant } from "./connection-health-view";
import { PROVIDER_FOOTNOTE, isUnavailable, providerRows, trustBadge, trustSegments, type Cell, type Fetched, type ProviderRowView } from "./provider-view";

// ── Grid ─────────────────────────────────────────────────────────────────────

const COLS = "minmax(0,1.6fr) 7rem minmax(0,1.6fr) minmax(0,1.1fr) 7rem 6.5rem 7rem";
const HEADINGS = ["Provider", "Status", "Data freshness", "Last success", "Threshold", "Affected connections", "Action"] as const;

// ── Cells ─────────────────────────────────────────────────────────────────────

function CellView({ cell }: { cell: Cell }) {
  if (isUnavailable(cell)) return <Unavailable reason={cell.unavailable} />;
  return <TwoLine value={cell.value} qualifier={cell.qualifier} />;
}

function StatusCell({ row }: { row: ProviderRowView }) {
  if ("unavailable" in row.status) return <Unavailable reason={row.status.unavailable} />;
  return <ToneBadge word={row.status.word} tone={row.status.tone} />;
}

function LastSuccessCell({ row, nowMs }: { row: ProviderRowView; nowMs?: number }) {
  if ("unavailable" in row.lastSuccess) return <Unavailable reason={row.lastSuccess.unavailable} />;
  const iso = row.lastSuccess.iso;
  return <TwoLine value={agoWords(iso, nowMs) ?? "just now"} qualifier={fmtUtcInstant(iso) ?? iso} />;
}

function ActionCell({ row, onOpen }: { row: ProviderRowView; onOpen?: (workspaceId: string) => void }) {
  if ("unavailable" in row.action) return <Unavailable reason={row.action.unavailable} />;
  const def = resolvePlatformDestination(row.action.workspaceId);
  if (!onOpen || !def) return <Unavailable reason="no workspace switcher on this host" />;
  const id = row.action.workspaceId;
  return (
    <button
      type="button"
      onClick={() => onOpen(id)}
      aria-label={`Open ${def.label} — ${row.label} evidence`}
      className="rounded-[var(--radius-xs)] py-1 text-xs text-[var(--meridian-400)] transition-colors hover:text-[var(--meridian-300)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]"
    >
      {def.label} →
    </button>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">{label}</span>
      <span className="text-xs tabular-nums text-[var(--text-primary)]">{value}</span>
    </div>
  );
}

/** Below-`md` expansion with the dropped columns. Exported for the test. */
export function ProviderRowDetail({ row, nowMs, onOpenWorkspace }: { row: ProviderRowView; nowMs?: number; onOpenWorkspace?: (id: string) => void }) {
  return (
    <div className="grid gap-x-6 gap-y-3 px-1 pb-4 pt-1 sm:grid-cols-2 md:hidden">
      <Metric label="Last success" value={<LastSuccessCell row={row} nowMs={nowMs} />} />
      <Metric label="Threshold" value={<CellView cell={row.threshold} />} />
      <Metric label="Affected connections" value={<CellView cell={row.affected} />} />
      <Metric label="Action" value={<ActionCell row={row} onOpen={onOpenWorkspace} />} />
    </div>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────

function ProviderRow({ row, nowMs, onOpenWorkspace, onInspect }: { row: ProviderRowView; nowMs?: number; onOpenWorkspace?: (id: string) => void; onInspect: (p: ProviderHealth) => void }) {
  const [expanded, setExpanded] = useState(false);
  const name = (
    <TwoLine
      value={<span className="font-medium">{row.label}</span>}
      qualifier={<Provenance source={row.authority}>{row.kind ? <span className="uppercase tracking-wide">{row.kind}</span> : null}</Provenance>}
    />
  );
  return (
    <li className="border-b transition-colors last:border-b-0 hover:bg-[var(--surface-hover)]" style={{ borderColor: "var(--border-hairline)" }}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 md:grid" style={{ gridTemplateColumns: COLS, minHeight: 52 }}>
        {row.detail ? (
          <button
            type="button"
            onClick={() => onInspect(row.detail!)}
            aria-label={`Inspect ${row.label}`}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-xs)] py-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)] md:flex-none"
          >
            {name}
          </button>
        ) : (
          <span className="flex min-w-0 flex-1 items-center py-2.5 md:flex-none">{name}</span>
        )}
        <span className="shrink-0"><StatusCell row={row} /></span>
        <span className="basis-full md:basis-auto"><CellView cell={row.freshness} /></span>
        <span className="hidden md:block"><LastSuccessCell row={row} nowMs={nowMs} /></span>
        <span className="hidden md:block"><CellView cell={row.threshold} /></span>
        <span className="hidden md:block"><CellView cell={row.affected} /></span>
        <span className="hidden md:block"><ActionCell row={row} onOpen={onOpenWorkspace} /></span>
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} details for ${row.label}`}
          className="ml-auto shrink-0 rounded-[var(--radius-sm)] p-1.5 text-[var(--text-faint)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)] md:hidden"
        >
          <ChevronRight size={12} aria-hidden className="transition-transform" style={{ transform: expanded ? "rotate(90deg)" : "none" }} />
        </button>
      </div>
      {expanded && <ProviderRowDetail row={row} nowMs={nowMs} onOpenWorkspace={onOpenWorkspace} />}
    </li>
  );
}

// ── Drawer ────────────────────────────────────────────────────────────────────

function pct(ratio: number | null): string { return ratio == null ? "—" : `${Math.round(ratio * 100)}%`; }
function latency(ms: number | null): string { return ms == null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`; }

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[var(--text-secondary)]">{label}</span>
      <span className="text-right tabular-nums text-[var(--text-primary)]">{value}</span>
    </div>
  );
}

/** The selected provider's full field set — the OPS-5 S3 enumeration, read-only. */
export function ProviderDetail({ p, nowMs }: { p: ProviderHealth; nowMs?: number }) {
  const badge = trustBadge(p.trust);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <ToneBadge word={badge.word} tone={badge.tone} />
        <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{p.kind}</span>
      </div>
      <div className="flex flex-col gap-1.5 text-xs">
        <Field label="Availability" value={pct(p.availability)} />
        <Field label="Freshness" value={p.freshness.detail} />
        <Field label="Last success" value={p.lastSuccessAt ? `${agoWords(p.lastSuccessAt, nowMs) ?? "just now"} · ${fmtUtcInstant(p.lastSuccessAt) ?? ""}` : "—"} />
        <Field label="Last failure" value={p.lastFailureAt ? `${agoWords(p.lastFailureAt, nowMs) ?? "just now"} · ${fmtUtcInstant(p.lastFailureAt) ?? ""}` : "none"} />
        <Field label="Latency" value={latency(p.latencyMs)} />
        <Field label="Error rate" value={pct(p.errorRate)} />
        <Field label="Sync failures" value={`${p.syncFailures}`} />
        <Field label="Coverage" value={p.coverage != null ? `${p.coverage}${p.coverageUnit ? ` ${p.coverageUnit}` : ""}` : "—"} />
        <Field label="Quota" value={p.quota != null ? `${p.remainingQuota ?? "?"} / ${p.quota}` : "not reported"} />
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

// ── Surface ───────────────────────────────────────────────────────────────────

export function OpsProviderHealthWidget({ section, onOpenWorkspace }: { section: PlatformSection; onOpenWorkspace?: (id: string) => void }) {
  const providers = useWidgetFetch<ProviderHealthResponse>("/api/platform/platform-ops/provider-health");
  const email = useWidgetFetch<EmailHealthResponse>("/api/platform/platform-ops/email-health");
  return <ProviderHealthSurface title={section.label} providers={providers} email={email} onOpenWorkspace={onOpenWorkspace} />;
}

/** Prop-driven surface, so every state is renderable in a test. */
export function ProviderHealthSurface({
  title,
  providers,
  email,
  onOpenWorkspace,
  nowMs,
}: {
  title: string;
  providers: Fetched<ProviderHealthResponse>;
  email: Fetched<EmailHealthResponse>;
  onOpenWorkspace?: (id: string) => void;
  nowMs?: number;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const rows = providerRows(providers, email);
  const selected = selectedKey ? rows.find((r) => r.key === selectedKey)?.detail ?? null : null;
  const checked = providers.data ? fmtUtcInstant(providers.data.checkedAt) : null;

  return (
    <SectionSurface icon={Radio} title={title} count={rows.length} footnote={PROVIDER_FOOTNOTE}>
      <div className="flex flex-col gap-6">
        {providers.loading || providers.error ? (
          <WidgetMessage loading={providers.loading} error={providers.error ? `provider-health: ${providers.error}` : null} />
        ) : providers.data ? (
          <DistributionBar
            label="Provider trust"
            segments={trustSegments(providers.data.counts)}
            caption={`provider-health authority only (${providers.data.providers.length} provider${providers.data.providers.length === 1 ? "" : "s"})${checked ? ` · judged at ${checked}` : ""}`}
            emptyText="no providers registered"
          />
        ) : null}

        <div className="overflow-x-auto">
          <div className="mb-1 hidden items-center gap-3 border-b px-1 pb-2 md:grid" style={{ gridTemplateColumns: COLS, borderColor: "var(--border-hairline)" }}>
            {HEADINGS.map((h) => (
              <span key={h} className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]">{h}</span>
            ))}
          </div>
          <ul className="flex flex-col">
            {rows.map((row) => (
              <ProviderRow key={row.key} row={row} nowMs={nowMs} onOpenWorkspace={onOpenWorkspace} onInspect={(p) => setSelectedKey(p.key)} />
            ))}
          </ul>
        </div>
      </div>

      <RightPanel open={selected != null} onClose={() => setSelectedKey(null)} ariaLabel="Provider detail">
        {selected && (
          <>
            <PanelHeader eyebrow="Provider" title={selected.label} />
            <PanelContent>
              <ProviderDetail p={selected} nowMs={nowMs} />
            </PanelContent>
          </>
        )}
      </RightPanel>
    </SectionSurface>
  );
}
