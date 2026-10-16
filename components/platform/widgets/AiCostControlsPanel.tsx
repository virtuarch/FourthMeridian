"use client";

/**
 * components/platform/widgets/AiCostControlsPanel.tsx  (AI COST CONTROLS — Policies → "AI Cost Controls")
 *
 * THE FOUR POLICY CARDS over GET/PATCH /api/platform/platform-ops/ai-cost-controls
 * (the frozen read model in lib/platform/ai/cost-controls.types.ts), rendered
 * alongside the Policies surface in place of the retired read-only "Cost
 * safeguards" group — the thresholds live here now and nowhere else:
 *
 *   Per-user daily AI allowance    enforcement + USD amount · ceiling · the effective
 *                                  default · per-customer overrides (opaque refs, changed
 *                                  in Customer Success) · where the allowance is judged
 *   Per-user spending alert        enable + threshold · live / firing / last fired · recent deliveries
 *   Fleet-wide spending alert      the same, plus the sentence that fleet excludes harness / operator traffic
 *   Pause paid AI requests         THE EMERGENCY CONTROL — its own state word, the sentence
 *                                  customers read, two-step confirmation in BOTH directions
 *
 * Each card leads with its effective value, status and authorized actions.
 * Fixed ceilings are read-only; all edits retain version checks and audit reasons.
 *
 * ── THE EDITOR ────────────────────────────────────────────────────────────────
 * For an operator whose resolved access permits it (`editable` — the host
 * forwards the descriptive flag; the SERVER is the authority and re-checks
 * fresh access on every PATCH), each card offers Edit and, when a stored row
 * exists, Restore defaults (never on the kill switch — Pause and Resume are its
 * only two actions), both through the shared CadenceForm grammar:
 * value control → consequences → reason (required, no default) → optional
 * note → Save changes / Restore defaults / Cancel. Nothing saves while typing;
 * validation (whole dollars, within the read model's bounds, not empty) is
 * shown before submission. Disabling enforcement and pausing OR resuming are
 * confirmation-gated: the first Save arms the sentence, the second confirms.
 *
 * Save sends ONE PATCH carrying only the controls that changed, each with the
 * `expectedUpdatedAt` the operator read; Restore sends `value: null` for the
 * card's stored rows. 200 ⇒ the canonical model is published and "Saved";
 * 409 ⇒ the canonical model replaces the surface and the editor closes;
 * 400 ⇒ the server's sentence, model refreshed if it came back; 403 ⇒ not authorized.
 *
 * Identity minimisation: opaque refs only. Every dollar is an estimate.
 * No polling, no router, no raw colour. Every state provable by props.
 */

import { useState, type ReactNode } from "react";
import { AlertTriangle, Loader2, Pause, Pencil, Play, RotateCcw } from "lucide-react";
import type { SharedFetchState } from "../workspace-session";
import { KeyRow, PolicyChip, Provenance, TONE_COLOR, ToneBadge } from "../platform-surface";
import { LOADING_TEXT, unavailableText } from "./platform-health-view";
import { AI_COST_CONTROLS_URL, type AiCostControlKey, type AiCostControlsReadModel, type ControlValueView } from "@/lib/platform/ai/cost-controls.types";
import { BTN, BTN_NEUTRAL, BTN_PRIMARY, BTN_QUIET, CadenceForm, FIELD, Notice, formatUtc, mutate, useSettle, type OperatorReasonInput, type PolicyNotice } from "./policy-editor-kit";
import {
  AI_COST_CONTROLS_SUBJECT, AI_COST_CONTROLS_TITLE, BOOL_WORDS, CARD_CONTROLS, CARD_TITLE,
  EMERGENCY_LABEL, RESTORED_TEXT, RESTORE_TEXT, SAVED_TEXT,
  cardConsequences, confirmLabel, confirmationSentences, controlLegend, controlProvenance, draftFromModel, enforcedWord,
  firingText, lastUpdatedText, modelView, originChip, patchBody, resolveDraft,
  restoreDefaultsChanges, stateWord, usdText, valueText, validateThresholdInput, type AnyControlView, type CardKey, type ControlDraft,
} from "./ai-cost-controls-view";

// ── Reading one control ───────────────────────────────────────────────────────

