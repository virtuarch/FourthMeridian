/**
 * components/platform/incidents/lifecycle-model.ts  (Incident detail — LIFECYCLE view-model, PURE)
 *
 * Owner-approved incident-detail UX (2026-11-08), item 6 "Lifecycle": detection,
 * recurrence, operator actions, recovery, resolution evidence, archive.
 * "Dismiss ≠ resolved; recurrences reopen / link prior."
 *
 * Turns the already-tiered IncidentDetailDTO into the drawer's milestone strip.
 * Presentation only — it derives NO verdict. Every milestone is read from a field
 * the route already put on the wire:
 *   detected / last observed   summary.firstDetectedAt / lastObservedAt
 *   acknowledged               the newest timeline event that moved to
 *                              ACKNOWLEDGED or carried actionCode ACKNOWLEDGE
 *   reopened                   a timeline event with actionCode REOPEN
 *   recovering                 the newest event that moved to RECOVERING
 *   needs verification         incident.state === "stale-unverified" (as of checkedAt)
 *   closed                     summary.resolvedAt + incident.closure + resolutionReasonCode
 *                              + the evidence DIGEST's counts
 *   archived                   archive.archivedAt / retainedUntil
 *   recurrence                 incident.generation + the PREVIOUS_EPISODE /
 *                              NEXT_EPISODE links (ids + their row DTOs)
 *
 * DISMISS ≠ RESOLVED: only closure "recovered" (AUTOMATIC_RECOVERY — success
 * evidence) is a verified recovery. An operator close is never called a
 * recovery: OPERATOR_FIXED is "closed by an operator as fixed — not verified",
 * the other registered operator reason codes are "dismissed", and an operator
 * close with no reason code or an unregistered one is "operator-closed" (closed,
 * reason unknown — neither fixed nor dismissed). A removed connection and a
 * legacy row are closed, not recovered.
 *
 * TEXT RULES: every sentence is fixed text here or a registry wording
 * (lib/platform/incidents/codes.ts). It reads codes, counts, times, enums and
 * opaque ids only — never `detail`, never operator notes, never resolution free
 * text, never provider message text, never an institution or customer id, and
 * never the operator (events carry only actorKind + "audited"). A code a
 * registry does not word is counted, never echoed. Identical on both tiers.
 */

import {
  ACTION_CODES, CAUSE_CODES, EVENT_TYPES, OUTCOME_CODES, RESOLUTION_REASON_CODES, STATE_CODES,
  type IncidentEventType,
} from "@/lib/platform/incidents/codes";
import type { IncidentDetailDTO, IncidentRowDTO } from "@/lib/platform/incidents/investigation-dto";
import type { IncidentTimelineEvent } from "@/lib/platform/incidents/intelligence/types";
import type { StatusTone } from "../platform-surface";
import { STATE_WORD, closureText, whenText } from "./incidents-model";

const n = (v: number) => v.toLocaleString("en-US");
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Key events listed at most (newest kept). The full list is the Timeline disclosure. */
export const KEY_EVENTS_SHOWN = 8;

export type MilestoneKey =
  | "detected" | "acknowledged" | "reopened" | "recovering" | "last-observed" | "needs-verification" | "closed" | "archived";

export interface LifecycleMilestone {
  key: MilestoneKey;
  label: string;
  /** ISO time, or null when the milestone holds but its time was not recorded / is "as of now". */
  at: string | null;
  /** The time in words ("3 Nov 2026 14:02 UTC", "Time not recorded", "As of …"). */
  when: string;
  /** Fixed wording only. */
  note: string | null;
  tone: StatusTone;
}

export type ClosureOutcome = "verified-recovery" | "operator-fixed" | "operator-closed" | "dismissed" | "subject-removed" | "legacy";

export interface LifecycleClosure {
  kind: NonNullable<IncidentRowDTO["closure"]>;
  outcome: ClosureOutcome;
  /** True ONLY for a verified recovery (success evidence). Dismiss ≠ resolved. */
  verifiedRecovery: boolean;
  headline: string;
  /** Registry wording of the reason code, or null (none / unregistered — never echoed). */
  reason: string | null;
  /** A reason code was recorded that the registry does not word. */
  unregisteredReason: boolean;
  /** "2 success proofs · last proof …" from the evidence digest (counts only), or null. */
  evidence: string | null;
  derived: boolean;
}

export interface EpisodeLink {
  id: string;
  generation: number | null;
  /** Fixed words: closure / state of the linked episode, or "No longer retained". */
  outcome: string;
  retained: boolean;
}

