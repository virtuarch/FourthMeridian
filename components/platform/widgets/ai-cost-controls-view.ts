/**
 * components/platform/widgets/ai-cost-controls-view.ts  (AI COST CONTROLS — Agent B)
 *
 * THE PURE WORDING AND THE PURE MUTATION SHAPES behind Policies → "AI Cost
 * Controls" (AiCostControlsPanel.tsx) and the per-customer allowance override
 * editor in Customer Success (CsCustomersWidget.tsx). Everything an operator
 * reads about a control — its origin chip, its provenance line, its legend, the
 * consequence of a draft, the confirmation it needs — and everything the panel
 * SENDS (the PATCH body, built from the controls that actually changed, each
 * with the version the operator read) is derived here from the frozen read
 * model in lib/platform/ai/cost-controls.types.ts.
 *
 * Every dollar is an ESTIMATE and the surface says so; no sentence here claims
 * billing accuracy. No React, no clock, no fetch: deterministic under test.
 */

import {
  AI_COST_CONTROL_CONFIRMATION, AI_COST_CONTROL_DEFAULTS,
  type AiCostControlChange, type AiCostControlKey, type AiCostControlsPatchBody, type AiCostControlsReadModel,
  type AlertControlsView, type AllowanceControlsView, type ControlOrigin, type ControlValueView,
} from "@/lib/platform/ai/cost-controls.types";

export const AI_COST_CONTROLS_SUBJECT = "AI cost controls";
export const AI_COST_CONTROLS_TITLE = "AI Cost Controls";

export const AI_COST_CONTROLS_SENTENCE =
  "Every dollar here is an estimate from the code-owned rate card over the invocation ledger — never a bill. " +
  "The allowance is judged per customer per UTC day; the two spend alerts judge the trailing 24 hours; the pause refuses every new paid request. " +
  "A change requires a reason and applies to the next decision; nothing already spent or recorded changes.";

export const AI_COST_CONTROLS_FOOTNOTE =
  "Values in force are resolved from platform settings at read time; a missing row is the code-owned default and an unreadable row leaves the default in force and says so. " +
  "Changing a control runs nothing now; the next admission, evaluation or turn applies it.";

export const FLEET_SCOPE_SENTENCE =
  "Fleet counts customer surfaces only (Conversations and the Daily Brief). Harness and operator traffic is overhead and never part of the fleet signal.";

export const EMERGENCY_LABEL = "Emergency control";
export const KILL_SWITCH_NOTE = "No allowance, overlay or override lifts a pause; it is judged before the allowance on every surface, including harness runs.";

export const RESTORE_TEXT =
  "Remove the stored values of this control so the code-owned defaults are in force again. Nothing already spent or recorded changes; the next decision applies the defaults.";
export const SAVED_TEXT = "Saved. The new values are in force for the next decision.";
export const RESTORED_TEXT = "Restored. The code-owned defaults are in force for the next decision.";
export const OVERRIDES_DOORWAY = "Per-customer overrides are changed in Customer Success, on the customer's policy.";

// ── Cards ─────────────────────────────────────────────────────────────────────

export type CardKey = "allowance" | "userAlert" | "fleetAlert" | "killSwitch";

export const CARD_CONTROLS: Readonly<Record<CardKey, readonly AiCostControlKey[]>> = {
  allowance:  ["allowance.enforced", "allowance.usd"],
  userAlert:  ["userAlert.enabled", "userAlert.thresholdUsd"],
  fleetAlert: ["fleetAlert.enabled", "fleetAlert.thresholdUsd"],
  killSwitch: ["killSwitch.paused"],
};

export const CARD_TITLE: Readonly<Record<CardKey, string>> = {
  allowance:  "Per-user daily AI allowance",
  userAlert:  "Per-user spending alert",
  fleetAlert: "Fleet-wide spending alert",
  killSwitch: "Pause paid AI requests",
};

