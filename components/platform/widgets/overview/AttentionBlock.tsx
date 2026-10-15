"use client";

/**
 * components/platform/widgets/overview/AttentionBlock.tsx  (UX-P1 · Agent 2)
 *
 * WHAT REQUIRES ATTENTION — the Overview's second block, over
 * GET /api/platform/platform-ops/attention.
 *
 * The Pipeline / Jobs grid-row idiom: ONE `gridTemplateColumns` shared by the
 * header and every row, `hidden md:grid` header, `TwoLine` cells, a ToneBadge
 * in the Severity column, `overflow-x-auto` on the table. Below `md` a row
 * collapses to severity + entity + problem and the entity cell toggles an
 * inline expansion that carries the dropped columns (Since · Evidence ·
 * Action) and the row's basis — a phone loses layout, never a fact.
 *
 * Columns: Severity | Entity | Problem | Since | Evidence | Action.
 *   Evidence  an execution id opens the same ExecutionTimelinePanel the
 *             Pipeline uses (keyed); anything else is a doorway into the
 *             workspace that holds the full read.
 *   Action    `resync` / `request-reauth` POST to the EXISTING connection
 *             routes behind a ConfirmDialog, rendered only when the operator's
 *             descriptive access says canWrite (the server gate decides);
 *             `run-now` is a doorway to Jobs — no write is added here.
 *
 * Order is the server's (attention-core.ts). The filter SELECTS, it never
 * re-sorts. The empty state counts authorities; it never says "healthy". The
 * recent firings line is history and is rendered apart from the rows.
 *
 * After a write succeeds the reader is REMOUNTED (`key`), which is the
 * sanctioned way to give `useWidgetFetch` a fresh read.
 */

import { useState, type ReactNode } from "react";
import { AlertTriangle, ChevronRight, KeyRound, RefreshCw } from "lucide-react";
import { WidgetMessage, useWidgetFetch } from "../../widget-kit";
import { BigStat, DistributionBar, GroupLabel, PillGroup, SectionSurface, TONE_COLOR, ToneBadge, TwoLine, Unavailable } from "../../platform-surface";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { getPlatformWorkspace } from "@/lib/platform/workspaces";
import { relTime } from "../job-health-format";
import type { AttentionResponse } from "@/lib/platform/ops/attention";
import type { AttentionAction, AttentionItem, UserImpactCore, UserImpactRow } from "@/lib/platform/ops/attention-core";
import { ExecutionTimelinePanel } from "../ExecutionTimelinePanel";
import {
  ATTENTION_FOOTNOTE,
  ENTITY_WORD,
  IMPACT_FOOTNOTE,
  IMPACT_KIND_TONE,
  IMPACT_KIND_WORD,
  IMPACT_TITLE,
  SEVERITY_TONE,
  SEVERITY_WORD,
  actionLabel,
  emptyText,
  evidenceLabel,
  failedAuthoritiesText,
  filterItems,
  filterOptions,
  impactEmptyText,
  impactFailedText,
  impactSegments,
  recentFiringsEmpty,
  recentFiringsHeading,
  referenceLabel,
  usersAffectedReading,
  utcStamp,
  type AttentionFilter,
} from "./attention-view";
import type { OverviewBlockProps } from "./block-contract";

const TITLE = "Attention required";

/** ONE grid definition, shared by the header row and every data row. */
const COLS = "6.5rem minmax(0,1.4fr) minmax(0,2.2fr) 6.5rem minmax(0,1fr) minmax(0,1.3fr)";
const HEADINGS = ["Severity", "Entity", "Problem", "Since", "Evidence", "Action"] as const;

interface ExecutionSelection { id: string; eyebrow: string; title: string }
type WriteAction = Extract<AttentionAction, { kind: "resync" | "request-reauth" }>;
interface PendingWrite { action: WriteAction; item: AttentionItem }

const LINK_CLASS =
  "rounded-[var(--radius-xs)] text-left text-[11px] text-[var(--meridian-400)] transition-colors hover:text-[var(--meridian-300)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]";
const WRITE_CLASS =
  "inline-flex items-center gap-1 rounded-[var(--radius-sm)] border px-2 py-0.5 text-[11px] font-medium transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)] disabled:opacity-40";