export interface LifecycleRecurrence {
  generation: number;
  line: string;
  previous: EpisodeLink | null;
  next: EpisodeLink | null;
}

export interface LifecycleEventSummary { type: string; label: string; count: number }

export interface LifecycleKeyEvent {
  at: string;
  when: string;
  title: string;
  /** Registry / fixed words only. */
  parts: string[];
}

export interface LifecycleView {
  milestones: LifecycleMilestone[];
  closure: LifecycleClosure | null;
  recurrence: LifecycleRecurrence;
  events: {
    source: IncidentDetailDTO["timeline"]["source"];
    total: number;
    truncated: boolean;
    /** "4 events recorded · 1 failure observed · 2 state changes · 1 operator action" */
    line: string;
    byType: LifecycleEventSummary[];
    key: LifecycleKeyEvent[];
    keyTruncated: boolean;
  };
}

// ── fixed words ─────────────────────────────────────────────────────────────

/** Persisted lifecycle states (STATE_CODES) in words. */
export const STATE_CODE_WORD: Readonly<Record<(typeof STATE_CODES)[number], string>> = {
  ACTIVE: "Active", ACKNOWLEDGED: "Acknowledged", RECOVERING: "Recovering", STALE: "Needs verification", RESOLVED: "Resolved",
};
const EVENT_TYPE_WORD: Readonly<Record<IncidentEventType, [one: string, many: string]>> = {
  OBSERVED: ["failure observed", "failures observed"],
  STATE_CHANGED: ["state change", "state changes"],
  CAUSE_HYPOTHESIZED: ["cause hypothesized", "causes hypothesized"],
  CAUSE_CONFIRMED: ["cause confirmed", "causes confirmed"],
  CAUSE_RETRACTED: ["cause retracted", "causes retracted"],
  ACTION_TAKEN: ["action taken", "actions taken"],
  ACTION_OUTCOME: ["action outcome", "action outcomes"],
  NOTE_CODE: ["coded note", "coded notes"],
};
const EVENT_TITLE: Readonly<Record<IncidentEventType, string>> = {
  OBSERVED: "Failure observed", STATE_CHANGED: "State changed", CAUSE_HYPOTHESIZED: "Cause hypothesized", CAUSE_CONFIRMED: "Cause confirmed",
  CAUSE_RETRACTED: "Cause retracted", ACTION_TAKEN: "Action taken", ACTION_OUTCOME: "Action outcome", NOTE_CODE: "Coded note",
};
const UNREGISTERED_EVENT: [string, string] = ["unrecognised event", "unrecognised events"];

export const VERIFIED_RECOVERY_HEADLINE = "Resolved by verified recovery";
export const OPERATOR_FIXED_HEADLINE = "Closed by an operator as fixed — not verified by a successful sync";
export const DISMISSED_HEADLINE = "Dismissed by an operator — not a recovery";
export const OPERATOR_CLOSED_HEADLINE = "Closed by an operator — not verified by a successful sync";
export const SUBJECT_REMOVED_HEADLINE = "Closed because the connection was removed — not a recovery";
export const LEGACY_HEADLINE = "Resolved (legacy record) — how it closed wasn't recorded, so recovery isn't verified";
export const STALE_NOTE = "No failure inside its freshness window and no attempt since: neither confirmed broken nor recovered.";
export const RECURRENCE_NOTE = "A recurrence opens a new incident linked to the earlier episode; a closed incident is never reopened in place.";

const DISMISS_CODES: ReadonlySet<string> = new Set(["OPERATOR_NOT_ACTIONABLE", "OPERATOR_DUPLICATE", "OPERATOR_TEST_ACTIVITY"]);

function registryWord(reg: Readonly<Record<string, string>>, code: string | null): string | null {
  return code && has(reg, code) ? reg[code] : null;
}
function stateWord(code: string | null): string | null {
  return code && (STATE_CODES as readonly string[]).includes(code) ? STATE_CODE_WORD[code as (typeof STATE_CODES)[number]] : null;
}
function isEventType(t: string): t is IncidentEventType {
  return (EVENT_TYPES as readonly string[]).includes(t);
}
function byWhom(e: IncidentTimelineEvent): string | null {
  if (e.actorKind === "OPERATOR") return `by an operator${e.audited ? " (audited)" : ""}`;
  if (e.actorKind === "SYSTEM") return "by the system";
  return null;
}