export const CARD_DESCRIPTION: Readonly<Record<CardKey, string>> = {
  allowance:  "The estimated USD a customer may cause per UTC day before their next turn is refused; overlays and per-customer overrides take precedence and the ceiling clamps last.",
  userAlert:  "Delivers an alert when one customer's estimated spend over the trailing 24 hours reaches the threshold.",
  fleetAlert: "Delivers an alert when estimated customer spend across the fleet over the trailing 24 hours reaches the threshold.",
  killSwitch: "Refuses every new paid AI request on every surface until resumed. An emergency control, separate from the allowance.",
};

/** The two words a boolean control reads as — true first. */
export const BOOL_WORDS: Readonly<Record<AiCostControlKey, readonly [string, string] | null>> = {
  "allowance.enforced":     ["Enforced", "Not enforced"],
  "allowance.usd":          null,
  "userAlert.enabled":      ["Enabled", "Disabled"],
  "userAlert.thresholdUsd": null,
  "fleetAlert.enabled":     ["Enabled", "Disabled"],
  "fleetAlert.thresholdUsd":null,
  "killSwitch.paused":      ["Paused", "Admitting"],
};

export type AnyControlView = ControlValueView<boolean> | ControlValueView<number>;

/** The read model's view for one control key. */
export function modelView(model: AiCostControlsReadModel, control: AiCostControlKey): AnyControlView {
  switch (control) {
    case "allowance.enforced":      return model.allowance.enforced;
    case "allowance.usd":           return model.allowance.usd;
    case "userAlert.enabled":       return model.userAlert.enabled;
    case "userAlert.thresholdUsd":  return model.userAlert.thresholdUsd;
    case "fleetAlert.enabled":      return model.fleetAlert.enabled;
    case "fleetAlert.thresholdUsd": return model.fleetAlert.thresholdUsd;
    case "killSwitch.paused":       return model.killSwitch.paused;
  }
}

export function cardViews(model: AiCostControlsReadModel, card: CardKey): AnyControlView[] {
  return CARD_CONTROLS[card].map((c) => modelView(model, c));
}

// ── Reading one control ───────────────────────────────────────────────────────

export function usdText(n: number): string {
  return `$${n}`;
}

/** The value in force, in the control's own words ("$5" · "Enforced" · "Paused"). */
export function valueText(view: AnyControlView): string {
  if (typeof view.value === "boolean") {
    const words = BOOL_WORDS[view.control];
    return words ? (view.value ? words[0] : words[1]) : view.value ? "on" : "off";
  }
  return usdText(view.value);
}

function rawText(view: AnyControlView, v: boolean | number): string {
  if (typeof v === "boolean") {
    const words = BOOL_WORDS[view.control];
    return words ? (v ? words[0] : words[1]) : v ? "on" : "off";
  }
  return usdText(v);
}

export type OriginChipWord = "Default" | "Setting" | "Default in force — stored value invalid";

/** The origin chip beside the effective value. Never presents an invalid row as configured. */
export function originChip(origin: ControlOrigin): OriginChipWord {
  switch (origin) {
    case "DEFAULT":         return "Default";
    case "SETTING":         return "Setting";
    case "INVALID_SETTING": return "Default in force — stored value invalid";
  }
}

/** "Platform default" · "Set 14 Oct 2026, 09:00 UTC by Chris" · "Default in force — stored value is invalid". */
export function controlProvenance(view: Pick<AnyControlView, "origin" | "updatedAt" | "updatedByName">, formatDate: (iso: string) => string): string {
  switch (view.origin) {
    case "DEFAULT": return "Platform default";
    case "INVALID_SETTING": return "Default in force — stored value is invalid";
    case "SETTING": {
      const when = view.updatedAt ? ` ${formatDate(view.updatedAt)}` : "";
      const by = view.updatedByName ? ` by ${view.updatedByName}` : "";
      return `Set${when}${by}`;
    }
  }
}

