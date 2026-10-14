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
} from "@/lib/platform/ops/attention-core";
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
