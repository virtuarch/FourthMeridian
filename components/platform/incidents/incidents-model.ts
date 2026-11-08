/**
 * components/platform/incidents/incidents-model.ts  (PB-1 2B — the incidents workspace's words, PURE)
 *
 * Presentation only: every figure and every decision arrives from the route
 * (the intelligence module decided state, severity, freshness, closure and
 * recovery). This turns codes into operator wording — and never re-derives a
 * verdict. Registry codes are worded from lib/platform/incidents/codes.ts;
 * an unregistered code is shown as the code itself, never guessed.
 */

import { ACTION_CODES, CAUSE_CODES, OPERATOR_RESOLUTION_REASON_CODES, OUTCOME_CODES, RESOLUTION_REASON_CODES, type OperatorResolutionReasonCode } from "@/lib/platform/incidents/codes";
import { OPERATOR_NOTE_MAX, OPERATOR_REASON_CODES, type OperatorReasonCode } from "@/lib/audit";
import type { IncidentDetailDTO, IncidentListDTO, IncidentRowDTO, LifecycleActionDTO, RecoveryActionDTO } from "@/lib/platform/incidents/investigation-dto";
import type { IncidentAttempt, IncidentLinkKind, IncidentStatusFilter, IncidentTimelineEvent } from "@/lib/platform/incidents/intelligence/types";
import type { StatusTone } from "../platform-surface";

const n = (v: number) => v.toLocaleString("en-US");

export const STATE_WORD: Readonly<Record<IncidentRowDTO["state"], string>> = {
  active: "Active", acknowledged: "Acknowledged", recovering: "Recovering", "stale-unverified": "Needs verification",
  resolved: "Resolved", archived: "Archived",
};
export const STATE_TONE: Readonly<Record<IncidentRowDTO["state"], StatusTone>> = {
  active: "bad", acknowledged: "warn", recovering: "info", "stale-unverified": "warn", resolved: "ok", archived: "muted",
};
export const SEVERITY_TONE: Readonly<Record<IncidentRowDTO["severity"], StatusTone>> = { critical: "bad", error: "bad", warning: "warn", info: "info" };
export const SEVERITY_WORD: Readonly<Record<IncidentRowDTO["severity"], string>> = { critical: "Critical", error: "Error", warning: "Warning", info: "Info" };
export const FRESHNESS_WORD: Readonly<Record<IncidentRowDTO["freshness"], string>> = {
  current: "Current", unverified: "Unverified", stale: "Stale",
};
const CLOSURE_WORD: Readonly<Record<NonNullable<IncidentRowDTO["closure"]>, string>> = {
  recovered: "Recovered (evidence)", operator: "Resolved by an operator", "connection-removed": "Closed — connection removed", "legacy-resolved": "Resolved (legacy, no kind recorded)",
};
export const STATUS_TITLE: Readonly<Record<IncidentStatusFilter, string>> = {
  "broken-now": "Broken now", "needs-verification": "Needs verification", history: "History", all: "All incidents",
};
export const LINK_WORD: Readonly<Record<IncidentLinkKind, string>> = {
  RECURRENCE_OF: "Recurrence of", SAME_ROOT_CAUSE: "Same root cause", RELATED: "Related",
  PREVIOUS_EPISODE: "Previous episode", NEXT_EPISODE: "Next episode",
};
export const RECOVERY_LABEL: Readonly<Record<RecoveryActionDTO["kind"], string>> = {
  resync: "Resync connection", "request-reauth": "Request reauthorization", "refresh-customer": "Refresh all for this customer",
};

/** "3 Nov 14:02 UTC" — absolute, so a list read later still says when. */
export function whenText(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return `${d.getUTCDate()} ${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCFullYear()} ${d.toISOString().slice(11, 16)} UTC`;
}

export function closureText(r: Pick<IncidentRowDTO, "closure" | "closureDerived">): string | null {
  if (!r.closure) return null;
  return `${CLOSURE_WORD[r.closure]}${r.closureDerived ? " · derived at read time" : ""}`;
}

/** The operation phrase first (§7), the kind label when the operation is unprovable. */
export function incidentTitle(r: Pick<IncidentRowDTO, "operationLabel" | "label">): string {
  return r.operationLabel ?? r.label;
}

