"use client";

/**
 * components/platform/widgets/OpsPoliciesWidget.tsx  (PLATFORM OPS POLICIES — Slices 1 + 2 · P1 · UX-P1)
 *
 * DECLARED OPERATIONAL POLICY — over /api/platform/platform-ops/policies and
 * /api/platform/platform-ops/job-cadence. ONE `SectionSurface`:
 *
 *   Bank refresh | Wallet refresh    the EFFECTIVE cadence as the figure, then
 *                                    ONE grammar every row shares (UX-P1):
 *                                      · a four-chip legend  Default · Override · Floor · Max
 *                                      · a Provenance chip   Platform default / Override set <date> by <name> /
 *                                                            Default in force — stored override is invalid
 *                                    then the consequences (overdue after, scheduler support, available
 *                                    cadences, attempt schedule), then ONE quiet OBSERVATION line (latest
 *                                    sweep from the job ledger) with a doorway to Jobs — declared policy
 *                                    above, what the ledger saw beneath, never mixed.
 *   Execution cadence                every registered job in THREE declared groups, the explanatory
 *                                    sentence once per group, not per row:
 *                                      Editable (fetch-fx-rates, fetch-security-prices, evaluate-alerts)
 *                                      Governed by the refresh policy (sync-banks, sync-crypto, continuation)
 *                                      Fixed (the five maintenance jobs — collapsed by default)
 *
 * ── THE CONTROL (Slice 2 · P1 · D7) ───────────────────────────────────────────
 * For an operator whose resolved access carries `canControl`, editable rows
 * offer Edit and, when an override exists, Reset to default. Both editors are
 * ONE form (`CadenceForm`): the value control, a reason select over
 * OPERATOR_REASON_CODES (no default — the operator chooses), an optional note,
 * then Save / Reset to default / Cancel. Reset is two-step inside the form
 * (arm, then confirm). D7: the refresh-cadence PATCH and DELETE now carry the
 * reason exactly as the job-cadence ones always did.
 *
 *   • The SERVER is the authority. `canControl` only decides whether the
 *     affordance is RENDERED; PATCH/DELETE require fresh control-plane access
 *     and re-validate every rule. A READ or WRITE operator sees the same facts
 *     with no control at all — never a button that 403s on click.
 *   • Save sends the override version the operator READ (`updatedAt`, or null
 *     for "no override"). A 409 means the policy moved: the canonical current
 *     model replaces the surface, the editor closes, and the operator is told.
 *   • Every response that carries the read model is published back into the
 *     workspace session, so siblings reading the same url show the same truth.
 *
 * ── AI COST CONTROLS ──────────────────────────────────────────────────────────
 * The read-only BETA C7 "Cost safeguards" group is RETIRED: the two spend-alert
 * thresholds, the allowance and the pause now live in ONE editable group,
 * "AI Cost Controls" (AiCostControlsPanel.tsx, its own file), composed beneath
 * the execution cadence — no setting is shown twice. The shared editor grammar
 * (CadenceForm, Notice, mutate, useSettle) moved to policy-editor-kit.tsx so
 * the panel shares it without a circular import; it is re-exported here.
 *
 * `OpsPoliciesWidget` fetches and publishes; `PoliciesSurface`, `PolicyColumn`,
 * `PolicyEditor`, `JobCadencePanel`, `JobCadenceRow`, `JobCadenceEditor` and
 * `AiCostControlsPanel` render — every state provable by handing them props.
 */

