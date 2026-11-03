/**
 * lib/platform/incidents/intelligence/core.ts  (PB-1 Phase 2 — the deterministic core, PURE)
 *
 * `deriveIncidentVerdicts(facts, { now, audience })` is the ONE place an
 * incident's verdict is decided: row class, state, freshness, closure,
 * brokenNow, alertable, severity, spread, recurrence, recovery and the
 * operator actions. Every rule here is one of the canonical rules D1–D10
 * (types.ts header; design docs/plans/PB1-INCIDENT-LIFECYCLE.md §3, §5, §12, §13).
 *
 * PURE: no I/O, no clock (the caller passes `now`), no writes, no LLM. The
 * same facts in any order give the same output (sorted, input-order free).
 *
 * COMBINES, NEVER DUPLICATES. Classification is `classifySyncIssue` (the
 * semantics authority), removal is `subjectVerdict` (subjects-core.ts), the
 * STALE rule is `incidentFreshness` (./staleness.ts) — applied ONCE, here,
 * and carried on the verdict. No consumer re-derives any of them.
 *
 * NEVER IN THE OUTPUT: `detail`, `plaidTransactionId`, the raw stored
 * evidence (the module only ever holds its digest), a raw producer stage, a
 * label carrying provider text. Identity is tiered: only a CUSTOMER_SUCCESS
 * derivation adds `subjectUserId`; a PLATFORM_OPS / SYSTEM verdict has no such
 * key at all.
 */

import {
  classifySyncIssue,
  incidentLabel,
  incidentOperationLabel,
  isSupersededMismatch,
  type SyncIssueClassification,
} from "@/lib/platform/sync-issue-semantics";
import { parseIncidentKey, LEGACY_UNSPECIFIED } from "../identity";
import { OPERATION_KEYS } from "../operation-key";
import { isRegistryCode } from "../codes";
import { subjectVerdict, type SubjectFacts, type SubjectVerdict } from "../subjects-core";
import { demoteSeverity, incidentFreshness, UNKNOWN_EVIDENCE } from "./staleness";
import type {
  ArchivedIncidentFacts,
  AttemptEvidence,
  Closure,
  CsIncidentVerdict,
  DeriveOptions,
  Freshness,
  IncidentAudience,
  IncidentFacts,
  IncidentRowFacts,
  IncidentState,
  IncidentVerdict,
  IncidentVerdictSet,
  NormalisedVerdict,
  OperatorAction,
  RecurrenceVerdict,
  RowClass,
  Severity,
  SubjectStateV2,
  VerdictFor,
} from "./types";

/** Distinct live subjects with an open incident in one provider::domain::operation group that make it "widespread". */
export const WIDESPREAD_MIN_SUBJECTS = 2;

const REGISTERED_OPERATIONS: ReadonlySet<string> = new Set(Object.values(OPERATION_KEYS));

const STATE_RANK: Record<IncidentState, number> = {
  active: 0, acknowledged: 1, recovering: 2, "stale-unverified": 3, resolved: 4, archived: 5,
};
const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, error: 1, warning: 2, info: 3 };
const NON_INCIDENT_RANK = 6;

const BROKEN_NOW_STATES: ReadonlySet<IncidentState> = new Set(["active", "acknowledged", "recovering"]);

// ── Per-row rules ───────────────────────────────────────────────────────────

/** D3 — classification always receives the full fact set (incl. plaidTransactionId). */
export function classifyRow(r: Pick<IncidentRowFacts, "kind" | "provider" | "detail" | "plaidTransactionId">): SyncIssueClassification {
  return classifySyncIssue({ kind: r.kind, provider: r.provider, detail: r.detail, plaidTransactionId: r.plaidTransactionId });
}

/** D1 — evidence (an EVENT) and superseded rows are never incidents, whatever `resolved` says. */
export function rowClassOf(r: Pick<IncidentRowFacts, "kind" | "provider" | "detail" | "plaidTransactionId">, c: SyncIssueClassification): RowClass {
  if (isSupersededMismatch({ kind: r.kind, provider: r.provider, detail: r.detail })) return "superseded";
  return c.nature === "event" ? "evidence" : "incident";
}

/**
 * The FULL operation discriminator, used internally (stale window, attempt
 * endpoints): the incident key's tail. A row with no key has NO provable
 * operation (null) — resolving a raw stage into an operation is the lifecycle
 * authority's job alone (pinned in operation-key.test.ts), so the core never
 * does it. Null falls back to the provider's default window and endpoints.
 * Never emitted as-is: an `unregistered:<stage>` value carries a raw stage.
 */
