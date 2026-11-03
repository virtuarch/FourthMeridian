/**
 * lib/platform/incidents/intelligence/types.ts  (PB-1 Phase 2 — the PUBLISHED API)
 *
 * The ONE deterministic incident-intelligence module. Every incident surface
 * (Platform Ops attention, Customer Success, alerts, convergence, incident
 * detail / history, and later AI tools) reads incidents ONLY through it. It is
 * pure over typed FACTS (`IncidentFacts`) — loaders gather facts, the core
 * derives verdicts — so the parity harness (design §13) can feed one fixture
 * world to the module and to the six legacy readers and compare.
 *
 * NO LLM. NEVER `detail`, never provider free text: no field below can carry
 * either. Identity is tiered: a PLATFORM_OPS verdict is identity-free; the
 * customer id appears only on the CUSTOMER_SUCCESS tier (CS READ).
 *
 * Canonical rules adopted for §13.2 D1–D8 (lead decision, 2026-11-03):
 *   D1  "open" = DERIVED state, never raw `resolved = false`
 *   D2  ONE referent rule (subjects-core.ts): soft-deleted account / REVOKED
 *       item / missing row = removed ⇒ closed "connection removed" at read time
 *   D3  classification always receives the full fact set (incl. plaidTransactionId)
 *   D4  ONE attribution rule: `subjectUserId` (Phase 1), else the subject's
 *       authoritative owner (PlaidItem.userId, else FinancialAccount
 *       ownerUserId ?? createdByUserId) — never an AccountConnection join
 *   D5  every list carries explicit `truncated` / `floor`
 *   D6  open incidents are included regardless of creation date
 *   D7  `firstSeenAt` = since; `lastSeenAt` = ordering / recency
 *   D8  episode identity = `incidentKey` (+ previousIncidentId recurrence);
 *       alert dedupe keeps per-Item grouping
 *   D9  severity is emitted; each consumer keeps its own filter (not a divergence)
 *
 * Divergences the MODULE introduces on purpose (listed in ALLOWED_DIVERGENCES):
 *   D10 a stale-unverified row stays `resolved = false` but is NOT brokenNow
 *       (legacy readers count it as open)
 *   D2b a REVOKED Item's incidents read "connection removed" (closed); legacy
 *       readers still treat them as live
 *
 * AUDIENCE: accessors take an UNFORGEABLE AudienceToken (./audience.ts), never a
 * string. Only the pure core takes the plain `IncidentAudience`.
 *
 * THIS FILE IS THE CONTRACT. Changing a shape here is a reviewed change.
 */

import type { ResolutionEvidenceDigest } from "../evidence";
import type { AudienceToken, CsToken, OpsToken, SystemToken } from "./audience";

export type { ResolutionEvidenceDigest };

// ── Facts (input) ────────────────────────────────────────────────────────────

/** One SyncIssue row as the module needs it. Loaders select exactly these. */
export interface IncidentRowFacts {
  id: string;
  kind: string;
  provider: string;
  plaidItemId: string | null;
  financialAccountId: string | null;
  /** D3 — required for classification; never re-exposed. */
  plaidTransactionId: string | null;
  /** Classified ONLY (stage, cursorBlocking, basis). NEVER leaves the module. */
  detail: unknown;
  resolved: boolean;
  incidentKey: string | null;
  previousIncidentId: string | null;
  createdAt: Date;
  firstOccurredAt: Date | null;
  lastOccurredAt: Date | null;
  resolvedAt: Date | null;
  resolutionKind: string | null;
  resolutionReasonCode: string | null;
  // Phase-1 columns (NULL on legacy rows).
  lifecycleState: string | null;
  acknowledgedAt: Date | null;
  recoveringSince: Date | null;
  archivedAt: Date | null;
  subjectUserId: string | null;
  causeStatus: string | null;
  causeCode: string | null;
  /**
   * The stored resolution evidence as a codes-and-counts DIGEST, derived by the
   * evidence builder (../evidence.ts `evidenceDigestOf`). The raw JSONB never
   * enters the module, so it can never reach an audience-scoped output.
   */
  evidence: ResolutionEvidenceDigest | null;
  occurrenceCount: number;
  correlatedOccurrenceCount: number;
}

