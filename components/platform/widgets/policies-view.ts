/**
 * components/platform/widgets/policies-view.ts  (PLATFORM OPS POLICIES — Slice 1)
 *
 * The PURE wording behind the Policies surface. Every sentence an operator reads
 * about a refresh policy is derived here from the read model — so the UI states
 * consequences ("Considered overdue after 8 hours") and never restates the
 * implementation (no enum names, no registry ids, no cron internals).
 *
 * No React, no clock: deterministic under test.
 */

import { DEFAULT_REFRESH_CADENCE, graceHoursFor, type RefreshCadence } from "@/lib/platform/refresh-policy.core";
import type { RefreshPolicyView, RefreshPoliciesReadModel } from "@/lib/platform/policies/refresh-policies.core";
import type { JobCadenceView } from "@/lib/platform/policies/job-cadence";

export const POLICIES_SUBJECT = "refresh policies";

/** "6h" → "Every 6 hours". */
export function cadenceText(cadence: RefreshCadence | string): string {
  const h = Number.parseInt(String(cadence), 10);
  return Number.isFinite(h) ? `Every ${h} hour${h === 1 ? "" : "s"}` : String(cadence);
}

/** "8 hours" — the overdue threshold, in the operator's units. */
export function hoursText(hours: number): string {
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/** The one-line origin reading. Never presents an invalid override as configured. */
export function originText(view: RefreshPolicyView): string {
  switch (view.effective.origin) {
    case "DEFAULT":         return "Platform default";
    case "SETTING":         return "Override set on the platform";
    case "INVALID_SETTING": return "Default in force — stored override is invalid";
  }
}

/** The headline value line: the effective cadence, qualified by its origin. */
export function effectiveHeadline(view: RefreshPolicyView): { value: string; qualifier: string } {
  const value = cadenceText(view.effective.cadence);
  return view.effective.origin === "INVALID_SETTING"
    ? { value: `Default ${value.toLowerCase()}`, qualifier: originText(view) }
    : { value, qualifier: originText(view) };
}

/** "Supported" / "Not supported — reason" for the EFFECTIVE cadence. */
export function schedulerSupportText(view: RefreshPolicyView): { word: string; reason: string | null } {
  if (view.capability.effectiveHonoured) return { word: "Supported", reason: null };
  const opt = view.capability.options.find((o) => o.cadence === view.effective.cadence);
  return { word: "Not supported", reason: opt?.reason ?? "The platform cannot execute this cadence." };
}

/** "6h · 12h · 24h" — the cadences at or above the safety floor. */
export function availableCadencesText(view: RefreshPolicyView): string {
  return view.capability.honourable.length > 0 ? view.capability.honourable.join(" · ") : "None";
}

/** The unsupported menu entries with their reasons, for the fine print. */
export function unsupportedOptions(view: RefreshPolicyView): { cadence: string; reason: string }[] {
  return view.capability.options
    .filter((o) => !o.honourable)
    .map((o) => ({ cadence: o.cadence, reason: o.reason ?? "" }));
}

/**
 * "Executed when due; the platform is woken every 15 minutes · floor 6 hours" —
 * P1: there are no slots to list. The cadence is executed from the ledger at the
 * first wake after it elapses, and the floor is the safety bound the menu stops at.
 */
export function attemptScheduleText(view: RefreshPolicyView): string {
  if (view.capability.floorHours === null) return "No scheduled attempt";
  return `Executed when due; the platform is woken every ${view.capability.wakeEveryMinutes} minutes · floor ${hoursText(view.capability.floorHours)}`;
}

/** The ACTUAL state as a word, with its evidence sentence. */
export function actualText(view: RefreshPolicyView): { word: string; note: string } {
  switch (view.actual.state) {
    case "CURRENT": return { word: "Current", note: view.actual.note };
    case "PENDING": return { word: "Pending", note: view.actual.note };
    case "UNKNOWN": return { word: "Unknown", note: view.actual.note };
  }
}

/** "Never overridden" or when and by whom the override was last written. */
export function lastChangedText(view: RefreshPolicyView, formatDate: (iso: string) => string): string {
  if (!view.desired.present || !view.desired.updatedAt) return "Never overridden";
  const by = view.desired.updatedBy?.name ? ` by ${view.desired.updatedBy.name}` : "";
  return `${formatDate(view.desired.updatedAt)}${by}`;
}

/**
 * The honesty line for the whole surface. UX-P1: the grace rule moved here from
 * the header's actions slot (it is a footnote fact, not a toolbar), and the
 * retired sentence "Nothing here … changes a policy" is gone — this surface IS
 * where policy changes, behind CONTROL, and the line must not deny it.
 */
export function policiesFootnote(grace: RefreshPoliciesReadModel["grace"]): string {
  return (
    "Effective values are resolved from platform settings at read time; the floor is the code-owned safety bound the scheduler can honour; " +
    "the latest sweep is read from the job ledger. " +
    `Grace is code-owned: the larger of ${grace.floorHours} hours and ${Math.round(grace.share * 100)}% of the cadence. ` +
    "Changing a policy refreshes nothing now and requires a reason; the next scheduled attempt applies it."
  );
}

// ── PLATFORM OPS POLICIES (Slice 2) — editor wording ──────────────────────────

/** Scheduled refresh opportunities per day at a cadence the schedule honours. */
export function opportunitiesPerDay(cadenceHours: number): number {
  return Math.round(24 / cadenceHours);
}

/**
 * "≈ half as many scheduled refresh opportunities" — directional, relative to the
 * cadence in force. Never a cost claim: no provider pricing authority exists.
 */
export function opportunityChangeText(fromHours: number, toHours: number): string | null {
  if (fromHours === toHours) return null;
  const ratio = fromHours / toHours;
  const word =
    ratio === 0.5 ? "half as many" : ratio === 0.25 ? "a quarter as many"
    : ratio === 2 ? "twice as many" : ratio === 4 ? "four times as many"
    : ratio < 1 ? `about ${Math.round((1 / ratio) * 10) / 10}× fewer` : `about ${Math.round(ratio * 10) / 10}× more`;
  return `≈ ${word} scheduled refresh opportunities (${opportunitiesPerDay(toHours)} per day instead of ${opportunitiesPerDay(fromHours)})`;
}

/** What choosing `cadence` means, in the operator's terms. Derived from the read model's own numbers. */
export function consequenceLines(view: RefreshPolicyView, cadence: RefreshCadence): string[] {
  const option = view.capability.options.find((o) => o.cadence === cadence);
  if (!option) return [];
  if (!option.honourable) return [option.reason ?? "The platform cannot execute this cadence."];
  const hours = Number.parseInt(cadence, 10);
  // The resolver's own grace rule (refresh-policy.core.ts) — never restated here.
  const lines = [`Sources would be considered overdue after ${hoursText(hours + graceHoursFor(hours))}.`];
  const change = opportunityChangeText(view.effective.expectedEveryHours, hours);
  if (change) lines.push(change);
  lines.push("Changing the cadence refreshes nothing now; the next scheduled attempt applies it.");
  return lines;
}

// ── P1 — execution cadence (per job) wording ──────────────────────────────────

export type JobCadenceOriginWord = "Platform default" | "Override set on the platform" | "Default in force — stored override is invalid" | "Governed by the refresh policy" | "Follows its primary job" | "Fixed";

export function jobCadenceOriginText(origin: string): JobCadenceOriginWord {
  switch (origin) {
    case "SETTING":         return "Override set on the platform";
    case "INVALID_SETTING": return "Default in force — stored override is invalid";
    case "REFRESH_POLICY":  return "Governed by the refresh policy";
    case "FOLLOWS_PRIMARY": return "Follows its primary job";
    case "FIXED":           return "Fixed";
    default:                return "Platform default";
  }
}

/** "Every 6 hours (allowed 1–168)" for an editable job; "Every 24 hours" otherwise. */
export function jobCadenceText(hours: number, editable: boolean, minHours: number, maxHours: number): string {
  const base = cadenceText(String(hours));
  return editable ? `${base} (allowed ${minHours}–${maxHours})` : base;
}

export const JOB_CADENCE_FOOTNOTE =
  "The platform is woken on a fixed infrastructure cadence; whether a job runs at a wake is decided from its last run and the cadence shown here. " +
  "Changing a cadence runs nothing now and requires a reason; the next wake applies it.";

/** Are there honourable cadences other than the one in force? Decides whether Edit is offered. */
export function hasAlternativeCadence(view: RefreshPolicyView): boolean {
  return view.capability.honourable.some((c) => c !== view.effective.cadence);
}

export const CONFLICT_TEXT = "This policy changed since you opened the editor. The current values are shown below; edit again if you still want to change it.";

// ── UX-P1 — legend, provenance, grouping and observation wording ──────────────
//
// One effective-value grammar for every row: the figure, then a four-chip
// legend Default · Override · Floor · Max (defaults, overrides, the hard safety
// floor and the read-only ceiling made distinct by chip, not prose), then a
// Provenance chip naming where the value in force came from. Declared policy
// sits above; what the ledger OBSERVED (latest sweep, last run, next due) is one
// quiet line beneath, never mixed into the declaration.

export interface CadenceLegendItem {
  label: "Default" | "Override" | "Floor" | "Max";
  value: string;
}

/** "24 h" — the chip spelling of an hour count; "none" when there is no bound. */
export function hoursChip(hours: number | null): string {
  return hours === null ? "none" : `${hours} h`;
}

/** The four chips for a financial-refresh policy. Override reads "—" when none is stored. */
export function refreshLegend(view: RefreshPolicyView): CadenceLegendItem[] {
  const menuMax = view.capability.options.reduce((m, o) => Math.max(m, Number.parseInt(o.cadence, 10)), 0);
  const override = !view.desired.present ? "—"
    : view.effective.origin === "INVALID_SETTING" ? `${view.desired.raw ?? ""} (invalid)`
    : hoursChip(view.effective.expectedEveryHours);
  return [
    { label: "Default", value: hoursChip(Number.parseInt(DEFAULT_REFRESH_CADENCE[view.sourceKind], 10)) },
    { label: "Override", value: override },
    { label: "Floor", value: hoursChip(view.capability.floorHours) },
    { label: "Max", value: menuMax > 0 ? hoursChip(menuMax) : "none" },
  ];
}

/** The four chips for an editable job cadence (the registry's own bounds). */
export function jobLegend(view: JobCadenceView): CadenceLegendItem[] {
  const override = view.origin === "SETTING" ? hoursChip(view.hours)
    : view.origin === "INVALID_SETTING" ? "invalid"
    : "—";
  return [
    { label: "Default", value: hoursChip(view.defaultHours) },
    { label: "Override", value: override },
    { label: "Floor", value: hoursChip(view.minHours) },
    { label: "Max", value: hoursChip(view.maxHours) },
  ];
}

/** "Platform default" · "Override set 13 Sep 2026, 18:32 UTC by Chris" · "Default in force — stored override is invalid". */
export function refreshProvenance(view: RefreshPolicyView, formatDate: (iso: string) => string): string {
  switch (view.effective.origin) {
    case "DEFAULT": return "Platform default";
    case "INVALID_SETTING": return "Default in force — stored override is invalid";
    case "SETTING": {
      const when = view.desired.updatedAt ? ` ${formatDate(view.desired.updatedAt)}` : "";
      const by = view.desired.updatedBy?.name ? ` by ${view.desired.updatedBy.name}` : "";
      return `Override set${when}${by}`;
    }
  }
}

/**
 * The job row's provenance. The job read model carries the override's version
 * clock but not its writer, so an override names its date only — a name is
 * never invented.
 */
export function jobProvenance(view: JobCadenceView, formatDate: (iso: string) => string): string {
  switch (view.origin) {
    case "SETTING": return `Override set${view.updatedAt ? ` ${formatDate(view.updatedAt)}` : ""}`;
    case "INVALID_SETTING": return "Default in force — stored override is invalid";
    case "REFRESH_POLICY": return "Refresh policy";
    case "FOLLOWS_PRIMARY": return view.primary ? `Follows ${view.primary}` : "Follows its primary job";
    case "FIXED": return "Fixed";
    default: return "Platform default";
  }
}

export type JobCadenceGroupKey = "editable" | "governed" | "fixed";

export const JOB_GROUP_TEXT: Readonly<Record<JobCadenceGroupKey, { title: string; sentence: string }>> = {
  editable: {
    title: "Editable",
    sentence: "These jobs take an operator-set cadence within the registry's code-owned floor and max. A change requires a reason, runs nothing now, and applies at the next wake.",
  },
  governed: {
    title: "Governed by the refresh policy",
    sentence: "These jobs run at the Bank and Wallet refresh cadences above; the continuation follows its primary job. Change them through the refresh policy, not here.",
  },
  fixed: {
    title: "Fixed",
    sentence: "Maintenance jobs run on a fixed, code-owned cadence. There is no override and nothing to edit.",
  },
};

/** The three declared groups, each keeping the registry's order. */
export function groupJobCadences(jobs: readonly JobCadenceView[]): Record<JobCadenceGroupKey, JobCadenceView[]> {
  const out: Record<JobCadenceGroupKey, JobCadenceView[]> = { editable: [], governed: [], fixed: [] };
  for (const j of jobs) {
    if (j.editable) out.editable.push(j);
    else if (j.origin === "REFRESH_POLICY" || j.origin === "FOLLOWS_PRIMARY") out.governed.push(j);
    else out.fixed.push(j);
  }
  return out;
}

/** "Every 6 hours" — the figure alone; bounds live in the legend now. */
export function jobFigureText(view: JobCadenceView): string {
  return cadenceText(String(view.hours));
}

/** The one quiet observation line under a job row: what the ledger recorded, never what the policy declares. */
export function jobObservationText(view: JobCadenceView, formatDate: (iso: string) => string): string {
  const last = view.lastStartedAt ? `Last run ${formatDate(view.lastStartedAt)}${view.lastStatus ? ` (${view.lastStatus})` : ""}` : "Never ran";
  const next = view.primary ? `next after ${view.primary} defers work` : view.nextDueAt ? `next due ${formatDate(view.nextDueAt)}` : "due at the next wake";
  return `${last} · ${next}`;
}

export const RESET_TEXT = "Remove the stored override so the platform default is in force again. Nothing is refreshed now; the next scheduled attempt applies it.";

// ── AI COST CONTROLS — the shared editor grammar's pure parts ────────────────
//
// The date wording, the notice shape and the outcome resolution moved here from
// the widget so the AI Cost Controls panel (its own file) shares them without a
// circular import. Pure: no React, no clock, no fetch.

/** "13 Sep 2026, 18:32 UTC" — one date wording for the whole Policies surface (and its neighbours). */
export function formatUtc(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const d = new Date(t);
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day}, ${hh}:${mm} UTC`;
}

/** One operator notice: the outcome of the last save/reset, or a refusal. */
export interface PolicyNotice {
  tone: "ok" | "warn" | "bad";
  text: string;
}

/** What a mutation call came back as, after the status mapping (200 / 409 / 400 / 403 / transport). */
export type MutationOutcome<M> =
  | { kind: "applied"; model: M }
  | { kind: "conflict"; model: M; reason: string }
  | { kind: "refused"; reason: string; model: M | null }
  | { kind: "failed"; reason: string };

/**
 * THE ONE OUTCOME RULE every editor on the surface follows:
 *   applied  ⇒ publish the canonical model, close the editor, say it was applied;
 *   conflict ⇒ publish the canonical model (it replaces the surface), close the editor, tell the operator;
 *   refused  ⇒ keep the editor open with the server's sentence; publish the model if the refusal carried one;
 *   failed   ⇒ keep the editor open with the transport / authorization sentence.
 */
export function resolveMutationOutcome<M>(outcome: MutationOutcome<M>, appliedText: string): { model: M | null; close: boolean; notice: PolicyNotice } {
  switch (outcome.kind) {
    case "applied":  return { model: outcome.model, close: true, notice: { tone: "ok", text: appliedText } };
    case "conflict": return { model: outcome.model, close: true, notice: { tone: "warn", text: CONFLICT_TEXT } };
    case "refused":  return { model: outcome.model, close: false, notice: { tone: "bad", text: outcome.reason } };
    case "failed":   return { model: null, close: false, notice: { tone: "bad", text: outcome.reason } };
  }
}
export const REASON_PLACEHOLDER = "Choose a reason…";
export const NOTE_PLACEHOLDER = "Note (optional, no personal data)";
export const FIXED_GROUP_SUMMARY = (n: number) => `Fixed (${n} maintenance job${n === 1 ? "" : "s"})`;
