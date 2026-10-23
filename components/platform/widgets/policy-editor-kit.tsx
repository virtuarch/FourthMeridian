"use client";

/**
 * components/platform/widgets/policy-editor-kit.tsx  (PLATFORM OPS POLICIES — the shared editor grammar)
 *
 * THE ONE EDITOR LAYOUT every declared-policy editor on the Policies surface
 * shares (UX-P1 4A.3 §4 + D7), lifted out of OpsPoliciesWidget.tsx so the AI
 * Cost Controls panel (AiCostControlsPanel.tsx) can use it without a circular
 * import:
 *
 *   value control (the caller's) → consequences → [warning] → reason select over
 *   OPERATOR_REASON_CODES with NO default → optional note → notice →
 *   Save / Reset / Cancel. Reset is two-step inside the form (arm, then confirm).
 *
 * Also here: the button and field styles, the Notice, the mutation call (the
 * ONLY network write idiom on the surface — 200 applied · 409 conflict with the
 * canonical model · 403 not authorized · otherwise refused with the server's
 * sentence) and `useSettle`, which applies `resolveMutationOutcome` from
 * policies-view.ts (pure, tested) to the React state.
 *
 * The SERVER is the authority. Nothing here decides who may write; the caller
 * decides only whether the affordance is RENDERED. No polling, no router, no
 * raw colour — tokens only.
 */

import { useState, type ReactNode } from "react";
import { Check, Loader2, RotateCcw, X } from "lucide-react";
import { OPERATOR_REASON_CODES, type OperatorReasonCode } from "@/lib/audit";
import { TONE_COLOR } from "../platform-surface";
import {
  CONFLICT_TEXT, NOTE_PLACEHOLDER, REASON_PLACEHOLDER, RESET_TEXT, formatUtc, resolveMutationOutcome, type MutationOutcome, type PolicyNotice,
} from "./policies-view";

export { formatUtc };
export type { MutationOutcome, PolicyNotice };

export type OperatorReasonInput = { code: OperatorReasonCode; note?: string };

// ── Styles (tokens only) ──────────────────────────────────────────────────────

export const BTN = "flex min-h-11 items-center justify-center gap-1 rounded-[var(--radius-sm)] border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]";
export const BTN_QUIET = { background: "color-mix(in srgb, var(--meridian-400) 10%, transparent)", color: "var(--meridian-400)", borderColor: "color-mix(in srgb, var(--meridian-400) 24%, transparent)" };
export const BTN_PRIMARY = { background: "color-mix(in srgb, var(--brass-300) 14%, transparent)", color: "var(--brass-300)", borderColor: "color-mix(in srgb, var(--brass-300) 30%, transparent)" };
export const BTN_NEUTRAL = { background: "transparent", color: "var(--text-muted)", borderColor: "var(--border-hairline)" };
export const FIELD = "min-h-11 min-w-0 max-w-full rounded-[var(--radius-sm)] border bg-transparent px-2 py-1 text-base text-[var(--text-primary)] sm:text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]";

// ── Notice ────────────────────────────────────────────────────────────────────

export function Notice({ notice }: { notice: PolicyNotice | null }) {
  if (!notice) return null;
  const token = notice.tone === "ok" ? TONE_COLOR.ok : notice.tone === "warn" ? TONE_COLOR.warn : TONE_COLOR.bad;
  return (
    <p className="text-[11px] leading-relaxed" style={{ color: token }} role={notice.tone === "ok" ? "status" : "alert"}>
      {notice.text}
    </p>
  );
}

// ── The form ──────────────────────────────────────────────────────────────────

/**
 * `intent` "reset" hides the value control and arms the two-step reset from the
 * start (the view-mode "Reset to default" button opens the form that way). In
 * "edit" intent the form's own Reset button arms it; the second click confirms.
 * The reason has no default: Save and Confirm reset stay disabled until the
 * operator chooses one.
 *
 * The four optional wording props are additive (AI COST CONTROLS): a caller
 * whose Save is itself confirmation-gated renames the button and shows the
 * governing sentence as `warning` once the operator has armed it; a caller
 * whose reset means "restore the code-owned defaults" renames the reset pair
 * and supplies its own reset sentence. Defaults reproduce the cadence editors
 * exactly. Prop-driven.
 */
