"use client";

/**
 * components/platform/widgets/OpsRefreshExecutionsWidget.tsx  (ops_refresh_executions)
 *
 * Recent refresh executions across EVERY source kind — Plaid items and
 * self-custody wallets alike — over the EXECUTION QUERY SEAM's read surface
 * (GET /api/platform/platform-ops/refresh/executions, PLATFORM_OPS READ).
 *
 * This is the ROW surface: it renders rows and nothing else — no totals, no
 * rates, no health verdict (the seam deliberately does not aggregate, and a
 * widget computing truth is the defect the read boundary exists to prevent).
 *
 * PLATFORM OPS OBSERVABILITY — an operator filters by source kind, network,
 * status and trigger. The unfiltered page comes through the static-url hook;
 * a filtered page is a keyed body remounted per query (`FilteredExecutions`,
 * reading through the shared keyed reader), which is the sanctioned way to
 * give a widget a new url. Every row opens the same inspection panel
 * (ExecutionTimelinePanel): the execution's verdict, its source's last
 * success, the policy in force, and its timeline.
 *
 * OPS-2C-4 — DEPLOYMENT IS EVIDENCE ON AN EXECUTION, NEVER A SUBJECT:
 *
 *     Execution → deploymentSha        ✅ one observed attribute of the object
 *     Deployment → execution summary   ❌ the inversion this must never become
 *
 * The list stays FLAT and TIME-ORDERED; a change of deployment between two
 * adjacent rows renders as an inline RULE — an annotation on the sequence,
 * not a group. Only the deploymentSha recorded on THAT execution is shown;
 * nothing here claims "current", and the panel receives it only as header
 * context.
 */

import { useState } from "react";
import { ListOrdered } from "lucide-react";
import { PlatformWidgetCard, WidgetMessage, timeAgo, useWidgetFetch, type PlatformSection } from "../widget-kit";
import { useKeyedFetch } from "../keyed-fetch";
import { SectionSurface, TONE_COLOR, TwoLine } from "../platform-surface";
import type { ExecutionPageDTO, ExecutionRowDTO } from "@/lib/platform/refresh/execution-query-core";
import { ExecutionTimelinePanel } from "./ExecutionTimelinePanel";
import { formatDuration, humanizeToken, isDeploymentBoundary, shortSha } from "./refresh-format";
import { describeCategory, describeSource, describeTrigger } from "./execution-format";

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** Status → tone. Presentation only; the status itself is the ledger's own value. */
export const EXECUTION_STATUS_TOKEN: Record<string, string> = {
  SUCCEEDED: TONE_COLOR.ok,
  PARTIAL: TONE_COLOR.warn,
  FAILED: TONE_COLOR.bad,
  SKIPPED: TONE_COLOR.muted,
  RUNNING: TONE_COLOR.info,
};

export const triggerWord = describeTrigger;

export interface ExecutionSelection { id: string; eyebrow: string; title: string }

/** The header context handed to the panel: kind, trigger, and the deployment recorded on the row. */
export function selectionFor(row: ExecutionRowDTO): ExecutionSelection {
  const source = describeSource(row);
  return {
    id: row.id,
    eyebrow: `${source.kind} · ${triggerWord(row.trigger)} · deploy ${shortSha(row.deploymentSha)}`,
    title: source.label,
  };
}

const SOURCE_OPTIONS = [
  { value: "", label: "All sources" },
  { value: "PLAID_ITEM", label: "Banks" },
  { value: "WALLET", label: "Wallets" },
] as const;
const NETWORK_OPTIONS = ["", "BTC", "ETH", "SOL", "BNB", "AVAX"] as const;
const STATUS_OPTIONS = [
  { value: "", label: "Any status" },
  { value: "FAILED", label: "Failed" },
  { value: "PARTIAL", label: "Partial" },
  { value: "SUCCEEDED", label: "Succeeded" },
  { value: "RUNNING", label: "Running" },
  { value: "SKIPPED", label: "Skipped" },
] as const;
const TRIGGER_OPTIONS = [
  { value: "", label: "Any trigger" },
  { value: "MANUAL", label: "Manual" },
  { value: "CRON", label: "Scheduled" },
  { value: "OPERATOR", label: "Operator" },
  { value: "WEBHOOK", label: "Webhook" },
  { value: "RECONNECT", label: "Reconnect" },
] as const;