export function operationOf(r: Pick<IncidentRowFacts, "incidentKey">): string | null {
  const parsed = parseIncidentKey(r.incidentKey);
  if (!parsed || parsed.operation === LEGACY_UNSPECIFIED) return null;
  return parsed.operation;
}

/** The operation as emitted: a REGISTERED key, or null when unprovable. */
export function emittedOperation(op: string | null): string | null {
  return op !== null && REGISTERED_OPERATIONS.has(op) ? op : null;
}

function toSubjectFacts(s: IncidentFacts["subjects"]): SubjectFacts {
  return {
    itemStatus: new Map([...s.items].map(([id, v]) => [id, v.status] as const)),
    accountDeletedAt: new Map([...s.accounts].map(([id, v]) => [id, v.deletedAt] as const)),
  };
}

/** D2 / D2b — the one referent rule: soft-deleted account, REVOKED item or missing row = removed. */
export function subjectStateOf(v: SubjectVerdict): SubjectStateV2 {
  if (v.verdict === "UNSCOPED") return "UNSCOPED";
  if (v.verdict === "SUBJECT_REMOVED") return v.subject.state;
  return "LIVE";
}

/** D4 — `subjectUserId` (Phase 1), else the subject's authoritative owner. Never an AccountConnection join. */
export function attributionOf(
  r: Pick<IncidentRowFacts, "subjectUserId" | "plaidItemId" | "financialAccountId">,
  s: IncidentFacts["subjects"],
): string | null {
  // Unattributed is null everywhere: an empty id is treated as absent, never emitted.
  if (r.subjectUserId) return r.subjectUserId;
  const item = r.plaidItemId ? s.items.get(r.plaidItemId) : undefined;
  if (item?.userId) return item.userId;
  const acct = r.financialAccountId ? s.accounts.get(r.financialAccountId) : undefined;
  return acct ? acct.ownerUserId || acct.createdByUserId || null : null;
}

function closureOfKind(kind: string | null): Closure {
  switch (kind) {
    case "AUTOMATIC_RECOVERY": return "recovered";
    case "OPERATOR_RESOLVED": return "operator";
    case "SUBJECT_REMOVED": return "connection-removed";
    default: return "legacy-resolved";
  }
}

/** The open-episode state before staleness: acknowledged / recovering from the Phase-1 columns, else active. */
function openStateOf(r: Pick<IncidentRowFacts, "lifecycleState" | "acknowledgedAt" | "recoveringSince">): Extract<IncidentState, "active" | "acknowledged" | "recovering"> {
  if (r.lifecycleState === "RECOVERING" || (r.lifecycleState === null && r.recoveringSince !== null)) return "recovering";
  if (r.lifecycleState === "ACKNOWLEDGED" || (r.lifecycleState === null && r.acknowledgedAt !== null)) return "acknowledged";
  return "active";
}

export interface StateDecision {
  state: IncidentState;
  freshness: Freshness;
  closure: Closure | null;
  closureDerived: boolean;
}

/**
 * D1 + D2 + D10 — the state of one INCIDENT-class row.
 *   resolved            → resolved, closure from its persisted kind
 *   subject removed     → resolved / connection-removed, DERIVED (S7 persists)
 *   open                → active | acknowledged | recovering, then the STALE rule
 *                         ONCE: `stale` ⇒ stale-unverified (still resolved=false);
 *                         `unverified` stays broken-now at a lower severity.
 * A RECOVERING row keeps its state: it already holds attempt evidence newer
 * than lastOccurredAt, so it cannot be "neither attempted nor skipped".
 */
export function decideState(
  r: Pick<IncidentRowFacts, "resolved" | "resolutionKind" | "lifecycleState" | "acknowledgedAt" | "recoveringSince" | "provider" | "lastOccurredAt" | "createdAt">,
  subject: SubjectVerdict,
  operation: string | null,
  evidence: AttemptEvidence,
  now: Date,
): StateDecision {
  if (r.resolved) return { state: "resolved", freshness: "current", closure: closureOfKind(r.resolutionKind), closureDerived: false };
  if (subject.verdict === "SUBJECT_REMOVED") return { state: "resolved", freshness: "current", closure: "connection-removed", closureDerived: true };
  const open = openStateOf(r);
  const freshness = incidentFreshness({ operation, provider: r.provider, lastOccurredAt: r.lastOccurredAt ?? r.createdAt, now, evidence });
  if (open === "recovering") return { state: "recovering", freshness: freshness === "stale" ? "unverified" : freshness, closure: null, closureDerived: false };
  return { state: freshness === "stale" ? "stale-unverified" : open, freshness, closure: null, closureDerived: false };
}