/** One SyncIssueArchive row (summary only). */
export interface ArchivedIncidentFacts {
  incidentId: string;
  incidentKey: string | null;
  provider: string;
  kind: string;
  operation: string | null;
  plaidItemId: string | null;
  financialAccountId: string | null;
  subjectUserId: string | null;
  previousIncidentId: string | null;
  firstOccurredAt: Date | null;
  lastOccurredAt: Date | null;
  resolvedAt: Date | null;
  resolutionKind: string | null;
  resolutionReasonCode: string | null;
  causeStatus: string | null;
  causeCode: string | null;
  occurrenceCount: number;
  archivedAt: Date;
}

/** Subject facts (the D2 / D4 inputs), keyed by id. */
export interface SubjectFactsInput {
  /** PlaidItem id → { status, userId }. Absent ⇒ the row is missing. `userId: null` ⇒ no known owner (unattributed). */
  items: ReadonlyMap<string, { status: string; userId: string | null }>;
  /** FinancialAccount id → { deletedAt, ownerUserId, createdByUserId }. Absent ⇒ missing. */
  accounts: ReadonlyMap<string, { deletedAt: Date | null; ownerUserId: string | null; createdByUserId: string | null }>;
  /** Episode id → account ids named on its occurrences (§12 P2.2). Optional per episode. */
  occurrenceAccounts?: ReadonlyMap<string, readonly string[]>;
}

/**
 * Attempt / skip evidence for one open episode's operation since its
 * lastOccurredAt (the STALE rule, §12 P2.1). `known: false` = not looked up or
 * unreadable — never hides a row.
 */
export interface AttemptEvidence {
  known: boolean;
  lastAttemptAt: Date | null;
  lastSkipAt: Date | null;
}

export interface RelationFacts {
  fromIncidentId: string;
  toIncidentId: string;
  kind: "RECURRENCE_OF" | "SAME_ROOT_CAUSE" | "RELATED";
}

/** Everything one derivation reads. Gathered by loaders; pure from here on. */
export interface IncidentFacts {
  rows: readonly IncidentRowFacts[];
  archived?: readonly ArchivedIncidentFacts[];
  subjects: SubjectFactsInput;
  /** Episode id → attempt evidence. Missing ⇒ UNKNOWN (not hidden). */
  attempts?: ReadonlyMap<string, AttemptEvidence>;
  relations?: readonly RelationFacts[];
  /** D5 — did the loader hit its row cap? Carried onto every list. */
  scanTruncated: boolean;
}

// ── Verdicts (output) ────────────────────────────────────────────────────────

/** Whether a row is an incident at all. Evidence / superseded rows are never incidents. */
export type RowClass = "incident" | "evidence" | "superseded";

export type IncidentState =
  /** Broken now. */
  | "active"
  /** Broken now; an operator has taken ownership. */
  | "acknowledged"
  /** Some proof, confirmation pending. Still listed, ranked below active. */
  | "recovering"
  /** Past its window, neither attempted nor skipped since: NOT broken now, never alerts critical. Still resolved=false. */
  | "stale-unverified"
  /** Closed — see `closure`. */
  | "resolved"
  /** Summary only (SyncIssueArchive). */
  | "archived";

/**
 * For an open incident past its window: `unverified` = attempted or skipped
 * since (stays broken-now at LOWER severity); `stale` = neither (state becomes
 * stale-unverified); `current` = inside its window.
 */
export type Freshness = "current" | "unverified" | "stale";

export type Closure =
  /** AUTOMATIC_RECOVERY — evidence. */
  | "recovered"
  /** OPERATOR_RESOLVED. */
  | "operator"
  /** SUBJECT_REMOVED, persisted or derived at read time (D2). Never "recovered". */
  | "connection-removed"
  /** A legacy resolved row with no kind. */
  | "legacy-resolved";

export type SubjectStateV2 = "LIVE" | "DELETED" | "REVOKED" | "MISSING" | "UNSCOPED";

export type Severity = "critical" | "error" | "warning" | "info";

export type OperatorAction = "acknowledge" | "resolve" | "reopen";

/** Isolated vs widespread: same provider + domain + operation across subjects. */
export interface SpreadVerdict {
  /** provider::domain::operation — never a subject id. */
  groupKey: string;
  spread: "isolated" | "widespread";
  /** Distinct live subjects with an open incident in the group (identity-free count). */
  affectedSubjects: number;
}

