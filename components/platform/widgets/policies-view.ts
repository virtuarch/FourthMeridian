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

import { graceHoursFor, type RefreshCadence } from "@/lib/platform/refresh-policy.core";
import type { RefreshPolicyView } from "@/lib/platform/policies/refresh-policies.core";

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

/** The honesty line for the whole surface. */
export const POLICIES_FOOTNOTE =
  "Effective values are resolved from platform settings at read time; support is the code-owned safety floor; " +
  "the actual state is read from the job ledger. Nothing here refreshes a source or changes a policy.";

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