const workspaceLabel = (id: string): string | null => getPlatformWorkspace(id)?.label ?? null;

// ── Cells ─────────────────────────────────────────────────────────────────────

function SinceCell({ item, nowMs }: { item: AttentionItem; nowMs: number }) {
  if (!item.since) return <TwoLine value="not recorded" qualifier="no onset in the ledger" />;
  return <TwoLine value={relTime(item.since, nowMs)} qualifier={utcStamp(item.since) ?? item.since} />;
}

function EvidenceCell({ item, onOpenWorkspace, onSelectExecution }: {
  item: AttentionItem;
  onOpenWorkspace?: (id: string) => void;
  onSelectExecution: (s: ExecutionSelection) => void;
}) {
  const e = item.evidence;
  if (e.kind === "execution") {
    return (
      <button
        type="button"
        onClick={() => onSelectExecution({ id: e.id, eyebrow: `${ENTITY_WORD[item.entity.kind]} · evidence`, title: item.entity.label })}
        aria-label={`Inspect execution …${e.id.slice(-6)} for ${item.entity.label}`}
        className={LINK_CLASS}
      >
        {evidenceLabel(e, null)}
      </button>
    );
  }
  const label = workspaceLabel(e.workspace);
  if (!onOpenWorkspace || !label) return <span className="text-[11px] text-[var(--text-muted)]">{label ?? "no doorway"}</span>;
  return (
    <button type="button" onClick={() => onOpenWorkspace(e.workspace)} aria-label={`${evidenceLabel(e, label)} — evidence for ${item.entity.label}`} className={LINK_CLASS}>
      {evidenceLabel(e, label)}
    </button>
  );
}

function ActionCell({ item, canWrite, busy, onOpenWorkspace, onWrite }: {
  item: AttentionItem;
  canWrite: boolean;
  busy: boolean;
  onOpenWorkspace?: (id: string) => void;
  onWrite: (p: PendingWrite) => void;
}) {
  // A doorway the Evidence column already renders is not repeated here.
  const evidenceDoorway = item.evidence.kind === "execution" ? null : item.evidence.workspace;
  const rendered: ReactNode[] = [];
  for (const a of item.actions) {
    if (a.kind === "open-workspace") {
      if (a.workspace === evidenceDoorway) continue;
      const label = workspaceLabel(a.workspace);
      if (onOpenWorkspace && label) {
        rendered.push(
          <button key={`open-${a.workspace}`} type="button" onClick={() => onOpenWorkspace(a.workspace)} aria-label={`${actionLabel(a, label)} — ${item.entity.label}`} className={LINK_CLASS}>
            {actionLabel(a, label)} →
          </button>,
        );
      }
    } else if (a.kind === "run-now") {
      const label = workspaceLabel("platform-jobs");
      if (onOpenWorkspace && label) {
        rendered.push(
          <button key="run-now" type="button" onClick={() => onOpenWorkspace("platform-jobs")} aria-label={`${actionLabel(a, label)} — ${item.entity.label}`} className={LINK_CLASS}>
            {actionLabel(a, label)} →
          </button>,
        );
      }
    } else {
      if (!canWrite) continue;
      rendered.push(
        <button key={a.kind} type="button" disabled={busy} onClick={() => onWrite({ action: a, item })} className={WRITE_CLASS}
          style={{ borderColor: "var(--border-hairline)", color: "var(--text-primary)" }}
          aria-label={`${actionLabel(a, null)} ${item.entity.label}`}>
          {a.kind === "resync" ? <RefreshCw size={11} aria-hidden /> : <KeyRound size={11} aria-hidden />} {actionLabel(a, null)}
        </button>,
      );
    }
  }
  if (rendered.length === 0) return <span className="text-[11px] text-[var(--text-muted)]">none beyond the evidence</span>;
  return <span className="flex flex-wrap items-center gap-x-3 gap-y-1">{rendered}</span>;
}