import { useState, type ReactNode } from "react";
import { AlertTriangle, Loader2, Pencil, RotateCcw, SlidersHorizontal } from "lucide-react";
import type { PlatformSection } from "../widget-kit";
import { useSharedWidgetFetch, useSharedWidgetPublish, type SharedFetchState } from "../workspace-session";
import { BigStat, GroupLabel, KeyRow, PolicyChip, Provenance, SectionSurface, StatusWord, TONE_COLOR, VRule } from "../platform-surface";
import { LOADING_TEXT, unavailableText } from "./platform-health-view";
import type { PlatformPoliciesResponse } from "@/app/api/platform/platform-ops/policies/route";
import type { JobCadenceResponse } from "@/app/api/platform/platform-ops/job-cadence/route";
import type { JobCadenceView } from "@/lib/platform/policies/job-cadence";
import type { RefreshPolicyView } from "@/lib/platform/policies/refresh-policies.core";
import type { RefreshCadence } from "@/lib/platform/refresh-policy.core";
import type { AiCostControlsReadModel } from "@/lib/platform/ai/cost-controls.types";
import { AiCostControlsPanel } from "./AiCostControlsPanel";
import {
  BTN, BTN_NEUTRAL, BTN_PRIMARY, BTN_QUIET, CadenceForm, FIELD, Notice, formatUtc, mutate, useSettle,
  type OperatorReasonInput, type PolicyNotice,
} from "./policy-editor-kit";
import {
  FIXED_GROUP_SUMMARY, JOB_CADENCE_FOOTNOTE, JOB_GROUP_TEXT, POLICIES_SUBJECT,
  actualText, attemptScheduleText, availableCadencesText, cadenceText, consequenceLines, effectiveHeadline, groupJobCadences,
  hasAlternativeCadence, hoursText, jobFigureText, jobLegend, jobObservationText, jobProvenance, policiesFootnote,
  refreshLegend, refreshProvenance, schedulerSupportText, unsupportedOptions, type CadenceLegendItem,
} from "./policies-view";

// The shared editor grammar lives in policy-editor-kit.tsx; re-exported so existing importers keep one path.
export { CadenceForm, Notice, formatUtc };
export type { OperatorReasonInput, PolicyNotice };

const POLICIES_URL = "/api/platform/platform-ops/policies";
const JOB_CADENCE_URL = "/api/platform/platform-ops/job-cadence";
// AI COST CONTROLS — the literal the session hooks need (the static-url contract); AI_COST_CONTROLS_URL in the types file spells the same path and the panel PATCHes it.
const COST_CONTROLS_URL = "/api/platform/platform-ops/ai-cost-controls";
const JOBS_WORKSPACE = "platform-jobs";

// ── Shared grammar: legend chips, observation line, doorway ───────────────────

/** Default · Override · Floor · Max — neutral chips; the value rides inside the chip so nothing is colour-only. */
function CadenceLegend({ items }: { items: readonly CadenceLegendItem[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Cadence bounds">
      {items.map((i) => (
        <li key={i.label} className="contents">
          <PolicyChip label={`${i.label} ${i.value}`} tone="skip" />
        </li>
      ))}
    </ul>
  );
}

/** One quiet line for what the ledger observed, with the doorway into Jobs when the host passed a switcher. */
function ObservationLine({ children, onOpenWorkspace }: { children: ReactNode; onOpenWorkspace?: (id: string) => void }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
      <span>{children}</span>
      {onOpenWorkspace && (
        <button
          type="button"
          onClick={() => onOpenWorkspace(JOBS_WORKSPACE)}
          className="text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]"
          aria-label="Open Jobs"
        >
          Jobs →
        </button>
      )}
    </p>
  );
}

// ── Controls (rendered only for canControl) ───────────────────────────────────

/**
 * The bounded refresh-cadence editor: every cadence the policy menu knows,
 * honourable ones selectable, unsupported ones disabled with the scheduler's
 * reason, inside the shared form. Prop-driven.
 */
export function PolicyEditor({
  view, intent = "edit", selected, busy, notice, onSelect, onSave, onReset, onCancel,
}: {
  view: RefreshPolicyView;
  intent?: "edit" | "reset";
  selected: RefreshCadence;
  busy: boolean;
  notice: PolicyNotice | null;
  onSelect: (c: RefreshCadence) => void;
  onSave: (reason: OperatorReasonInput) => void;
  onReset: (reason: OperatorReasonInput) => void;
  onCancel: () => void;
}) {
  const unchanged = selected === view.effective.cadence && view.effective.origin !== "INVALID_SETTING";
  const selectedHonourable = view.capability.options.find((o) => o.cadence === selected)?.honourable ?? false;
  const control = (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Expected refresh cadence</span>
      {view.capability.options.map((o) => {
        const isSelected = o.cadence === selected;
        return (
          <div key={o.cadence} className="flex flex-col gap-0.5">
            <button
              type="button"
              onClick={() => o.honourable && onSelect(o.cadence)}
              disabled={!o.honourable || busy}
              aria-pressed={isSelected}
              className={`${BTN} justify-between normal-case tracking-normal`}
              style={isSelected ? BTN_PRIMARY : BTN_NEUTRAL}
            >
              <span>{cadenceText(o.cadence)}</span>
              <span className="text-[10px] uppercase tracking-wide">{o.honourable ? (isSelected ? "Selected" : "Available") : "Unavailable"}</span>
            </button>
            {!o.honourable && o.reason && (
              <span className="pl-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">{o.reason}</span>
            )}
          </div>
        );
      })}
    </div>
  );
  return (
    <CadenceForm
      ariaLabel={`${intent === "reset" ? "Reset" : "Edit"} ${view.label}`}
      intent={intent}
      control={control}
      consequences={consequenceLines(view, selected)}
      busy={busy}
      notice={notice}
      canSave={!unchanged && selectedHonourable}
      canReset={view.desired.present}
      onSave={onSave}
      onReset={onReset}
      onCancel={onCancel}
    />
  );
}