export interface RecurrenceVerdict {
  /** 1 = first episode; n = n-th generation in its previousIncidentId chain (as far as rows are visible). */
  generation: number;
  previousIncidentId: string | null;
  /** SAME_ROOT_CAUSE / RELATED / RECURRENCE_OF links (soft refs, may be archived ids). */
  relatedIncidentIds: string[];
}

export interface RecoveryVerdict {
  /** SUCCEEDED proof facts on the frozen evidence. A SKIP is never proof (P2.1). */
  proofCount: number;
  /** True only when ≥ 1 SUCCEEDED proof exists. */
  mayAdvance: boolean;
  lastAttemptAt: string | null;
  lastSkipAt: string | null;
  evidenceKnown: boolean;
}

/** The identity-free verdict (PLATFORM_OPS tier, and the base of every tier). */
export interface IncidentVerdict {
  id: string;
  rowClass: RowClass;
  state: IncidentState;
  freshness: Freshness;
  closure: Closure | null;
  /** True when `closure` was DERIVED at read time and is not yet persisted (S7 persists). */
  closureDerived: boolean;
  kind: string;
  provider: string;
  domain: string;
  /** The classified severity (D9: consumers filter). */
  severity: Severity;
  /** One notch lower for an `unverified` row; equal otherwise. Attention ranks on this. */
  effectiveSeverity: Severity;
  /** Registered operation key, or null when unprovable. */
  operation: string | null;
  /** Operator wording. */
  label: string;
  operationLabel: string | null;
  /** D7 */
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  occurrenceCount: number;
  correlatedOccurrenceCount: number;
  /** D8 — episode identity; `legacy:<id>` when the row has no key. */
  episodeKey: string;
  /** Another open row shares this episodeKey and is newer (legacy F6 duplicates): this one is folded. */
  duplicateOf: string | null;
  /** Opaque ids for navigation (never labels, never a customer id). */
  plaidItemId: string | null;
  financialAccountId: string | null;
  subjectState: SubjectStateV2;
  /** Counts toward "broken now" (attention, CS reason). */
  brokenNow: boolean;
  /** Eligible for the critical alert (brokenNow, current, not recovering). */
  alertable: boolean;
  /** Lower = more urgent. Deterministic. */
  attentionPriority: number;
  spread: SpreadVerdict;
  recurrence: RecurrenceVerdict;
  recovery: RecoveryVerdict;
  causeStatus: "HYPOTHESIS" | "CONFIRMED" | null;
  causeCode: string | null;
  /** What an operator may do (routes land with S6; this is the rule, not a button). */
  availableActions: OperatorAction[];
}

/** CUSTOMER_SUCCESS tier — the only tier that names the customer (D4). */
export interface CsIncidentVerdict extends IncidentVerdict {
  subjectUserId: string | null;
}

/** D5 — every list says whether it is complete. */
export interface VerdictList<T extends IncidentVerdict = IncidentVerdict> {
  items: T[];
  /** The loader hit its cap: counts are floors. */
  truncated: boolean;
  /** Rows the loader read (before filtering). */
  scanned: number;
}

export interface IncidentVerdictSet<T extends IncidentVerdict = IncidentVerdict> {
  /** Every row's verdict, incidents and non-incidents, input order independent (sorted by attentionPriority, then lastSeenAt desc, then id). */
  all: T[];
  truncated: boolean;
  scanned: number;
}

// ── Audiences (permission scope) ────────────────────────────────────────────

/**
 * Who is asking. Callers obtain it from the route's EXISTING guard
 * (requirePlatformAccess) — the module never authenticates, it only enforces
 * the tier: PLATFORM_OPS and SYSTEM never receive `subjectUserId`.
 */
export type IncidentAudience = "PLATFORM_OPS" | "CUSTOMER_SUCCESS" | "SYSTEM";

export type VerdictFor<A extends IncidentAudience> = A extends "CUSTOMER_SUCCESS" ? CsIncidentVerdict : IncidentVerdict;

// ── Harness hooks (design §13.3 step 2) ─────────────────────────────────────

/**
 * The per-row verdict the parity harness compares, normalised across readers.
 * `open` MEANS `brokenNow` (counts toward "broken now"); both are emitted so a
 * reader that expresses one can be compared without guessing.
 */