/** "Plaid · 14 occurrences · first 1 Nov · last 3 Nov" — one line under the title. */
export function incidentLine(r: IncidentRowDTO): string {
  return [r.provider, `${n(r.occurrenceCount)} occurrence${r.occurrenceCount === 1 ? "" : "s"}`, `first ${whenText(r.firstSeenAt)}`, `last ${whenText(r.lastSeenAt)}`].join(" · ");
}

/** "Showing 26–50 of 112 incidents · scanned 500 (a floor)" — from the server's own counts. */
export function populationLine(d: Pick<IncidentListDTO, "items" | "total" | "page" | "pageSize" | "truncated" | "scanned">): string {
  if (d.total === 0) return d.truncated ? `No matching incidents in the ${n(d.scanned)} rows scanned (a capped read)` : "No matching incidents";
  const from = (d.page - 1) * d.pageSize + 1;
  const to = from + d.items.length - 1;
  const span = d.items.length > 0 ? `Showing ${n(from)}–${n(to)} of ${n(d.total)}` : `${n(d.total)} incidents`;
  return `${span}${d.truncated ? "+ (a floor — the read was capped)" : ""} · ${n(d.scanned)} rows scanned`;
}

/**
 * The ONE "how many" figure: the Operations broken-now KPI and the incidents
 * list header both print this over the SAME route response, so list total = KPI.
 */
export function incidentTotalText(d: Pick<IncidentListDTO, "total" | "truncated">): string {
  return `${n(d.total)}${d.truncated ? "+" : ""}`;
}

export function pageCount(d: Pick<IncidentListDTO, "total" | "pageSize">): number {
  return Math.max(1, Math.ceil(d.total / d.pageSize));
}

/**
 * WHY — the rule and basis behind the verdict, in sentences, from the fields
 * the module emitted. Nothing here decides; it reads `state`, `freshness`,
 * `closure`, `recovery` and the evidence digest.
 */
export function whyLines(d: Pick<IncidentDetailDTO, "incident" | "evidence" | "resolutionReasonCode">): string[] {
  const r = d.incident;
  const out: string[] = [];
  switch (r.state) {
    case "active":
    case "acknowledged":
      out.push(r.freshness === "unverified"
        ? "Broken now at lower severity: past its freshness window, the operation was attempted or skipped since, but no success has been proven."
        : "Broken now: the operation last failed inside its freshness window and no success has been proven since.");
      if (r.state === "acknowledged") out.push("An operator has taken ownership.");
      break;
    case "recovering":
      out.push(`Recovering: ${n(r.recovery.proofCount)} success proof${r.recovery.proofCount === 1 ? "" : "s"} recorded; confirmation is pending, so it still counts as broken now (ranked below active).`);
      break;
    case "stale-unverified":
      out.push("Needs verification: no failure inside its freshness window, but the operation has been neither attempted nor skipped since — not counted as broken, never alerts.");
      break;
    case "resolved":
    case "archived": {
      const c = closureText(r);
      if (c) out.push(`${c}.`);
      if (r.state === "archived") out.push("Summary only: the incident row passed its retention and is kept as an archive record.");
      break;
    }
  }
  if (r.duplicateOf) out.push(`Folded onto a newer open row of the same episode (${r.duplicateOf}); not counted on its own.`);
  if (r.alertable) out.push("Eligible for the critical alert.");
  if (r.spread.spread === "widespread") out.push(`Widespread: ${n(r.spread.affectedSubjects)} subjects share this provider, domain and operation.`);
  const e = d.evidence;
  if (e) out.push(`Evidence rule ${e.rule}: ${n(e.proofCount)} proof${e.proofCount === 1 ? "" : "s"}, ${n(e.nonProofCount)} non-proof fact${e.nonProofCount === 1 ? "" : "s"}${e.lastProofAt ? `, last proof ${whenText(e.lastProofAt)}` : ""}.`);
  if (d.resolutionReasonCode) out.push(`Reason: ${codeText(d.resolutionReasonCode)}.`);
  if (r.causeCode) out.push(`Cause (${r.causeStatus === "CONFIRMED" ? "confirmed" : "hypothesis"}): ${codeText(r.causeCode)}.`);
  const evidenceNote = attemptEvidenceNote(r.recovery.evidenceBasis);
  if (evidenceNote && (r.state === "active" || r.state === "acknowledged" || r.state === "recovering")) out.push(evidenceNote);
  return out;
}

