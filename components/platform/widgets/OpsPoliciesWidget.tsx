"use client";

/**
 * components/platform/widgets/OpsPoliciesWidget.tsx  (PLATFORM OPS POLICIES — Slices 1 + 2)
 *
 * FINANCIAL REFRESH POLICY — over /api/platform/platform-ops/policies.
 *
 * One `SectionSurface`, two columns (Bank refresh | Wallet refresh), each led by
 * the EFFECTIVE cadence as a `BigStat` and followed by the consequences an
 * operator needs before touching it:
 *
 *     Source                 Platform default / Override / Default in force — override invalid
 *     Considered overdue     cadence + grace, as hours
 *     Scheduler              Supported / Not supported — and why
 *     Available today        the cadences the deployed scheduler can honour
 *     Latest sweep           Current / Pending / Unknown — from the job ledger
 *     Last changed           when and by whom the override was written
 *
 * ── SLICE 2: THE FIRST CONTROL ───────────────────────────────────────────────
 * For an operator whose resolved access carries `canControl` (a CONTROL grant on
 * Platform Operations), each column offers Edit and, when an override exists,
 * Reset to default. The card stays readable; the editor is a bounded choice of
 * cadence with its consequences, then Save / Cancel.
 *
 *   • The SERVER is the authority. `canControl` only decides whether the
 *     affordance is RENDERED; PATCH/DELETE on the route require fresh CONTROL
 *     and re-validate every rule. A READ or WRITE operator sees exactly the
 *     Slice 1 card with no control at all — never a button that 403s on click.
 *   • Unsupported cadences render disabled with the scheduler's reason; they
 *     cannot be selected, and the server would refuse them anyway.
 *   • Save sends the override version the operator READ (`desired.updatedAt`,
 *     or null for "no override"). A 409 means the policy moved: the canonical
 *     current model replaces the card, the editor closes, and the operator is
 *     told — never a silent retry.
 *   • Every response that carries the read model is PUBLISHED into the
 *     workspace session, so the card shows the canonical result, not a guess.
 *     `actual` therefore stays whatever the ledger says — PENDING or UNKNOWN
 *     after a save, never CURRENT because a write succeeded.
 *
 * `OpsPoliciesWidget` fetches and publishes; `PoliciesSurface`, `PolicyColumn`
 * and `PolicyEditor` render — every state provable by handing them props.
 */