/** The value in force with its origin chip, the Default · Setting · Max legend, and the provenance line. */
export function ControlFacts({ view }: { view: AnyControlView }) {
  return (
    <div className="flex flex-col gap-1.5">
      <KeyRow
        label={view.label}
        value={
          <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
            <span>{valueText(view)}</span>
            <PolicyChip label={originChip(view.origin)} tone={view.origin === "INVALID_SETTING" ? "off" : "skip"} />
          </span>
        }
      />
      <ul className="flex flex-wrap gap-1.5" aria-label="Control bounds">
        {controlLegend(view).map((i) => (
          <li key={i.label} className="contents"><PolicyChip label={`${i.label} ${i.value}`} tone="skip" /></li>
        ))}
      </ul>
      <Provenance source={controlProvenance(view, formatUtc)} />
      {view.origin === "INVALID_SETTING" && (
        <p className="text-[11px]" style={{ color: TONE_COLOR.warn }} role="alert">
          The stored value is unreadable; the default is in force. {view.updatedAt ? lastUpdatedText(view, formatUtc) + "." : ""}
        </p>
      )}
    </div>
  );
}

// ── The editor (prop-driven) ──────────────────────────────────────────────────

function ControlToggle({ view, value, busy, onChange, label = view.label }: { label?: string; view: ControlValueView<boolean>; value: boolean; busy: boolean; onChange: (v: boolean) => void }) {
  const words = BOOL_WORDS[view.control] ?? ["on", "off"];
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label={label}>
      <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{label}</span>
      <div className="flex flex-wrap gap-2">
        {([true, false] as const).map((v) => (
          <button key={String(v)} type="button" onClick={() => onChange(v)} disabled={busy} aria-pressed={value === v}
            className={`${BTN} normal-case tracking-normal`} style={value === v ? BTN_PRIMARY : BTN_NEUTRAL}>
            {v ? words[0] : words[1]}
          </button>
        ))}
      </div>
    </div>
  );
}

function ThresholdInput({ view, raw, busy, onChange }: { view: ControlValueView<number>; raw: string; busy: boolean; onChange: (raw: string) => void }) {
  const v = validateThresholdInput(raw, view);
  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-secondary)]">
        {view.label}
        <input type="number" min={view.bounds?.min} max={view.bounds?.max} step={1} value={raw} onChange={(e) => onChange(e.target.value)} disabled={busy}
          aria-invalid={v.error !== null} className={`${FIELD} w-24 tabular-nums`} style={{ borderColor: v.error ? TONE_COLOR.bad : "var(--border-hairline)" }} />
        {view.bounds && <span className="text-[var(--text-muted)]">(whole dollars · min {usdText(view.bounds.min)} · max {usdText(view.bounds.max)})</span>}
      </label>
      {v.error && <p className="text-[11px]" style={{ color: TONE_COLOR.bad }} role="alert">{v.error}</p>}
    </div>
  );
}

/**
 * One card's editor inside the shared form. `armed` is the card's confirmation
 * state: once the operator has pressed Save on a confirmation-gated change the
 * sentence is shown and the button reads "Confirm …"; the second press submits.
 */
export function CardEditor({
  card, model, draft, armed, intent = "edit", busy, notice, onDraft, onSave, onReset, onCancel,
}: {
  card: CardKey;
  model: AiCostControlsReadModel;
  draft: ControlDraft;
  armed: boolean;
  intent?: "edit" | "reset";
  busy: boolean;
  notice: PolicyNotice | null;
  onDraft: (draft: ControlDraft) => void;
  onSave: (reason: OperatorReasonInput) => void;
  onReset: (reason: OperatorReasonInput) => void;
  onCancel: () => void;
}) {
  const { changes, errors } = resolveDraft(model, card, draft);
  const confirmations = confirmationSentences(changes);
  const restore = restoreDefaultsChanges(model, card);
  const restoreConfirmations = confirmationSentences(restore);
  const gated = confirmations.length > 0;
  const pausing = card === "killSwitch" ? draft["killSwitch.paused"] === true : null;
  const saveLabel = armed && gated ? confirmLabel(changes) : card === "killSwitch" ? (pausing ? "Pause paid requests" : "Resume paid requests") : "Save changes";
  const control = (
    <div className="flex flex-col gap-3">
      {CARD_CONTROLS[card].map((key: AiCostControlKey) => {
        const view = modelView(model, key);
        if (typeof view.value === "boolean") {
          const drafted = draft[key];
          return <ControlToggle key={key} view={view as ControlValueView<boolean>} value={typeof drafted === "boolean" ? drafted : view.value} busy={busy} onChange={(v) => onDraft({ ...draft, [key]: v })} />;
        }
        const raw = typeof draft[key] === "string" ? (draft[key] as string) : String(view.value);
        return <ThresholdInput key={key} view={view as ControlValueView<number>} raw={raw} busy={busy} onChange={(r) => onDraft({ ...draft, [key]: r })} />;
      })}
      {card === "killSwitch" && (
        <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
          While paused, customers read: <q className="text-[var(--text-primary)]">{model.killSwitch.customerMessage}</q>
        </p>
      )}
    </div>
  );
  return (
    <CadenceForm
      ariaLabel={`${intent === "reset" ? "Restore" : "Edit"} ${CARD_TITLE[card]}`}
      intent={intent}
      control={control}
      consequences={cardConsequences(card, model, changes)}
      warning={armed && gated ? confirmations.join(" ") : null}
      busy={busy}
      notice={notice}
      canSave={changes.length > 0 && Object.keys(errors).length === 0}
      dirty={Object.entries(draft).some(([key, value]) => draftFromModel(model, card)[key as AiCostControlKey] !== value)}
      canReset={restore.length > 0}
      saveLabel={saveLabel}
      resetLabel="Restore defaults"
      confirmResetLabel="Confirm restore"
      resetText={[RESTORE_TEXT, ...restoreConfirmations].join(" ")}
      onSave={onSave}
      onReset={onReset}
      onCancel={onCancel}
    />
  );
}