/**
 * PB-1 D10 — operator wording for WHY attempt evidence is missing. Only a read
 * that failed is "could not be read"; a subject the ledger cannot key on is
 * "not tracked"; a row inside its window needed no evidence. Never-hide in every case.
 */
export function attemptEvidenceNote(basis: "read" | "not-needed" | "unsupported" | "unreadable"): string | null {
  if (basis === "unreadable") return "Attempt evidence since the last failure could not be read; the state is not hidden because of it.";
  if (basis === "unsupported") return "Attempt evidence isn't tracked for this provider yet; the state is not hidden because of it.";
  return null;
}

const WORDED: Readonly<Record<string, string>> = { ...RESOLUTION_REASON_CODES, ...CAUSE_CODES, ...ACTION_CODES, ...OUTCOME_CODES };
/** A registry code's words, or the code itself (never guessed). */
export function codeText(code: string): string {
  return WORDED[code] ?? code;
}

const EVENT_WORD: Readonly<Record<string, string>> = {
  OBSERVED: "Failure observed", STATE_CHANGED: "State changed", CAUSE_HYPOTHESIZED: "Cause hypothesized", CAUSE_CONFIRMED: "Cause confirmed",
  CAUSE_RETRACTED: "Cause retracted", ACTION_TAKEN: "Action taken", ACTION_OUTCOME: "Action outcome", NOTE_CODE: "Note",
};

/** One timeline event in words. Every coded field the event carries is shown; nothing is merged. */
export function timelineText(e: IncidentTimelineEvent): { title: string; parts: string[] } {
  const parts: string[] = [];
  if (e.fromState || e.toState) parts.push(`${e.fromState ?? "—"} → ${e.toState ?? "—"}`);
  if (e.causeCode) parts.push(codeText(e.causeCode));
  if (e.actionCode) parts.push(codeText(e.actionCode));
  if (e.outcomeCode) parts.push(codeText(e.outcomeCode));
  if (e.actorKind) parts.push(e.actorKind === "OPERATOR" ? `by an operator${e.audited ? " (audited)" : ""}` : "by the system");
  return { title: EVENT_WORD[e.type] ?? e.type, parts };
}

export function affectedLine(a: IncidentDetailDTO["affected"]): string {
  const bits = [a.provider];
  if (a.institution) bits.push(a.institution);
  bits.push(`${n(a.itemCount)} connection${a.itemCount === 1 ? "" : "s"}`, `${n(a.accountCount)} account${a.accountCount === 1 ? "" : "s"}`);
  if (a.subjectState !== "LIVE") bits.push(`subject ${a.subjectState.toLowerCase()}`);
  if (a.itemStatus) bits.push(`connection status ${a.itemStatus.toLowerCase().replace(/_/g, " ")}`);
  return bits.join(" · ");
}

export function archiveLine(a: IncidentDetailDTO["archive"]): string {
  if (a.archived) return `Archived ${whenText(a.archivedAt)} · kept until ${whenText(a.retainedUntil)} (13-month retention)`;
  if (a.archiveDueAt) return `Live record · moves to the archive after ${whenText(a.archiveDueAt)} (90 days after resolution)`;
  return "Live record · open incidents are never pruned";
}

// ── PB-1 S6 — operator lifecycle actions (acknowledge / resolve) ────────────

export const LIFECYCLE_LABEL: Readonly<Record<LifecycleActionDTO, string>> = { acknowledge: "Acknowledge", resolve: "Resolve" };

export const LIFECYCLE_CONFIRM: Readonly<Record<LifecycleActionDTO, { title: string; message: string }>> = {
  acknowledge: {
    title: "Acknowledge this incident?",
    message: "Records that you have taken ownership. The incident stays broken now and keeps alerting until it recovers or is resolved; a new failure is still recorded against it. Audited as an operator action.",
  },
  resolve: {
    title: "Resolve this incident manually?",
    message: "Closes the incident as resolved by an operator, with your reason. If the operation is still failing, the next failure opens a new episode linked to this one (shown as reopened). Audited as an operator action.",
  },
};