/** "Last updated 14 Oct 2026, 09:00 UTC by Chris" · "Never set". */
export function lastUpdatedText(view: Pick<AnyControlView, "updatedAt" | "updatedByName">, formatDate: (iso: string) => string): string {
  if (!view.updatedAt) return "Never set";
  const by = view.updatedByName ? ` by ${view.updatedByName}` : "";
  return `Last updated ${formatDate(view.updatedAt)}${by}`;
}

/** A stored row exists (something to restore): the row's version is known, or the origin says a row is there. */
export function hasStoredRow(view: Pick<AnyControlView, "origin" | "updatedAt">): boolean {
  return view.updatedAt !== null || view.origin !== "DEFAULT";
}

/** The configured (stored) value as a word: the stored value, "not set", or "unreadable". */
export function configuredText(view: AnyControlView): string {
  switch (view.origin) {
    case "SETTING":         return valueText(view);
    case "DEFAULT":         return "not set";
    case "INVALID_SETTING": return "unreadable";
  }
}

export interface ControlLegendItem { label: "Default" | "Setting" | "Max"; value: string }

/** Default · Setting · Max — the three chips under a control's figure (Max only when bounded). */
export function controlLegend(view: AnyControlView): ControlLegendItem[] {
  const items: ControlLegendItem[] = [
    { label: "Default", value: rawText(view, view.defaultValue) },
    { label: "Setting", value: view.origin === "SETTING" ? valueText(view) : view.origin === "INVALID_SETTING" ? "invalid" : "—" },
  ];
  if (view.bounds) items.push({ label: "Max", value: usdText(view.bounds.max) });
  return items;
}

export function stateWord(enabled: boolean): { word: "Enabled" | "Disabled"; tone: "ok" | "muted" } {
  return enabled ? { word: "Enabled", tone: "ok" } : { word: "Disabled", tone: "muted" };
}

export function enforcedWord(enforced: boolean): { word: "Enforced" | "Not enforced"; tone: "ok" | "warn" } {
  return enforced ? { word: "Enforced", tone: "ok" } : { word: "Not enforced", tone: "warn" };
}

export function pausedWord(paused: boolean): { word: "Paused" | "Admitting"; tone: "bad" | "ok" } {
  return paused ? { word: "Paused", tone: "bad" } : { word: "Admitting", tone: "ok" };
}

// ── Allowance wording ─────────────────────────────────────────────────────────

export function sourceText(source: string): string {
  switch (source) {
    case "USER_OVERRIDE":    return "customer override";
    case "OVERLAY":          return "overlay";
    case "PLATFORM_SETTING": return "platform setting";
    case "POLICY":           return "policy group";
    case "CEILING":          return "ceiling";
    default:                 return source.replace(/_/g, " ").toLowerCase();
  }
}

/** "$5 per UTC day for a customer on the default policy with no overlay and no override (platform setting) · ceiling $20". */
export function effectiveDefaultText(a: Pick<AllowanceControlsView, "effectiveDefaultUsd" | "effectiveDefaultSource" | "ceilingUsd">): string {
  return `${usdText(a.effectiveDefaultUsd)} per UTC day for a customer on the default policy with no overlay and no override (${sourceText(a.effectiveDefaultSource)}) · ceiling ${usdText(a.ceilingUsd)}`;
}

/** "No per-customer overrides." · "3 per-customer overrides in force." */
export function overridesSentence(count: number): string {
  if (count === 0) return "No per-customer overrides.";
  return `${count} per-customer override${count === 1 ? "" : "s"} in force.`;
}

// ── Alert wording ─────────────────────────────────────────────────────────────

/** "Firing now" · "Last fired 14 Oct 2026, 09:00 UTC" · "Never fired" · "Awaiting authority" (not live). */
export function firingText(status: AlertControlsView["status"], formatDate: (iso: string) => string): { word: string; tone: "bad" | "muted" | "ok" } {
  if (!status.live) return { word: "Awaiting authority", tone: "muted" };
  if (status.firingNow) return { word: "Firing now", tone: "bad" };
  if (status.lastFiredAt) return { word: `Last fired ${formatDate(status.lastFiredAt)}`, tone: "ok" };
  return { word: "Never fired", tone: "muted" };
}

