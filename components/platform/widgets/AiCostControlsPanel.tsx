"use client";

/**
 * components/platform/widgets/AiCostControlsPanel.tsx  (AI COST CONTROLS — Policies → "AI Cost Controls")
 *
 * THE FOUR POLICY CARDS over GET/PATCH /api/platform/platform-ops/ai-cost-controls
 * (the frozen read model in lib/platform/ai/cost-controls.types.ts), rendered
 * inside the Policies SectionSurface in place of the retired read-only "Cost
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
 * ONE grammar per control: the value in force with its origin chip (Default ·
 * Setting · Default in force — stored value invalid), a Default · Setting · Max
 * legend, a Provenance chip naming when and by whom the row was written.
 *
 * ── THE EDITOR ────────────────────────────────────────────────────────────────
 * For an operator whose resolved access permits it (`editable` — the host
 * forwards the descriptive flag; the SERVER is the authority and re-checks
 * fresh access on every PATCH), each card offers Edit and, when a stored row
 * exists, Restore defaults, both through the shared CadenceForm grammar:
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
import { GroupLabel, KeyRow, PolicyChip, Provenance, TONE_COLOR, ToneBadge } from "../platform-surface";
import { LOADING_TEXT, unavailableText } from "./platform-health-view";
import { AI_COST_CONTROLS_URL, type AiCostControlKey, type AiCostControlsReadModel, type ControlValueView } from "@/lib/platform/ai/cost-controls.types";
import { BTN, BTN_NEUTRAL, BTN_PRIMARY, BTN_QUIET, CadenceForm, FIELD, Notice, formatUtc, mutate, useSettle, type OperatorReasonInput, type PolicyNotice } from "./policy-editor-kit";
import {
  AI_COST_CONTROLS_SENTENCE, AI_COST_CONTROLS_SUBJECT, AI_COST_CONTROLS_TITLE, BOOL_WORDS, CARD_CONTROLS, CARD_DESCRIPTION, CARD_TITLE,
  EMERGENCY_LABEL, FLEET_SCOPE_SENTENCE, KILL_SWITCH_NOTE, OVERRIDES_DOORWAY, RESTORED_TEXT, RESTORE_TEXT, SAVED_TEXT,
  cardConsequences, confirmLabel, confirmationSentences, controlLegend, controlProvenance, draftFromModel, effectiveDefaultText, enforcedWord,
  firingText, lastUpdatedText, modelView, originChip, overridesSentence, patchBody, pausedWord, propagationText, resolveDraft,
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

function ControlToggle({ view, value, busy, onChange }: { view: ControlValueView<boolean>; value: boolean; busy: boolean; onChange: (v: boolean) => void }) {
  const words = BOOL_WORDS[view.control] ?? ["on", "off"];
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label={view.label}>
      <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{view.label}</span>
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

function Affordances({ notice, edit, restore }: { notice: PolicyNotice | null; edit: { label: string; icon: ReactNode; onClick: () => void } | null; restore: (() => void) | null }) {
  if (!edit && !restore) return notice ? <Notice notice={notice} /> : null;
  return (
    <div className="flex flex-col gap-2">
      <Notice notice={notice} />
      <div className="flex flex-wrap items-center gap-2">
        {edit && (
          <button type="button" onClick={edit.onClick} className={BTN} style={BTN_QUIET}>{edit.icon} {edit.label}</button>
        )}
        {restore && (
          <button type="button" onClick={restore} className={BTN} style={BTN_NEUTRAL}><RotateCcw size={11} aria-hidden /> Restore defaults</button>
        )}
      </div>
    </div>
  );
}

function CardShell({ card, state, children, control }: { card: CardKey; state: { word: string; tone: "ok" | "warn" | "bad" | "muted" }; children: ReactNode; control: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-4" role="group" aria-label={CARD_TITLE[card]}>
      <div className="flex flex-col gap-1.5">
        <GroupLabel hint={CARD_DESCRIPTION[card]}>{CARD_TITLE[card]}</GroupLabel>
        <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">{CARD_DESCRIPTION[card]}</p>
        <ToneBadge word={state.word} tone={state.tone} />
      </div>
      {children}
      {control}
    </div>
  );
}

/** One of the three ordinary cards (allowance, per-user alert, fleet alert). The facts are the caller's; the editor is shared. */
function PolicyCard({ card, model, editable, onModel, state, children }: {
  card: CardKey; model: AiCostControlsReadModel; editable: boolean; onModel: (m: AiCostControlsReadModel) => void;
  state: { word: string; tone: "ok" | "warn" | "bad" | "muted" }; children: ReactNode;
}) {
  const c = useCard(card, model, onModel);
  const offerRestore = editable && restoreDefaultsChanges(model, card).length > 0;
  const control = c.mode !== "view"
    ? <CardEditor key={c.mode} card={card} model={model} draft={c.draft} armed={c.armed} intent={c.mode} busy={c.busy} notice={c.notice} onDraft={c.onDraft} onSave={c.save} onReset={c.restore} onCancel={c.cancel} />
    : <Affordances notice={c.notice}
        edit={editable ? { label: "Edit", icon: <Pencil size={11} aria-hidden />, onClick: () => c.open("edit") } : null}
        restore={offerRestore ? () => c.open("reset") : null} />;
  return <CardShell card={card} state={state} control={control}>{children}</CardShell>;
}

