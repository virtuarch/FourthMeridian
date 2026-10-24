"use client";

/**
 * components/platform/widgets/MaintenanceModePanel.tsx  (PLATFORM OPS — Policies → "Operational Controls")
 *
 * MAINTENANCE MODE over GET/PATCH /api/platform/platform-ops/operational-controls
 * (lib/platform/policies/operational-controls.types.ts). Leads with the
 * deployment environment (PREVIEW / PRODUCTION) and the state word — Enabled,
 * Disabled or Not configured — then what maintenance blocks, what it does not,
 * and how it differs from the AI kill switch and the ingestion pause.
 *
 * Actions follow the state: Enable (when not on), Disable (when on or
 * unreadable), Reset to not configured (when a row exists — absent and "false"
 * are different provenance). Opening an action is step one; the shared form
 * (policy-editor-kit.tsx) shows the confirmation sentence naming the
 * environment and host, and requires a reason AND a note before the Confirm
 * button enables — step two. "Saved" appears only when the server returned the
 * canonical model AND it reads the promised state (resolveMaintenanceOutcome);
 * a 409 replaces the surface with the current state; 400/403 keep the form
 * open with the server's sentence.
 *
 * `editable` is descriptive: the SERVER re-checks fresh access on every PATCH.
 * No polling, no router, no raw colour. Every state provable by props.
 */

import { useState } from "react";
import { AlertTriangle, Loader2, Power, RotateCcw } from "lucide-react";
import type { SharedFetchState } from "../workspace-session";
import { KeyRow, TONE_COLOR, ToneBadge } from "../platform-surface";
import { LOADING_TEXT, unavailableText } from "./platform-health-view";
import {
  OPERATIONAL_CONTROLS_URL, type MaintenanceAction, type OperationalControlsReadModel,
} from "@/lib/platform/policies/operational-controls.types";
import { BTN, BTN_NEUTRAL, BTN_PRIMARY, CadenceForm, Notice, formatUtc, mutate, type OperatorReasonInput, type PolicyNotice } from "./policy-editor-kit";
import {
  ACTION_LABEL, DISTINCTION_LINES, MAINTENANCE_LABEL, OPERATIONAL_CONTROLS_SUBJECT, OPERATIONAL_CONTROLS_TITLE,
  availableActions, confirmLabel, confirmationSentence, environmentBadge, lastChangedText, maintenanceCaption,
  maintenanceConsequences, maintenancePatchBody, maintenanceStateWord, relatedStateWord, resolveMaintenanceOutcome,
} from "./maintenance-mode-view";

function MaintenanceCard({ model, editable, onModel }: {
  model: OperationalControlsReadModel; editable: boolean; onModel: (m: OperationalControlsReadModel) => void;
}) {
  const [open, setOpen] = useState<MaintenanceAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<PolicyNotice | null>(null);
  const m = model.maintenance;
  const state = maintenanceStateWord(m.state);
  const env = environmentBadge(model.environment);
  const host = typeof window === "undefined" ? null : window.location.host;
  const changed = lastChangedText(model, formatUtc);

  const submit = async (action: MaintenanceAction, reason: OperatorReasonInput) => {
    setBusy(true);
    setNotice(null);
    const outcome = await mutate<OperationalControlsReadModel>(OPERATIONAL_CONTROLS_URL, "PATCH", maintenancePatchBody(model, action, reason), "maintenance setting");
    const r = resolveMaintenanceOutcome(outcome, action);
    if (r.model) onModel(r.model);
    if (r.close) setOpen(null);
    setNotice(r.notice);
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-sm)] border p-4" style={{ borderColor: "var(--border-hairline-strong)" }} role="region" aria-label={MAINTENANCE_LABEL}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-[var(--text-primary)]">{MAINTENANCE_LABEL}</span>
        <span className="inline-flex items-center gap-3">
          <span className="rounded-[var(--radius-sm)] border px-1.5 text-[10px] font-semibold tracking-wide" style={{ color: TONE_COLOR[env.tone], borderColor: TONE_COLOR[env.tone] }} aria-label={`Environment: ${env.word}`}>
            {env.word}
          </span>
          <ToneBadge word={state.word} tone={state.tone} />
        </span>
      </div>
      <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">{maintenanceCaption(m.state)}</p>
      {m.state === "INVALID" && m.invalidRaw !== null && (
        <p className="text-[11px]" style={{ color: TONE_COLOR.bad }} role="alert">Stored value: <code>{m.invalidRaw}</code></p>
      )}
      {changed && <p className="text-[10px] text-[var(--text-muted)]">{changed}</p>}

      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">While enabled</span>
        <ul className="flex list-disc flex-col gap-0.5 pl-4">
          {maintenanceConsequences(m.blocks).map((line) => <li key={line} className="text-[11px] leading-relaxed text-[var(--text-secondary)]">{line}</li>)}
        </ul>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Not the same as</span>
        {DISTINCTION_LINES.map((line) => <p key={line} className="text-[11px] leading-relaxed text-[var(--text-secondary)]">{line}</p>)}
        <KeyRow label="Paid AI kill switch now" value={relatedStateWord(model.related.aiKillSwitch.state, "paused")} />
        <KeyRow label="Ingestion pause now" value={relatedStateWord(model.related.ingestionPaused.state, "paused")} />
      </div>

      {open ? (
        <CadenceForm
          key={open}
          ariaLabel={`${ACTION_LABEL[open]} (${env.word})`}
          intent="edit"
          control={null}
          consequences={[]}
          warning={confirmationSentence(open, model.environment, host)}
          busy={busy}
          notice={notice}
          canSave
          canReset={false}
          noteRequired
          saveLabel={confirmLabel(open, model.environment)}
          onSave={(reason) => void submit(open, reason)}
          onReset={() => {}}
          onCancel={() => { setOpen(null); setNotice(null); }}
        />
      ) : (
        <>
          <Notice notice={notice} />
          <div className="flex flex-wrap gap-2">
            {availableActions(m.state).map((action) => (
              <button key={action} type="button" disabled={!editable} onClick={() => { setNotice(null); setOpen(action); }}
                className={BTN} style={action === "RESET" ? BTN_NEUTRAL : BTN_PRIMARY}>
                {action === "RESET" ? <RotateCcw size={12} aria-hidden /> : <Power size={12} aria-hidden />} {ACTION_LABEL[action]}
              </button>
            ))}
          </div>
          {!editable && <p className="text-[10px] text-[var(--text-muted)]">Changing maintenance needs the highest Platform Ops grant level.</p>}
        </>
      )}
    </div>
  );
}

/** Prop-driven and fetch-free: the host passes the shared read and the publish side. */
export function MaintenanceModePanel({ state, editable = false, onModel = () => {} }: {
  state: SharedFetchState<OperationalControlsReadModel>;
  editable?: boolean;
  onModel?: (model: OperationalControlsReadModel) => void;
}) {
  const data = state.error ? null : state.data;
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-[var(--text-primary)]">{OPERATIONAL_CONTROLS_TITLE}</h2>
      {state.loading ? (
        <p className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]" role="status"><Loader2 size={12} className="animate-spin" aria-hidden /> {LOADING_TEXT}</p>
      ) : !data ? (
        <p className="flex items-start gap-1.5 text-xs" style={{ color: TONE_COLOR.bad }} role="alert"><AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden /><span>{unavailableText(OPERATIONAL_CONTROLS_SUBJECT)}</span></p>
      ) : (
        <MaintenanceCard model={data} editable={editable} onModel={onModel} />
      )}
    </div>
  );
}