export interface NormalisedVerdict {
  id: string;
  open: boolean;
  brokenNow: boolean;
  alertable: boolean;
  state: IncidentState | "evidence" | "superseded";
  severity?: Severity;
  subjectUserId?: string | null;
  groupKey?: string;
}

export interface DeriveOptions {
  now: Date;
  audience: IncidentAudience;
}

/** The pure core's signature (implemented in ./core.ts). */
export type DeriveIncidentVerdicts = <A extends IncidentAudience>(
  facts: IncidentFacts,
  opts: DeriveOptions & { audience: A },
) => IncidentVerdictSet<VerdictFor<A>>;

/** Normalise one verdict for the harness (implemented in ./core.ts). */
export type NormaliseVerdict = (v: IncidentVerdict | CsIncidentVerdict) => NormalisedVerdict;

// ── Accessors (I/O; implemented in ./index.ts) ──────────────────────────────

export interface ListOptions {
  /** Row cap for the underlying scan (D5 — reported via `truncated`). */
  limit?: number;
  /** Required for determinism in tests; defaults to the wall clock at the accessor only. */
  now?: Date;
  /**
   * Scan only NOT-closed rows (`resolved = false`) — for a "broken now" view
   * whose cap must not be spent on history. The verdicts are unchanged; only
   * the scan narrows. Ignored by accessors that already scan open rows.
   */
  openOnly?: boolean;
}

/** The verdict shape a token entitles. A PLATFORM_OPS / SYSTEM verdict has NO `subjectUserId` key. */
export type VerdictForToken<T> = T extends AudienceToken<infer A> ? VerdictFor<A> : never;

/**
 * The typed, permission-scoped read surface. Every consumer uses one of these;
 * none reads SyncIssue itself. Each accessor verifies its token at runtime
 * (assertAudienceToken) before reading anything.
 *
 *   brokenNow          active + acknowledged + recovering (attention, CS reason)
 *   needsVerification  stale-unverified (shown separately; never alerts)
 *   history            resolved + archived
 *   forCustomer        one customer's incidents — CUSTOMER_SUCCESS token only
 *   alertable          brokenNow ∩ alertable — SYSTEM token only (lib/alerts/)
 *   detail             one episode — tiered by token
 *   window             PB-1 R3: every row touching [from, to] (seen, created or resolved in it)
 *                      PLUS every NOT-closed row whatever its dates (D6) — tiered by token
 *   search             PB-1 2B: filtered, paged search over one status preset — tiered by token
 *   investigate        PB-1 2B: one episode with timeline, evidence digest, links — tiered by token
 */
export interface IncidentAccessors extends IncidentInvestigationAccessors {
  brokenNow<T extends CsToken | OpsToken>(token: T, opts?: ListOptions): Promise<VerdictList<VerdictForToken<T>>>;
  needsVerification<T extends CsToken | OpsToken>(token: T, opts?: ListOptions): Promise<VerdictList<VerdictForToken<T>>>;
  history<T extends CsToken | OpsToken>(token: T, opts?: ListOptions): Promise<VerdictList<VerdictForToken<T>>>;
  forCustomer(token: CsToken, userId: string, opts?: ListOptions): Promise<VerdictList<CsIncidentVerdict>>;
  alertable(token: SystemToken, opts?: ListOptions): Promise<VerdictList<IncidentVerdict>>;
  detail<T extends CsToken | OpsToken>(token: T, id: string, opts?: ListOptions): Promise<VerdictForToken<T> | null>;
  window<T extends CsToken | OpsToken>(token: T, range: { from: Date; to: Date }, opts?: ListOptions): Promise<VerdictList<VerdictForToken<T>>>;
}

// ── PB-1 Phase 2B — investigation (search · detail · timeline) ──────────────

/**
 * The status preset a search starts from. Each is EXACTLY one accessor's filter:
 *   broken-now          ≡ brokenNow
 *   needs-verification  ≡ needsVerification
 *   history             ≡ history (resolved + archived)
 *   all                 every incident-class row (no evidence / superseded rows)
 */
export type IncidentStatusFilter = "broken-now" | "needs-verification" | "history" | "all";

