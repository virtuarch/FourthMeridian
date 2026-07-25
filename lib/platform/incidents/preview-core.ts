/**
 * lib/platform/incidents/preview-core.ts  (OPS-2D-5D-1)
 *
 * The Preview read model, pure.
 *
 * WHAT THIS IS
 * ------------
 * A PRESENTATION shaping layer over `IncidentView` — it decides what an operator
 * sees FIRST and in what words, and nothing else. Every semantic value it emits
 * (severity, domain, nature, state, label, description, recovery) is asked for
 * from `lib/platform/sync-issue-semantics.ts`. There is no `deriveSeverity`, no
 * `inferDomain`, no `calculateActive`, no `guessRecovery` here, and there must
 * never be: a second opinion about what an incident MEANS is the exact defect
 * the semantics authority exists to prevent.
 *
 * WHY A SEPARATE MODULE FROM projections.ts
 * -----------------------------------------
 * `projections.ts` answers "what incidents exist and what are they?". This
 * answers "which six does an operator look at, in what order, described how?".
 * Keeping them apart means a wording change never touches the read authority,
 * and the ORDERING lives in exactly one place instead of being re-implemented by
 * each component that renders a list.
 *
 * PURE: no DB, no clock, no I/O. Subject labels are resolved by the caller and
 * injected — see preview.ts.
 *
 * PRIVACY: `detail` is never read here and is not reachable — `IncidentView`
 * does not carry it. Raw ids are never used as display text; an unresolvable
 * subject renders as UNAVAILABLE, never as an id and never as a guess.
 */

import {
  incidentLabel,
  incidentDescription,
  incidentOperationLabel,
  incidentRecovery,
  type IncidentRecovery,
  type SyncIssueDomain,
  type SyncIssueNature,
  type SyncIssueSeverity,
  type SyncIssueState,
} from "@/lib/platform/sync-issue-semantics";
import { parseIncidentKey } from "./identity";
import type { IncidentView } from "./projections";

/**
 * A subject the incident is about, already resolved to human names by the
 * caller. `null` anywhere means UNKNOWN — never substituted with a plausible
 * default, because "Unknown bank" asserts a bank we have not proven exists.
 */
export interface IncidentSubject {
  /** Institution or wallet chain, e.g. "Chase". */
  primary: string | null;
  /** Account or connection, e.g. "Checking". */
  secondary: string | null;
}

/**
 * One preview row. Presentation-ready and privacy-safe: everything here is
 * either a canonical semantic value or a name an operator is entitled to see.
 */
export interface IncidentPreviewItem {
  /** Episode id — for navigation only; never rendered as the subject label. */
  id: string;
  /** Canonical operator label. */
  title: string;
  /**
   * Which OPERATION failed, in operator words — the qualifier that makes two
   * incidents sharing one label distinguishable (OPS-2D-5C-minimal).
   *
   * A PRESENTATION field, deliberately. It carries no new fact: the operation is
   * already inside `IncidentView.incidentKey`, so this reconstructs nothing and
   * needs no column, no extra query and no change to what the projection reads.
   * Shaping it here rather than in the projection is the same split that keeps
   * `title` and `description` out of the read authority.
   *
   * NULL when the platform cannot prove which operation failed — a legacy row
   * with no key, an EVENT (which never carries one), or an operation the
   * registry does not recognise. The surface then renders nothing extra. It is
   * never the raw stage and never a guess.
   */
  operationLabel: string | null;
  /** Canonical operator-safe sentence. */
  description: string;
  severity: SyncIssueSeverity;
  domain: SyncIssueDomain;
  nature: SyncIssueNature;
  state: SyncIssueState;
  /** Resolved subject, or null when the platform genuinely does not know. */
  subject: IncidentSubject;
  firstOccurredAt: string;
  lastOccurredAt: string;
  /**
   * Occurrences of THIS episode. Meaningful only when `occurrenceCountKnown`;
   * legacy rows predate the occurrence table and their depth is unknowable.
   */
  occurrenceCount: number;
  occurrenceCountKnown: boolean;
  recovery: IncidentRecovery;
  /** At least one occurrence carries a real RefreshExecution FK. */
  executionCorrelated: boolean;
}