/** The audit envelope's reason codes, worded. */
export const AUDIT_REASON_WORD: Readonly<Record<OperatorReasonCode, string>> = {
  BETA_ONBOARDING: "Beta onboarding", SUPPORT_REQUEST: "Support request", DOGFOOD: "Dogfooding", TESTING: "Testing",
  POLICY_ROLLOUT: "Policy rollout", INCIDENT: "Incident handling", ABUSE: "Abuse", OTHER: "Other",
};
export const AUDIT_REASON_OPTIONS = OPERATOR_REASON_CODES.map((c) => ({ value: c, label: AUDIT_REASON_WORD[c] }));
export const RESOLUTION_REASON_OPTIONS = OPERATOR_RESOLUTION_REASON_CODES.map((c) => ({ value: c, label: RESOLUTION_REASON_CODES[c] }));
export { OPERATOR_NOTE_MAX };

export interface LifecycleForm {
  auditReason: OperatorReasonCode | "";
  resolutionReason: OperatorResolutionReasonCode | "";
  note: string;
}
export const EMPTY_LIFECYCLE_FORM: LifecycleForm = { auditReason: "INCIDENT", resolutionReason: "", note: "" };

/** Confirm is enabled when the form is complete: a reason always; resolve also needs its code and a note. */
export function lifecycleFormValid(action: LifecycleActionDTO, f: LifecycleForm): boolean {
  if (!f.auditReason || f.note.trim().length > OPERATOR_NOTE_MAX) return false;
  if (action === "resolve") return f.resolutionReason !== "" && f.note.trim() !== "";
  return true;
}

/** The POST body the route parses (operator-route.ts parseIncidentActionBody). */
export function lifecycleBody(action: LifecycleActionDTO, f: LifecycleForm): Record<string, unknown> {
  const note = f.note.trim();
  const reason = { code: f.auditReason, ...(note ? { note } : {}) };
  return action === "resolve" ? { resolutionReasonCode: f.resolutionReason, reason } : { reason };
}

/** The route each lifecycle action posts to. */
export function lifecyclePath(action: LifecycleActionDTO, incidentId: string): string {
  return `/api/platform/platform-ops/incidents/${encodeURIComponent(incidentId)}/${action}`;
}

// ── Incident detail v1 — summary, guidance, diagnosis words ─────────────────

export { DISPLAY_STATUS_WORD } from "@/lib/platform/incidents/display-status";
export const DISPLAY_STATUS_TONE: Readonly<Record<IncidentDetailDTO["summary"]["displayStatus"], StatusTone>> = {
  "action-needed": "bad", active: "bad", recurring: "warn", investigating: "warn", recovering: "info", resolved: "ok",
};

/** "Ongoing" vs "Historical" — whether it is broken now. */
export function ongoingWord(s: IncidentDetailDTO["summary"], state: IncidentRowDTO["state"]): string {
  if (s.ongoing) return "Ongoing";
  if (state === "stale-unverified") return "Not confirmed broken now · needs verification";
  return "Historical";
}

/**
 * The impact line under the title: what is affected and what that means for
 * the customer now. Identity-free (institution + counts only).
 */
export function impactLine(d: Pick<IncidentDetailDTO, "summary" | "affected" | "incident">): string {
  const a = d.affected;
  const where = a.institution ?? (a.provider === "PLAID" ? "this bank connection" : `this ${a.provider.toLowerCase()} connection`);
  const accounts = a.accountCount > 0 ? ` (${n(a.accountCount)} account${a.accountCount === 1 ? "" : "s"})` : "";
  const s = d.summary;
  if (s.displayStatus === "resolved") return `No current impact — ${where}${accounts} recovered or was closed.`;
  if (s.remedy === "customer-re-add") return `Data from ${where}${accounts} has stopped updating until the customer adds the connection again.`;
  if (s.customerActionRequired) return `Data from ${where}${accounts} isn't updating until the customer reconnects.`;
  if (!s.ongoing) return `${where}${accounts}: not confirmed broken now.`;
  return `${d.incident.operationLabel ?? d.incident.label} is failing for ${where}${accounts}; its data may be out of date.`;
}

export interface PrimaryGuidance {
  headline: string;
  body: string;
  /** Shown beside the guidance: why the obvious retry is not offered. */
  caveat: string | null;
}

/**
 * The drawer's first action block. Guidance TEXT for what only the customer
 * can do (no placeholder button); the real, audited recovery actions render
 * beneath it from `d.recovery` (already filtered by the remediation rule).
 */
