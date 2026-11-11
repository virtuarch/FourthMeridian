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
 * INCIDENT DETAIL v1 — the drawer leads with a SUMMARY (derived status pill,
 * impact line, timestamps, ongoing vs historical), then the primary guidance /
 * action (customer reconnect is guidance text, never a Resync), then DIAGNOSIS
 * (plain English, confirmed facts vs a labelled probable cause, the verified
 * code, attempts + recurrence summaries), then LIFECYCLE (a milestone strip
 * from lifecycle-model.ts: detected, acknowledged, recovering, needs
 * verification, closed — a verified recovery is never confused with an
 * operator dismissal — archived, the recurrence neighbours); attempts,
 * timeline (key events first), recurrence history and technical details sit
 * behind disclosures.
 *
 * Every row opens the detail drawer: verdict + why, the append-only timeline
 * (rendered in stored order, never rewritten), the evidence digest, affected
 * subjects, related / recurring incidents, archive state — and ONLY the
 * EXISTING recovery routes (resync / request-reauth for Ops; the customer's
 * Refresh all for CS), each behind a confirmation, rendered only when the
 * operator's descriptive access says WRITE. PB-1 S6 — on the OPS tier only,
 * the lifecycle actions the module offers (Acknowledge / Resolve) open a
 * confirmation with a reason and a note; Customer Success never gets them. The server guard decides; each
 * route audits through recordOperatorAction. Presentation only: nothing here
 * derives a verdict.
 *
 * INCIDENT DRAWER PR-A (owner 11-08, S2 09gg a) — the Summary carries a "Job"
 * stamp when the newest occurrence names a job (the run id, Ops only, sits in
 * Technical details); "Go to" gains the unfiltered "Jobs (all)" link from the
 * resolver. On the CS tier ONLY, the customer line shows the opaque PRIV-ref
 * (never the raw id) and an "Open customer profile" BUTTON opens the audited
 * profile panel in-page (cs-open-customer.ts → the hosted cs_customers panel,
 * whose every open re-reads customers/[userId]); no user id in any URL.
 *
 * INCIDENT DRAWER PR-B (S2 09gg b) — the FIRST recovery action is PRIMARY
 * (recoveryActionsFor ranks by remedy class: customer-reconnect ⇒ request-
 * reauth, server-retry ⇒ resync, job ⇒ run-job); the rest are secondary. "Run
 * job" posts the SERVER-provided command to the existing Manual operations
 * route with `?incidentId=`; its confirmation states the scope ("for all
 * customers") and, for a fleet command, collects the required reason. Every
 * action kind has a real route (pinned by incident-drawer-run-job.test.ts).
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, KeyRound, Play, RefreshCw, RotateCcw, UserCheck } from "lucide-react";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { Surface } from "@/components/atlas/Surface";
import { useSpaceUrl } from "@/components/space/shell/useSpaceUrl";
import { DetailDrawer } from "../ui";
import { RememberButton } from "../RememberButton";
import { ChartMessage } from "../leads/visual-kit";
import { TONE_COLOR } from "../platform-surface";
import { ExecutionTimelinePanel } from "../widgets/ExecutionTimelinePanel";
import type { PlatformViewLeadProps } from "../leads/lead-contract";
import { DEFAULT_SEARCH, SEVERITY_FILTERS, retentionFloorDay } from "@/lib/platform/incidents/intelligence/search-core";
import type { IncidentSearchQuery } from "@/lib/platform/incidents/intelligence/types";
import type {
  IncidentComponentDTO, IncidentDetailDTO, IncidentListDTO, IncidentRowDTO, IncidentTier, LifecycleActionDTO, RecoveryActionDTO,
} from "@/lib/platform/incidents/investigation-dto";
import { OPAQUE_USER_REF_FALLBACK } from "@/lib/platform/opaque-user-ref-format";
import { requestOpenCustomer } from "../leads/cs-open-customer";
import type { IncidentNavigationLinkDTO } from "@/lib/platform/incidents/related-navigation";
import {
  incidentDetailApiPath, incidentsApiPath, incidentsUrlUpdate, readIncidentsUrl, statusOfView, type IncidentsUrlState,
} from "./incidents-url";
import { explainProviderError } from "@/lib/platform/incidents/explanations";
import {
  FRESHNESS_WORD, LINK_WORD, RECOVERY_LABEL, SEVERITY_WORD, STATE_TONE, STATE_WORD, STATUS_TITLE,
  DISPLAY_STATUS_TONE, DISPLAY_STATUS_WORD, attemptText, attemptsLine, impactLine, ongoingWord, primaryGuidance, recurrenceLine,
  affectedLine, archiveLine, closureText, codeText, incidentLine, incidentTotalText, incidentTitle, pageCount, populationLine, timelineText, whenText, whyLines,
  AUDIT_REASON_OPTIONS, EMPTY_LIFECYCLE_FORM, LIFECYCLE_CONFIRM, LIFECYCLE_LABEL, OPERATOR_NOTE_MAX, RESOLUTION_REASON_OPTIONS,
  lifecycleBody, lifecycleFormValid, lifecyclePath, type LifecycleForm,
} from "./incidents-model";
import { incidentDiagnosisView } from "./diagnosis-model";
import { incidentLifecycleView, type EpisodeLink } from "./lifecycle-model";
import { OperatorReasonField, EMPTY_OPERATOR_REASON, reasonPayload, type OperatorReasonValue } from "../widgets/OperatorReasonField";
import { IncidentCustomerUpdate } from "./CustomerUpdateSection";

const PRIMARY_BTN = "min-h-11 min-w-0 rounded-[var(--radius-sm)] border border-[var(--meridian-400)] bg-[var(--meridian-400)] px-3 text-xs font-medium text-white lg:min-h-8";
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
                  {/* PRIV-ref — the opaque reference, never the raw customer id. */}
                  {"subjectUserId" in r && r.subjectUserId ? <span className="block truncate font-mono text-[10px] text-[var(--text-faint)]" data-incident-row-customer-ref>{`Customer ${r.subjectRef ?? OPAQUE_USER_REF_FALLBACK}`}</span> : null}
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