/**
 * Ordering authority for every incident list surface (OPS-2D-5D-1 · D4).
 *
 * SEVERITY FIRST, then most-recent occurrence, then id for stability. Recency
 * alone would bury a critical held-cursor incident under a burst of wallet
 * retries, which is the one ordering an operational preview must never produce.
 *
 * Centralised here on purpose: a component that re-sorts becomes a second
 * ordering authority, and the two are then free to disagree about the same list.
 */
const SEVERITY_RANK: Record<SyncIssueSeverity, number> = {
  critical: 0,
  error:    1,
  warning:  2,
  info:     3,
};

export function sortIncidentsForOperator(views: IncidentView[]): IncidentView[] {
  // `lastOccurredAt` is nullable on the view (legacy rows carry no lifecycle
  // timestamps and the projection falls back to createdAt, which can still be
  // absent in a hand-built view). An unknown time sorts LAST within its severity
  // band rather than being treated as the epoch, which would rank it as the
  // stalest incident on the platform.
  const at = (v: IncidentView) => v.lastOccurredAt ?? v.firstOccurredAt ?? "";
  return [...views].sort((a, b) => {
    const rank = SEVERITY_RANK[a.classification.severity] - SEVERITY_RANK[b.classification.severity];
    if (rank !== 0) return rank;
    const recency = at(b).localeCompare(at(a));
    if (recency !== 0) return recency;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Shape one incident for the preview.
 *
 * `subject` is injected because resolving it needs the database, and this module
 * must stay pure. Passing `{primary: null, secondary: null}` is a legitimate
 * answer and renders as unavailable.
 */
export function toPreviewItem(view: IncidentView, subject: IncidentSubject): IncidentPreviewItem {
  // ONE VERDICT. `view.classification` was derived by the projection with the
  // row's `detail` in hand; wording and recovery are asked for using THAT
  // verdict rather than re-classifying from `kind`, which would hit the
  // conservative transactions fallback and badge an investment incident
  // "investments" while labelling it "Transaction persistence failed".
  const { domain, severity, nature } = view.classification;

  // THE OPERATION IS READ, NOT RECONSTRUCTED. It is the last segment of the
  // stored incident key, taken apart by the module that owns that format —
  // never by splitting a string here, which would make this file a second owner
  // of the key layout. Only the OPERATION is consumed: the key's `domain`
  // segment is what the classifier said at write time, and the live verdict
  // above is the one that must win.
  const operation = parseIncidentKey(view.incidentKey)?.operation ?? null;

  return {
    id: view.id,
    title: incidentLabel(view.kind, domain),
    operationLabel: incidentOperationLabel(operation),
    description: incidentDescription(view.kind, domain),
    severity,
    domain,
    nature,
    state: view.state,
    subject,
    firstOccurredAt: view.firstOccurredAt ?? view.lastOccurredAt ?? "",
    lastOccurredAt: view.lastOccurredAt ?? view.firstOccurredAt ?? "",
    occurrenceCount: view.occurrenceCount,
    // A converged episode always has at least one occurrence. Zero means this
    // row predates OPS-2D-5A-1, so its depth is genuinely unknown — reporting
    // "occurred 0 times" would be a fabrication in the healthy direction.
    occurrenceCountKnown: view.occurrenceCount > 0,
    recovery: incidentRecovery(view.classification, view.state),
    executionCorrelated: view.correlatedOccurrenceCount > 0,
  };
}

export interface IncidentPreview {
  /** The incidents actually rendered, already ordered. */
  items: IncidentPreviewItem[];
  /** Active incidents the projection found. */
  activeTotal: number;
  /** activeTotal - items.length, i.e. what the preview is not showing. */
  moreCount: number;
  /**
   * Severity distribution across EVERY active incident, not just the rendered
   * few. Computed here rather than in a component: a summary counted from the
   * six visible rows would silently under-report the moment a seventh existed.
   */
  severityCounts: Record<SyncIssueSeverity, number>;
  /** True when the underlying active scan hit its ceiling, so totals are a floor. */
  truncated: boolean;
}

/** Severity distribution over the full active set. Pure. */
export function countBySeverity(views: IncidentView[]): Record<SyncIssueSeverity, number> {
  const counts: Record<SyncIssueSeverity, number> = { critical: 0, error: 0, warning: 0, info: 0 };
  for (const v of views) counts[v.classification.severity] += 1;
  return counts;
}