export function propagationText(p: AiCostControlsReadModel["propagation"]): string {
  return p.cached ? `Cached — ${p.note}` : p.note;
}

// ── The draft → changes → PATCH body ─────────────────────────────────────────

/** What the editor holds while the operator types: booleans as chosen, numbers as the RAW string (nothing is coerced until validation). */
export type ControlDraft = Partial<Record<AiCostControlKey, boolean | string>>;

/** The editor's starting draft: every control at its value in force. */
export function draftFromModel(model: AiCostControlsReadModel, card: CardKey): ControlDraft {
  const draft: ControlDraft = {};
  for (const control of CARD_CONTROLS[card]) {
    const v = modelView(model, control);
    draft[control] = typeof v.value === "boolean" ? v.value : String(v.value);
  }
  return draft;
}

/** Validation of a whole-dollar threshold BEFORE submission: an integer within the read model's bounds. */
export function validateThresholdInput(raw: string, view: Pick<ControlValueView<number>, "bounds">): { value: number | null; error: string | null } {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null, error: "Enter a whole-dollar amount." };
  if (!/^-?\d+$/.test(trimmed)) return { value: null, error: "Enter a whole number of dollars (no cents)." };
  const n = Number.parseInt(trimmed, 10);
  const min = view.bounds?.min ?? 1;
  const max = view.bounds?.max ?? Number.MAX_SAFE_INTEGER;
  if (n < min || n > max) return { value: null, error: `Must be between ${usdText(min)} and ${usdText(max)}.` };
  return { value: n, error: null };
}

export interface DraftResolution {
  /** Only the controls whose drafted value differs from the value in force (an invalid stored row counts as changed, so Save replaces it). */
  changes: AiCostControlChange[];
  /** Validation sentences by control, shown before submission; a card with any error cannot save. */
  errors: Partial<Record<AiCostControlKey, string>>;
}

export function resolveDraft(model: AiCostControlsReadModel, card: CardKey, draft: ControlDraft): DraftResolution {
  const changes: AiCostControlChange[] = [];
  const errors: Partial<Record<AiCostControlKey, string>> = {};
  for (const control of CARD_CONTROLS[card]) {
    const view = modelView(model, control);
    const drafted = draft[control];
    if (drafted === undefined) continue;
    const replacingInvalid = view.origin === "INVALID_SETTING";
    if (typeof view.value === "boolean") {
      if (typeof drafted !== "boolean") continue;
      if (drafted !== view.value || replacingInvalid) changes.push({ control, value: drafted, expectedUpdatedAt: view.updatedAt });
    } else {
      if (typeof drafted !== "string") continue;
      const v = validateThresholdInput(drafted, view as ControlValueView<number>);
      if (v.error !== null || v.value === null) { errors[control] = v.error ?? "Invalid value."; continue; }
      if (v.value !== view.value || replacingInvalid) changes.push({ control, value: v.value, expectedUpdatedAt: view.updatedAt });
    }
  }
  return { changes, errors };
}

/** Restore defaults: `value: null` for every control of the card that has a stored row — the row is deleted, never written as if configured. */
export function restoreDefaultsChanges(model: AiCostControlsReadModel, card: CardKey): AiCostControlChange[] {
  return cardViews(model, card)
    .filter((v) => hasStoredRow(v))
    .map((v) => ({ control: v.control, value: null, expectedUpdatedAt: v.updatedAt }));
}

/** ONE PATCH per Save: the changed controls (each with the version the operator read) and the reason. */
export function patchBody(changes: readonly AiCostControlChange[], reason: { code: string; note?: string }): AiCostControlsPatchBody {
  return { changes: [...changes], reason: reason.note ? { code: reason.code, note: reason.note } : { code: reason.code } };
}

/**
 * The confirmation sentences a set of changes needs (AI_COST_CONTROL_CONFIRMATION):
 * disabling enforcement; pausing OR resuming. A `null` (restore) resolves to the
 * default so a restore that lifts a pause still confirms.
 */