/** One recurrence neighbour in the Lifecycle section: opens in the drawer, like the recurrence list. */
function EpisodeRow({ label, e, onSelect }: { label: string; e: EpisodeLink; onSelect: (id: string) => void }) {
  const title = `${label}${e.generation ? ` · episode ${e.generation}` : ""}`;
  if (!e.retained) return <li className="py-1.5 text-[11px] text-[var(--text-muted)]" data-lifecycle-episode={e.id}>{`${title} · ${e.outcome}`}</li>;
  return (
    <li className="min-w-0">
      <button type="button" onClick={() => onSelect(e.id)} className={`${ROW_BTN} py-1.5`} data-lifecycle-episode={e.id}>
        <span className="min-w-0 flex-1">
          <span className="block break-words text-xs text-[var(--text-primary)]">{title}</span>
          <span className="block break-words text-[10px] text-[var(--text-muted)]">{e.outcome}</span>
        </span>
        <ChevronRight size={12} aria-hidden className="mt-1 shrink-0 text-[var(--text-faint)]" />
      </button>
    </li>
  );
}

/** A resolver href only: a same-origin relative path (the route already validated it; this refuses anything else). */
const isRelativePath = (href: string) => href.startsWith("/") && !href.startsWith("//") && !href.includes("\\");

/**
 * The "Go to" links (titled apart from "Related and recurring", which lists
 * linked incidents). Every href is the route's resolveNavigationTarget
 * output, rendered VERBATIM — this component builds none (pinned by a source
 * scan). A link the route did not resolve is not in the list: nothing renders
 * in its place.
 *
 * IN PLACE ONLY WHEN THE URL WOULD BE THE HREF: a plain click on an incident
 * link whose view IS the current view opens it in place (`onOpenInPlace`: that
 * view, filters cleared, iid — exactly the href's URL, REPLACE idiom). A link
 * to another view (e.g. the previous episode → History), a modified click, or
 * no `onOpenInPlace` follows the href itself, so the URL always matches it.
 */
export const NAVIGATION_SECTION_TITLE = "Go to";