// ── closure ─────────────────────────────────────────────────────────────────

export function lifecycleClosureOf(d: Pick<IncidentDetailDTO, "incident" | "resolutionReasonCode" | "evidence">): LifecycleClosure | null {
  const r = d.incident;
  if (!r.closure) return null;
  const code = d.resolutionReasonCode;
  const reason = registryWord(RESOLUTION_REASON_CODES, code);
  const unregisteredReason = !!code && reason === null;
  let outcome: ClosureOutcome;
  let headline: string;
  switch (r.closure) {
    case "recovered": outcome = "verified-recovery"; headline = VERIFIED_RECOVERY_HEADLINE; break;
    case "operator":
      if (code === "OPERATOR_FIXED") { outcome = "operator-fixed"; headline = OPERATOR_FIXED_HEADLINE; }
      else if (code && DISMISS_CODES.has(code)) { outcome = "dismissed"; headline = DISMISSED_HEADLINE; }
      else { outcome = "operator-closed"; headline = OPERATOR_CLOSED_HEADLINE; } // absent / unregistered reason
      break;
    case "connection-removed": outcome = "subject-removed"; headline = SUBJECT_REMOVED_HEADLINE; break;
    default: outcome = "legacy"; headline = LEGACY_HEADLINE;
  }
  const e = d.evidence;
  const evidence = e && r.closure === "recovered"
    ? `${n(e.proofCount)} success proof${e.proofCount === 1 ? "" : "s"}${e.lastProofAt ? ` · last proof ${whenText(e.lastProofAt)}` : ""}`
    : null;
  return {
    kind: r.closure, outcome, verifiedRecovery: outcome === "verified-recovery", headline,
    reason, unregisteredReason, evidence, derived: r.closureDerived,
  };
}

// ── recurrence ──────────────────────────────────────────────────────────────

function episodeLink(id: string, row: IncidentRowDTO | null): EpisodeLink {
  if (!row) return { id, generation: null, outcome: "No longer retained", retained: false };
  return { id, generation: row.generation, outcome: closureText(row) ?? STATE_WORD[row.state], retained: true };
}

export function lifecycleRecurrenceOf(d: Pick<IncidentDetailDTO, "incident" | "related">): LifecycleRecurrence {
  const g = d.incident.generation;
  const prevLink = d.related.find((l) => l.kind === "PREVIOUS_EPISODE") ?? null;
  const nextLink = d.related.find((l) => l.kind === "NEXT_EPISODE") ?? null;
  const previous = prevLink ? episodeLink(prevLink.id, prevLink.incident) : null;
  const next = nextLink ? episodeLink(nextLink.id, nextLink.incident) : null;
  let line: string;
  if (g <= 1 && !previous) line = "First episode — no earlier episode of this incident is recorded.";
  else line = `Episode ${n(Math.max(g, 2))} — a recurrence of an earlier episode.`;
  if (next) line += " It recurred later as a new episode.";
  return { generation: g, line, previous, next };
}

// ── events ──────────────────────────────────────────────────────────────────

function keyEventOf(e: IncidentTimelineEvent): LifecycleKeyEvent {
  const parts: string[] = [];
  const from = stateWord(e.fromState);
  const to = stateWord(e.toState);
  if (from || to) parts.push(`${from ?? "—"} → ${to ?? "—"}`);
  for (const [reg, code] of [[CAUSE_CODES, e.causeCode], [ACTION_CODES, e.actionCode], [OUTCOME_CODES, e.outcomeCode]] as const) {
    const w = registryWord(reg, code);
    if (w) parts.push(w);
    else if (code) parts.push("an unrecognised code (not shown)");
  }
  const who = byWhom(e);
  if (who) parts.push(who);
  return { at: e.at, when: whenText(e.at), title: isEventType(e.type) ? EVENT_TITLE[e.type] : "Unrecognised event", parts };
}

/** A key event changes state, records an action / outcome, or a cause. OBSERVED is the detection milestone. */
function isKeyEvent(e: IncidentTimelineEvent): boolean {
  return e.type !== "OBSERVED";
}