// ── The mutation calls — the ONLY network writes on this surface ──────────────

const mutatePolicy = (method: "PATCH" | "DELETE", body: Record<string, unknown>) =>
  mutate<PlatformPoliciesResponse>(POLICIES_URL, method, body, "policy");
const mutateCadence = (method: "PATCH" | "DELETE", body: Record<string, unknown>) =>
  mutate<JobCadenceResponse>(JOB_CADENCE_URL, method, body, "cadence");

// ── One source kind's column ──────────────────────────────────────────────────

/** Declared policy above, observation beneath, and — for a controller — the affordances. Every figure comes from the read model. */
export function PolicyColumn({
  view, canControl, onModel, onOpenWorkspace,
}: {
  view: RefreshPolicyView;
  canControl: boolean;
  /** The canonical model a mutation returned — published so the surface shows it. */
  onModel: (model: PlatformPoliciesResponse) => void;
  onOpenWorkspace?: (workspaceId: string) => void;
}) {
  const headline = effectiveHeadline(view);
  const support = schedulerSupportText(view);
  const unsupported = unsupportedOptions(view);
  const actual = actualText(view);
  const invalid = view.mismatch?.kind === "INVALID_OVERRIDE";

  const [mode, setMode] = useState<"view" | "edit" | "reset">("view");
  const [selected, setSelected] = useState<RefreshCadence>(view.effective.cadence);
  const { notice, setNotice, busy, setBusy, settle } = useSettle(onModel);

  const offerEdit = canControl && (hasAlternativeCadence(view) || invalid);
  const offerReset = canControl && view.desired.present;
  const close = () => setMode("view");

  const save = async (reason: OperatorReasonInput) => {
    setBusy(true); setNotice(null);
    const outcome = await mutatePolicy("PATCH", { sourceKind: view.sourceKind, cadence: selected, expectedUpdatedAt: view.desired.updatedAt, reason });
    setBusy(false);
    settle(outcome, "Saved. The new cadence is in force; the next scheduled attempt applies it.", close);
  };
  const reset = async (reason: OperatorReasonInput) => {
    setBusy(true); setNotice(null);
    const outcome = await mutatePolicy("DELETE", { sourceKind: view.sourceKind, expectedUpdatedAt: view.desired.updatedAt, reason });
    setBusy(false);
    settle(outcome, "Reset. The platform default is in force; the next scheduled attempt applies it.", close);
  };

  let control: ReactNode = null;
  if (mode === "edit" || mode === "reset") {
    control = (
      <PolicyEditor key={mode} view={view} intent={mode} selected={selected} busy={busy} notice={notice}
        onSelect={setSelected} onSave={save} onReset={reset} onCancel={() => { close(); setNotice(null); }} />
    );
  } else if (offerEdit || offerReset) {
    control = (
      <div className="flex flex-col gap-2">
        <Notice notice={notice} />
        <div className="flex items-center gap-2">
          {offerEdit && (
            <button type="button" onClick={() => { setSelected(view.effective.cadence); setNotice(null); setMode("edit"); }} className={BTN} style={BTN_QUIET}>
              <Pencil size={11} aria-hidden /> Edit
            </button>
          )}
          {offerReset && (
            <button type="button" onClick={() => { setNotice(null); setMode("reset"); }} className={BTN} style={BTN_NEUTRAL}>
              <RotateCcw size={11} aria-hidden /> Reset to default
            </button>
          )}
        </div>
      </div>
    );
  } else if (notice) {
    control = <Notice notice={notice} />;
  }

  return (
    <div className="min-w-0 flex-1">
      <GroupLabel hint={view.description}>{view.label}</GroupLabel>
      <div className="mt-4 flex flex-col gap-5">
        <BigStat
          label="Effective cadence"
          value={headline.value}
          qualifier={`Considered overdue after ${hoursText(view.effective.overdueAfterHours)}`}
          derivation={
            invalid && view.mismatch ? (
              <span className="text-[11px]" style={{ color: TONE_COLOR.warn }} role="alert">
                {view.mismatch.message}
              </span>
            ) : undefined
          }
        />
        <div className="flex flex-col gap-2">
          <CadenceLegend items={refreshLegend(view)} />
          <Provenance source={refreshProvenance(view, formatUtc)} />
        </div>
        <div className="flex flex-col gap-2">
          <KeyRow
            label="Scheduler"
            value={<StatusWord word={support.word} token={support.reason ? TONE_COLOR.warn : TONE_COLOR.ok} />}
          />
          {support.reason && (
            <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]" role="note">{support.reason}</p>
          )}
          <KeyRow label="Available with current scheduler" value={availableCadencesText(view)} />
          <KeyRow label="Attempt schedule" value={attemptScheduleText(view)} />
        </div>
        <ObservationLine onOpenWorkspace={onOpenWorkspace}>
          Latest sweep: <StatusWord word={actual.word} token={view.actual.state === "CURRENT" ? TONE_COLOR.ok : view.actual.state === "PENDING" ? TONE_COLOR.warn : TONE_COLOR.muted} /> — {actual.note}
        </ObservationLine>
        {control}
        {unsupported.length > 0 && mode === "view" && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
              Not available today
            </span>
            {unsupported.map((o) => (
              <p key={o.cadence} className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
                <span className="font-mono text-[10px] text-[var(--text-primary)]">{o.cadence}</span> — {o.reason}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── P1 — EXECUTION CADENCE (per job) ──────────────────────────────────────────

/** The bounded cadence editor for one job: hours within floor–max inside the shared form. Prop-driven. */
export function JobCadenceEditor({ view, intent = "edit", busy, notice, onSave, onReset, onCancel }: {
  view: JobCadenceView; intent?: "edit" | "reset"; busy: boolean; notice: PolicyNotice | null;
  onSave: (hours: number, reason: OperatorReasonInput) => void;
  onReset: (reason: OperatorReasonInput) => void;
  onCancel: () => void;
}) {
  const [hours, setHours] = useState(String(view.hours));
  const n = Number.parseInt(hours, 10);
  const inBounds = Number.isInteger(n) && n >= view.minHours && n <= view.maxHours;
  const unchanged = n === view.hours && view.origin !== "INVALID_SETTING";
  const control = (
    <label className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-secondary)]">
      Every
      <input type="number" min={view.minHours} max={view.maxHours} value={hours} onChange={(e) => setHours(e.target.value)} disabled={busy}
        className={`${FIELD} w-16 tabular-nums`} style={{ borderColor: "var(--border-hairline)" }} />
      hours <span className="text-[var(--text-muted)]">(floor {view.minHours} · max {view.maxHours})</span>
    </label>
  );
  return (
    <CadenceForm
      ariaLabel={`${intent === "reset" ? "Reset" : "Edit"} cadence of ${view.job}`}
      intent={intent}
      control={control}
      consequences={["Changing the cadence runs nothing now; the next wake applies it."]}
      busy={busy}
      notice={notice}
      canSave={inBounds && !unchanged}
      canReset={view.updatedAt !== null}
      onSave={(reason) => onSave(n, reason)}
      onReset={onReset}
      onCancel={onCancel}
    />
  );
}

/** One job's row: figure · provenance (· legend when editable) · one observation line · the editor for a controller. */
export function JobCadenceRow({ view, canControl, onModel, onOpenWorkspace }: {
  view: JobCadenceView; canControl: boolean; onModel: (m: JobCadenceResponse) => void; onOpenWorkspace?: (id: string) => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "reset">("view");
  const { notice, setNotice, busy, setBusy, settle } = useSettle(onModel);
  const close = () => setMode("view");
  const save = async (hours: number, reason: OperatorReasonInput) => {
    setBusy(true); setNotice(null);
    settle(await mutateCadence("PATCH", { job: view.job, hours, expectedUpdatedAt: view.updatedAt, reason }), "Saved. The next wake applies the new cadence.", close);
    setBusy(false);
  };
  const reset = async (reason: OperatorReasonInput) => {
    setBusy(true); setNotice(null);
    settle(await mutateCadence("DELETE", { job: view.job, expectedUpdatedAt: view.updatedAt, reason }), "Reset. The default cadence is in force at the next wake.", close);
    setBusy(false);
  };
  const offerEdit = canControl && view.editable;
  const offerReset = canControl && view.editable && view.updatedAt !== null;
  return (
    <li className="flex flex-col gap-2 border-t border-[var(--border-hairline)] py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="font-mono text-[11px] text-[var(--text-primary)]">{view.job}</span>
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-xs tabular-nums text-[var(--text-primary)]">{jobFigureText(view)}</span>
          <Provenance source={jobProvenance(view, formatUtc)} />
        </span>
      </div>
      {view.editable && <CadenceLegend items={jobLegend(view)} />}
      {view.origin === "INVALID_SETTING" && (
        <p className="text-[11px]" style={{ color: TONE_COLOR.warn }} role="alert">The stored override is unreadable; the default is in force.</p>
      )}
      <ObservationLine onOpenWorkspace={onOpenWorkspace}>{jobObservationText(view, formatUtc)}</ObservationLine>
      {mode !== "view" ? (
        <JobCadenceEditor key={mode} view={view} intent={mode} busy={busy} notice={notice} onSave={save} onReset={reset} onCancel={() => { close(); setNotice(null); }} />
      ) : offerEdit || offerReset ? (
        <div className="flex flex-col gap-2">
          <Notice notice={notice} />
          <div className="flex items-center gap-2">
            {offerEdit && (
              <button type="button" onClick={() => { setNotice(null); setMode("edit"); }} className={BTN} style={BTN_QUIET}>
                <Pencil size={11} aria-hidden /> Edit
              </button>
            )}
            {offerReset && (
              <button type="button" onClick={() => { setNotice(null); setMode("reset"); }} className={BTN} style={BTN_NEUTRAL}>
                <RotateCcw size={11} aria-hidden /> Reset to default
              </button>
            )}
          </div>
        </div>
      ) : notice ? <Notice notice={notice} /> : null}
    </li>
  );
}

function JobGroup({ title, sentence, jobs, canControl, onModel, onOpenWorkspace }: {
  title: string; sentence: string; jobs: readonly JobCadenceView[]; canControl: boolean;
  onModel: (m: JobCadenceResponse) => void; onOpenWorkspace?: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <GroupLabel>{title}</GroupLabel>
      <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">{sentence}</p>
      <ul className="flex flex-col">
        {jobs.map((j) => <JobCadenceRow key={j.job} view={j} canControl={canControl} onModel={onModel} onOpenWorkspace={onOpenWorkspace} />)}
      </ul>
    </div>
  );
}

/** The execution-cadence panel: three declared groups, the Fixed one collapsed by default. Prop-driven and fetch-free. */
export function JobCadencePanel({ state, canControl, onModel, onOpenWorkspace }: {
  state: SharedFetchState<JobCadenceResponse>; canControl: boolean; onModel: (m: JobCadenceResponse) => void; onOpenWorkspace?: (id: string) => void;
}) {
  const data = state.error ? null : state.data;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <GroupLabel hint={JOB_CADENCE_FOOTNOTE}>Execution cadence</GroupLabel>
        {data && (
          <p className="text-[11px] text-[var(--text-muted)]">The platform is woken every {data.wakeEveryMinutes} minutes; each job runs when its cadence has elapsed since its last run.</p>
        )}
      </div>
      {state.loading ? (
        <p className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]" role="status"><Loader2 size={12} className="animate-spin" aria-hidden /> {LOADING_TEXT}</p>
      ) : !data ? (
        <p className="flex items-start gap-1.5 text-xs" style={{ color: "var(--coral-400)" }} role="alert"><AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden /><span>{unavailableText("execution cadence")}</span></p>
      ) : (() => {
        const groups = groupJobCadences(data.jobs);
        return (
          <>
            <JobGroup title={JOB_GROUP_TEXT.editable.title} sentence={JOB_GROUP_TEXT.editable.sentence} jobs={groups.editable} canControl={canControl} onModel={onModel} onOpenWorkspace={onOpenWorkspace} />
            <JobGroup title={JOB_GROUP_TEXT.governed.title} sentence={JOB_GROUP_TEXT.governed.sentence} jobs={groups.governed} canControl={canControl} onModel={onModel} onOpenWorkspace={onOpenWorkspace} />
            <details className="group flex flex-col gap-2">
              <summary className="cursor-pointer list-none text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]">
                <span aria-hidden className="mr-1 inline-block transition-transform group-open:rotate-90">▸</span>
                {FIXED_GROUP_SUMMARY(groups.fixed.length)}
              </summary>
              <div className="mt-2 flex flex-col gap-2">
                <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">{JOB_GROUP_TEXT.fixed.sentence}</p>
                <ul className="flex flex-col">
                  {groups.fixed.map((j) => <JobCadenceRow key={j.job} view={j} canControl={canControl} onModel={onModel} onOpenWorkspace={onOpenWorkspace} />)}
                </ul>
              </div>
            </details>
          </>
        );
      })()}
    </div>
  );
}

/** The presentational surface. Prop-driven and fetch-free. */
export function PoliciesSurface({
  section, state, canControl = false, onModel = () => {}, cadence, onCadenceModel = () => {}, costControls, onCostControlsModel = () => {}, onOpenWorkspace,
}: {
  section: PlatformSection;
  state: SharedFetchState<PlatformPoliciesResponse>;
  canControl?: boolean;
  onModel?: (model: PlatformPoliciesResponse) => void;
  /** P1 — the execution-cadence read; omitted by callers that render only the refresh columns. */
  cadence?: SharedFetchState<JobCadenceResponse>;
  onCadenceModel?: (model: JobCadenceResponse) => void;
  /** AI COST CONTROLS — the read model behind the "AI Cost Controls" group; omitted by callers that do not have it. */
  costControls?: SharedFetchState<AiCostControlsReadModel>;
  onCostControlsModel?: (model: AiCostControlsReadModel) => void;
  onOpenWorkspace?: (workspaceId: string) => void;
}) {
  const data = state.error ? null : state.data;
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <SectionSurface icon={SlidersHorizontal} title={section.label} footnote={data ? policiesFootnote(data.grace) : undefined}>
        {state.loading ? (
          <p className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]" role="status">
            <Loader2 size={12} className="animate-spin" aria-hidden /> {LOADING_TEXT}
          </p>
        ) : !data ? (
          <p className="flex items-start gap-1.5 text-xs" style={{ color: "var(--coral-400)" }} role="alert">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
            <span>{unavailableText(POLICIES_SUBJECT)}</span>
          </p>
        ) : (
          <div className="flex flex-col gap-8 md:gap-10">
            <div className="flex flex-col gap-8 md:flex-row">
              {data.policies.map((view, i) => (
                <div key={view.sourceKind} className="contents">
                  {i > 0 && <VRule />}
                  <PolicyColumn view={view} canControl={canControl} onModel={onModel} onOpenWorkspace={onOpenWorkspace} />
                </div>
              ))}
            </div>
            {cadence && <JobCadencePanel state={cadence} canControl={canControl} onModel={onCadenceModel} onOpenWorkspace={onOpenWorkspace} />}
          </div>
        )}
      </SectionSurface>
      {data && !state.loading && costControls && <AiCostControlsPanel state={costControls} editable={canControl} onModel={onCostControlsModel} />}
    </div>
  );
}