/** True when a click on `l` opens in place: an incident link on the CURRENT view, a plain primary click. Otherwise the href is followed. */
export function opensInPlace(
  l: Pick<IncidentNavigationLinkDTO, "incidentId" | "viewId">,
  viewId: string | null | undefined,
  e: { defaultPrevented: boolean; button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
): boolean {
  if (!l.incidentId || !l.viewId || !viewId || l.viewId !== viewId) return false;
  return !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export function IncidentRelatedNavigation({ links, viewId, onOpenInPlace }: {
  links: readonly IncidentNavigationLinkDTO[];
  /** The drawer's current incidents view. */
  viewId?: string | null;
  onOpenInPlace?: (id: string) => void;
}) {
  const shown = links.filter((l) => isRelativePath(l.href));
  if (shown.length === 0) return null;
  return (
    <Section title={NAVIGATION_SECTION_TITLE}>
      <ul className="flex min-w-0 flex-col" data-incident-navigation>
        {shown.map((l) => (
          <li key={`${l.kind}:${l.href}`} className="min-w-0">
            <a
              href={l.href}
              data-navigation-kind={l.kind}
              className={`${ROW_BTN} py-1.5`}
              onClick={(e) => {
                if (!onOpenInPlace || !l.incidentId || !opensInPlace(l, viewId, e)) return;
                e.preventDefault();
                onOpenInPlace(l.incidentId);
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block break-words text-xs text-[var(--text-primary)]">{l.label}</span>
                {l.note && <span className="block break-words text-[10px] text-[var(--text-muted)]">{l.note}</span>}
              </span>
              <ChevronRight size={12} aria-hidden className="mt-1 shrink-0 text-[var(--text-faint)]" />
            </a>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * EXTENSION POINTS (Incident detail v1). Later PRs fill these — AI assessment
 * (section 3), customer communication (section 5), lifecycle actions (section
 * 6). Each renders in its fixed place ONLY when passed. `customerMessage` is
 * passed on the CS tier only (customerMessageSlot, PR-C2); the others are not
 * passed yet, so nothing renders. The existing Acknowledge / Resolve controls stay
 * until `lifecycle` replaces them.
 */
export interface IncidentDetailSlots {
  aiAssessment?: ReactNode;
  customerMessage?: ReactNode;
  lifecycle?: ReactNode;
  /** Platform AI memory (design v2 §5): the "Remember" control; renders nothing unless memory is effective. */
  remember?: ReactNode;
}

/** Progressive disclosure: closed by default; the content is in the DOM (and in tests). */
function Disclosure({ title, hint, children, attr }: { title: string; hint?: string; children: ReactNode; attr: string }) {
  return (
    <details className="group min-w-0 border-t border-[var(--border-hairline)] pt-3" data-disclosure={attr}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-xs text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-8 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={12} aria-hidden className="shrink-0 text-[var(--text-faint)] transition-transform group-open:rotate-90" />
        <span className={H}>{title}</span>
        {hint && <span className="min-w-0 truncate text-[11px] text-[var(--text-muted)]">{hint}</span>}
      </summary>
      <div className="flex min-w-0 flex-col gap-2 pb-1 pt-2">{children}</div>
    </details>
  );
}

/** Technical details: the job / component in words (the run id rides the Ops tier only — the DTO decides). */
export function componentLine(c: IncidentComponentDTO): string {
  return [`Job: ${c.jobLabel}`, c.operationLabel ?? null, c.domain ? `domain ${c.domain}` : null, c.jobRunId ? `run ${c.jobRunId}` : null]
    .filter((x): x is string => !!x).join(" · ");
}

function Stamp({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] text-[var(--text-faint)]">{label}</dt>
      <dd className="truncate text-xs tabular-nums text-[var(--text-secondary)]">{value}</dd>
    </div>
  );
}

export function IncidentDetailSurface({ d, canWrite, onSelect, onExecution, onRecover, onLifecycle, viewId, onOpenInPlace, onOpenCustomer, slots }: {
  d: IncidentDetailDTO;
  /**
   * Incident drawer PR-A — CS tier ONLY: open the attributed customer's audited
   * profile in-page (cs-open-customer.ts). Ignored on the Ops tier (never rendered there).
   */
  onOpenCustomer?: (userId: string) => void;
  canWrite: boolean;
  onSelect: (id: string) => void;
  /** The current incidents view, and the in-place opener for a "Go to" link on it (IncidentRelatedNavigation). */
  viewId?: string | null;
  onOpenInPlace?: (id: string) => void;
  onExecution?: (id: string) => void;
  onRecover: (a: RecoveryActionDTO) => void;
  /** PB-1 S6 — opens the acknowledge / resolve confirmation (Ops tier only; the server decides). */
  onLifecycle?: (a: LifecycleActionDTO) => void;
  slots?: IncidentDetailSlots;
}) {
  const r = d.incident;
  const s = d.summary;
  const dx = d.diagnosis;
  const ex = explainProviderError(dx.providerErrorCode);
  const guidance = primaryGuidance(d, ex.customerAction);
  const closure = closureText(r);
  const lifecycle = d.lifecycleActions ?? [];
  const dv = incidentDiagnosisView(d);
  const lv = incidentLifecycleView(d);
  const tone = DISPLAY_STATUS_TONE[s.displayStatus];
  // An ACTIVE connection whose code once asked the customer to act: say so, never re-ask.
  const healedNote = dx.providerErrorCode && ex.customerActionRequired && !s.customerActionRequired && s.displayStatus !== "resolved"
    ? "The connection is healthy again; the next completed sync confirms recovery."
    : null;

  const recoveryControls = d.recovery.length > 0 && (
    canWrite ? (
      <div className="flex flex-wrap gap-2" data-incident-recovery>
        {/* PR-B — the first action is primary (ranked server-side by remedy class); the rest are secondary. */}
        {d.recovery.map((a, i) => (
          <button key={a.kind} type="button" className={i === 0 ? PRIMARY_BTN : `${FIELD} px-3 text-[var(--text-primary)]`} onClick={() => onRecover(a)} aria-haspopup="dialog"
            data-recovery-action={a.kind} data-recovery-rank={i === 0 ? "primary" : "secondary"}>{recoveryButtonLabel(a)}</button>
        ))}
      </div>
    ) : (
      <p className="text-[11px] text-[var(--text-muted)]">{`${d.recovery.map((a) => RECOVERY_LABEL[a.kind]).join(" · ")} — requires write access.`}</p>
    )
  );

  return (
    <div className="flex min-w-0 flex-col gap-5" data-incident-detail={r.id} data-display-status={s.displayStatus}>
      {/* 1 · SUMMARY — what happened, what it affects, since when. */}
      <section className="flex min-w-0 flex-col gap-3" data-incident-summary>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
          <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-medium" style={{ color: TONE_COLOR[tone], borderColor: TONE_COLOR[tone] }} data-status-pill>
            <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: TONE_COLOR[tone] }} />
            {DISPLAY_STATUS_WORD[s.displayStatus]}
          </span>
          <span className="text-[var(--text-secondary)]">{SEVERITY_WORD[r.severity]}{r.effectiveSeverity !== r.severity ? ` (ranked ${SEVERITY_WORD[r.effectiveSeverity].toLowerCase()})` : ""}</span>
          <span className="text-[var(--text-muted)]" data-incident-ongoing={s.ongoing ? "ongoing" : "historical"}>{ongoingWord(s, r.state)}</span>
          {closure && <span className="text-[var(--text-muted)]">{closure}</span>}
        </div>
        <p className="break-words text-sm text-[var(--text-primary)]" data-incident-impact>{impactLine(d)}</p>
        <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
          <Stamp label="First detected" value={whenText(s.firstDetectedAt)} />
          <Stamp label="Last observed" value={whenText(s.lastObservedAt)} />
          <Stamp label="Resolved" value={s.resolvedAt ? whenText(s.resolvedAt) : "Not yet"} />
          <Stamp label="Occurrences" value={`${r.occurrenceCount.toLocaleString("en-US")}`} />
          {d.component && <div className="min-w-0" data-incident-component><Stamp label="Job" value={d.component.jobLabel} /></div>}
        </dl>
        <p className="break-words text-[11px] text-[var(--text-muted)]" data-incident-affected>{affectedLine(d.affected)}</p>
        {d.tier === "cs" && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5" data-incident-customer>
            {/* PRIV-ref — the opaque customer reference, never the raw id (as elsewhere in Customer Success). */}
            <p className="min-w-0 break-words font-mono text-[11px] text-[var(--text-muted)]" data-incident-customer-ref>
              {r.subjectUserId ? `Customer ${d.subjectRef ?? OPAQUE_USER_REF_FALLBACK}` : "No attributed customer"}
            </p>
            {/* CS ONLY — an in-page button (never a link): opens the audited profile panel; no id in any URL. */}
            {r.subjectUserId && onOpenCustomer && (
              <button type="button" className={`${FIELD} px-3 text-[var(--text-primary)]`} onClick={() => onOpenCustomer(r.subjectUserId!)} aria-haspopup="dialog" data-open-customer-profile>
                Open customer profile
              </button>
            )}
          </div>
        )}
      </section>

      {/* Primary action / guidance — guidance TEXT for what only the customer can do; real, audited actions only. */}
      {(guidance || recoveryControls) && (
        <section className="flex min-w-0 flex-col gap-2 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-3" data-incident-guidance={s.remedy ?? "none"}>
          {guidance && (
            <>
              <p className="text-sm font-medium text-[var(--text-primary)]">{guidance.headline}</p>
              <p className="break-words text-xs text-[var(--text-secondary)]">{guidance.body}</p>
              {guidance.caveat && <p className="text-[11px] text-[var(--text-muted)]" data-guidance-caveat>{guidance.caveat}</p>}
            </>
          )}
          {healedNote && <p className="text-[11px] text-[var(--text-muted)]">{healedNote}</p>}
          {recoveryControls}
        </section>
      )}

      {slots?.lifecycle ?? (lifecycle.length > 0 && onLifecycle && (
        <Section title="Operator actions">
          {canWrite ? (
            <div className="flex flex-wrap gap-2" data-incident-lifecycle>
              {lifecycle.map((a) => (
                <button key={a} type="button" className={`${FIELD} px-3 text-[var(--text-primary)]`} onClick={() => onLifecycle(a)} aria-haspopup="dialog" data-lifecycle-action={a}>{`${LIFECYCLE_LABEL[a]}…`}</button>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-[var(--text-muted)]">{`${lifecycle.map((a) => LIFECYCLE_LABEL[a]).join(" · ")} — requires write access.`}</p>
          )}
        </Section>
      ))}

      {slots?.customerMessage}

      {slots?.remember ? <div className="min-w-0" data-incident-remember="">{slots.remember}</div> : null}

      {/* 2 · DIAGNOSIS — essentials first (diagnosis-model.ts): plain English, the verified code, confirmed vs likely, attempts, prior episodes. */}
      <Section title="Diagnosis">
        <div className="flex min-w-0 flex-col gap-2 text-xs" data-incident-diagnosis={dv.verified ? "verified" : "unverified"}>
          <p className="break-words text-[var(--text-primary)]" data-diagnosis-plain>{dv.plainEnglish}</p>
          {dv.codeLine && <p className="break-words text-[11px] text-[var(--text-muted)]" data-provider-code>Error code: <span className="font-mono text-[var(--text-secondary)]">{dv.codeLine}</span></p>}
          {dv.unrecognisedNote && <p className="break-words text-[11px] text-[var(--text-muted)]" data-provider-code-unrecognised>{dv.unrecognisedNote}</p>}
          {dv.customerStep && <p className="break-words font-medium text-[var(--text-primary)]" data-diagnosis-customer-step={dv.customerStep.kind}>{dv.customerStep.text}</p>}
          {dv.causes.map((c) => (
            <p key={`${c.source}:${c.status}`} className="break-words text-[var(--text-secondary)]" data-cause-status={c.status} data-cause-source={c.source}>
              <span className="text-[11px]" style={{ color: c.status === "confirmed" ? TONE_COLOR.ok : "var(--text-faint)" }}>{`${c.label}: `}</span>{c.text}
            </p>
          ))}
          {dv.unregisteredCause && <p className="text-[11px] text-[var(--text-muted)]">{"A cause was recorded with a code this view doesn't recognise (not shown)."}</p>}
          {dv.operatorNext && <p className="break-words text-[var(--text-secondary)]" data-operator-next><span className="text-[11px] text-[var(--text-faint)]">Next step: </span>{dv.operatorNext}</p>}
          <p className="break-words text-[11px] text-[var(--text-muted)]" data-incident-attempts-summary>{dv.attempts.line}</p>
          {dv.attempts.stamps.length > 0 && (
            <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4" data-diagnosis-attempt-times>
              {dv.attempts.stamps.map((st) => <Stamp key={st.label} label={st.label} value={st.value} />)}
            </dl>
          )}
          <p className="break-words text-[11px] text-[var(--text-muted)]" data-incident-recurrence>{dv.prior.line}</p>
        </div>
        <Disclosure title="Diagnosis details" hint={dv.prior.episodes.length ? "confirmed facts · prior episodes" : "confirmed facts"} attr="diagnosis">
          {dv.confirmedFacts.length > 0 ? (
            <div className="min-w-0 text-xs" data-confirmed-facts>
              <p className="text-[11px] text-[var(--text-faint)]">Confirmed by the error code</p>
              <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[var(--text-secondary)]">{dv.confirmedFacts.map((f) => <li key={f}>{f}</li>)}</ul>
            </div>
          ) : (
            <p className="text-[11px] text-[var(--text-muted)]">No error code was recorded, so nothing is confirmed beyond what the timeline shows.</p>
          )}
          {dv.prior.episodes.length > 0 && (
            <div className="min-w-0" data-diagnosis-prior>
              <p className="text-[11px] text-[var(--text-faint)]">Prior occurrences and how they ended</p>
              <ul className="flex min-w-0 flex-col">
                {dv.prior.episodes.map((e) => (
                  <li key={e.id} className="min-w-0">
                    <button type="button" onClick={() => onSelect(e.id)} className={`${ROW_BTN} py-1.5`} data-prior-episode={e.id}>
                      <span className="min-w-0 flex-1">
                        <span className="block break-words text-xs text-[var(--text-primary)]">{e.generation > 0 ? `Episode ${e.generation}` : "Earlier episode"}{e.firstSeenAt ? ` · first ${whenText(e.firstSeenAt)}` : ""}</span>
                        <span className="block break-words text-[10px] text-[var(--text-muted)]">{e.closedAt ? `${e.outcome} · closed ${whenText(e.closedAt)}` : e.outcome}</span>
                      </span>
                      <ChevronRight size={12} aria-hidden className="mt-1 shrink-0 text-[var(--text-faint)]" />
                    </button>
                  </li>
                ))}
              </ul>
              {dv.prior.truncated && <p className="text-[10px] text-[var(--text-faint)]">More earlier episodes exist than are listed.</p>}
            </div>
          )}
        </Disclosure>
      </Section>

      {/* 3 · LIFECYCLE — milestones first (lifecycle-model.ts); the full event list stays under Timeline. Dismiss ≠ resolved. */}
      <Section title="Lifecycle">
        <ol className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4" data-lifecycle-strip>
          {lv.milestones.map((m) => (
            <li key={m.key} className="flex min-w-0 gap-2" data-milestone={m.key}>
              <Dot tone={m.tone} />
              <span className="min-w-0">
                <span className="block text-[10px] text-[var(--text-faint)]">{m.label}</span>
                <span className="block truncate text-xs tabular-nums text-[var(--text-secondary)]">{m.when}</span>
                {m.note && <span className="block break-words text-[10px] text-[var(--text-muted)]">{m.note}</span>}
              </span>
            </li>
          ))}
        </ol>
        {lv.closure && (
          <div className="min-w-0 text-xs" data-lifecycle-closure={lv.closure.outcome} data-verified-recovery={lv.closure.verifiedRecovery ? "yes" : "no"}>
            <p className="break-words font-medium text-[var(--text-primary)]">{lv.closure.headline}</p>
            {lv.closure.reason && <p className="break-words text-[11px] text-[var(--text-muted)]">{`Reason: ${lv.closure.reason}.`}</p>}
            {lv.closure.unregisteredReason && <p className="text-[11px] text-[var(--text-muted)]">{"A reason was recorded with a code this view doesn't recognise (not shown)."}</p>}
            {lv.closure.evidence && <p className="break-words text-[11px] text-[var(--text-muted)]">{`Evidence: ${lv.closure.evidence}.`}</p>}
            {lv.closure.derived && <p className="text-[11px] text-[var(--text-faint)]">Derived at read time; not yet recorded on the incident.</p>}
          </div>
        )}
        <div className="min-w-0 text-xs" data-lifecycle-recurrence={lv.recurrence.generation}>
          <p className="break-words text-[11px] text-[var(--text-muted)]">{lv.recurrence.line}</p>
          {(lv.recurrence.previous || lv.recurrence.next) && (
            <ul className="flex min-w-0 flex-col">
              {lv.recurrence.previous && <EpisodeRow label="Previous episode" e={lv.recurrence.previous} onSelect={onSelect} />}
              {lv.recurrence.next && <EpisodeRow label="Next episode" e={lv.recurrence.next} onSelect={onSelect} />}
            </ul>
          )}
        </div>
        <p className="break-words text-[11px] text-[var(--text-muted)]" data-lifecycle-events={lv.events.total}>
          {lv.events.total > 0 ? `${lv.events.line} — key events and the full list are under Timeline.` : lv.events.line}
        </p>
      </Section>

      {slots?.aiAssessment}

      <IncidentRelatedNavigation links={d.navigation ?? []} viewId={viewId} onOpenInPlace={onOpenInPlace} />

      {/* Progressive disclosure — the technical record. */}
      <div className="flex min-w-0 flex-col">
        <Disclosure title="Recent attempts" hint={dx.attempts?.readable && dx.attempts.recent.length ? `${dx.attempts.recent.length} shown` : undefined} attr="attempts">
          {!dx.attempts || !dx.attempts.readable || dx.attempts.recent.length === 0 ? (
            <p className="text-[11px] text-[var(--text-muted)]">{attemptsLine(dx.attempts)}</p>
          ) : (
            <ol className="flex min-w-0 flex-col" data-incident-attempts>
              {dx.attempts.recent.map((a, i) => {
                const t = attemptText(a);
                return (
                  <li key={`${a.at}:${i}`} className="flex min-w-0 flex-col border-l border-[var(--border-hairline)] py-1.5 pl-3" data-attempt-status={a.status}>
                    <span className="text-xs text-[var(--text-primary)]">{t.title}</span>
                    <span className="break-words text-[10px] text-[var(--text-muted)]">{t.parts.join(" · ")}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </Disclosure>

        <Disclosure title="Timeline" hint={d.timeline.events.length ? `${d.timeline.events.length} event${d.timeline.events.length === 1 ? "" : "s"}` : undefined} attr="timeline">
          {lv.events.key.length > 0 && (
            <div className="min-w-0" data-lifecycle-key-events>
              <p className="text-[11px] text-[var(--text-faint)]">{lv.events.keyTruncated ? "Key events (newest)" : "Key events"}</p>
              <ol className="flex min-w-0 flex-col">
                {lv.events.key.map((k, i) => (
                  <li key={`${k.at}:${i}`} className="flex min-w-0 flex-col border-l border-[var(--border-hairline)] py-1.5 pl-3">
                    <span className="text-xs text-[var(--text-primary)]">{k.title}</span>
                    <span className="break-words text-[10px] text-[var(--text-muted)]">{[k.when, ...k.parts].join(" · ")}</span>
                  </li>
                ))}
              </ol>
              <p className="text-[11px] text-[var(--text-faint)]">All events</p>
            </div>
          )}
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
        </Disclosure>

        <Disclosure title="Recurrence history" hint={d.related.length + d.recurrences.length ? recurrenceLine(dx.recurrence) : undefined} attr="recurrence">
          {d.related.length === 0 && d.recurrences.length === 0 ? (
            <p className="text-[11px] text-[var(--text-muted)]">No related or earlier incidents recorded.</p>
          ) : (
            <ul className="flex min-w-0 flex-col" data-incident-related>
              {d.related.map((l) => <LinkedRow key={`${l.kind}:${l.id}`} id={l.id} r={l.incident} prefix={LINK_WORD[l.kind]} onSelect={onSelect} />)}
              {d.recurrences.filter((x) => !d.related.some((l) => l.id === x.id)).map((x) => <LinkedRow key={`rec:${x.id}`} id={x.id} r={x} prefix={`Episode ${x.generation}`} onSelect={onSelect} />)}
            </ul>
          )}
          {d.recurrencesTruncated && <p className="text-[10px] text-[var(--text-faint)]">More episodes exist than are listed (a capped read).</p>}
        </Disclosure>

        <Disclosure title="Technical details" attr="technical">
          <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-[var(--text-secondary)]" data-incident-why>
            {whyLines(d).map((l) => <li key={l}>{l}</li>)}
          </ul>
          <p className="text-[11px] text-[var(--text-muted)]">{`State ${STATE_WORD[r.state]} · freshness ${FRESHNESS_WORD[r.freshness].toLowerCase()}`}</p>
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
            <p className="text-[11px] text-[var(--text-muted)]">{`No resolution evidence recorded. Attempt evidence: last attempt ${whenText(r.recovery.lastAttemptAt)}, last skip ${whenText(r.recovery.lastSkipAt)}${r.recovery.evidenceBasis === "unreadable" ? " (unreadable)" : r.recovery.evidenceBasis === "unsupported" ? " (not tracked for this provider yet)" : r.recovery.evidenceBasis === "not-needed" ? " (not needed: inside its window)" : ""}.`}</p>
          )}
          {d.component && <p className="break-words text-[11px] text-[var(--text-muted)]" data-incident-component-detail>{componentLine(d.component)}</p>}
          <p className="text-xs text-[var(--text-secondary)]">{archiveLine(d.archive)}</p>
          <p className="break-all font-mono text-[10px] text-[var(--text-faint)]">{`${r.kind} · ${r.id}`}{r.causeCode ? ` · ${codeText(r.causeCode)}` : ""}</p>
        </Disclosure>
      </div>
    </div>
  );
}

/**
 * The route each existing recovery action posts to (each guarded + audited
 * server-side). From an incident drawer the Ops routes also carry
 * `?incidentId=` so the audit row names the incident (context only).
 */
export function recoveryPath(a: RecoveryActionDTO, incidentId?: string): string {
  const ctx = incidentId ? `?incidentId=${encodeURIComponent(incidentId)}` : "";
  switch (a.kind) {
    case "resync": return `/api/platform/platform-ops/connections/${encodeURIComponent(a.connectionId)}/resync${ctx}`;
    case "request-reauth": return `/api/platform/platform-ops/connections/${encodeURIComponent(a.connectionId)}/request-reauth${ctx}`;
    case "refresh-customer": return `/api/platform/customer-success/customers/${encodeURIComponent(a.userId)}/refresh`;
    // PR-B — the existing Manual operations route; the command rides the body (recoveryBody), the incident the query.
    case "run-job": return `/api/platform/platform-ops/operations${ctx}`;
  }
}

/** The button word: "Run job" names the job (a word from the server's DTO). */
export function recoveryButtonLabel(a: RecoveryActionDTO): string {
  return a.kind === "run-job" ? `Run ${a.jobLabel}` : RECOVERY_LABEL[a.kind];
}

/**
 * PR-B — the POST body. run-job: the SERVER-provided command id (never a job
 * name), plus the structured reason a fleet command requires. Others: none.
 */
export function recoveryBody(a: RecoveryActionDTO, why: OperatorReasonValue | null): string | undefined {
  if (a.kind !== "run-job") return undefined;
  const reason = a.reasonRequired && why ? reasonPayload(why) : null;
  return JSON.stringify(reason ? { commandId: a.commandId, reason } : { commandId: a.commandId });
}

/** PR-B — the scope sentence every run-job confirmation leads with (pinned). */
export function runJobScope(jobLabel: string): string {
  return `Runs ${jobLabel} for all customers.`;
}

/** The confirmation for an action: static copy, except run-job, which names its job and scope. */
export function confirmFor(a: RecoveryActionDTO): { title: string; message: string; icon: typeof RefreshCw } {
  if (a.kind !== "run-job") return CONFIRM[a.kind];
  return {
    title: `Run ${a.jobLabel} now?`,
    message: `${runJobScope(a.jobLabel)} Fleet jobs can trigger provider calls and cost. It runs through the same Run Now path as the Jobs view (one run at a time, rate-limited${a.reasonRequired ? "; a fleet-wide run needs control access and a reason" : ""}). Audited as an operator action, recorded against this incident.`,
    icon: Play,
  };
}

/** What the operations route reported for a run-job, in words. */
export function runJobOutcomeText(status: number, body: Record<string, unknown>): string {
  if (status === 409) return "A run of this job is already in progress — nothing new was started.";
  if (body.outcome === "executed") return "Ran — recorded as a manual run. The incident updates when the lifecycle records the outcome.";
  if (body.outcome === "failed") return `The run failed${typeof body.error === "string" ? `: ${body.error}` : ""}.`;
  return "Run job: the server did not report an outcome.";
}

/** What a request-reauth actually did, in words (the route reports it; never a bare "done"). */
export function reauthOutcomeText(body: Record<string, unknown>): string {
  switch (body.outcome) {
    case "created": return "Reconnect request sent: the connection is marked as needing reauthorization and the customer was notified.";
    case "suppressed_duplicate": return "No new notice sent: the customer already has an open reconnect notice for this connection.";
    case "marked_not_notified": return "The connection is marked as needing reauthorization, but no notice was sent to the customer.";
    case "no_change": return "Nothing changed: the connection was already marked as needing reauthorization and no notice was sent.";
    default: return "Request reauthorization: the server did not report an outcome.";
  }
}

/** S2 R1 — the request-reauth confirmation says exactly what the customer receives (pinned by test). */
export const REQUEST_REAUTH_CONFIRM_MESSAGE = "Marks the connection as needing reauthorization and sends the customer an in-app notice and an email asking them to reconnect (unless one is already open). It does NOT remove the connection or any data. Audited as an operator action.";

export const CONFIRM: Readonly<Record<Exclude<RecoveryActionDTO["kind"], "run-job">, { title: string; message: string; icon: typeof RefreshCw }>> = {
  resync: { title: "Resync this connection now?", message: "Re-runs this connection's sync through the existing per-item path (respects the in-flight lock and manual cooldown). Audited as an operator action.", icon: RefreshCw },
  "request-reauth": { title: "Ask the customer to reauthorize this connection?", message: REQUEST_REAUTH_CONFIRM_MESSAGE, icon: KeyRound },
  "refresh-customer": { title: "Refresh all of this customer's connections?", message: "Runs the customer's Refresh all through the one orchestrator with operator authority. Nothing is reported as refreshed that was skipped or refused. Audited as an operator action.", icon: RotateCcw },
};

const LABEL = "flex min-w-0 flex-col gap-1 text-left text-[11px] text-[var(--text-muted)]";

/** The reason fields inside the lifecycle confirmation. Presentation only; the route validates. */
export function LifecycleFormFields({ action, form, onChange, disabled }: { action: LifecycleActionDTO; form: LifecycleForm; onChange: (f: LifecycleForm) => void; disabled?: boolean }) {
  const left = OPERATOR_NOTE_MAX - form.note.trim().length;
  return (
    <div className="mt-3 flex min-w-0 flex-col gap-3 text-left" data-lifecycle-form={action}>
      {action === "resolve" && (
        <label className={LABEL}>
          Resolution
          <select className={`${FIELD} w-full`} value={form.resolutionReason} disabled={disabled} onChange={(e) => onChange({ ...form, resolutionReason: e.target.value as LifecycleForm["resolutionReason"] })}>
            <option value="">Choose a resolution…</option>
            {RESOLUTION_REASON_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      )}
      <label className={LABEL}>
        Reason
        <select className={`${FIELD} w-full`} value={form.auditReason} disabled={disabled} onChange={(e) => onChange({ ...form, auditReason: e.target.value as LifecycleForm["auditReason"] })}>
          {AUDIT_REASON_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <label className={LABEL}>
        {action === "resolve" ? "Note (required)" : "Note (optional)"}
        <textarea className={`${FIELD} min-h-20 w-full resize-y py-1.5`} maxLength={OPERATOR_NOTE_MAX} value={form.note} disabled={disabled}
          onChange={(e) => onChange({ ...form, note: e.target.value })} placeholder="What was checked. No customer details, emails or account numbers." />
        <span className={`self-end tabular-nums ${left < 0 ? "text-[var(--status-bad,#c33)]" : "text-[var(--text-faint)]"}`}>{`${left} left`}</span>
      </label>
    </div>
  );
}

/**
 * Incident customer update PR-C2 (owner yes; S2 09gg c / 09gm) — the drawer's
 * "Customer update" section, on the CUSTOMER SUCCESS tier ONLY. Platform Ops
 * (identity-free) never gets it: undefined ⇒ the slot renders nothing.
 */
export function customerMessageSlot(tier: IncidentTier, d: IncidentDetailDTO, canWrite: boolean): ReactNode | undefined {
  if (tier !== "cs" || d.tier !== "cs") return undefined;
  return <IncidentCustomerUpdate d={d} canWrite={canWrite} />;
}

function IncidentDetail({ tier, id, canWrite, onSelect, onChanged, viewId, onOpenInPlace, customerProfileHosted = false }: {
  tier: IncidentTier; id: string; canWrite: boolean; onSelect: (id: string) => void; onChanged?: () => void;
  viewId?: string | null; onOpenInPlace?: (id: string) => void;
  /** CS only: the view hosts the audited profile panel (cs_customers, "customer-profile"). */
  customerProfileHosted?: boolean;
}) {
  const [generation, setGeneration] = useState(0);
  const [lifecyclePending, setLifecyclePending] = useState<LifecycleActionDTO | null>(null);
  const [form, setForm] = useState<LifecycleForm>(EMPTY_LIFECYCLE_FORM);
  const { data, error, fresh } = useKeyedJson<IncidentDetailDTO>(incidentDetailApiPath(tier, id), generation);
  const [execution, setExecution] = useState<string | null>(null);
  const [pending, setPending] = useState<RecoveryActionDTO | null>(null);
  const [why, setWhy] = useState<OperatorReasonValue>(EMPTY_OPERATOR_REASON);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function run() {
    if (!pending) return;
    setBusy(true);
    setNotice(null);
    try {
      const payload = recoveryBody(pending, why);
      const r = await fetch(recoveryPath(pending, id), {
        method: "POST", credentials: "same-origin",
        ...(payload ? { headers: { "Content-Type": "application/json" }, body: payload } : {}),
      });
      const body = await r.json().catch(() => ({} as Record<string, unknown>));
      if (pending.kind === "run-job" && (r.ok || r.status === 409)) {
        setNotice(runJobOutcomeText(r.status, body as Record<string, unknown>));
        setGeneration((g) => g + 1);
        return;
      }
      if (!r.ok) {
        if (r.status === 429 && typeof body.retryAfterSeconds === "number") throw new Error(`On cooldown — try again in ~${Math.ceil(body.retryAfterSeconds / 60)} min.`);
        if (r.status === 403) throw new Error(pending.kind === "run-job" && pending.reasonRequired
          ? "Not authorized (a fleet-wide run needs control access with a fresh sign-in)."
          : "Not authorized (write access with a fresh sign-in is required).");
        throw new Error(typeof body.error === "string" ? body.error : `${RECOVERY_LABEL[pending.kind]} failed (${r.status})`);
      }
      setNotice(pending.kind === "request-reauth"
        ? reauthOutcomeText(body as Record<string, unknown>)
        : `${RECOVERY_LABEL[pending.kind]}: done. The incident updates when the lifecycle records the outcome.`);
      setGeneration((g) => g + 1);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  function openLifecycle(a: LifecycleActionDTO) {
    setForm(EMPTY_LIFECYCLE_FORM);
    setNotice(null);
    setLifecyclePending(a);
  }

  async function runLifecycle() {
    if (!lifecyclePending || !lifecycleFormValid(lifecyclePending, form)) return;
    const a = lifecyclePending;
    setBusy(true);
    setNotice(null);
    try {
      const r = await fetch(lifecyclePath(a, id), {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lifecycleBody(a, form)),
      });
      const body = await r.json().catch(() => ({} as Record<string, unknown>));
      if (!r.ok) {
        if (r.status === 403) throw new Error("Not authorized (write access with a fresh sign-in is required).");
        if (r.status === 429) throw new Error("Too many actions — wait a minute and try again.");
        throw new Error(typeof body.error === "string" ? body.error : `${LIFECYCLE_LABEL[a]} failed (${r.status})`);
      }
      setNotice(body.changed === false ? "Already acknowledged — nothing changed." : `${LIFECYCLE_LABEL[a]}: recorded. The timeline shows the event.`);
      setGeneration((g) => g + 1);
      onChanged?.();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
      setLifecyclePending(null);
    }
  }

  if (fresh && error) return <ChartMessage>{`Incident unavailable — ${error}`}</ChartMessage>;
  if (!data || data.incident.id !== id) return <ChartMessage>Reading incident…</ChartMessage>;
  const c = pending ? confirmFor(pending) : null;
  const needsReason = pending?.kind === "run-job" && pending.reasonRequired;
  return (
    <>
      {notice && <p role="status" className="mb-3 text-xs text-[var(--text-secondary)]">{notice}</p>}
      <IncidentDetailSurface d={data} canWrite={canWrite} onSelect={onSelect} viewId={viewId} onOpenInPlace={onOpenInPlace} onExecution={tier === "ops" ? setExecution : undefined} onRecover={(a) => { setWhy(EMPTY_OPERATOR_REASON); setPending(a); }}
        onLifecycle={tier === "ops" ? openLifecycle : undefined}
        onOpenCustomer={tier === "cs" && customerProfileHosted ? requestOpenCustomer : undefined}
        slots={{ remember: <RememberButton area={tier === "ops" ? "PLATFORM_OPS" : "CUSTOMER_SUCCESS"} kind="INCIDENT" id={data.incident.id} />, customerMessage: customerMessageSlot(tier, data, canWrite) }} />
      {lifecyclePending && (
        <ConfirmDialog icon={lifecyclePending === "resolve" ? CheckCircle2 : UserCheck} title={LIFECYCLE_CONFIRM[lifecyclePending].title}
          message={<>{LIFECYCLE_CONFIRM[lifecyclePending].message}<LifecycleFormFields action={lifecyclePending} form={form} onChange={setForm} disabled={busy} /></>}
          confirmLabel={LIFECYCLE_LABEL[lifecyclePending]} confirmTone="meridian" busy={busy}
          confirmDisabled={!lifecycleFormValid(lifecyclePending, form)} onConfirm={runLifecycle} onClose={() => setLifecyclePending(null)} />
      )}
      {pending && c && (
        <ConfirmDialog icon={c.icon} title={c.title}
          message={needsReason ? <><span>{c.message}</span><OperatorReasonField value={why} onChange={setWhy} disabled={busy} label="Fleet-wide run — a reason is recorded with it" /></> : c.message}
          confirmLabel={recoveryButtonLabel(pending)} confirmTone="meridian" busy={busy}
          confirmDisabled={needsReason && reasonPayload(why) === null} onConfirm={run} onClose={() => setPending(null)} />
      )}
      <ExecutionTimelinePanel executionId={execution} eyebrow="Incident evidence" title="Refresh execution" onClose={() => setExecution(null)} />
    </>
  );
}

// ── The workspace ───────────────────────────────────────────────────────────

/** The hosted section whose "customer-profile" variant is the audited CS profile panel. */
export const CUSTOMER_PROFILE_HOST_KEY = "cs_customers";

function IncidentsWorkspace({ tier, viewId, access, renderHosted, hasHosted }: { tier: IncidentTier } & PlatformViewLeadProps) {
  const spaceUrl = useSpaceUrl();
  // Incident drawer PR-A — CS ONLY: the audited profile panel, hosted in-page (never on the Ops tier).
  const customerProfileHosted = tier === "cs" && hasHosted(CUSTOMER_PROFILE_HOST_KEY);
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

  const [listGeneration, setListGeneration] = useState(0);
  const list = useKeyedJson<IncidentListDTO>(incidentsApiPath(tier, state.query), listGeneration);
  const select = (id: string | null) => apply({ ...state, selectedId: id });
  const title = list.data?.items.find((r) => r.id === state.selectedId);
  /** A "Go to" link on THIS view: its href's state — this view's bare preset (no filters) + iid. */
  const openInPlace = (id: string) => apply({ query: { ...DEFAULT_SEARCH, status }, selectedId: id, fromClamped: false });

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
        {state.selectedId ? <IncidentDetail tier={tier} id={state.selectedId} canWrite={access?.canWrite === true} onSelect={(id) => select(id)} onChanged={() => setListGeneration((g) => g + 1)}
          viewId={viewId ?? null} onOpenInPlace={openInPlace} customerProfileHosted={customerProfileHosted} /> : null}
      </DetailDrawer>
      {customerProfileHosted ? renderHosted(CUSTOMER_PROFILE_HOST_KEY, undefined, "customer-profile") : null}
    </div>
  );
}

export function OpsIncidentsLead(props: PlatformViewLeadProps) {
  return <IncidentsWorkspace tier="ops" {...props} />;
}

export function CsIncidentsLead(props: PlatformViewLeadProps) {
  return <IncidentsWorkspace tier="cs" {...props} />;
}