// ── The four cards ────────────────────────────────────────────────────────────

function AllowanceCard({ model, editable, onModel }: { model: AiCostControlsReadModel; editable: boolean; onModel: (m: AiCostControlsReadModel) => void }) {
  const a = model.allowance;
  return (
    <PolicyCard card="allowance" model={model} editable={editable} onModel={onModel} state={enforcedWord(a.enforced.value)}>
      <ControlFacts view={a.enforced} />
      <ControlFacts view={a.usd} />
      <div className="flex flex-col gap-1.5">
        <KeyRow label="Ceiling" value={usdText(a.ceilingUsd)} />
        <KeyRow label="Effective default" value={usdText(a.effectiveDefaultUsd)} />
        <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">{effectiveDefaultText(a)}</p>
        <KeyRow label="Per-customer overrides" value={String(a.overrides.count)} />
        {a.overrides.customers.length > 0 && (
          <ul className="flex flex-col gap-0.5" aria-label="Per-customer overrides">
            {a.overrides.customers.map((o) => (
              <li key={o.ref} className="flex flex-wrap items-baseline justify-between gap-x-3 text-[11px] text-[var(--text-secondary)]">
                <span className="font-mono text-[10px] text-[var(--text-primary)]">{o.ref}</span>
                <span className="tabular-nums">{usdText(o.usd)} per UTC day · set {formatUtc(o.updatedAt)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">{overridesSentence(a.overrides.count)} {OVERRIDES_DOORWAY}</p>
        <p className="text-[11px] leading-relaxed text-[var(--text-muted)]" role="note">{a.enforcementNote}</p>
      </div>
    </PolicyCard>
  );
}

function AlertCard({ card, model, editable, onModel }: { card: "userAlert" | "fleetAlert"; model: AiCostControlsReadModel; editable: boolean; onModel: (m: AiCostControlsReadModel) => void }) {
  const v = model[card];
  const firing = firingText(v.status, formatUtc);
  return (
    <PolicyCard card={card} model={model} editable={editable} onModel={onModel} state={stateWord(v.enabled.value)}>
      <ControlFacts view={v.enabled} />
      <ControlFacts view={v.thresholdUsd} />
      <div className="flex flex-col gap-1.5">
        <KeyRow label="Rule" value={<span className="font-mono text-[10px]">{v.ruleId}</span>} />
        <KeyRow label="Status" value={<ToneBadge word={firing.word} tone={firing.tone} />} />
        {v.status.recent.length === 0 ? (
          <p className="text-[11px] text-[var(--text-muted)]" role="status">No recent triggers in the retained evaluation runs.</p>
        ) : (
          <ul className="flex flex-col gap-0.5" aria-label="Recent triggers">
            {v.status.recent.map((t, i) => (
              <li key={`${t.dedupeKey}:${i}`} className="flex flex-wrap items-baseline justify-between gap-x-3 text-[11px] text-[var(--text-secondary)]">
                <span className="min-w-0"><ToneBadge word={t.severity} tone={t.severity === "critical" ? "bad" : "warn"} /> {t.summary}</span>
                <span className="shrink-0 tabular-nums text-[var(--text-muted)]">delivered {formatUtc(t.at)}</span>
              </li>
            ))}
          </ul>
        )}
        {card === "fleetAlert" && <p className="text-[11px] leading-relaxed text-[var(--text-muted)]" role="note">{FLEET_SCOPE_SENTENCE}</p>}
      </div>
    </PolicyCard>
  );
}

/** THE EMERGENCY CONTROL: its own region and state word, the sentence customers read, confirmation in both directions. */
function KillSwitchCard({ model, editable, onModel }: { model: AiCostControlsReadModel; editable: boolean; onModel: (m: AiCostControlsReadModel) => void }) {
  const k = model.killSwitch;
  const c = useCard("killSwitch", model, onModel);
  const paused = k.paused.value;
  const offerRestore = editable && restoreDefaultsChanges(model, "killSwitch").length > 0;
  // The flip is drafted and ARMED at open: opening is step one, Confirm pause / Confirm resume with the reason is step two.
  const control = c.mode !== "view"
    ? <CardEditor key={c.mode} card="killSwitch" model={model} draft={c.draft} armed={c.armed} intent={c.mode} busy={c.busy} notice={c.notice} onDraft={c.onDraft} onSave={c.save} onReset={c.restore} onCancel={c.cancel} />
    : <Affordances notice={c.notice}
        edit={editable ? {
          label: paused ? "Resume paid requests" : "Pause paid requests",
          icon: paused ? <Play size={11} aria-hidden /> : <Pause size={11} aria-hidden />,
          onClick: () => c.open("edit", { "killSwitch.paused": !paused }, true),
        } : null}
        restore={offerRestore ? () => c.open("reset") : null} />;
  return (
    <div className="flex flex-col gap-2 border-t pt-6" style={{ borderColor: "var(--border-hairline-strong)" }} role="region" aria-label={EMERGENCY_LABEL}>
      <span className="text-[10px] font-medium uppercase tracking-wide" style={{ color: "var(--brass-300)" }}>{EMERGENCY_LABEL}</span>
      <CardShell card="killSwitch" state={pausedWord(paused)} control={control}>
        <ControlFacts view={k.paused} />
        <div className="flex flex-col gap-1.5">
          <KeyRow label="Customers read while paused" value={<q>{k.customerMessage}</q>} />
          <p className="text-[11px] leading-relaxed text-[var(--text-muted)]" role="note">{KILL_SWITCH_NOTE}</p>
        </div>
      </CardShell>
    </div>
  );
}

// ── The panel ─────────────────────────────────────────────────────────────────

/** Prop-driven and fetch-free: the host passes the shared read and the publish side. `editable` only decides whether affordances RENDER. */
export function AiCostControlsPanel({ state, editable = false, onModel = () => {} }: {
  state: SharedFetchState<AiCostControlsReadModel>;
  editable?: boolean;
  onModel?: (model: AiCostControlsReadModel) => void;
}) {
  const data = state.error ? null : state.data;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <GroupLabel hint={AI_COST_CONTROLS_SENTENCE}>{AI_COST_CONTROLS_TITLE}</GroupLabel>
        <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">{AI_COST_CONTROLS_SENTENCE}</p>
      </div>
      {state.loading ? (
        <p className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]" role="status"><Loader2 size={12} className="animate-spin" aria-hidden /> {LOADING_TEXT}</p>
      ) : !data ? (
        <p className="flex items-start gap-1.5 text-xs" style={{ color: TONE_COLOR.bad }} role="alert"><AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden /><span>{unavailableText(AI_COST_CONTROLS_SUBJECT)}</span></p>
      ) : (
        <>
          <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">{propagationText(data.propagation)} · checked {formatUtc(data.checkedAt)}</p>
          <div className="grid gap-8 md:grid-cols-3">
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
