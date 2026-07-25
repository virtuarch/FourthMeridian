/**
 * components/platform/widgets/incident-preview-view.ts  (OPS-2D-5D-1)
 *
 * The Preview's presentation vocabulary. Pure, React-free, and testable without
 * rendering anything.
 *
 * WHAT IT MAY DO: turn a canonical value into the exact words and the exact
 * design token used to show it.
 *
 * WHAT IT MUST NOT DO: decide what that value IS. There is no severity map that
 * reads `kind`, no domain guess from `stage`, no active/resolved arithmetic and
 * no recovery inference. Every input here was already decided by
 * lib/platform/sync-issue-semantics.ts and shaped by the preview projection —
 * this file only chooses phrasing.
 *
 * The distinction matters because the file it replaces did not observe it: the
 * old widget carried a private `humanizeKind()` that turned enum spelling into a
 * label ("Upsert error"), so renaming an enum member would have silently changed
 * what operators read, and two typed kinds sharing one operator problem read as
 * two different problems.
 */

import type { IncidentRecovery, SyncIssueSeverity } from "@/lib/platform/sync-issue-semantics";
import type { IncidentPreviewItem, IncidentSubject } from "@/lib/platform/incidents/preview-core";

/**
 * Severity → an EXISTING design token.
 *
 * URGENCY IS CARRIED BY SATURATION, NOT BY DARKNESS. The first version of this
 * map used the deepest coral (`--coral-600`) for critical on the theory that
 * darker reads as heavier. On a dark surface that is exactly backwards: measured
 * against the rendered card background it gave the platform's most important
 * signal a contrast ratio of 3.28:1, failing WCAG AA for small text — the one
 * severity an operator must never struggle to read.
 *
 * So it follows the ramp components/atlas/tones.ts already ships: danger is the
 * fully saturated coral, caution is the lighter tint. Warning stays inside the
 * coral family for the reason that file gives — borrowing brass would teach
 * "caution" the investments association — and info drops to a neutral, because
 * informational severity is not a warning at all.
 *
 * Colour is never the only signal: the severity WORD is always rendered beside
 * it, so nothing here is lost to a screen reader or a colour-blind operator.
 */
export const SEVERITY_TOKEN: Record<SyncIssueSeverity, string> = {
  critical: "var(--coral-400)",  // = --accent-negative, the app's saturated danger
  error:    "var(--coral-300)",  // the lighter tint
  warning:  "var(--coral-100)",  // palest step: least urgent, still in-family
  info:     "var(--text-muted)", // not a warning; a neutral
};

/**
 * Occurrence phrasing.
 *
 * "Occurred 3 times" is a claim about THIS episode's manifestations. It is
 * deliberately not "3 incidents" (that would be three separate problems) and not
 * "3 failed attempts" (an attempt is a sync RUN, and several occurrences can
 * share one run while one run can produce none).
 *
 * A count of zero is not zero — it means this row predates the occurrence table,
 * so its depth is unknowable and is said to be.
 */
export function occurrenceText(item: Pick<IncidentPreviewItem, "occurrenceCount" | "occurrenceCountKnown">): string {
  if (!item.occurrenceCountKnown) return "Occurrence count unavailable";
  if (item.occurrenceCount === 1) return "Occurred once";
  return `Occurred ${item.occurrenceCount} times`;
}

/**
 * Recovery phrasing, one line per canonical state.
 *
 * "No automatic recovery rule" is the honest reading for the three typed
 * conditions that have no resolver yet (OPS-2D-5B-2). It is a statement about
 * the SYSTEM, not a prediction about the incident, and it must not be softened
 * into anything that implies the problem will clear itself.
 */
export const RECOVERY_TEXT: Record<IncidentRecovery, string> = {
  "automatic-available": "Automatic recovery available",
  "none":                "No automatic recovery rule",
  "recovered":           "Resolved",
  "not-applicable":      "Recovery not applicable",
};

/**
 * Subject phrasing.
 *
 * Returns null when the platform does not know, so the caller renders an honest
 * unavailable line. It never falls back to an id (an operator cannot read a
 * cuid) and never to a category we have not proven — "Unknown bank" asserts a
 * bank, and a wallet incident is not a bank.
 */
export function subjectText(subject: IncidentSubject): string | null {
  const parts = [subject.primary, subject.secondary].filter((p): p is string => !!p && p.trim() !== "");
  return parts.length ? parts.join(" · ") : null;
}

export const SUBJECT_UNAVAILABLE = "Affected account unavailable";

/**
 * The one-line summary above the list.
 *
 * Counts come from the projection (the FULL active set), never from the rendered
 * rows. Severity is named rather than merely coloured so the summary survives
 * being read aloud.
 */
export function summaryText(
  activeTotal: number,
  severityCounts: Record<SyncIssueSeverity, number>,
): string {
  const noun = activeTotal === 1 ? "active incident" : "active incidents";
  const named = (["critical", "error", "warning", "info"] as const)
    .filter((s) => severityCounts[s] > 0)
    .map((s) => `${severityCounts[s]} ${s}`);
  return named.length ? `${activeTotal} ${noun} · ${named.join(" · ")}` : `${activeTotal} ${noun}`;
}