// ── The card shell: facts above, the affordances or the editor beneath ────────

const subject = AI_COST_CONTROLS_SUBJECT.replace(/s$/, "");

function useCard(card: CardKey, model: AiCostControlsReadModel, onModel: (m: AiCostControlsReadModel) => void) {
  const [mode, setMode] = useState<"view" | "edit" | "reset">("view");
  const [draft, setDraft] = useState<ControlDraft>({});
  const [armed, setArmed] = useState(false);
  const { notice, setNotice, busy, setBusy, settle } = useSettle(onModel);
  const close = () => { setMode("view"); setArmed(false); };
  const open = (intent: "edit" | "reset", initial?: ControlDraft, armedAtOpen = false) => {
    setDraft(initial ?? draftFromModel(model, card)); setArmed(armedAtOpen); setNotice(null); setMode(intent);
  };
  const onDraft = (d: ControlDraft) => { setDraft(d); setArmed(false); };
  const save = async (reason: OperatorReasonInput) => {
    const { changes, errors } = resolveDraft(model, card, draft);
    if (changes.length === 0 || Object.keys(errors).length > 0) return;
    if (confirmationSentences(changes).length > 0 && !armed) { setArmed(true); return; }
    setBusy(true); setNotice(null);
    const outcome = await mutate<AiCostControlsReadModel>(AI_COST_CONTROLS_URL, "PATCH", patchBody(changes, reason) as unknown as Record<string, unknown>, subject);
    setBusy(false);
    settle(outcome, SAVED_TEXT, close);
  };
  const restore = async (reason: OperatorReasonInput) => {
    const changes = restoreDefaultsChanges(model, card);
    if (changes.length === 0) return;
    setBusy(true); setNotice(null);
    const outcome = await mutate<AiCostControlsReadModel>(AI_COST_CONTROLS_URL, "PATCH", patchBody(changes, reason) as unknown as Record<string, unknown>, subject);
    setBusy(false);
    settle(outcome, RESTORED_TEXT, close);
  };
  return { mode, draft, armed, notice, busy, open, onDraft, save, restore, cancel: () => { close(); setNotice(null); } };
}

const DISPLAY_TITLE: Record<CardKey, string> = {
  allowance: "Daily allowance",
  userAlert: "Per-customer spending alert",
  fleetAlert: "Fleet-wide spending alert",
  killSwitch: "Emergency AI pause",
};

function CardShell({ card, state, children, control, primary, caption, signal }: { card: CardKey; state: { word: string; tone: "ok" | "warn" | "bad" | "muted" }; children: ReactNode; control: ReactNode; primary: ReactNode; caption: string; signal?: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-[var(--border-hairline-strong)] bg-[var(--surface-muted)] p-5 sm:p-6" aria-label={CARD_TITLE[card]}>
      <div className="flex min-w-0 flex-col items-start gap-2">
        <h3 className="break-words text-sm font-semibold leading-6 text-[var(--text-primary)]">{DISPLAY_TITLE[card]}</h3>
        <div className="flex flex-wrap items-center gap-2"><ToneBadge word={state.word} tone={state.tone} />{signal}</div>
      </div>
      <div className="my-4 min-w-0">
        <p className="break-words text-3xl font-semibold leading-tight tracking-tight tabular-nums text-[var(--text-primary)]">{primary}</p>
        <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">{caption}</p>
      </div>
      <div className="mb-4 flex min-w-0 flex-col gap-3">{children}</div>
      <div className="mt-auto border-t border-[var(--border-hairline)] pt-4">{control}</div>
    </section>
  );
}