const PAGE = 30;
const FOOTNOTE =
  "Rows are the refresh execution ledger's own values, newest first. A wallet row is a chain adapter run; a bank row is a Plaid item refresh. Source references are opaque ids, never addresses or names.";

// ── Row list (the house CSS-grid row idiom) ──────────────────────────────────

const COLS = "minmax(0,1.8fr) 6rem 6.5rem 7rem 5.5rem minmax(0,1.6fr)";
const HEADINGS = ["Source", "Trigger", "Status", "Started", "Duration", "Verdict"] as const;

export function ExecutionRows({ rows, onSelect }: { rows: readonly ExecutionRowDTO[]; onSelect: (s: ExecutionSelection) => void }) {
  return (
    <div className="overflow-x-auto">
      <div className="mb-1 hidden items-center gap-3 border-b px-1 pb-2 md:grid" style={{ gridTemplateColumns: COLS, borderColor: "var(--border-hairline)" }}>
        {HEADINGS.map((h) => (
          <span key={h} className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]">{h}</span>
        ))}
      </div>
      <ul className="flex flex-col">
        {rows.map((row, i) => {
          const source = describeSource(row);
          const status = EXECUTION_STATUS_TOKEN[row.overallStatus] ?? TONE_COLOR.muted;
          const category = describeCategory(row.failureCategory);
          const verdict =
            row.failureStage ? `failed at ${row.failureStage}${category ? ` · ${category}` : ""}`
            : row.outcome === "UPDATED" ? "canonical state updated"
            : row.outcome === "NO_CHANGE" ? "no change (verified)"
            : row.overallStatus === "SUCCEEDED" ? "outcome not proven"
            : "";
          return (
            <li key={row.id}>
              {/* An inline RULE between two time-ordered rows — never a heading
                  that owns the rows beneath it. The list is never grouped by
                  deployment; this only marks where the attribute changed. */}
              {isDeploymentBoundary(rows, i) && (
                <div className="my-1 flex items-center gap-2" aria-hidden>
                  <span className="h-px flex-1" style={{ background: "var(--border-hairline)" }} />
                  <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">deployment changed · {shortSha(row.deploymentSha)}</span>
                  <span className="h-px flex-1" style={{ background: "var(--border-hairline)" }} />
                </div>
              )}
              <button
                type="button"
                onClick={() => onSelect(selectionFor(row))}
                className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 border-b px-1 py-2.5 text-left transition-colors last:border-b-0 hover:bg-[var(--surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)] md:grid"
                style={{ gridTemplateColumns: COLS, borderColor: "var(--border-hairline)", minHeight: 48 }}
                aria-label={`Inspect ${triggerWord(row.trigger)} execution of ${source.label}`}
                title={`run ${row.runId} · deployment ${row.deploymentSha ?? "not observed"}`}
              >
                <TwoLine value={<span className="font-medium">{source.label}</span>} qualifier={`${source.kind} · ${humanizeToken(row.profile)}`} />
                <span className="text-xs text-[var(--text-primary)]">{triggerWord(row.trigger)}</span>
                <span className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: status }}>
                  <span aria-hidden className="rounded-full" style={{ width: 6, height: 6, background: status }} />
                  {humanizeToken(row.overallStatus)}
                </span>
                <TwoLine value={`${timeAgo(row.startedAt)} ago`} qualifier={`${row.startedAt.slice(0, 16).replace("T", " ")} UTC`} />
                <span className="text-xs tabular-nums text-[var(--text-primary)]">{formatDuration(row.durationMs)}</span>
                <TwoLine
                  value={<span style={row.failureStage ? { color: TONE_COLOR.bad } : undefined}>{verdict || "—"}</span>}
                  qualifier={row.hasError && row.errorSummary ? row.errorSummary : undefined}
                />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The keyed, filtered reader. Remounted per `query` by the caller. */
function FilteredExecutions({ query, onSelect }: { query: string; onSelect: (s: ExecutionSelection) => void }) {
  const { data, loading, error } = useKeyedFetch<ExecutionPageDTO>(`/api/platform/platform-ops/refresh/executions?${query}`);
  if (loading || error || !data) return <WidgetMessage loading={loading} error={error} />;
  if (data.scopeDenied) return <p className="text-xs text-[var(--text-muted)]">No connections in scope — this read was refused rather than widened.</p>;
  if (data.rows.length === 0) {
    return (
      <p className="text-xs text-[var(--text-muted)]">
        No executions match — <em>not observed</em> for this filter; the ledger holds no such rows.
      </p>
    );
  }
  return (
    <>
      <ExecutionRows rows={data.rows} onSelect={onSelect} />
      {data.nextCursor && <p className="mt-2 text-[11px] text-[var(--text-muted)]">Older executions exist beyond this page.</p>}
    </>
  );
}

// ── Filter control ───────────────────────────────────────────────────────────

function Segmented<V extends string>({ label, value, options, onChange }: {
  label: string; value: V; options: readonly { value: V; label: string }[]; onChange: (v: V) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={label}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value || "all"}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className="rounded-[var(--radius-sm)] border px-2 py-0.5 text-[11px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]"
            style={{
              borderColor: active ? "var(--meridian-400)" : "var(--border-hairline)",
              color: active ? "var(--text-primary)" : "var(--text-secondary)",
              background: active ? "color-mix(in srgb, var(--meridian-500) 10%, transparent)" : "transparent",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ── The widget ───────────────────────────────────────────────────────────────

export function OpsRefreshExecutionsWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<ExecutionPageDTO>(
    "/api/platform/platform-ops/refresh/executions?limit=30",
  );
  // The inspected execution. Only the id + its header context are held here —
  // the panel fetches its own inspection and timeline.
  const [selected, setSelected] = useState<ExecutionSelection | null>(null);
  const [sourceKind, setSourceKind] = useState<"" | "PLAID_ITEM" | "WALLET">("");
  const [network, setNetwork] = useState<(typeof NETWORK_OPTIONS)[number]>("");
  const [status, setStatus] = useState<(typeof STATUS_OPTIONS)[number]["value"]>("");
  const [trigger, setTrigger] = useState<(typeof TRIGGER_OPTIONS)[number]["value"]>("");

  const params = new URLSearchParams();
  params.set("limit", String(PAGE));
  if (sourceKind) params.set("sourceKind", sourceKind);
  if (sourceKind === "WALLET" && network) params.set("network", network);
  if (status) params.set("status", status);
  if (trigger) params.set("trigger", trigger);
  const filtered = Boolean(sourceKind || status || trigger);
  const query = params.toString();

  if (loading || error || !data) {
    return (
      <PlatformWidgetCard label={section.label} icon={ListOrdered}>
        <WidgetMessage loading={loading} error={error} />
      </PlatformWidgetCard>
    );
  }

  return (
    <>
      <SectionSurface icon={ListOrdered} title={section.label} footnote={FOOTNOTE}>
        <div className="mb-5 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Segmented label="Source" value={sourceKind} options={SOURCE_OPTIONS} onChange={(v) => { setSourceKind(v); if (v !== "WALLET") setNetwork(""); }} />
            {sourceKind === "WALLET" && (
              <Segmented label="Network" value={network} options={NETWORK_OPTIONS.map((n) => ({ value: n, label: n || "Any network" }))} onChange={setNetwork} />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Segmented label="Status" value={status} options={STATUS_OPTIONS} onChange={setStatus} />
            <Segmented label="Trigger" value={trigger} options={TRIGGER_OPTIONS} onChange={setTrigger} />
          </div>
        </div>

        {filtered ? (
          <FilteredExecutions key={query} query={query} onSelect={setSelected} />
        ) : data.scopeDenied ? (
          <p className="text-xs text-[var(--text-muted)]">
            No connections in scope — this read was refused rather than widened.
          </p>
        ) : data.rows.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">
            No refresh executions recorded — <em>not observed</em>. The ledger holds no rows
            for this view; that is not the same as a successful quiet period.
          </p>
        ) : (
          <>
            <ExecutionRows rows={data.rows} onSelect={setSelected} />
            {data.nextCursor && (
              <p className="mt-2 text-[11px] text-[var(--text-muted)]">Older executions exist beyond this page.</p>
            )}
          </>
        )}
      </SectionSurface>

      <ExecutionTimelinePanel
        executionId={selected?.id ?? null}
        eyebrow={selected?.eyebrow ?? ""}
        title={selected?.title ?? ""}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
