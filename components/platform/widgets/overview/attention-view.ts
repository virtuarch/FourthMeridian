/**
 * components/platform/widgets/overview/attention-view.ts  (UX-P1 · Agent 2)
 *
 * The Attention Required block's presentation vocabulary. Pure, React-free,
 * clock-injected. It turns values the attention route already decided into
 * words, tones and cells, and SELECTS rows by a severity the server assigned.
 * It never re-sorts (the server is the one ordering authority) and never
 * computes a severity.
 */

import type { StatusTone } from "../../platform-surface";
import type {
  AttentionAction,
  AttentionEntityKind,
  AttentionEvidence,
  AttentionItem,
  AttentionSeverity,
  UserImpactCore,
  UserImpactKind,
  UserImpactReference,
} from "@/lib/platform/ops/attention-core";
import type { DistributionSegment } from "../../platform-surface";
import type { AttentionRecentFirings } from "@/lib/platform/ops/attention";

export const SEVERITY_WORD: Record<AttentionSeverity, string> = {
  critical: "Critical",
  error: "Error",
  warning: "Warning",
  info: "Info",
};

/** The word carries the level; the tone only groups critical/error (bad) from warning and info. */
export const SEVERITY_TONE: Record<AttentionSeverity, StatusTone> = {
  critical: "bad",
  error: "bad",
  warning: "warn",
  info: "info",
};

export const ENTITY_WORD: Record<AttentionEntityKind, string> = {
  connection: "Connection",
  job: "Job",
  provider: "Provider",
  resource: "Resource",
  "alert-rule": "Alert rule",
  incident: "Incident",
  // Owner ruling (2026-10-30) — a customer named by an opaque reference (missing / invalid policy assignment).
  customer: "Customer",
};

export type AttentionFilter = "all" | AttentionSeverity;

export const ATTENTION_FILTERS: readonly AttentionFilter[] = ["all", "critical", "error", "warning", "info"];

/** Pill labels carry the server's counts; an empty level still shows (never a hidden option). */
export function filterOptions(counts: Record<AttentionSeverity, number>, total: number): { value: AttentionFilter; label: string }[] {
  return ATTENTION_FILTERS.map((f) => ({
    value: f,
    label: f === "all" ? `All ${total}` : `${SEVERITY_WORD[f]} ${counts[f]}`,
  }));
}

/** Selection only — order is preserved exactly as the server sent it. */
export function filterItems(items: readonly AttentionItem[], filter: AttentionFilter): AttentionItem[] {
  return filter === "all" ? [...items] : items.filter((i) => i.severity === filter);
}

