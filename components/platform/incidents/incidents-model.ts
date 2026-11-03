/**
 * components/platform/incidents/incidents-model.ts  (PB-1 2B — the incidents workspace's words, PURE)
 *
 * Presentation only: every figure and every decision arrives from the route
 * (the intelligence module decided state, severity, freshness, closure and
 * recovery). This turns codes into operator wording — and never re-derives a
 * verdict. Registry codes are worded from lib/platform/incidents/codes.ts;
 * an unregistered code is shown as the code itself, never guessed.
 */

import { ACTION_CODES, CAUSE_CODES, OUTCOME_CODES, RESOLUTION_REASON_CODES } from "@/lib/platform/incidents/codes";
import type { IncidentDetailDTO, IncidentListDTO, IncidentRowDTO, RecoveryActionDTO } from "@/lib/platform/incidents/investigation-dto";
import type { IncidentLinkKind, IncidentStatusFilter, IncidentTimelineEvent } from "@/lib/platform/incidents/intelligence/types";
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