/** The row expansion. Exported so the test can render it (a collapsed row is unreachable without clicks). */
export function AttentionRowDetail({ item, nowMs, canWrite, busy, onOpenWorkspace, onSelectExecution, onWrite }: {
  item: AttentionItem;
  nowMs: number;
  canWrite: boolean;
  busy: boolean;
  onOpenWorkspace?: (id: string) => void;
  onSelectExecution: (s: ExecutionSelection) => void;
  onWrite: (p: PendingWrite) => void;
}) {
  return (
    <div className="flex flex-col gap-3 px-6 pb-4 pt-1">
      {/* RESPONSIVE — the three columns that drop below `md` reappear here. */}
      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-3 md:hidden">
        <Labelled label="Since"><SinceCell item={item} nowMs={nowMs} /></Labelled>
        <Labelled label="Evidence"><EvidenceCell item={item} onOpenWorkspace={onOpenWorkspace} onSelectExecution={onSelectExecution} /></Labelled>
        <Labelled label="Action"><ActionCell item={item} canWrite={canWrite} busy={busy} onOpenWorkspace={onOpenWorkspace} onWrite={onWrite} /></Labelled>
      </div>
      <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">Basis: {item.basis}</p>
    </div>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">{label}</span>
      {children}
    </div>
  );
}