export function primaryGuidance(d: Pick<IncidentDetailDTO, "summary" | "recovery">, customerAction: string | null): PrimaryGuidance | null {
  const s = d.summary;
  if (s.displayStatus === "resolved") return null;
  switch (s.remedy) {
    case "customer-reconnect":
      return {
        headline: "Customer must reconnect",
        body: customerAction ?? "The customer must reconnect this bank from the Connections page.",
        caveat: "A server resync can't fix this, so it isn't offered.",
      };
    case "customer-re-add":
      return {
        headline: "Customer must add the connection again",
        body: customerAction ?? "The connection is gone at the provider. Only the customer can add it again.",
        caveat: "Resync and reauthorization can't fix a revoked connection.",
      };
    case "server-retry":
      return {
        headline: d.recovery.some((a) => a.kind === "resync") ? "A resync may help" : "Wait for the next sync",
        body: "This is transient or provider-side. A later sync usually recovers it; nothing is required of the customer.",
        caveat: null,
      };
    case "investigate":
      return { headline: "Investigate", body: "There is no verified explanation for this failure yet. Check the diagnosis and recent attempts before acting.", caveat: null };
    default:
      return null;
  }
}

const TRIGGER_WORD: Readonly<Record<string, string>> = {
  MANUAL: "manual refresh", CRON: "scheduled sync", RECONNECT: "reconnect", WEBHOOK: "provider webhook", ADMIN: "admin", OPERATOR: "operator", RESUME: "resume", OTHER: "other",
};
const ATTEMPT_STATUS_WORD: Readonly<Record<string, string>> = {
  SUCCEEDED: "Succeeded", FAILED: "Failed", PARTIAL: "Partial", SKIPPED: "Skipped", RUNNING: "Running", OTHER: "Other",
};

/** "12 sync attempts since first detected · 0 succeeded · 12 failed · last success —" */
export function attemptsLine(a: IncidentDetailDTO["diagnosis"]["attempts"]): string {
  if (!a) return "Sync attempts aren't tracked for this incident.";
  if (!a.readable) return "Sync attempts could not be read.";
  const c = a.counts;
  if (c.total === 0) return "No sync attempts recorded for this connection in the incident's window.";
  const bits = [`${n(c.total)}${a.truncated ? "+" : ""} sync attempt${c.total === 1 ? "" : "s"} in the incident's window`, `${n(c.succeeded)} succeeded`, `${n(c.failed)} failed`];
  if (c.partial) bits.push(`${n(c.partial)} partial`);
  if (c.skipped) bits.push(`${n(c.skipped)} skipped`);
  bits.push(`last success ${whenText(a.lastSucceededAt)}`);
  return bits.join(" · ");
}

export function attemptText(x: IncidentAttempt): { title: string; parts: string[] } {
  const parts = [whenText(x.at), TRIGGER_WORD[x.trigger] ?? x.trigger];
  if (x.errorCode) parts.push(x.errorCode);
  if (x.httpStatus !== null) parts.push(`HTTP ${x.httpStatus}`);
  if (x.callStatus === "RATE_LIMITED") parts.push("rate limited");
  if (x.operation) parts.push(x.operation);
  return { title: ATTEMPT_STATUS_WORD[x.status] ?? x.status, parts };
}

/** "First occurrence" / "Episode 3 · 2 earlier episodes · last recovered 1 Nov" */
export function recurrenceLine(r: IncidentDetailDTO["diagnosis"]["recurrence"]): string {
  if (r.generation <= 1 && !r.previousIncidentId && r.earlierEpisodes === 0) return "First occurrence — no earlier episode of this incident is recorded.";
  const bits = [`Episode ${n(r.generation)}`, `${n(r.earlierEpisodes)}${r.truncated ? "+" : ""} earlier episode${r.earlierEpisodes === 1 ? "" : "s"}`];
  if (r.lastRecoveredAt) bits.push(`last closed ${whenText(r.lastRecoveredAt)}`);
  return bits.join(" · ");
}

/** "NO_ACCOUNTS · reported by the connection now" */
export function providerCodeLine(dx: IncidentDetailDTO["diagnosis"]): string | null {
  if (dx.providerErrorCode) return `${dx.providerErrorCode} · ${dx.providerErrorSource === "connection" ? "the connection's current error" : "recorded when the incident opened"}`;
  if (dx.providerErrorUnrecognised) return "A provider code was recorded but is not a recognised code (not shown).";
  return null;
}