function eventsView(t: IncidentDetailDTO["timeline"]): LifecycleView["events"] {
  const counts = new Map<string, number>();
  for (const e of t.events) {
    const k = isEventType(e.type) ? e.type : "UNREGISTERED";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const order = [...EVENT_TYPES, "UNREGISTERED"];
  const byType: LifecycleEventSummary[] = order.filter((k) => counts.has(k)).map((k) => {
    const c = counts.get(k)!;
    const words = isEventType(k) ? EVENT_TYPE_WORD[k] : UNREGISTERED_EVENT;
    return { type: k, label: c === 1 ? words[0] : words[1], count: c };
  });
  const total = t.events.length;
  let line: string;
  if (total === 0) line = t.source === "none" ? "No lifecycle events recorded for this incident." : "No lifecycle events in the retained copy.";
  else line = [`${n(total)}${t.truncated ? "+" : ""} event${total === 1 ? "" : "s"} recorded`, ...byType.map((b) => `${n(b.count)} ${b.label}`)].join(" · ");
  const keyAll = t.events.filter(isKeyEvent);
  const key = keyAll.slice(-KEY_EVENTS_SHOWN).map(keyEventOf);
  return { source: t.source, total, truncated: t.truncated, line, byType, key, keyTruncated: keyAll.length > KEY_EVENTS_SHOWN };
}

// ── milestones ──────────────────────────────────────────────────────────────

/** The stored timeline is oldest first; the newest match wins. */
function newest(events: readonly IncidentTimelineEvent[], pred: (e: IncidentTimelineEvent) => boolean): IncidentTimelineEvent | null {
  for (let i = events.length - 1; i >= 0; i--) if (pred(events[i])) return events[i];
  return null;
}

function stamp(at: string | null, missing = "Time not recorded"): { at: string | null; when: string } {
  return { at, when: at ? whenText(at) : missing };
}

/** The Lifecycle section's view-model (pure over the DTO). */
export function incidentLifecycleView(
  d: Pick<IncidentDetailDTO, "incident" | "summary" | "timeline" | "archive" | "related" | "resolutionReasonCode" | "evidence" | "checkedAt">,
): LifecycleView {
  const r = d.incident;
  const s = d.summary;
  const ev = d.timeline.events;
  const ms: LifecycleMilestone[] = [];

  ms.push({ key: "detected", label: "First detected", ...stamp(s.firstDetectedAt), note: null, tone: "bad" });

  const ack = newest(ev, (e) => e.toState === "ACKNOWLEDGED" || e.actionCode === "ACKNOWLEDGE");
  if (ack || r.state === "acknowledged") {
    const who = ack ? byWhom(ack) : null;
    ms.push({ key: "acknowledged", label: "Acknowledged", ...stamp(ack?.at ?? null), note: who ? `Ownership taken ${who}` : "Ownership taken", tone: "warn" });
  }

  const reopen = newest(ev, (e) => e.actionCode === "REOPEN");
  if (reopen) {
    const who = byWhom(reopen);
    ms.push({ key: "reopened", label: "Reopened", ...stamp(reopen.at), note: who ? `Reopened ${who}` : null, tone: "warn" });
  }

  const rec = newest(ev, (e) => e.toState === "RECOVERING");
  if (rec || r.state === "recovering") {
    const current = r.state === "recovering";
    ms.push({
      key: "recovering", label: current ? "Recovering since" : "Recovery began", ...stamp(rec?.at ?? null),
      note: current ? `${n(r.recovery.proofCount)} success proof${r.recovery.proofCount === 1 ? "" : "s"} so far; confirmation pending` : null,
      tone: "info",
    });
  }

  ms.push({ key: "last-observed", label: "Last observed", ...stamp(s.lastObservedAt), note: null, tone: "muted" });

  if (r.state === "stale-unverified") {
    ms.push({ key: "needs-verification", label: "Needs verification", at: null, when: `As of ${whenText(d.checkedAt)}`, note: STALE_NOTE, tone: "warn" });
  }

  const closure = lifecycleClosureOf(d);
  if (closure || s.resolvedAt) {
    ms.push({
      key: "closed",
      label: closure?.verifiedRecovery ? "Resolved" : closure?.outcome === "dismissed" ? "Dismissed" : "Closed",
      ...stamp(s.resolvedAt),
      note: closure?.headline ?? null,
      tone: closure?.verifiedRecovery ? "ok" : "muted",
    });
  }

  if (d.archive.archived) {
    ms.push({
      key: "archived", label: "Archived", ...stamp(d.archive.archivedAt),
      note: d.archive.retainedUntil ? `Summary kept until ${whenText(d.archive.retainedUntil)}` : null, tone: "muted",
    });
  }

  return { milestones: ms, closure, recurrence: lifecycleRecurrenceOf(d), events: eventsView(d.timeline) };
}