function AttentionRow(props: {
  item: AttentionItem;
  nowMs: number;
  canWrite: boolean;
  busy: boolean;
  onOpenWorkspace?: (id: string) => void;
  onSelectExecution: (s: ExecutionSelection) => void;
  onWrite: (p: PendingWrite) => void;
}) {
  const { item, nowMs, canWrite, busy, onOpenWorkspace, onSelectExecution, onWrite } = props;
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="border-b transition-colors last:border-b-0 hover:bg-[var(--surface-hover)]" style={{ borderColor: "var(--border-hairline)" }}>
      <div className="flex items-center gap-3 px-1 md:grid" style={{ gridTemplateColumns: COLS, minHeight: 52 }}>
        <span className="shrink-0"><ToneBadge word={SEVERITY_WORD[item.severity]} tone={SEVERITY_TONE[item.severity]} /></span>
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${item.entity.label}`}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-xs)] py-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]"
        >
          <ChevronRight size={12} aria-hidden className="shrink-0 text-[var(--text-faint)] transition-transform" style={{ transform: expanded ? "rotate(90deg)" : "none" }} />
          <TwoLine value={<span className="font-medium">{item.entity.label}</span>} qualifier={ENTITY_WORD[item.entity.kind]} />
        </button>
        <span className="hidden min-w-0 text-xs leading-snug break-words text-[var(--text-primary)] md:block">{item.problem}</span>
        <span className="hidden md:block"><SinceCell item={item} nowMs={nowMs} /></span>
        <span className="hidden md:block"><EvidenceCell item={item} onOpenWorkspace={onOpenWorkspace} onSelectExecution={onSelectExecution} /></span>
        <span className="hidden md:block"><ActionCell item={item} canWrite={canWrite} busy={busy} onOpenWorkspace={onOpenWorkspace} onWrite={onWrite} /></span>
      </div>
      {/* Below md the problem is the row's second line, never dropped. */}
      <p className="px-6 pb-2 text-xs leading-snug break-words text-[var(--text-primary)] md:hidden">{item.problem}</p>
      {expanded && <AttentionRowDetail item={item} nowMs={nowMs} canWrite={canWrite} busy={busy} onOpenWorkspace={onOpenWorkspace} onSelectExecution={onSelectExecution} onWrite={onWrite} />}
    </li>
  );
}

// ── BETA V1 · User-impacting failures (a separate composition, rendered first) ─

/** ONE grid for the impact rows: Kind | Reference | Problem | When | Evidence. */
const IMPACT_COLS = "9rem minmax(0,1fr) minmax(0,2.2fr) 6.5rem minmax(0,1.2fr)";
const IMPACT_HEADINGS = ["Kind", "Reference", "Problem", "When", "Evidence"] as const;

function ImpactEvidence({ row, onOpenWorkspace, onSelectExecution }: {
  row: UserImpactRow;
  onOpenWorkspace?: (id: string) => void;
  onSelectExecution: (s: ExecutionSelection) => void;
}) {
  const e = row.evidence;
  if (e.kind === "execution") {
    return (
      <button type="button" onClick={() => onSelectExecution({ id: e.id, eyebrow: `${row.label} · evidence`, title: referenceLabel(row.reference) })}
        aria-label={`Inspect execution …${e.id.slice(-6)} for ${referenceLabel(row.reference)}`} className={LINK_CLASS}>
        {evidenceLabel(e, null)}
      </button>
    );
  }
  const label = workspaceLabel(e.workspace);
  if (!onOpenWorkspace || !label) return <span className="text-[11px] text-[var(--text-muted)]">{label ?? "no doorway"}</span>;
  return (
    <button type="button" onClick={() => onOpenWorkspace(e.workspace)} aria-label={`${evidenceLabel(e, label)} — evidence for ${row.label}`} className={LINK_CLASS}>
      {evidenceLabel(e, label)}
    </button>
  );
}

/** A table cell that carries its column word below `md`, where the header row is hidden. */
function ImpactCell({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="text-[10px] uppercase tracking-wide text-[var(--text-faint)] md:hidden">{heading}</span>
      {children}
    </span>
  );
}

/** Exported for the test. Rows render in the server's order; this never re-sorts. */
export function UserImpactGroup({ impact, nowMs, onOpenWorkspace, onSelectExecution }: {
  impact: UserImpactCore;
  nowMs: number;
  onOpenWorkspace?: (id: string) => void;
  onSelectExecution: (s: ExecutionSelection) => void;
}) {
  const reading = usersAffectedReading(impact);
  const failed = impactFailedText(impact.authorities.failed);
  return (
    <div className="mb-8 border-b pb-6" style={{ borderColor: "var(--border-hairline)" }}>
      <GroupLabel hint={IMPACT_FOOTNOTE}>{IMPACT_TITLE}</GroupLabel>
      <div className="mt-4 grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <BigStat
          label={`Users affected · last ${impact.windowHours} h`}
          value={reading.kind === "figure" ? reading.value : <Unavailable reason={reading.reason} />}
          qualifier={reading.qualifier}
        />
        <DistributionBar
          label={`Facts by kind · last ${impact.windowHours} h`}
          segments={impactSegments(impact.counts)}
          floor={impact.floors.length > 0}
          emptyText={impactEmptyText(impact)}
        />
      </div>
      {failed && <p role="alert" className="mt-3 text-[11px] leading-relaxed" style={{ color: "var(--coral-400)" }}>{failed}</p>}

      {impact.rows.length === 0 ? (
        <p role="status" className="mt-4 text-xs text-[var(--text-secondary)]">{impactEmptyText(impact)}</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <div className="mb-1 hidden items-center gap-3 border-b px-1 pb-2 md:grid" style={{ gridTemplateColumns: IMPACT_COLS, borderColor: "var(--border-hairline)" }}>
            {IMPACT_HEADINGS.map((h) => <span key={h} className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]">{h}</span>)}
          </div>
          <ul className="flex flex-col">
            {impact.rows.map((row) => (
              <li key={row.id} className="flex flex-wrap gap-x-3 gap-y-2 border-b px-1 py-2.5 last:border-b-0 md:grid md:items-start" style={{ gridTemplateColumns: IMPACT_COLS, borderColor: "var(--border-hairline)" }}>
                <ImpactCell heading="Kind">
                  {/* Dot + WORD in the kind's tone — the word carries the level, the dot is decorative. Not a ToneBadge: badges are the severity table's rows. */}
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-medium" style={{ color: TONE_COLOR[IMPACT_KIND_TONE[row.kind]] }}>
                    <span aria-hidden className="rounded-full" style={{ width: 6, height: 6, background: TONE_COLOR[IMPACT_KIND_TONE[row.kind]] }} />
                    {IMPACT_KIND_WORD[row.kind]}{row.count > 1 ? ` ×${row.count}` : ""}
                  </span>
                </ImpactCell>
                <ImpactCell heading="Reference"><TwoLine value={referenceLabel(row.reference)} qualifier={row.label} /></ImpactCell>
                <ImpactCell heading="Problem"><span className="text-xs leading-snug break-words text-[var(--text-primary)]">{row.problem}</span></ImpactCell>
                <ImpactCell heading="When">
                  {row.at ? <TwoLine value={relTime(row.at, nowMs)} qualifier={utcStamp(row.at) ?? row.at} /> : <TwoLine value="not recorded" qualifier="no instant from the reader" />}
                </ImpactCell>
                <ImpactCell heading="Evidence"><ImpactEvidence row={row} onOpenWorkspace={onOpenWorkspace} onSelectExecution={onSelectExecution} /></ImpactCell>
              </li>
            ))}
          </ul>
        </div>
      )}
      {impact.floors.length > 0 && (
        <ul className="mt-3 flex flex-col gap-0.5 text-[10px] leading-relaxed text-[var(--text-faint)]">
          {impact.floors.map((f) => <li key={f}>{f}</li>)}
        </ul>
      )}
    </div>
  );
}

// ── Table ─────────────────────────────────────────────────────────────────────

/** The aligned grid and its rows, in the server's order. Exported for the test. */
export function AttentionTable({ rows, nowMs, canWrite, busy, onOpenWorkspace, onSelectExecution, onWrite, emptyMessage = "No rows match this filter." }: {
  rows: readonly AttentionItem[];
  nowMs: number;
  canWrite: boolean;
  busy: boolean;
  onOpenWorkspace?: (id: string) => void;
  onSelectExecution: (s: ExecutionSelection) => void;
  onWrite: (p: PendingWrite) => void;
  emptyMessage?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <div className="mb-1 hidden items-center gap-3 border-b px-1 pb-2 md:grid" style={{ gridTemplateColumns: COLS, borderColor: "var(--border-hairline)" }}>
        {HEADINGS.map((h) => (
          <span key={h} className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]">{h}</span>
        ))}
      </div>
      <ul className="flex flex-col">
        {rows.length === 0 ? (
          <li className="py-6 text-center text-xs text-[var(--text-muted)]">{emptyMessage}</li>
        ) : (
          rows.map((item) => (
            <AttentionRow key={item.id} item={item} nowMs={nowMs} canWrite={canWrite} busy={busy} onOpenWorkspace={onOpenWorkspace} onSelectExecution={onSelectExecution} onWrite={onWrite} />
          ))
        )}
      </ul>
    </div>
  );
}

// ── The surface (prop-driven; every state renderable in a test) ───────────────

export function AttentionSurface({ data, nowMs, canWrite, onOpenWorkspace, onChanged }: {
  data: AttentionResponse;
  nowMs: number;
  canWrite: boolean;
  onOpenWorkspace?: (id: string) => void;
  /** Called after a write succeeded, so the host can re-read. */
  onChanged?: () => void;
}) {
  const [filter, setFilter] = useState<AttentionFilter>("all");
  const [execution, setExecution] = useState<ExecutionSelection | null>(null);
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const rows = filterItems(data.items, filter);
  const failed = failedAuthoritiesText(data.authoritiesFailed);

  async function runPending() {
    if (!pending) return;
    const { action, item } = pending;
    const path = action.kind === "resync" ? "resync" : "request-reauth";
    setActing(true);
    setActionError(null);
    try {
      const r = await fetch(`/api/platform/platform-ops/connections/${action.connectionId}/${path}`, { method: "POST", credentials: "same-origin" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        if (r.status === 429 && body.retryAfterSeconds) throw new Error(`On cooldown — try again in ~${Math.ceil(body.retryAfterSeconds / 60)} min.`);
        if (r.status === 409 && body.error === "in-flight") throw new Error("A sync is already in flight for this connection.");
        if (body.message) throw new Error(String(body.message));
        throw new Error(body.error ?? `${actionLabel(action, null)} failed for ${item.entity.label} (${r.status})`);
      }
      setPending(null);
      onChanged?.();
    } catch (e) {
      setPending(null);
      setActionError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setActing(false);
    }
  }

  return (
    <>
      <SectionSurface
        icon={AlertTriangle}
        title={TITLE}
        count={data.items.length}
        actions={<PillGroup label="Filter by severity" value={filter} options={filterOptions(data.counts, data.items.length)} onChange={setFilter} />}
        footnote={ATTENTION_FOOTNOTE}
      >
        {actionError && (
          <p role="alert" className="mb-3 flex items-start gap-1.5 text-xs" style={{ color: "var(--coral-400)" }}>
            <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden /> <span>{actionError}</span>
          </p>
        )}
        {failed && (
          <p role="alert" className="mb-3 text-[11px] leading-relaxed" style={{ color: "var(--coral-400)" }}>{failed}</p>
        )}

        {/* BETA V1 — failures that reached a customer, first; the platform severity table follows. */}
        <UserImpactGroup impact={data.userImpact} nowMs={nowMs} onOpenWorkspace={onOpenWorkspace} onSelectExecution={setExecution} />

        {data.items.length === 0 ? (
          <p role="status" className="text-xs text-[var(--text-secondary)]">{emptyText(data.authoritiesChecked.count, data.checkedAt)}</p>
        ) : (
          <AttentionTable rows={rows} nowMs={nowMs} canWrite={canWrite} busy={acting} onOpenWorkspace={onOpenWorkspace} onSelectExecution={setExecution} onWrite={setPending} />
        )}

        {data.floors.length > 0 && (
          <ul className="mt-3 flex flex-col gap-0.5 text-[10px] leading-relaxed text-[var(--text-faint)]">
            {data.floors.map((f) => <li key={f}>{f}</li>)}
          </ul>
        )}

        {/* HISTORY — kept apart from the rows, and labelled as the past. */}
        <div className="mt-6 border-t pt-4" style={{ borderColor: "var(--border-hairline)" }}>
          <p className="text-[11px] font-medium text-[var(--text-secondary)]">{recentFiringsHeading(data.recentFirings)}</p>
          {data.recentFirings.count === 0 ? (
            <p className="mt-1 text-[11px] text-[var(--text-muted)]">{recentFiringsEmpty(data.recentFirings)}</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-[var(--text-muted)]">
              {data.recentFirings.items.map((h, i) => (
                <li key={`${h.dedupeKey}:${h.deliveredAtISO}:${i}`}>
                  {h.summary} <span className="text-[var(--text-faint)]">· {h.severity} · delivered {relTime(h.deliveredAtISO, nowMs)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SectionSurface>

      <ExecutionTimelinePanel executionId={execution?.id ?? null} eyebrow={execution?.eyebrow ?? ""} title={execution?.title ?? ""} onClose={() => setExecution(null)} />

      {pending && pending.action.kind === "resync" && (
        <ConfirmDialog
          icon={RefreshCw}
          title={`Resync ${pending.item.entity.label} now?`}
          message="Re-runs this connection's sync through the existing per-item path (respects the in-flight lock and manual cooldown). No customer data is exposed."
          confirmLabel="Resync now"
          confirmTone="meridian"
          busy={acting}
          onConfirm={runPending}
          onClose={() => setPending(null)}
        />
      )}
      {pending && pending.action.kind === "request-reauth" && (
        <ConfirmDialog
          icon={KeyRound}
          title={`Ask the customer to reauthorize ${pending.item.entity.label}?`}
          message="Marks the connection as needing reauthorization and prompts the customer to reconnect. It does NOT remove the connection or any data."
          confirmLabel="Request reauthorization"
          confirmTone="meridian"
          busy={acting}
          onConfirm={runPending}
          onClose={() => setPending(null)}
        />
      )}
    </>
  );
}

// ── The block (fetches; remounted after a write) ──────────────────────────────

function AttentionReader({ onOpenWorkspace, access, onChanged }: OverviewBlockProps & { onChanged: () => void }) {
  const { data, loading, error } = useWidgetFetch<AttentionResponse>("/api/platform/platform-ops/attention");
  const [nowMs] = useState(() => Date.now());

  if (loading || error || !data) {
    return (
      <SectionSurface icon={AlertTriangle} title={TITLE}>
        <WidgetMessage loading={loading} error={error} />
      </SectionSurface>
    );
  }
  return <AttentionSurface data={data} nowMs={nowMs} canWrite={access?.canWrite ?? false} onOpenWorkspace={onOpenWorkspace} onChanged={onChanged} />;
}

export function AttentionBlock(props: OverviewBlockProps) {
  const [generation, setGeneration] = useState(0);
  return <AttentionReader key={generation} {...props} onChanged={() => setGeneration((g) => g + 1)} />;
}