export function confirmationSentences(changes: readonly AiCostControlChange[]): string[] {
  const out: string[] = [];
  for (const c of changes) {
    const rule = AI_COST_CONTROL_CONFIRMATION[c.control];
    if (!rule) continue;
    const to = c.value === null ? AI_COST_CONTROL_DEFAULTS[c.control] : c.value;
    if (typeof to !== "boolean") continue;
    const direction = to ? "ENABLE" : "DISABLE";
    if (rule.when === "ANY" || rule.when === direction) out.push(rule.sentence);
  }
  return out;
}

/** The Save button's word once the operator has armed a confirmation-gated change. */
export function confirmLabel(changes: readonly AiCostControlChange[]): string {
  const ks = changes.find((c) => c.control === "killSwitch.paused");
  if (ks) {
    const to = ks.value === null ? AI_COST_CONTROL_DEFAULTS["killSwitch.paused"] : ks.value;
    return to ? "Confirm pause" : "Confirm resume";
  }
  return "Confirm and save";
}

/** What a drafted set of changes means, in the operator's terms. Never a billing claim. */
export function cardConsequences(card: CardKey, model: AiCostControlsReadModel, changes: readonly AiCostControlChange[]): string[] {
  const lines: string[] = [];
  const has = (k: AiCostControlKey) => changes.find((c) => c.control === k);
  switch (card) {
    case "allowance": {
      const usd = has("allowance.usd");
      if (usd && typeof usd.value === "number") {
        lines.push(`Customers on the default policy with no overlay and no override would get ${usdText(usd.value)} per UTC day; overlays and per-customer overrides keep precedence and the ${usdText(model.allowance.ceilingUsd)} ceiling clamps last.`);
      }
      lines.push("Nothing already spent changes; the next customer turn is judged against the new values.");
      break;
    }
    case "userAlert":
    case "fleetAlert":
      lines.push("The threshold is judged against the trailing 24 hours at the next evaluation. Disabling the rule stops its evaluation only — usage and estimated cost are still recorded.");
      if (card === "fleetAlert") lines.push(FLEET_SCOPE_SENTENCE);
      break;
    case "killSwitch":
      lines.push(KILL_SWITCH_NOTE);
      break;
  }
  return lines;
}

// ── Customer Success — the per-customer allowance override ───────────────────

/** The field Agent A appends to CustomerPolicyView; optional here so the editor degrades when a build does not carry it. */
export interface AllowanceEffectiveView { usd: number; source: string; override: number | null }

/** Client-side gate: a whole-dollar integer of at least $1. The ceiling is the SERVER's refusal (its sentence is shown), never clamped here. */
export function validateAllowanceOverrideInput(raw: string): { value: number | null; error: string | null } {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null, error: "Enter a whole-dollar amount." };
  if (!/^-?\d+$/.test(trimmed)) return { value: null, error: "Enter a whole number of dollars (no cents)." };
  const n = Number.parseInt(trimmed, 10);
  if (n < 1) return { value: null, error: "Must be at least $1." };
  return { value: n, error: null };
}

/** "$20 per UTC day (overlay) · no override" · "$7 per UTC day (customer override)" · the honest sentence when the field is absent. */
export function allowanceEffectiveText(a: AllowanceEffectiveView | undefined): string {
  if (!a) return "Effective allowance not reported by this build.";
  const override = a.override === null ? "no override" : `override ${usdText(a.override)}`;
  return `${usdText(a.usd)} per UTC day (${sourceText(a.source)}) · ${override} · estimated`;
}

/** The body the CS editor posts: only the override and the reason — group and overlay are never mixed in. */
export function allowanceOverrideBody(override: number | null, reason: { code: string; note?: string }): { aiDailyUsdAllowanceOverride: number | null; reason: { code: string; note?: string } } {
  return { aiDailyUsdAllowanceOverride: override, reason };
}