export function CadenceForm({
  ariaLabel, intent, control, consequences, busy, notice, canSave, canReset, onSave, onReset, onCancel, dirty,
  saveLabel = "Save", resetLabel = "Reset to default", confirmResetLabel = "Confirm reset", resetText = RESET_TEXT, warning = null,
}: {
  ariaLabel: string;
  intent: "edit" | "reset";
  control: ReactNode;
  consequences: readonly string[];
  busy: boolean;
  notice: PolicyNotice | null;
  /** The value control's own gate (changed + in bounds); the reason gate is added here. */
  canSave: boolean;
  /** Unsaved input, including an invalid draft that cannot yet be saved. */
  dirty?: boolean;
  /** Whether an override exists to reset. */
  canReset: boolean;
  onSave: (reason: OperatorReasonInput) => void;
  onReset: (reason: OperatorReasonInput) => void;
  onCancel: () => void;
  saveLabel?: string;
  resetLabel?: string;
  confirmResetLabel?: string;
  resetText?: string;
  /** A sentence the operator must read before the (armed) Save — rendered as an alert in the caution tone. */
  warning?: ReactNode;
}) {
  const [code, setCode] = useState<OperatorReasonCode | "">("");
  const [note, setNote] = useState("");
  const [armed, setArmed] = useState(intent === "reset");
  const reason = (): OperatorReasonInput | null => (code === "" ? null : note.trim() ? { code, note: note.trim() } : { code });
  const hasReason = code !== "";
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-3" role="group" aria-label={ariaLabel}>
      {!armed && control}
      {!armed && consequences.map((line) => (
        <p key={line} className="text-[11px] leading-relaxed text-[var(--text-secondary)]">{line}</p>
      ))}
      {!armed && warning && (
        <p className="text-[11px] leading-relaxed" style={{ color: TONE_COLOR.warn }} role="alert">{warning}</p>
      )}
      {armed && <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">{resetText}</p>}
      <label className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-secondary)]">
        Reason
        <select value={code} onChange={(e) => setCode(e.target.value as OperatorReasonCode | "")} disabled={busy} required className={FIELD} style={{ borderColor: "var(--border-hairline)" }}>
          <option value="">{REASON_PLACEHOLDER}</option>
          {OPERATOR_REASON_CODES.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ").toLowerCase()}</option>)}
        </select>
      </label>
      <input type="text" value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} maxLength={280} placeholder={NOTE_PLACEHOLDER}
        aria-label="Reason note (optional)" className={FIELD} style={{ borderColor: "var(--border-hairline)" }} />
      <Notice notice={notice} />
      <div className="flex flex-wrap items-center gap-2">
        {!armed && (
          <button type="button" onClick={() => { const r = reason(); if (r) onSave(r); }} disabled={busy || !canSave || !hasReason} className={BTN} style={BTN_PRIMARY}>
            {busy ? <Loader2 size={11} className="animate-spin" aria-hidden /> : <Check size={11} aria-hidden />} {saveLabel}
          </button>
        )}
        {canReset && !armed && (
          <button type="button" onClick={() => setArmed(true)} disabled={busy} className={BTN} style={BTN_NEUTRAL}>
            <RotateCcw size={11} aria-hidden /> {resetLabel}
          </button>
        )}
        {armed && (
          <button type="button" onClick={() => { const r = reason(); if (r) onReset(r); }} disabled={busy || !hasReason} className={BTN} style={BTN_PRIMARY}>
            {busy ? <Loader2 size={11} className="animate-spin" aria-hidden /> : <RotateCcw size={11} aria-hidden />} {confirmResetLabel}
          </button>
        )}
        <button type="button" onClick={armed && intent === "edit" ? () => setArmed(false) : () => {
          if (((dirty ?? canSave) || code !== "" || note !== "") && !window.confirm("Discard unsaved policy changes?")) return;
          onCancel();
        }} disabled={busy} className={BTN} style={BTN_NEUTRAL}>
          <X size={11} aria-hidden /> {armed && intent === "edit" ? "Keep editing" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

// ── The mutation call — the ONLY network write idiom on the surface ───────────

export async function mutate<M>(url: string, method: "PATCH" | "DELETE", body: Record<string, unknown>, subject: string): Promise<MutationOutcome<M>> {
  try {
    const r = await fetch(url, { method, credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = (await r.json().catch(() => null)) as M | { error?: string; model?: M } | null;
    if (r.ok) return { kind: "applied", model: json as M };
    const refusal = json as { error?: string; model?: M } | null;
    if (r.status === 409 && refusal?.model) return { kind: "conflict", model: refusal.model, reason: refusal.error ?? CONFLICT_TEXT };
    if (r.status === 403) return { kind: "failed", reason: `Not authorized to change this ${subject}.` };
    return { kind: "refused", reason: refusal?.error ?? `Request failed (${r.status})`, model: refusal?.model ?? null };
  } catch (e) {
    return { kind: "failed", reason: e instanceof Error ? e.message : "The request could not be sent." };
  }
}

/** Shared outcome handling: publish the canonical model, close the editor, tell the operator (the pure rule lives in policies-view.ts). */
export function useSettle<M>(onModel: (m: M) => void) {
  const [notice, setNotice] = useState<PolicyNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const settle = (outcome: MutationOutcome<M>, appliedText: string, close: () => void) => {
    const r = resolveMutationOutcome(outcome, appliedText);
    if (r.model) onModel(r.model);
    if (r.close) close();
    setNotice(r.notice);
  };
  return { notice, setNotice, busy, setBusy, settle };
}