/** A parsed, validated search (search-core.ts `parseIncidentSearch` is the one parser). */
export interface IncidentSearchQuery {
  status: IncidentStatusFilter;
  severity: Severity | null;
  /** Platform provider value ("PLAID", "WALLET", …) — enum-shaped, never free text. */
  provider: string | null;
  /** A registered operation key. */
  operation: string | null;
  /** A registry-shaped code matched against the incident's kind OR its cause code. */
  code: string | null;
  /** Inclusive UTC day bounds on lastSeenAt (YYYY-MM-DD), clamped to the archive retention. */
  from: string | null;
  to: string | null;
  /** 1-based page (clamped by the parser). */
  page: number;
}

/** One page of a search. `total` counts the FILTERED set the scan saw (a floor when `truncated`). */
export interface IncidentSearchResult<T extends IncidentVerdict = IncidentVerdict> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  /** D5 — the scan hit its cap: `total` is a floor. */
  truncated: boolean;
  scanned: number;
  /** Values present in the scanned incidents, for the filter controls (identity-free codes only). */
  facets: { providers: string[]; operations: string[]; codes: string[] };
}

/** One SyncIssueEvent (or archived timeline entry) — codes and opaque refs ONLY, in stored order. */
export interface IncidentTimelineEvent {
  /** The event row id; null for an archived (summary) entry. */
  id: string | null;
  at: string;
  type: string;
  actorKind: "SYSTEM" | "OPERATOR" | null;
  /** An operator event carries an AuditLog id; only its presence is emitted (never the operator). */
  audited: boolean;
  fromState: string | null;
  toState: string | null;
  causeCode: string | null;
  actionCode: string | null;
  outcomeCode: string | null;
  refEventId: string | null;
  refreshExecutionId: string | null;
  jobRunId: string | null;
}

export interface IncidentTimeline {
  /** events = SyncIssueEvent rows; archive = the archive's capped code-only copy; none = nothing recorded. */
  source: "events" | "archive" | "none";
  events: IncidentTimelineEvent[];
  /** The read cap was hit, or the archive copy dropped its oldest entries. */
  truncated: boolean;
}

export type IncidentLinkKind = RelationFacts["kind"] | "PREVIOUS_EPISODE" | "NEXT_EPISODE";

/** A linked incident. `incident` is null when the row is no longer readable (pruned past retention). */
export interface IncidentLink<T extends IncidentVerdict = IncidentVerdict> {
  id: string;
  kind: IncidentLinkKind;
  incident: T | null;
}

/** The affected subjects, identity-free: provider, institution label, counts and the subject facts. */
export interface IncidentAffected {
  provider: string;
  /** PlaidItem.institutionName (an institution, never a customer); null when unknown. */
  institution: string | null;
  itemCount: number;
  accountCount: number;
  subjectState: SubjectStateV2;
  /** PlaidItem.status of the subject item (an enum), when the incident is item-scoped and the item is readable. */
  itemStatus: string | null;
}

export interface IncidentArchiveState {
  archived: boolean;
  archivedAt: string | null;
  /** A live resolved row is pruned (and archived) this long after resolvedAt. */
  archiveDueAt: string | null;
  /** The archive record is kept until (archivedAt + 13 months). */
  retainedUntil: string | null;
}

/** Everything an incident detail shows, tiered by the token (VerdictForToken). */
export interface IncidentInvestigation<T extends IncidentVerdict = IncidentVerdict> {
  verdict: T;
  /** The evidence DIGEST (codes and counts) — never the stored evidence. */
  evidence: ResolutionEvidenceDigest | null;
  resolutionReasonCode: string | null;
  timeline: IncidentTimeline;
  affected: IncidentAffected;
  /** SyncIssueRelation links + the previousIncidentId chain neighbours. */
  related: IncidentLink<T>[];
  /** Other episodes of the same incident key (recurrences), newest first, capped. */
  recurrences: T[];
  recurrencesTruncated: boolean;
  archive: IncidentArchiveState;
}

/** PB-1 Phase 2B accessors (implemented in ./index.ts); token-checked before any read. */
export interface IncidentInvestigationAccessors {
  search<T extends CsToken | OpsToken>(token: T, query: IncidentSearchQuery, opts?: ListOptions): Promise<IncidentSearchResult<VerdictForToken<T>>>;
  investigate<T extends CsToken | OpsToken>(token: T, id: string, opts?: ListOptions): Promise<IncidentInvestigation<VerdictForToken<T>> | null>;
}
