"use client";

/**
 * components/platform/incidents/IncidentsLead.tsx  (PB-1 2B — the incidents workspace)
 *
 * ONE workspace, two tiers:
 *   OpsIncidentsLead  Platform Ops   → /api/platform/platform-ops/incidents       (Ops token, identity-free)
 *   CsIncidentsLead   Customer Succ. → /api/platform/customer-success/incidents   (CS token; the customer id may appear)
 *
 * The VIEW is the status preset (Broken now · Needs verification · History —
 * each exactly one intelligence accessor's filter, lib/platform/workspaces.ts).
 * Filters, page and the open incident live in the URL (incidents-url.ts, the
 * AI-budget drawer idiom), so a refresh reopens the same list and drawer.
 *
 * Every row opens the detail drawer: verdict + why, the append-only timeline
 * (rendered in stored order, never rewritten), the evidence digest, affected
 * subjects, related / recurring incidents, archive state — and ONLY the
 * EXISTING recovery routes (resync / request-reauth for Ops; the customer's
 * Refresh all for CS), each behind a confirmation, rendered only when the
 * operator's descriptive access says WRITE. The server guard decides; each
 * route audits through recordOperatorAction. Presentation only: nothing here
 * derives a verdict.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, KeyRound, RefreshCw, RotateCcw } from "lucide-react";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { Surface } from "@/components/atlas/Surface";
import { useSpaceUrl } from "@/components/space/shell/useSpaceUrl";
import { DetailDrawer } from "../ui";
import { ChartMessage } from "../leads/visual-kit";
import { TONE_COLOR } from "../platform-surface";
import { ExecutionTimelinePanel } from "../widgets/ExecutionTimelinePanel";
import type { PlatformViewLeadProps } from "../leads/lead-contract";
import { DEFAULT_SEARCH, SEVERITY_FILTERS, retentionFloorDay } from "@/lib/platform/incidents/intelligence/search-core";
import type { IncidentSearchQuery } from "@/lib/platform/incidents/intelligence/types";
import type { IncidentDetailDTO, IncidentListDTO, IncidentRowDTO, IncidentTier, RecoveryActionDTO } from "@/lib/platform/incidents/investigation-dto";
import {
  incidentDetailApiPath, incidentsApiPath, incidentsUrlUpdate, readIncidentsUrl, statusOfView, type IncidentsUrlState,
} from "./incidents-url";
import {
  FRESHNESS_WORD, LINK_WORD, RECOVERY_LABEL, SEVERITY_WORD, STATE_TONE, STATE_WORD, STATUS_TITLE,
  affectedLine, archiveLine, closureText, codeText, incidentLine, incidentTotalText, incidentTitle, pageCount, populationLine, timelineText, whenText, whyLines,
} from "./incidents-model";

const FIELD = "min-h-11 min-w-0 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] bg-transparent px-2 text-xs text-[var(--text-secondary)] lg:min-h-8";
const ROW_BTN = "group flex min-h-11 w-full min-w-0 items-start gap-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]";
const H = "text-[11px] font-medium uppercase tracking-wide text-[var(--text-faint)]";

/** A keyed GET: a stale response never lands over a newer one; `reload` re-reads the same key. */
function useKeyedJson<T>(path: string | null, generation = 0): { data: T | null; error: string | null; fresh: boolean } {
  const [res, setRes] = useState<{ key: string | null; data: T | null; error: string | null }>({ key: null, data: null, error: null });
  const key = path ? `${path}#${generation}` : null;
  useEffect(() => {
    if (!path || !key) return;
    let alive = true;
    fetch(path, { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 403 ? "Not authorized" : r.status === 404 ? "Not found" : `Request failed (${r.status})`);
        return (await r.json()) as T;
      })
      .then((data) => { if (alive) setRes({ key, data, error: null }); })
      .catch((e: unknown) => { if (alive) setRes({ key, data: null, error: e instanceof Error ? e.message : "Failed to load" }); });
    return () => { alive = false; };
  }, [path, key]);
  return { data: res.data, error: res.key === key ? res.error : null, fresh: res.key === key };
}