export function OpsPoliciesWidget({ section, access, onOpenWorkspace }: {
  section: PlatformSection; access?: { canControl: boolean }; onOpenWorkspace?: (workspaceId: string) => void;
}) {
  // ONE literal url, one workspace-shared read (OPS-2C-6); mutations publish the
  // canonical model they receive back into that same session entry.
  const state = useSharedWidgetFetch<PlatformPoliciesResponse>(POLICIES_URL);
  const publish = useSharedWidgetPublish<PlatformPoliciesResponse>(POLICIES_URL);
  const cadence = useSharedWidgetFetch<JobCadenceResponse>(JOB_CADENCE_URL);
  const publishCadence = useSharedWidgetPublish<JobCadenceResponse>(JOB_CADENCE_URL);
  const costControls = useSharedWidgetFetch<AiCostControlsReadModel>(COST_CONTROLS_URL);
  const publishCostControls = useSharedWidgetPublish<AiCostControlsReadModel>(COST_CONTROLS_URL);
  return (
    <PoliciesSurface section={section} state={state} canControl={access?.canControl ?? false} onModel={publish}
      cadence={cadence} onCadenceModel={publishCadence} costControls={costControls} onCostControlsModel={publishCostControls} onOpenWorkspace={onOpenWorkspace} />
  );
}