function PolicySetting({ label, value }: { label: string; value: ReactNode }) {
  return <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs">
    <span className="text-[var(--text-muted)]">{label}</span>
    <span className="min-w-0 max-w-full break-words text-[var(--text-primary)]">{value}</span>
  </div>;
}

function InvalidSettingNotice({ views }: { views: AnyControlView[] }) {
  return views.some((view) => view.origin === "INVALID_SETTING")
    ? <p className="text-xs leading-5" style={{ color: TONE_COLOR.warn }} role="alert">A stored setting is invalid. Its default is in effect.</p>
    : null;
}

/** One of the three ordinary cards (allowance, per-user alert, fleet alert). The facts are the caller's; the editor is shared. */
function PolicyCard({ card, model, editable, onModel, state, children, primary, caption, signal }: {
  card: CardKey; model: AiCostControlsReadModel; editable: boolean; onModel: (m: AiCostControlsReadModel) => void;
  state: { word: string; tone: "ok" | "warn" | "bad" | "muted" }; children: ReactNode; primary: ReactNode; caption: string; signal?: ReactNode;
}) {
  const c = useCard(card, model, onModel);
  const offerRestore = restoreDefaultsChanges(model, card).length > 0;
  const control = c.mode !== "view"
    ? <CardEditor key={c.mode} card={card} model={model} draft={c.draft} armed={c.armed} intent={c.mode} busy={c.busy} notice={c.notice} onDraft={c.onDraft} onSave={c.save} onReset={c.restore} onCancel={c.cancel} />
    : <div className="flex flex-col gap-3">
        <Notice notice={c.notice} />
        {card !== "killSwitch" && <ControlToggle
          label={card === "allowance" ? "Enforcement" : "Alert"}
          view={card === "allowance" ? model.allowance.enforced : model[card].enabled}
          value={card === "allowance" ? model.allowance.enforced.value : model[card].enabled.value}
          busy={!editable}
          onChange={(value) => c.open("edit", { ...draftFromModel(model, card), [card === "allowance" ? "allowance.enforced" : `${card}.enabled`]: value })}
        />}
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!editable} onClick={() => c.open("edit")} className={BTN} style={BTN_QUIET}>
            <Pencil size={12} aria-hidden /> {card === "allowance" ? "Custom" : "Edit"}
          </button>
          <button type="button" disabled={!editable || !offerRestore} onClick={() => c.open("reset")} className={BTN} style={BTN_NEUTRAL}>
            <RotateCcw size={12} aria-hidden /> Revert
          </button>
        </div>
        {!editable && <p className="text-xs text-[var(--text-muted)]">Read only · Control access required</p>}
        {editable && !offerRestore && <p className="text-xs text-[var(--text-muted)]">Default configuration in use</p>}
      </div>;
  return <CardShell card={card} state={state} control={control} primary={primary} caption={caption} signal={signal}>{children}</CardShell>;
}

// ── The four cards ────────────────────────────────────────────────────────────

function AllowanceCard({ model, editable, onModel }: { model: AiCostControlsReadModel; editable: boolean; onModel: (m: AiCostControlsReadModel) => void }) {
  const a = model.allowance;
  return (
    <PolicyCard card="allowance" model={model} editable={editable} onModel={onModel} state={enforcedWord(a.enforced.value)} primary={usdText(a.effectiveDefaultUsd)} caption="Effective default per customer · UTC day">
      <PolicySetting label="Default" value={usdText(a.usd.defaultValue)} />
      <PolicySetting label="Configured allowance" value={usdText(a.usd.value)} />
      <PolicySetting label="Max spend" value={`${usdText(a.ceilingUsd)} / UTC day · fixed ceiling`} />
      <InvalidSettingNotice views={[a.enforced, a.usd]} />
      <p className="text-xs leading-5 text-[var(--text-muted)]">Per-customer overrides are managed in Customer Success.</p>
    </PolicyCard>
  );
}