function Dot({ tone }: { tone: keyof typeof TONE_COLOR }) {
  return <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: TONE_COLOR[tone] }} />;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2 border-t border-[var(--border-hairline)] pt-4 first:border-t-0 first:pt-0">
      <h3 className={H}>{title}</h3>
      {children}
    </section>
  );
}

// ── Filters ─────────────────────────────────────────────────────────────────

function Select({ label, value, options, onChange }: { label: string; value: string | null; options: readonly { value: string; label: string }[]; onChange: (v: string | null) => void }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[10px] text-[var(--text-faint)]">
      {label}
      <select className={FIELD} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Any</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

/** Facet values plus the selected one (a URL filter is shown even when this page's scan has no row for it). */
const withSelected = (values: readonly string[], selected: string | null) => [...new Set([...values, ...(selected ? [selected] : [])])].map((v) => ({ value: v, label: v }));

export function IncidentFilters({ query, facets, nowMs, onQuery }: {
  query: IncidentSearchQuery;
  facets: IncidentListDTO["facets"] | null;
  nowMs: number;
  onQuery: (q: IncidentSearchQuery) => void;
}) {
  const set = (patch: Partial<IncidentSearchQuery>) => onQuery({ ...query, ...patch, page: 1 });
  const floor = retentionFloorDay(nowMs);
  const any = query.severity || query.provider || query.operation || query.code || query.from || query.to;
  return (
    <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7" data-incident-filters>
      <Select label="Severity" value={query.severity} options={SEVERITY_FILTERS.map((s) => ({ value: s, label: SEVERITY_WORD[s] }))} onChange={(v) => set({ severity: v as IncidentSearchQuery["severity"] })} />
      <Select label="Provider" value={query.provider} options={withSelected(facets?.providers ?? [], query.provider)} onChange={(v) => set({ provider: v })} />
      <Select label="Operation" value={query.operation} options={withSelected(facets?.operations ?? [], query.operation)} onChange={(v) => set({ operation: v })} />
      <Select label="Code" value={query.code} options={withSelected(facets?.codes ?? [], query.code)} onChange={(v) => set({ code: v })} />
      <label className="flex min-w-0 flex-col gap-1 text-[10px] text-[var(--text-faint)]">
        Last seen from
        <input type="date" className={FIELD} min={floor} value={query.from ?? ""} onChange={(e) => set({ from: e.target.value || null })} />
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-[10px] text-[var(--text-faint)]">
        Last seen to
        <input type="date" className={FIELD} min={floor} value={query.to ?? ""} onChange={(e) => set({ to: e.target.value || null })} />
      </label>
      <div className="flex items-end">
        <button type="button" className={`${FIELD} w-full`} disabled={!any} onClick={() => onQuery({ ...DEFAULT_SEARCH, status: query.status })}>Clear filters</button>
      </div>
    </div>
  );
}

// ── The list (prop-driven; every state renders in a test) ───────────────────

export function IncidentListSurface({ data, onSelect, onPage }: { data: IncidentListDTO; onSelect: (id: string) => void; onPage: (page: number) => void }) {
  const pages = pageCount(data);
  return (
    <div className="flex min-w-0 flex-col gap-2" data-incident-list data-total={data.total}>
      <p className="text-[11px] tabular-nums text-[var(--text-muted)]" data-incident-population>{populationLine(data)}{data.fromClamped ? " · start date clamped to the 13-month retention" : ""}</p>
      {data.items.length === 0 ? (
        <ChartMessage>{data.total === 0 ? "No incidents match." : "No incidents on this page."}</ChartMessage>
      ) : (
        <ul aria-label="Incidents" className="flex min-w-0 flex-col">
          {data.items.map((r) => (
            <li key={r.id} className="min-w-0 border-t border-[var(--border-hairline)] first:border-t-0">
              <button type="button" aria-haspopup="dialog" onClick={() => onSelect(r.id)} className={ROW_BTN} data-incident-row={r.id}>
                <Dot tone={STATE_TONE[r.state]} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--text-primary)]">{incidentTitle(r)}</span>
                  <span className="block truncate text-[11px] text-[var(--text-muted)]">{incidentLine(r)}</span>
                  {"subjectUserId" in r && r.subjectUserId ? <span className="block truncate font-mono text-[10px] text-[var(--text-faint)]">customer {r.subjectUserId}</span> : null}
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5 text-[11px]">
                  <span style={{ color: TONE_COLOR[STATE_TONE[r.state]] }}>{STATE_WORD[r.state]}</span>
                  <span className="text-[var(--text-muted)]">{SEVERITY_WORD[r.effectiveSeverity]}</span>
                </span>
                <ChevronRight size={14} aria-hidden className="mt-1 shrink-0 text-[var(--text-faint)] group-hover:text-[var(--text-secondary)]" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {(pages > 1 || data.page > 1) && (
        <nav aria-label="Pages" className="flex items-center justify-end gap-2 text-[11px] text-[var(--text-muted)]" data-pager>
          <button type="button" className={FIELD} disabled={data.page <= 1} onClick={() => onPage(Math.min(data.page - 1, pages))} aria-label="Previous page"><ChevronLeft size={12} aria-hidden /></button>
          <span className="tabular-nums">{`Page ${data.page} of ${pages}`}</span>
          <button type="button" className={FIELD} disabled={data.page >= pages} onClick={() => onPage(data.page + 1)} aria-label="Next page"><ChevronRight size={12} aria-hidden /></button>
        </nav>
      )}
    </div>
  );
}

// ── The detail ──────────────────────────────────────────────────────────────

function LinkedRow({ id, r, prefix, onSelect }: { id: string; r: IncidentRowDTO | null; prefix?: string; onSelect: (id: string) => void }) {
  if (!r) return <li className="break-all py-1.5 text-[11px] text-[var(--text-muted)]">{prefix ? `${prefix} · ` : ""}<span className="font-mono">{id}</span> · no longer retained</li>;
  return (
    <li className="min-w-0">
      <button type="button" onClick={() => onSelect(id)} className={`${ROW_BTN} py-1.5`}>
        <Dot tone={STATE_TONE[r.state]} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-[var(--text-primary)]">{prefix ? `${prefix} · ` : ""}{incidentTitle(r)}</span>
          <span className="block truncate text-[10px] text-[var(--text-muted)]">{`${STATE_WORD[r.state]} · last ${whenText(r.lastSeenAt)}`}</span>
        </span>
        <ChevronRight size={12} aria-hidden className="mt-1 shrink-0 text-[var(--text-faint)]" />
      </button>
    </li>
  );
}

export function IncidentDetailSurface({ d, canWrite, onSelect, onExecution, onRecover }: {
  d: IncidentDetailDTO;
  canWrite: boolean;
  onSelect: (id: string) => void;
  onExecution?: (id: string) => void;
  onRecover: (a: RecoveryActionDTO) => void;
}) {
  const r = d.incident;
  const closure = closureText(r);
  return (
    <div className="flex min-w-0 flex-col gap-5" data-incident-detail={r.id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-medium" style={{ color: TONE_COLOR[STATE_TONE[r.state]] }}>{STATE_WORD[r.state]}</span>
        <span className="text-[var(--text-secondary)]">{SEVERITY_WORD[r.severity]}{r.effectiveSeverity !== r.severity ? ` (ranked ${SEVERITY_WORD[r.effectiveSeverity].toLowerCase()})` : ""}</span>
        <span className="text-[var(--text-muted)]">{FRESHNESS_WORD[r.freshness]}</span>
        {closure && <span className="text-[var(--text-muted)]">{closure}</span>}
      </div>
      <p className="text-[11px] text-[var(--text-muted)]">{incidentLine(r)}{r.resolvedAt ? ` · resolved ${whenText(r.resolvedAt)}` : ""}</p>

      <Section title="Why">
        <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-[var(--text-secondary)]" data-incident-why>
          {whyLines(d).map((l) => <li key={l}>{l}</li>)}
        </ul>
      </Section>

      <Section title="Timeline">
        {d.timeline.events.length === 0 ? (
          <p className="text-[11px] text-[var(--text-muted)]">No lifecycle events recorded for this incident (rows before the timeline existed have none).</p>
        ) : (
          <ol className="flex min-w-0 flex-col" data-incident-timeline={d.timeline.source}>
            {d.timeline.events.map((e, i) => {
              const t = timelineText(e);
              return (
                <li key={e.id ?? `${e.at}:${i}`} className="flex min-w-0 gap-3 border-l border-[var(--border-hairline)] py-1.5 pl-3" data-event-type={e.type}>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-[var(--text-primary)]">{t.title}</span>
                    <span className="block break-words text-[10px] text-[var(--text-muted)]">{[whenText(e.at), ...t.parts].join(" · ")}</span>
                  </span>
                  {e.refreshExecutionId && onExecution ? (
                    <button type="button" className={`${FIELD} shrink-0`} onClick={() => onExecution(e.refreshExecutionId!)} aria-haspopup="dialog">Execution</button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
        {d.timeline.truncated && <p className="text-[10px] text-[var(--text-faint)]">{d.timeline.source === "archive" ? "The archive copy keeps the newest events within its size cap; older ones were dropped on archive." : "Showing the newest events only (read cap)."}</p>}
      </Section>

      <Section title="Evidence">
        {d.evidence ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3" data-incident-evidence>
            <dt className="text-[var(--text-muted)]">Rule</dt><dd className="font-mono text-[11px] text-[var(--text-secondary)] sm:col-span-2 break-all">{d.evidence.rule}</dd>
            <dt className="text-[var(--text-muted)]">Success proofs</dt><dd className="tabular-nums sm:col-span-2">{d.evidence.proofCount}</dd>
            <dt className="text-[var(--text-muted)]">Non-proof facts</dt><dd className="tabular-nums sm:col-span-2">{d.evidence.nonProofCount}</dd>
            <dt className="text-[var(--text-muted)]">May advance</dt><dd className="sm:col-span-2">{d.evidence.mayAdvance ? "Yes" : "No"}</dd>
            {d.evidence.lastProofAt && <><dt className="text-[var(--text-muted)]">Last proof</dt><dd className="sm:col-span-2">{whenText(d.evidence.lastProofAt)}</dd></>}
            {d.evidence.removedSubjectState && <><dt className="text-[var(--text-muted)]">Removed subject</dt><dd className="sm:col-span-2">{d.evidence.removedSubjectState}</dd></>}
            <dt className="text-[var(--text-muted)]">Subjects recorded</dt><dd className="tabular-nums sm:col-span-2">{d.evidence.subjectCount}{d.evidence.subjectsTruncated ? "+" : ""}</dd>
          </dl>
        ) : (
          <p className="text-[11px] text-[var(--text-muted)]">{`No resolution evidence recorded. Attempt evidence: last attempt ${whenText(r.recovery.lastAttemptAt)}, last skip ${whenText(r.recovery.lastSkipAt)}${r.recovery.evidenceKnown ? "" : " (unreadable)"}.`}</p>
        )}
      </Section>

      <Section title="Affected">
        <p className="break-words text-xs text-[var(--text-secondary)]" data-incident-affected>{affectedLine(d.affected)}</p>
        {"subjectUserId" in r && <p className="break-all font-mono text-[11px] text-[var(--text-muted)]">{r.subjectUserId ? `Customer ${r.subjectUserId}` : "No attributed customer"}</p>}
      </Section>

      <Section title="Related and recurring">
        {d.related.length === 0 && d.recurrences.length === 0 ? (
          <p className="text-[11px] text-[var(--text-muted)]">No related or earlier incidents recorded.</p>
        ) : (
          <ul className="flex min-w-0 flex-col" data-incident-related>
            {d.related.map((l) => <LinkedRow key={`${l.kind}:${l.id}`} id={l.id} r={l.incident} prefix={LINK_WORD[l.kind]} onSelect={onSelect} />)}
            {d.recurrences.filter((x) => !d.related.some((l) => l.id === x.id)).map((x) => <LinkedRow key={`rec:${x.id}`} id={x.id} r={x} prefix={`Episode ${x.generation}`} onSelect={onSelect} />)}
          </ul>
        )}
        {d.recurrencesTruncated && <p className="text-[10px] text-[var(--text-faint)]">More episodes exist than are listed (a capped read).</p>}
      </Section>

      <Section title="Archive">
        <p className="text-xs text-[var(--text-secondary)]">{archiveLine(d.archive)}</p>
      </Section>

      {d.recovery.length > 0 && (
        <Section title="Recovery">
          {canWrite ? (
            <div className="flex flex-wrap gap-2" data-incident-recovery>
              {d.recovery.map((a) => (
                <button key={a.kind} type="button" className={`${FIELD} px-3 text-[var(--text-primary)]`} onClick={() => onRecover(a)} aria-haspopup="dialog">{RECOVERY_LABEL[a.kind]}</button>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-[var(--text-muted)]">{`${d.recovery.map((a) => RECOVERY_LABEL[a.kind]).join(" · ")} — requires write access.`}</p>
          )}
        </Section>
      )}
      <p className="break-all font-mono text-[10px] text-[var(--text-faint)]">{`${r.kind} · ${r.id}`}{r.causeCode ? ` · ${codeText(r.causeCode)}` : ""}</p>
    </div>
  );
}

/** The route each existing recovery action posts to (each guarded + audited server-side). */
export function recoveryPath(a: RecoveryActionDTO): string {
  switch (a.kind) {
    case "resync": return `/api/platform/platform-ops/connections/${encodeURIComponent(a.connectionId)}/resync`;
    case "request-reauth": return `/api/platform/platform-ops/connections/${encodeURIComponent(a.connectionId)}/request-reauth`;
    case "refresh-customer": return `/api/platform/customer-success/customers/${encodeURIComponent(a.userId)}/refresh`;
  }
}

const CONFIRM: Readonly<Record<RecoveryActionDTO["kind"], { title: string; message: string; icon: typeof RefreshCw }>> = {
  resync: { title: "Resync this connection now?", message: "Re-runs this connection's sync through the existing per-item path (respects the in-flight lock and manual cooldown). Audited as an operator action.", icon: RefreshCw },
  "request-reauth": { title: "Ask the customer to reauthorize this connection?", message: "Marks the connection as needing reauthorization and prompts the customer to reconnect. It does NOT remove the connection or any data. Audited as an operator action.", icon: KeyRound },
  "refresh-customer": { title: "Refresh all of this customer's connections?", message: "Runs the customer's Refresh all through the one orchestrator with operator authority. Nothing is reported as refreshed that was skipped or refused. Audited as an operator action.", icon: RotateCcw },
};

function IncidentDetail({ tier, id, canWrite, onSelect }: { tier: IncidentTier; id: string; canWrite: boolean; onSelect: (id: string) => void }) {
  const [generation, setGeneration] = useState(0);
  const { data, error, fresh } = useKeyedJson<IncidentDetailDTO>(incidentDetailApiPath(tier, id), generation);
  const [execution, setExecution] = useState<string | null>(null);
  const [pending, setPending] = useState<RecoveryActionDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function run() {
    if (!pending) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await fetch(recoveryPath(pending), { method: "POST", credentials: "same-origin" });
      const body = await r.json().catch(() => ({} as Record<string, unknown>));
      if (!r.ok) {
        if (r.status === 429 && typeof body.retryAfterSeconds === "number") throw new Error(`On cooldown — try again in ~${Math.ceil(body.retryAfterSeconds / 60)} min.`);
        if (r.status === 403) throw new Error("Not authorized (write access with a fresh sign-in is required).");
        throw new Error(typeof body.error === "string" ? body.error : `${RECOVERY_LABEL[pending.kind]} failed (${r.status})`);
      }
      setNotice(`${RECOVERY_LABEL[pending.kind]}: done. The incident updates when the lifecycle records the outcome.`);
      setGeneration((g) => g + 1);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  if (fresh && error) return <ChartMessage>{`Incident unavailable — ${error}`}</ChartMessage>;
  if (!data || data.incident.id !== id) return <ChartMessage>Reading incident…</ChartMessage>;
  const c = pending ? CONFIRM[pending.kind] : null;
  return (
    <>
      {notice && <p role="status" className="mb-3 text-xs text-[var(--text-secondary)]">{notice}</p>}
      <IncidentDetailSurface d={data} canWrite={canWrite} onSelect={onSelect} onExecution={tier === "ops" ? setExecution : undefined} onRecover={setPending} />
      {pending && c && (
        <ConfirmDialog icon={c.icon} title={c.title} message={c.message} confirmLabel={RECOVERY_LABEL[pending.kind]} confirmTone="meridian" busy={busy} onConfirm={run} onClose={() => setPending(null)} />
      )}
      <ExecutionTimelinePanel executionId={execution} eyebrow="Incident evidence" title="Refresh execution" onClose={() => setExecution(null)} />
    </>
  );
}

// ── The workspace ───────────────────────────────────────────────────────────

function IncidentsWorkspace({ tier, viewId, access }: { tier: IncidentTier } & PlatformViewLeadProps) {
  const spaceUrl = useSpaceUrl();
  const status = statusOfView(viewId);
  // First paint is the view's bare preset (SSR-safe); the URL is read after mount and on Back/Forward.
  const [state, setState] = useState<IncidentsUrlState>(() => ({ query: { ...DEFAULT_SEARCH, status }, selectedId: null, fromClamped: false }));
  const [nowMs] = useState(() => Date.now());
  useEffect(() => {
    const sync = () => setState(readIncidentsUrl(spaceUrl.getSearch(), viewId, Date.now()));
    sync();
    return spaceUrl.subscribe(sync);
  }, [spaceUrl, viewId]);
  /** THE one setter: state + the URL mirror (REPLACE — a refinement of this entry, never a history step). */
  const apply = useCallback((next: IncidentsUrlState) => {
    setState(next);
    spaceUrl.commit(incidentsUrlUpdate(next), { history: "replace" });
  }, [spaceUrl]);

  const list = useKeyedJson<IncidentListDTO>(incidentsApiPath(tier, state.query));
  const select = (id: string | null) => apply({ ...state, selectedId: id });
  const title = list.data?.items.find((r) => r.id === state.selectedId);

  return (
    <div className="flex min-w-0 flex-col gap-4" data-incidents-workspace={tier}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">{STATUS_TITLE[status]}</h2>
        {list.data && <span className="text-sm tabular-nums text-[var(--text-secondary)]" data-incidents-total>{incidentTotalText(list.data)}</span>}
        <span className="text-[11px] text-[var(--text-faint)]">{tier === "ops" ? "Identity-free · through the incident intelligence module" : "Customer Success tier · the attributed customer is shown"}</span>
      </div>
      <Surface className="flex min-w-0 flex-col gap-4 p-4 sm:p-5">
        <IncidentFilters query={state.query} facets={list.data?.facets ?? null} nowMs={nowMs} onQuery={(q) => apply({ ...state, query: q })} />
        {list.fresh && list.error ? <ChartMessage>{`Incidents unavailable — ${list.error}`}</ChartMessage>
          : !list.data ? <ChartMessage>Reading incidents…</ChartMessage>
          : <IncidentListSurface data={list.data} onSelect={(id) => select(id)} onPage={(page) => apply({ ...state, query: { ...state.query, page } })} />}
      </Surface>
      <DetailDrawer open={state.selectedId !== null} onClose={() => select(null)} eyebrow={tier === "ops" ? "Platform Ops · Incident" : "Customer Success · Incident"}
        title={title ? incidentTitle(title) : "Incident"} size="xl">
        {state.selectedId ? <IncidentDetail tier={tier} id={state.selectedId} canWrite={access?.canWrite === true} onSelect={(id) => select(id)} /> : null}
      </DetailDrawer>
    </div>
  );
}

export function OpsIncidentsLead(props: PlatformViewLeadProps) {
  return <IncidentsWorkspace tier="ops" {...props} />;
}

export function CsIncidentsLead(props: PlatformViewLeadProps) {
  return <IncidentsWorkspace tier="cs" {...props} />;
}