/** "14 Oct 09:30 UTC" from an ISO instant; null when unreadable. */
export function utcStamp(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

/** The empty state — a count of authorities, never a health claim. */
export function emptyText(authoritiesChecked: number, checkedAt: string): string {
  return `Nothing needs attention — ${authoritiesChecked} authorit${authoritiesChecked === 1 ? "y" : "ies"} checked at ${utcStamp(checkedAt) ?? checkedAt}.`;
}

export function failedAuthoritiesText(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  return `${names.length} authorit${names.length === 1 ? "y" : "ies"} could not be asked (${names.join(", ")}) — absence of rows from ${names.length === 1 ? "it" : "them"} is not a clean reading.`;
}

export function recentFiringsHeading(rf: AttentionRecentFirings): string {
  return `Recent alert firings (historical, last ${rf.runs} evaluation${rf.runs === 1 ? "" : "s"})`;
}

export function recentFiringsEmpty(rf: AttentionRecentFirings): string {
  return rf.runs === 0 ? "no evaluation recorded" : "none delivered in that window";
}

/** The evidence cell's words. `workspaceLabel` is resolved by the caller from the registry. */
export function evidenceLabel(e: AttentionEvidence, workspaceLabel: string | null): string {
  if (e.kind === "execution") return `Inspect execution …${e.id.slice(-6)}`;
  return workspaceLabel ? `Open ${workspaceLabel}` : "no doorway";
}

export function actionLabel(a: AttentionAction, workspaceLabel: string | null): string {
  switch (a.kind) {
    case "resync": return "Resync";
    case "request-reauth": return "Request reauthorization";
    case "run-now": return "Run from Jobs";
    case "open-workspace": return workspaceLabel ? `Open ${workspaceLabel}` : "no doorway";
  }
}

export const ATTENTION_FOOTNOTE =
  "Each row restates a verdict its authority already reached; nothing here is a new judgement. " +
  "An alert rule appears only when it breached in the latest evaluation. The firings listed beneath are history.";

export const CONNECTION_HEALTH_CAP_NOTE = "Connection rows are the health reader's capped list (20).";

// ── BETA V1 · user-impacting failures ────────────────────────────────────────
//
// Words and tones for the second composition. The kind word carries the
// level; the tone only groups outright failures (bad) from partial results
// and a reconnect the customer can perform (warn).

export const IMPACT_TITLE = "User-impacting failures";

export const IMPACT_KIND_WORD: Record<UserImpactKind, string> = {
  "refresh-failed": "Refresh failed",
  "refresh-partial": "Refresh partial",
  "ai-failure": "AI failure",
  "brief-failed": "Brief failed",
  "needs-reauth": "Needs reauthorization",
};

export const IMPACT_KIND_TONE: Record<UserImpactKind, StatusTone> = {
  "refresh-failed": "bad",
  "refresh-partial": "warn",
  "ai-failure": "bad",
  "brief-failed": "bad",
  "needs-reauth": "warn",
};

export const IMPACT_KIND_ORDER: readonly UserImpactKind[] = ["refresh-failed", "refresh-partial", "ai-failure", "brief-failed", "needs-reauth"];

/** "item …a1b2c3" — the reader's opaque reference, never a person. */
export function referenceLabel(ref: UserImpactReference | null): string {
  return ref ? `${ref.kind} …${ref.tail}` : "no reference exposed";
}

/** Word + count for every kind, including the zero ones (never a hidden segment). */
export function impactSegments(counts: UserImpactCore["counts"]): DistributionSegment[] {
  return IMPACT_KIND_ORDER.map((k) => ({ word: IMPACT_KIND_WORD[k], count: counts[k], tone: IMPACT_KIND_TONE[k] }));
}

export type UsersAffectedReading =
  | { kind: "figure"; value: string; qualifier: string }
  | { kind: "unavailable"; reason: string; qualifier: string };

/** The tile: a count only when a reader exposed users; otherwise the reason, in full weight. */
export function usersAffectedReading(u: UserImpactCore): UsersAffectedReading {
  const facts = Object.values(u.counts).reduce((n, c) => n + c, 0);
  const qualifier = `${u.sourcesAffected} source${u.sourcesAffected === 1 ? "" : "s"} affected · ${facts} fact${facts === 1 ? "" : "s"} · last ${u.windowHours} h`;
  if (u.usersAffected.count === null) return { kind: "unavailable", reason: u.usersAffected.reason ?? "not derivable", qualifier };
  return { kind: "figure", value: String(u.usersAffected.count), qualifier: u.usersAffected.reason ? `${qualifier} · ${u.usersAffected.reason}` : qualifier };
}

export function impactEmptyText(u: UserImpactCore): string {
  const n = u.authorities.checked.length;
  return `No user-impacting failure recorded in the last ${u.windowHours} h — ${n} reader${n === 1 ? "" : "s"} answered.`;
}

export function impactFailedText(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  return `${names.length} user-impact reader${names.length === 1 ? "" : "s"} could not be asked (${names.join(", ")}) — ${names.length === 1 ? "its" : "their"} failures are not in this group.`;
}

export const IMPACT_FOOTNOTE =
  "User-impacting failures restate four readers (refresh executions, AI failures, Brief ops, connection health) over the last 24 h. " +
  "A reference is the opaque handle its reader exposes; no reader on this surface exposes a user, so the users-affected figure is withheld with its reason rather than guessed from sources.";