function AlertCard({ card, model, editable, onModel }: { card: "userAlert" | "fleetAlert"; model: AiCostControlsReadModel; editable: boolean; onModel: (m: AiCostControlsReadModel) => void }) {
  const v = model[card];
  const firing = firingText(v.status, formatUtc);
  return (
    <PolicyCard card={card} model={model} editable={editable} onModel={onModel} state={stateWord(v.enabled.value)} signal={v.status.firingNow ? <ToneBadge word={firing.word} tone={firing.tone} /> : null} primary={usdText(v.thresholdUsd.value)} caption={card === "userAlert" ? "Estimated spend per customer · trailing 24h" : "Estimated fleet spend · trailing 24h"}>
      <PolicySetting label="Default" value={usdText(v.thresholdUsd.defaultValue)} />
      <PolicySetting label="Last activity" value={firing.word} />
      <InvalidSettingNotice views={[v.enabled, v.thresholdUsd]} />
    </PolicyCard>
  );
}

/** THE EMERGENCY CONTROL: its own region and state word, the sentence customers read, confirmation in both directions. */
function KillSwitchCard({ model, editable, onModel }: { model: AiCostControlsReadModel; editable: boolean; onModel: (m: AiCostControlsReadModel) => void }) {
  const k = model.killSwitch;
  const c = useCard("killSwitch", model, onModel);
  const paused = k.paused.value;
  // Exactly two actions, Pause and Resume, both confirmation-gated; no Restore defaults here (restoreDefaultsChanges is [] for this card).
  // The flip is drafted and ARMED at open: opening is step one, Confirm pause / Confirm resume with the reason is step two.
  const control = c.mode !== "view"
    ? <CardEditor key={c.mode} card="killSwitch" model={model} draft={c.draft} armed={c.armed} intent={c.mode} busy={c.busy} notice={c.notice} onDraft={c.onDraft} onSave={c.save} onReset={c.restore} onCancel={c.cancel} />
    : <div className="flex flex-col items-start gap-3">
        <Notice notice={c.notice} />
        <button type="button" disabled={!editable} onClick={() => c.open("edit", { "killSwitch.paused": !paused }, true)} className={BTN} style={BTN_PRIMARY}>
          {paused ? <Play size={12} aria-hidden /> : <Pause size={12} aria-hidden />} {paused ? "Resume AI" : "Pause AI"}
        </button>
        {!editable && <p className="text-xs text-[var(--text-muted)]">Read only · Control access required</p>}
      </div>;
  return (
    <div className="flex flex-col gap-3" style={{ borderColor: "var(--border-hairline-strong)" }} role="region" aria-label={EMERGENCY_LABEL}>
      <span className="text-[10px] font-medium uppercase tracking-wide" style={{ color: "var(--brass-300)" }}>{EMERGENCY_LABEL}</span>
      <CardShell card="killSwitch" state={{ word: paused ? "PAUSED" : "ACTIVE", tone: paused ? "warn" : "ok" }} control={control} primary={paused ? "Paused" : "Active"} caption="Controls new paid AI requests across all surfaces.">
        <InvalidSettingNotice views={[k.paused]} />
      </CardShell>
    </div>
  );
}

// ── The panel ─────────────────────────────────────────────────────────────────

/** Prop-driven and fetch-free: the host passes the shared read and the publish side. `editable` disables affordances without granting authority. */
export function AiCostControlsPanel({ state, editable = false, onModel = () => {} }: {
  state: SharedFetchState<AiCostControlsReadModel>;
  editable?: boolean;
  onModel?: (model: AiCostControlsReadModel) => void;
}) {
  const data = state.error ? null : state.data;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">{AI_COST_CONTROLS_TITLE}</h2>

      </div>
      {state.loading ? (
        <p className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]" role="status"><Loader2 size={12} className="animate-spin" aria-hidden /> {LOADING_TEXT}</p>
      ) : !data ? (
        <p className="flex items-start gap-1.5 text-xs" style={{ color: TONE_COLOR.bad }} role="alert"><AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden /><span>{unavailableText(AI_COST_CONTROLS_SUBJECT)}</span></p>
      ) : (
        <>

          <div className="grid items-stretch gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 18.5rem), 1fr))" }}>
            <AllowanceCard model={data} editable={editable} onModel={onModel} />
            <AlertCard card="userAlert" model={data} editable={editable} onModel={onModel} />
            <AlertCard card="fleetAlert" model={data} editable={editable} onModel={onModel} />
          </div>
          <KillSwitchCard model={data} editable={editable} onModel={onModel} />
        </>
      )}
    </div>
  );
}