import { useState, type ReactNode } from "react";
import { AlertTriangle, Check, Loader2, Pencil, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import type { PlatformSection } from "../widget-kit";
import { useSharedWidgetFetch, useSharedWidgetPublish, type SharedFetchState } from "../workspace-session";
import { BigStat, GroupLabel, KeyRow, SectionSurface, StatusWord, TONE_COLOR, VRule } from "../platform-surface";
import { LOADING_TEXT, unavailableText } from "./platform-health-view";
import type { PlatformPoliciesRefusal, PlatformPoliciesResponse } from "@/app/api/platform/platform-ops/policies/route";
import type { RefreshPolicyView } from "@/lib/platform/policies/refresh-policies.core";
import type { RefreshCadence } from "@/lib/platform/refresh-policy.core";
import {
  CONFLICT_TEXT, POLICIES_FOOTNOTE, POLICIES_SUBJECT,
  actualText, attemptScheduleText, availableCadencesText, cadenceText, consequenceLines, effectiveHeadline,
  hasAlternativeCadence, hoursText, lastChangedText, schedulerSupportText, unsupportedOptions,
} from "./policies-view";

const POLICIES_URL = "/api/platform/platform-ops/policies";

/** "13 Sep 2026, 18:32 UTC" — one date wording for the whole surface. */
function formatUtc(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const d = new Date(t);
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day}, ${hh}:${mm} UTC`;
}

function ActualWord({ view }: { view: RefreshPolicyView }) {
  const { word } = actualText(view);
  const token =
    view.actual.state === "CURRENT" ? TONE_COLOR.ok
    : view.actual.state === "PENDING" ? TONE_COLOR.warn
    : TONE_COLOR.muted;
  return <StatusWord word={word} token={token} />;
}

// ── Controls (rendered only for canControl) ───────────────────────────────────

const BTN = "flex items-center gap-1 rounded-[var(--radius-sm)] border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide disabled:opacity-40";
const BTN_QUIET = { background: "rgba(125,168,255,.1)", color: "var(--meridian-400)", borderColor: "rgba(125,168,255,.24)" };
const BTN_PRIMARY = { background: "rgba(201,155,60,.14)", color: "var(--brass-300)", borderColor: "rgba(201,155,60,.3)" };
const BTN_NEUTRAL = { background: "transparent", color: "var(--text-muted)", borderColor: "var(--border-hairline)" };

/** One operator notice: the outcome of the last save/reset, or a refusal. */
export interface PolicyNotice {
  tone: "ok" | "warn" | "bad";
  text: string;
}

function Notice({ notice }: { notice: PolicyNotice | null }) {
  if (!notice) return null;
  const token = notice.tone === "ok" ? TONE_COLOR.ok : notice.tone === "warn" ? TONE_COLOR.warn : TONE_COLOR.bad;
  return (
    <p className="text-[11px] leading-relaxed" style={{ color: token }} role={notice.tone === "ok" ? "status" : "alert"}>
      {notice.text}
    </p>
  );
}

/**
 * The bounded cadence editor: every cadence the policy menu knows, honourable
 * ones selectable, unsupported ones disabled with the scheduler's reason, the
 * consequences of the selection, then Save / Cancel. Prop-driven.
 */
export function PolicyEditor({
  view,
  selected,
  busy,
  notice,
  onSelect,
  onSave,
  onCancel,
}: {
  view: RefreshPolicyView;
  selected: RefreshCadence;
  busy: boolean;
  notice: PolicyNotice | null;
  onSelect: (c: RefreshCadence) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const unchanged = selected === view.effective.cadence && view.effective.origin !== "INVALID_SETTING";
  const selectedHonourable = view.capability.options.find((o) => o.cadence === selected)?.honourable ?? false;
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-3" role="group" aria-label={`Edit ${view.label}`}>
      <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Expected refresh cadence</span>
      <div className="flex flex-col gap-1.5">
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
      <div className="flex flex-col gap-1">
        {consequenceLines(view, selected).map((line) => (
          <p key={line} className="text-[11px] leading-relaxed text-[var(--text-secondary)]">{line}</p>
        ))}
      </div>
      <Notice notice={notice} />
      <div className="flex items-center gap-2">
        <button type="button" onClick={onSave} disabled={busy || unchanged || !selectedHonourable} className={BTN} style={BTN_PRIMARY}>
          {busy ? <Loader2 size={11} className="animate-spin" aria-hidden /> : <Check size={11} aria-hidden />} Save
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={BTN} style={BTN_NEUTRAL}>
          <X size={11} aria-hidden /> Cancel
        </button>
      </div>
    </div>
  );
}

/** A two-step reset: the first click asks, the second confirms. Prop-driven. */
export function ResetConfirm({
  view,
  busy,
  notice,
  onConfirm,
  onCancel,
}: {
  view: RefreshPolicyView;
  busy: boolean;
  notice: PolicyNotice | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-3" role="group" aria-label={`Reset ${view.label}`}>
      <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
        Remove the stored override so the platform default is in force again. Nothing is refreshed now; the next scheduled attempt applies it.
      </p>
      <Notice notice={notice} />
      <div className="flex items-center gap-2">
        <button type="button" onClick={onConfirm} disabled={busy} className={BTN} style={BTN_PRIMARY}>
          {busy ? <Loader2 size={11} className="animate-spin" aria-hidden /> : <RotateCcw size={11} aria-hidden />} Confirm reset
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={BTN} style={BTN_NEUTRAL}>
          <X size={11} aria-hidden /> Cancel
        </button>
      </div>
    </div>
  );
}

// ── The mutation calls — the ONLY network writes on this surface ──────────────

type MutationOutcome =
  | { kind: "applied"; model: PlatformPoliciesResponse }
  | { kind: "conflict"; model: PlatformPoliciesResponse; reason: string }
  | { kind: "refused"; reason: string; model: PlatformPoliciesResponse | null }
  | { kind: "failed"; reason: string };

async function mutatePolicy(method: "PATCH" | "DELETE", body: Record<string, unknown>): Promise<MutationOutcome> {
  try {
    const r = await fetch(POLICIES_URL, {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await r.json().catch(() => null)) as PlatformPoliciesResponse | PlatformPoliciesRefusal | { error?: string } | null;
    if (r.ok) return { kind: "applied", model: json as PlatformPoliciesResponse };
    const refusal = json as Partial<PlatformPoliciesRefusal> | null;
    if (r.status === 409 && refusal?.model) return { kind: "conflict", model: refusal.model, reason: refusal.error ?? CONFLICT_TEXT };
    if (r.status === 403) return { kind: "failed", reason: "Not authorized to change this policy." };
    return { kind: "refused", reason: refusal?.error ?? `Request failed (${r.status})`, model: refusal?.model ?? null };
  } catch (e) {
    return { kind: "failed", reason: e instanceof Error ? e.message : "The request could not be sent." };
  }
}

// ── One source kind's column ──────────────────────────────────────────────────

/** Prose plus, for a controller, the affordances. Every figure comes from the read model. */
export function PolicyColumn({
  view,
  canControl,
  onModel,
}: {
  view: RefreshPolicyView;
  canControl: boolean;
  /** The canonical model a mutation returned — published so the surface shows it. */
  onModel: (model: PlatformPoliciesResponse) => void;
}) {
  const headline = effectiveHeadline(view);
  const support = schedulerSupportText(view);
  const unsupported = unsupportedOptions(view);
  const actual = actualText(view);
  const invalid = view.mismatch?.kind === "INVALID_OVERRIDE";

  const [mode, setMode] = useState<"view" | "edit" | "reset">("view");
  const [selected, setSelected] = useState<RefreshCadence>(view.effective.cadence);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<PolicyNotice | null>(null);

  const offerEdit = canControl && (hasAlternativeCadence(view) || invalid);
  const offerReset = canControl && view.desired.present;

  const settle = (outcome: MutationOutcome, appliedText: string) => {
    if (outcome.kind === "applied") {
      onModel(outcome.model);
      setMode("view");
      setNotice({ tone: "ok", text: appliedText });
    } else if (outcome.kind === "conflict") {
      onModel(outcome.model);
      setMode("view");
      setNotice({ tone: "warn", text: CONFLICT_TEXT });
    } else if (outcome.kind === "refused") {
      if (outcome.model) onModel(outcome.model);
      setNotice({ tone: "bad", text: outcome.reason });
    } else {
      setNotice({ tone: "bad", text: outcome.reason });
    }
  };

  const save = async () => {
    setBusy(true); setNotice(null);
    const outcome = await mutatePolicy("PATCH", { sourceKind: view.sourceKind, cadence: selected, expectedUpdatedAt: view.desired.updatedAt });
    setBusy(false);
    settle(outcome, "Saved. The new cadence is in force; the next scheduled attempt applies it.");
  };
  const reset = async () => {
    setBusy(true); setNotice(null);
    const outcome = await mutatePolicy("DELETE", { sourceKind: view.sourceKind, expectedUpdatedAt: view.desired.updatedAt });
    setBusy(false);
    settle(outcome, "Reset. The platform default is in force; the next scheduled attempt applies it.");
  };

  let control: ReactNode = null;
  if (mode === "edit") {
    control = <PolicyEditor view={view} selected={selected} busy={busy} notice={notice} onSelect={setSelected} onSave={save} onCancel={() => { setMode("view"); setNotice(null); }} />;
  } else if (mode === "reset") {
    control = <ResetConfirm view={view} busy={busy} notice={notice} onConfirm={reset} onCancel={() => { setMode("view"); setNotice(null); }} />;
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
          qualifier={headline.qualifier}
          derivation={
            invalid && view.mismatch ? (
              <span className="text-[11px]" style={{ color: TONE_COLOR.warn }} role="alert">
                {view.mismatch.message}
              </span>
            ) : undefined
          }
        />
        <div className="flex flex-col gap-2">
          <KeyRow label="Considered overdue after" value={hoursText(view.effective.overdueAfterHours)} />
          <KeyRow
            label="Scheduler"
            value={<StatusWord word={support.word} token={support.reason ? TONE_COLOR.warn : TONE_COLOR.ok} />}
          />
          {support.reason && (
            <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]" role="note">{support.reason}</p>
          )}
          <KeyRow label="Available with current scheduler" value={availableCadencesText(view)} />
          <KeyRow label="Attempt schedule" value={attemptScheduleText(view)} />
          <KeyRow label="Latest sweep" value={<ActualWord view={view} />} />
          <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">{actual.note}</p>
          <KeyRow label="Last changed" value={lastChangedText(view, formatUtc)} />
        </div>
        {control}
        {unsupported.length > 0 && mode !== "edit" && (
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

/** The presentational surface. Prop-driven and fetch-free. */
export function PoliciesSurface({
  section,
  state,
  canControl = false,
  onModel = () => {},
}: {
  section: PlatformSection;
  state: SharedFetchState<PlatformPoliciesResponse>;
  canControl?: boolean;
  onModel?: (model: PlatformPoliciesResponse) => void;
}) {
  const data = state.error ? null : state.data;
  const actions = data ? (
    <span className="text-[11px] text-[var(--text-muted)]">
      Grace is code-owned: the larger of {data.grace.floorHours} hours and {Math.round(data.grace.share * 100)}% of the cadence.
    </span>
  ) : undefined;

  return (
    <SectionSurface icon={SlidersHorizontal} title={section.label} actions={actions} footnote={POLICIES_FOOTNOTE}>
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
        <div className="flex flex-col gap-8 md:flex-row">
          {data.policies.map((view, i) => (
            <div key={view.sourceKind} className="contents">
              {i > 0 && <VRule />}
              <PolicyColumn view={view} canControl={canControl} onModel={onModel} />
            </div>
          ))}
        </div>
      )}
    </SectionSurface>
  );
}

export function OpsPoliciesWidget({ section, access }: { section: PlatformSection; access?: { canControl: boolean } }) {
  // ONE literal url, one workspace-shared read (OPS-2C-6); mutations publish the
  // canonical model they receive back into that same session entry.
  const state = useSharedWidgetFetch<PlatformPoliciesResponse>(POLICIES_URL);
  const publish = useSharedWidgetPublish<PlatformPoliciesResponse>(POLICIES_URL);
  return <PoliciesSurface section={section} state={state} canControl={access?.canControl ?? false} onModel={publish} />;
}