/** §6 — what an operator may do (the rule; the routes land with S6). */
export function actionsFor(rowClass: RowClass, d: StateDecision, openKeyExists: boolean): OperatorAction[] {
  if (rowClass !== "incident") return [];
  switch (d.state) {
    case "active":
    case "recovering":
    case "stale-unverified":
      return ["acknowledge", "resolve"];
    case "acknowledged":
      return ["resolve"];
    case "resolved":
      // A derived closure is not persisted yet; a legacy kind-less closure has no reopen rule.
      if (d.closureDerived || d.closure === "legacy-resolved") return [];
      return openKeyExists ? [] : ["reopen"];
    default:
      return [];
  }
}

export function attentionPriorityOf(rowClass: RowClass, state: IncidentState, effective: Severity): number {
  const rank = rowClass === "incident" ? STATE_RANK[state] : NON_INCIDENT_RANK;
  return rank * 10 + SEVERITY_ORDER[effective];
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const causeStatusOf = (s: string | null) => (s === "HYPOTHESIS" || s === "CONFIRMED" ? s : null);
const codeOrNull = (c: string | null) => (isRegistryCode(c) ? c : null);

// ── The derivation ──────────────────────────────────────────────────────────

interface Draft {
  verdict: IncidentVerdict;
  /** Subject identity for the spread count only — never emitted. */
  subjectRef: string;
  attributedUserId: string | null;
  incidentKey: string | null;
}

function sortVerdicts<T extends IncidentVerdict>(vs: T[]): T[] {
  return vs.sort((a, b) =>
    a.attentionPriority - b.attentionPriority
    || (a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function generationOf(id: string, prev: ReadonlyMap<string, string | null>): number {
  let n = 1;
  const seen = new Set<string>([id]);
  let cur = prev.get(id) ?? null;
  while (cur !== null && !seen.has(cur)) {
    n++;
    seen.add(cur);
    if (!prev.has(cur)) break; // the chain continues beyond the visible rows
    cur = prev.get(cur) ?? null;
  }
  return n;
}

function archivedDraft(a: ArchivedIncidentFacts): Draft {
  const c = classifySyncIssue({ kind: a.kind, provider: a.provider, detail: null });
  const op = a.operation ?? parseIncidentKey(a.incidentKey)?.operation ?? null;
  const operation = emittedOperation(op);
  const first = a.firstOccurredAt ?? a.lastOccurredAt ?? a.archivedAt;
  const last = a.lastOccurredAt ?? a.firstOccurredAt ?? a.archivedAt;
  return {
    subjectRef: a.plaidItemId ? `item:${a.plaidItemId}` : a.financialAccountId ? `account:${a.financialAccountId}` : "unscoped",
    attributedUserId: a.subjectUserId,
    incidentKey: a.incidentKey,
    verdict: {
      id: a.incidentId, rowClass: c.nature === "event" ? "evidence" : "incident", state: "archived", freshness: "current",
      closure: closureOfKind(a.resolutionKind), closureDerived: false,
      kind: a.kind, provider: a.provider, domain: c.domain, severity: c.severity, effectiveSeverity: c.severity,
      operation, label: incidentLabel(a.kind, c.domain), operationLabel: incidentOperationLabel(operation),
      firstSeenAt: first.toISOString(), lastSeenAt: last.toISOString(), resolvedAt: iso(a.resolvedAt),
      occurrenceCount: a.occurrenceCount, correlatedOccurrenceCount: 0,
      episodeKey: a.incidentKey ?? `legacy:${a.incidentId}`, duplicateOf: null,
      plaidItemId: a.plaidItemId, financialAccountId: a.financialAccountId, subjectState: "LIVE",
      brokenNow: false, alertable: false,
      attentionPriority: attentionPriorityOf(c.nature === "event" ? "evidence" : "incident", "archived", c.severity),
      spread: { groupKey: `${a.provider}::${c.domain}::${operation ?? "unknown"}`, spread: "isolated", affectedSubjects: 0 },
      recurrence: { generation: 1, previousIncidentId: a.previousIncidentId, relatedIncidentIds: [] },
      recovery: { proofCount: 0, mayAdvance: false, lastAttemptAt: null, lastSkipAt: null, evidenceKnown: false },
      causeStatus: causeStatusOf(a.causeStatus), causeCode: codeOrNull(a.causeCode),
      availableActions: [],
    },
  };
}

/**
 * THE pure core. Every row (incident or not) gets one verdict; archived
 * summaries follow (a live row wins over its own archive copy).
 */
export function deriveIncidentVerdicts<A extends IncidentAudience>(
  facts: IncidentFacts,
  opts: DeriveOptions & { audience: A },
): IncidentVerdictSet<VerdictFor<A>> {
  const { now } = opts;
  const subjectFacts = toSubjectFacts(facts.subjects);
  const attempts = facts.attempts ?? new Map<string, AttemptEvidence>();
  const occurrenceAccounts = facts.subjects.occurrenceAccounts ?? new Map<string, readonly string[]>();

  // Pass 1 — per-row decisions.
  const drafts: Draft[] = [];
  const liveIds = new Set<string>();
  for (const r of facts.rows) {
    liveIds.add(r.id);
    const c = classifyRow(r);
    const rowClass = rowClassOf(r, c);
    const subject = subjectVerdict(r, subjectFacts, occurrenceAccounts.get(r.id) ?? []);
    const fullOp = operationOf(r);
    const evidence = attempts.get(r.id) ?? UNKNOWN_EVIDENCE;
    const d: StateDecision = rowClass === "incident"
      ? decideState(r, subject, fullOp, evidence, now)
      // D1 — evidence and superseded rows are CLOSED by nature (never active, never
      // resolvable): state "resolved" with no closure; read `rowClass` for which.
      : { state: "resolved", freshness: "current", closure: null, closureDerived: false };
    const effectiveSeverity: Severity = d.freshness === "unverified" ? demoteSeverity(c.severity) : c.severity;
    const operation = emittedOperation(fullOp);
    const first = r.firstOccurredAt ?? r.createdAt;
    const last = r.lastOccurredAt ?? r.createdAt;
    drafts.push({
      subjectRef: r.plaidItemId ? `item:${r.plaidItemId}` : r.financialAccountId ? `account:${r.financialAccountId}` : "unscoped",
      attributedUserId: attributionOf(r, facts.subjects),
      incidentKey: r.incidentKey,
      verdict: {
        id: r.id, rowClass, state: d.state, freshness: d.freshness, closure: d.closure, closureDerived: d.closureDerived,
        kind: r.kind, provider: r.provider, domain: c.domain, severity: c.severity, effectiveSeverity,
        operation, label: incidentLabel(r.kind, c.domain), operationLabel: incidentOperationLabel(operation),
        firstSeenAt: first.toISOString(), lastSeenAt: last.toISOString(), resolvedAt: iso(r.resolvedAt),
        occurrenceCount: r.occurrenceCount, correlatedOccurrenceCount: r.correlatedOccurrenceCount,
        episodeKey: r.incidentKey ?? `legacy:${r.id}`, duplicateOf: null,
        plaidItemId: r.plaidItemId, financialAccountId: r.financialAccountId, subjectState: subjectStateOf(subject),
        brokenNow: rowClass === "incident" && BROKEN_NOW_STATES.has(d.state),
        alertable: false, // pass 2
        attentionPriority: attentionPriorityOf(rowClass, d.state, effectiveSeverity),
        spread: { groupKey: `${r.provider}::${c.domain}::${operation ?? "unknown"}`, spread: "isolated", affectedSubjects: 0 },
        recurrence: { generation: 1, previousIncidentId: r.previousIncidentId, relatedIncidentIds: [] },
        recovery: {
          proofCount: r.evidence?.proofCount ?? 0,
          mayAdvance: r.evidence?.mayAdvance ?? false,
          lastAttemptAt: iso(evidence.lastAttemptAt),
          lastSkipAt: iso(evidence.lastSkipAt),
          evidenceKnown: evidence.known,
        },
        causeStatus: causeStatusOf(r.causeStatus), causeCode: codeOrNull(r.causeCode),
        availableActions: [], // pass 2
      },
    });
  }
  for (const a of facts.archived ?? []) if (!liveIds.has(a.incidentId)) drafts.push(archivedDraft(a));

  // Pass 2 — cross-row rules.
  // D8 — legacy duplicates: two NOT-closed incident rows sharing one episode
  // key fold onto the newest (lastSeenAt, then id); the folded one is not
  // counted as broken now.
  const openByKey = new Map<string, Draft[]>();
  for (const dr of drafts) {
    const v = dr.verdict;
    if (v.rowClass !== "incident" || v.state === "resolved" || v.state === "archived") continue;
    const list = openByKey.get(v.episodeKey) ?? [];
    list.push(dr);
    openByKey.set(v.episodeKey, list);
  }
  for (const list of openByKey.values()) {
    if (list.length < 2) continue;
    const [head, ...rest] = [...list].sort((a, b) =>
      (a.verdict.lastSeenAt < b.verdict.lastSeenAt ? 1 : a.verdict.lastSeenAt > b.verdict.lastSeenAt ? -1 : 0)
      || (a.verdict.id < b.verdict.id ? -1 : 1));
    for (const dr of rest) { dr.verdict.duplicateOf = head.verdict.id; dr.verdict.brokenNow = false; }
  }
  // Keys with an open episode (reopen is refused while one exists, §6).
  const openKeys = new Set<string>();
  for (const dr of drafts) if (dr.incidentKey && dr.verdict.rowClass === "incident" && !["resolved", "archived"].includes(dr.verdict.state)) openKeys.add(dr.incidentKey);

  // Spread — distinct live subjects broken now per group (identity-free count).
  const groupSubjects = new Map<string, Set<string>>();
  for (const dr of drafts) {
    if (!dr.verdict.brokenNow) continue;
    const g = groupSubjects.get(dr.verdict.spread.groupKey) ?? new Set<string>();
    g.add(dr.subjectRef);
    groupSubjects.set(dr.verdict.spread.groupKey, g);
  }
  // Recurrence — the previousIncidentId chain as far as rows are visible, plus relations.
  const prev = new Map<string, string | null>(drafts.map((dr) => [dr.verdict.id, dr.verdict.recurrence.previousIncidentId]));
  const related = new Map<string, Set<string>>();
  for (const rel of facts.relations ?? []) {
    for (const [a, b] of [[rel.fromIncidentId, rel.toIncidentId], [rel.toIncidentId, rel.fromIncidentId]] as const) {
      const s = related.get(a) ?? new Set<string>();
      s.add(b);
      related.set(a, s);
    }
  }

  for (const dr of drafts) {
    const v = dr.verdict;
    const affected = v.brokenNow ? groupSubjects.get(v.spread.groupKey)?.size ?? 0 : 0;
    v.spread = { ...v.spread, affectedSubjects: affected, spread: affected >= WIDESPREAD_MIN_SUBJECTS ? "widespread" : "isolated" };
    const rec: RecurrenceVerdict = {
      generation: generationOf(v.id, prev),
      previousIncidentId: v.recurrence.previousIncidentId,
      relatedIncidentIds: [...(related.get(v.id) ?? [])].sort(),
    };
    v.recurrence = rec;
    // Alertable: broken now, inside its window, not recovering, not a folded duplicate.
    v.alertable = v.brokenNow && v.freshness === "current" && v.state !== "recovering";
    if (v.state !== "archived") {
      const openKeyExists = dr.incidentKey !== null && openKeys.has(dr.incidentKey);
      v.availableActions = actionsFor(v.rowClass, { state: v.state, freshness: v.freshness, closure: v.closure, closureDerived: v.closureDerived }, openKeyExists);
    }
  }

  // Audience tier — the CUSTOMER_SUCCESS tier is the only one that names the customer.
  const includeIdentity = opts.audience === "CUSTOMER_SUCCESS";
  const all = drafts.map((dr) =>
    includeIdentity ? ({ ...dr.verdict, subjectUserId: dr.attributedUserId } satisfies CsIncidentVerdict) : dr.verdict,
  ) as VerdictFor<A>[];

  return { all: sortVerdicts(all), truncated: facts.scanTruncated, scanned: facts.rows.length };
}

/** Harness hook (§13.3 step 2): one verdict, normalised across readers. `open` MEANS brokenNow. */
export function normaliseVerdict(v: IncidentVerdict | CsIncidentVerdict): NormalisedVerdict {
  const out: NormalisedVerdict = {
    id: v.id,
    open: v.brokenNow,
    brokenNow: v.brokenNow,
    alertable: v.alertable,
    state: v.rowClass === "incident" ? v.state : v.rowClass,
    severity: v.severity,
    groupKey: v.spread.groupKey,
  };
  if ("subjectUserId" in v) out.subjectUserId = v.subjectUserId;
  return out;
}
