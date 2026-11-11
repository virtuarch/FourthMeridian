/**
 * lib/platform/incidents/investigation-dto.ts  (PB-1 Phase 2B — the wire shapes, PURE + client-safe)
 *
 * What the incident investigation routes put on the wire, by TIER, through an
 * explicit ALLOWLIST of verdict fields. A route never serialises a verdict as
 * it came from the accessor: it projects it here. So the Platform Ops output is
 * identity-free STRUCTURALLY — even if a CUSTOMER_SUCCESS verdict reached an
 * Ops route (a System Admin's break-glass mints a CS token), `subjectUserId`
 * is not a field this projection copies for the "ops" tier.
 *
 * RECOVERY ACTIONS are only the EXISTING, audited operator routes:
 *   ops  resync          POST /api/platform/platform-ops/connections/[id]/resync          (PLATFORM_OPS WRITE, fresh)
 *        request-reauth  POST /api/platform/platform-ops/connections/[id]/request-reauth  (PLATFORM_OPS WRITE, fresh)
 *   cs   refresh-customer POST /api/platform/customer-success/customers/[userId]/refresh  (CUSTOMER_SUCCESS WRITE, fresh)
 *   ops  run-job         POST /api/platform/platform-ops/operations  { commandId }       (PLATFORM_OPS WRITE, fresh;
 *                        a fleet command also CONTROL + reason — the route's guards, unchanged)
 * each recording through recordOperatorAction.
 *
 * INCIDENT DRAWER PR-B (S2 09gg b) — `run-job`: for a JOB-SOURCED incident
 * (no connection subject), the newest occurrence's evidence `jobName`, mapped
 * through job-commands.ts to a REGISTERED operations command. The SERVER derives
 * the command here; an unmapped job offers nothing. The operations route
 * re-derives it from the incident's own evidence before recording `incidentId`.
 * ORDER IS RANK: the FIRST recovery action is the primary one (the drawer
 * renders it as such); the rest are secondary.
 *
 * LIFECYCLE ACTIONS (PB-1 S6) — the verdict's `availableActions`, narrowed to
 * the ones with a route, on the OPS tier only:
 *   ops  acknowledge  POST /api/platform/platform-ops/incidents/[id]/acknowledge  (PLATFORM_OPS WRITE, fresh)
 *        resolve      POST /api/platform/platform-ops/incidents/[id]/resolve      (PLATFORM_OPS WRITE, fresh)
 *   cs   none — Customer Success is read-only for incident state.
 * Reopen has no route (an operator reopen would open a NEW episode; not built).
 * The offer is descriptive; the route's guard and the lifecycle CAS decide.
 *
 * INCIDENT DETAIL v1 — `summary` (derived display status, customer action,
 * timestamps, ongoing) and `diagnosis` (allowlisted provider error code, the
 * connection's attempts summary, the recurrence chain). Both are built from
 * fields already on the investigation — never `detail`, never provider text —
 * and are identity-free on every tier. The REMEDIATION RULE: a code the
 * customer must fix (explanations.ts remedyFor = customer-reconnect /
 * customer-re-add, or a NEEDS_REAUTH connection) NEVER offers Resync — a
 * server retry cannot fix it. Resync is offered only where a retry can help.
 *
 * INCIDENT DRAWER PR-A (owner 11-08, S2 09gg a) — `component`: the job the
 * newest occurrence was observed under, WORDED here (JOB_LABELS; an
 * unregistered ledger name becomes UNKNOWN_JOB_LABEL — never the raw string),
 * plus the verdict's operation label and domain. `jobRunId` rides the OPS tier
 * only (S2). `subjectRef` (CS tier only) is the opaque PRIV-ref the CS drawer
 * shows in place of the raw customer id; the route computes it server-side.
 */

import type {
  CsIncidentVerdict,
  IncidentAffected,
  IncidentArchiveState,
  IncidentInvestigation,
  IncidentLinkKind,
  IncidentSearchResult,
  IncidentTimeline,
  IncidentVerdict,
  ResolutionEvidenceDigest,
  IncidentAttemptsSummary,
} from "./intelligence/types";
import type { IncidentNavigationLinkDTO } from "./related-navigation";
import { deriveDisplayStatus, isOpenState, type DisplayStatus } from "./display-status";
import { remedyFor, type RemedyClass } from "./explanations";
import { JOB_LABELS } from "@/components/platform/ops-visual/job-catalog";
import { jobCommandForJob } from "./job-commands";
import { OPAQUE_USER_REF_FALLBACK } from "@/lib/platform/opaque-user-ref-format";

export type IncidentTier = "ops" | "cs";

/** The lifecycle actions that HAVE a route (PB-1 S6). Reopen is deliberately absent. */
export type LifecycleActionDTO = "acknowledge" | "resolve";
const ROUTED_LIFECYCLE_ACTIONS: readonly LifecycleActionDTO[] = ["acknowledge", "resolve"];

/** One incident row on the wire. `subjectUserId` exists ONLY on the cs tier. */
export interface IncidentRowDTO {
  id: string;
  state: IncidentVerdict["state"];
  freshness: IncidentVerdict["freshness"];
  closure: IncidentVerdict["closure"];
  closureDerived: boolean;
  kind: string;
  provider: string;
  domain: string;
  severity: IncidentVerdict["severity"];
  effectiveSeverity: IncidentVerdict["effectiveSeverity"];
  operation: string | null;
  label: string;
  operationLabel: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  occurrenceCount: number;
  correlatedOccurrenceCount: number;
  duplicateOf: string | null;
  subjectState: IncidentVerdict["subjectState"];
  brokenNow: boolean;
  alertable: boolean;
  spread: IncidentVerdict["spread"];
  generation: number;
  recovery: IncidentVerdict["recovery"];
  causeStatus: IncidentVerdict["causeStatus"];
  causeCode: string | null;
  subjectUserId?: string | null;
  /** CS tier ONLY: the opaque PRIV-ref of `subjectUserId` (server-computed) — what the CS list and drawer SHOW. */
  subjectRef?: string | null;
}

export type RecoveryActionDTO =
  | { kind: "resync" | "request-reauth"; connectionId: string }
  | { kind: "refresh-customer"; userId: string }
  /**
   * Incident drawer PR-B — run the job this incident was observed under, for
   * ALL customers, through the existing Manual operations route. `commandId`
   * is SERVER-derived from the incident's evidence (job-commands.ts);
   * `jobLabel` is the JOB_LABELS word; `reasonRequired` mirrors the command's
   * requirement (a fleet run needs a structured reason).
   */
  | { kind: "run-job"; commandId: string; jobLabel: string; reasonRequired: boolean };

/** Every recovery action kind (the drawer's "no button without a route" scan iterates this). */
export const RECOVERY_ACTION_KINDS = ["resync", "request-reauth", "refresh-customer", "run-job"] as const satisfies readonly RecoveryActionDTO["kind"][];
type _AllKindsListed = Exclude<RecoveryActionDTO["kind"], (typeof RECOVERY_ACTION_KINDS)[number]> extends never ? true : false;
const _allKindsListed: _AllKindsListed = true;
void _allKindsListed;

export interface IncidentListDTO extends Omit<IncidentSearchResult, "items"> {
  tier: IncidentTier;
  items: IncidentRowDTO[];
  checkedAt: string;
  /** The requested `from` was older than the archive retention and was clamped. */
  fromClamped: boolean;
}

/** Incident detail v1 — the drawer's top block. Identity-free on every tier. */
export interface IncidentSummaryDTO {
  /** DERIVED (display-status.ts) — never stored. */
  displayStatus: DisplayStatus;
  /** The customer (not the server) must act for this to recover. Open incidents only. */
  customerActionRequired: boolean;
  /** What may help — decides the primary guidance and which recovery actions are offered. */
  remedy: RemedyClass | null;
  firstDetectedAt: string;
  lastObservedAt: string;
  resolvedAt: string | null;
  /** Broken now (counts toward the broken-now KPI). False for a closed or needs-verification incident. */
  ongoing: boolean;
}

/** Incident detail v1 — the earlier episodes of this incident (counts and ids; no identity). */
export interface IncidentRecurrenceDTO {
  generation: number;
  previousIncidentId: string | null;
  /** Earlier episodes visible to the read (recurrences + previous episode), a floor when truncated. */
  earlierEpisodes: number;
  truncated: boolean;
  /** The most recent earlier episode's closure time, when one is visible. */
  lastRecoveredAt: string | null;
}

export interface IncidentDiagnosisDTO {
  /** Allowlisted provider error code (explanations.ts), or null. */
  providerErrorCode: string | null;
  providerErrorSource: "connection" | "incident" | null;
  /** A code was recorded but is not a known provider code (it is not shown). */
  providerErrorUnrecognised: boolean;
  /** Null when the incident is not connection-scoped or the reader has no attempts seam. */
  attempts: IncidentAttemptsSummary | null;
  recurrence: IncidentRecurrenceDTO;
}

/**
 * Incident drawer PR-A — the job / component the incident was observed under.
 * Null when the newest occurrence names no job. Words only, except `jobRunId`
 * (an opaque run id; OPS tier only — absent on CS).
 */
export interface IncidentComponentDTO {
  /** JOB_LABELS word; UNKNOWN_JOB_LABEL for an unregistered job — never the raw ledger name. */
  jobLabel: string;
  jobRunId?: string;
  operationLabel?: string;
  domain?: string;
}

/** The word for a job the catalogue does not know (the raw internal name is never shown). */
export const UNKNOWN_JOB_LABEL = "Unrecognised scheduled job";
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The component block (pure): a job ⇒ its client word; no job ⇒ null. */
export function incidentComponentOf(
  inv: Pick<IncidentInvestigation<IncidentVerdict | CsIncidentVerdict>, "verdict" | "component">,
  tier: IncidentTier,
): IncidentComponentDTO | null {
  const c = inv.component;
  if (!c || typeof c.jobName !== "string" || c.jobName === "") return null;
  const label = Object.prototype.hasOwnProperty.call(JOB_LABELS, c.jobName) ? (JOB_LABELS as Record<string, string>)[c.jobName] : UNKNOWN_JOB_LABEL;
  const out: IncidentComponentDTO = { jobLabel: label };
  if (tier === "ops" && typeof c.jobRunId === "string" && RUN_ID.test(c.jobRunId)) out.jobRunId = c.jobRunId;
  const v = inv.verdict;
  if (typeof v.operationLabel === "string" && v.operationLabel !== "") out.operationLabel = v.operationLabel;
  if (typeof v.domain === "string" && v.domain !== "") out.domain = v.domain;
  return out;
}

export interface IncidentDetailDTO {
  tier: IncidentTier;
  incident: IncidentRowDTO;
  evidence: ResolutionEvidenceDigest | null;
  resolutionReasonCode: string | null;
  timeline: IncidentTimeline;
  affected: IncidentAffected;
  related: { id: string; kind: IncidentLinkKind; incident: IncidentRowDTO | null }[];
  recurrences: IncidentRowDTO[];
  recurrencesTruncated: boolean;
  archive: IncidentArchiveState;
  recovery: RecoveryActionDTO[];
  /** PB-1 S6 — lifecycle actions offered (ops tier only; always [] on cs). */
  lifecycleActions: LifecycleActionDTO[];
  /**
   * The "Go to" links (./related-navigation.ts): hrefs the ROUTE resolved
   * through the navigation registry for its own token and surface. Absent ⇒
   * none rendered. The client never builds one.
   */
  navigation?: IncidentNavigationLinkDTO[];
  /** Incident detail v1. */
  summary: IncidentSummaryDTO;
  diagnosis: IncidentDiagnosisDTO;
  /** Incident drawer PR-A — the job / component (null ⇒ not a job incident). */
  component: IncidentComponentDTO | null;
  /**
   * CS tier ONLY: the attributed customer's opaque PRIV-ref ("user #…", or
   * "customer" without a key) — what the drawer shows instead of the raw id.
   * Null when no customer is attributed. Absent on the ops tier.
   */
  subjectRef?: string | null;
  /**
   * Incident drawer PR-D (S2 09gg d) — the ROUTE says whether the Platform AI assessment exists
   * (the incidents pack flag, master included). Absent / false ⇒ the drawer renders nothing for it.
   */
  aiAssessmentAvailable?: boolean;
  checkedAt: string;
}

/** The verdict's available actions that have a route, for this tier. CS: none (read-only). */
export function lifecycleActionsFor(v: Pick<IncidentVerdict, "availableActions">, tier: IncidentTier): LifecycleActionDTO[] {
  if (tier !== "ops") return [];
  return ROUTED_LIFECYCLE_ACTIONS.filter((a) => v.availableActions.includes(a));
}

/** THE allowlist projection. Copies named fields only; identity only for the cs tier. */
export function incidentRowDTO(v: IncidentVerdict | CsIncidentVerdict, tier: IncidentTier, subjectRefOf?: (userId: string) => string): IncidentRowDTO {
  const row: IncidentRowDTO = {
    id: v.id, state: v.state, freshness: v.freshness, closure: v.closure, closureDerived: v.closureDerived,
    kind: v.kind, provider: v.provider, domain: v.domain, severity: v.severity, effectiveSeverity: v.effectiveSeverity,
    operation: v.operation, label: v.label, operationLabel: v.operationLabel,
    firstSeenAt: v.firstSeenAt, lastSeenAt: v.lastSeenAt, resolvedAt: v.resolvedAt,
    occurrenceCount: v.occurrenceCount, correlatedOccurrenceCount: v.correlatedOccurrenceCount,
    duplicateOf: v.duplicateOf, subjectState: v.subjectState, brokenNow: v.brokenNow, alertable: v.alertable,
    spread: { groupKey: v.spread.groupKey, spread: v.spread.spread, affectedSubjects: v.spread.affectedSubjects },
    generation: v.recurrence.generation,
    recovery: { ...v.recovery },
    causeStatus: v.causeStatus, causeCode: v.causeCode,
  };
  if (tier === "cs") {
    row.subjectUserId = "subjectUserId" in v ? v.subjectUserId : null;
    // PRIV-ref (P3, S2): the reference shown in place of the raw id; fail-closed word without a ref function.
    row.subjectRef = row.subjectUserId ? (subjectRefOf ? subjectRefOf(row.subjectUserId) : OPAQUE_USER_REF_FALLBACK) : null;
  }
  return row;
}

const OPEN_STATES: ReadonlySet<IncidentVerdict["state"]> = new Set(["active", "acknowledged", "recovering", "stale-unverified"]);

/**
 * The EXISTING recovery routes that apply to this incident, for this tier.
 * Ops: a live PLAID item subject of an open incident, by REMEDY (explanations.ts):
 *   customer-reconnect  request-reauth only (prompts the customer) — NEVER resync:
 *                       a server retry cannot fix a code the customer must fix
 *   customer-re-add     none (the connection is gone at the provider)
 *   server-retry        resync only (reconnecting cannot fix a provider outage)
 *   investigate         ACTIVE ⇒ resync; ERROR with no verified explanation ⇒
 *                       resync + request-reauth (operator judgement; both audited)
 * request-reauth is never offered on a healthy (ACTIVE) connection from here.
 * Ops, JOB-SOURCED (PR-B): an open incident with NO connection subject whose
 * newest occurrence names a job mapped to a registered operations command ⇒
 * run-job (that command, server-derived). An unmapped job ⇒ none. A
 * connection-scoped incident never gets run-job: its remedy is per connection
 * (a fleet run is never the fix for one connection's error).
 * The FIRST action returned is the primary one.
 * CS: an open incident attributed to a customer — that customer's Refresh all,
 * EXCEPT when the customer must act (a refresh is a server retry too).
 * Closed, archived or unattributed ⇒ none.
 */
export function recoveryActionsFor(
  inv: Pick<IncidentInvestigation<IncidentVerdict | CsIncidentVerdict>, "verdict" | "affected" | "providerError" | "component">,
  tier: IncidentTier,
): RecoveryActionDTO[] {
  const v = inv.verdict;
  if (v.rowClass !== "incident" || !OPEN_STATES.has(v.state)) return [];
  const status = inv.affected.itemStatus;
  const remedy = remedyFor(inv.providerError?.code ?? null, status);
  const customerMustAct = v.provider === "PLAID" && (remedy === "customer-reconnect" || remedy === "customer-re-add");
  if (tier === "cs") {
    // A refresh is a server retry: it cannot fix what only the customer can.
    if (customerMustAct) return [];
    const userId = "subjectUserId" in v ? v.subjectUserId : null;
    return userId ? [{ kind: "refresh-customer", userId }] : [];
  }
  if (!v.plaidItemId) return runJobActionFor(inv);
  if (v.provider !== "PLAID" || v.subjectState !== "LIVE") return [];
  const id = v.plaidItemId;
  switch (remedy) {
    case "customer-reconnect":
      return status === "NEEDS_REAUTH" || status === "ERROR" ? [{ kind: "request-reauth", connectionId: id }] : [];
    case "customer-re-add":
      return [];
    case "server-retry":
      return status === "ACTIVE" || status === "ERROR" ? [{ kind: "resync", connectionId: id }] : [];
    case "investigate": {
      const out: RecoveryActionDTO[] = [];
      if (status === "ACTIVE" || status === "ERROR") out.push({ kind: "resync", connectionId: id });
      if (status === "ERROR") out.push({ kind: "request-reauth", connectionId: id });
      return out;
    }
  }
}

/** PR-B — the run-job action for a job-sourced incident: its evidence's job ⇒ the registered command, or nothing. */
function runJobActionFor(inv: Pick<IncidentInvestigation<IncidentVerdict | CsIncidentVerdict>, "component">): RecoveryActionDTO[] {
  const jobName = inv.component?.jobName ?? null;
  const cmd = jobCommandForJob(jobName);
  if (!cmd || jobName === null) return [];
  return [{ kind: "run-job", commandId: cmd.commandId, jobLabel: (JOB_LABELS as Record<string, string>)[jobName] ?? UNKNOWN_JOB_LABEL, reasonRequired: cmd.reasonRequired }];
}

/** Incident detail v1 — the summary block (pure over the investigation). */
export function incidentSummaryOf(
  inv: Pick<IncidentInvestigation<IncidentVerdict | CsIncidentVerdict>, "verdict" | "affected" | "providerError">,
): IncidentSummaryDTO {
  const v = inv.verdict;
  const open = isOpenState(v.state);
  const code = inv.providerError?.code ?? null;
  const itemStatus = inv.affected.itemStatus;
  const remedy = open && v.provider === "PLAID" && (v.plaidItemId || code) ? remedyFor(code, itemStatus) : null;
  return {
    displayStatus: deriveDisplayStatus({ state: v.state, generation: v.recurrence.generation, previousIncidentId: v.recurrence.previousIncidentId, itemStatus, providerErrorCode: code }),
    customerActionRequired: remedy === "customer-reconnect" || remedy === "customer-re-add",
    remedy,
    firstDetectedAt: v.firstSeenAt,
    lastObservedAt: v.lastSeenAt,
    resolvedAt: v.resolvedAt,
    ongoing: open && v.brokenNow,
  };
}

/** Incident detail v1 — the diagnosis block (pure over the investigation). */
export function incidentDiagnosisOf(
  inv: Pick<IncidentInvestigation<IncidentVerdict | CsIncidentVerdict>, "verdict" | "providerError" | "attempts" | "recurrences" | "recurrencesTruncated" | "related">,
): IncidentDiagnosisDTO {
  const v = inv.verdict;
  const earlier = new Map<string, string | null>();
  for (const r of inv.recurrences) if (r.id !== v.id && r.firstSeenAt < v.firstSeenAt) earlier.set(r.id, r.resolvedAt);
  for (const l of inv.related) if (l.kind === "PREVIOUS_EPISODE") earlier.set(l.id, l.incident?.resolvedAt ?? earlier.get(l.id) ?? null);
  const closures = [...earlier.values()].filter((x): x is string => x !== null).sort();
  const pe = inv.providerError;
  return {
    providerErrorCode: pe?.code ?? null,
    providerErrorSource: pe?.code ? pe.source : null,
    providerErrorUnrecognised: pe?.unrecognised === true,
    attempts: inv.attempts
      ? { ...inv.attempts, counts: { ...inv.attempts.counts }, recent: inv.attempts.recent.map((a) => ({ ...a })) }
      : null,
    recurrence: {
      generation: v.recurrence.generation,
      previousIncidentId: v.recurrence.previousIncidentId,
      earlierEpisodes: Math.max(earlier.size, v.recurrence.generation - 1),
      truncated: inv.recurrencesTruncated,
      lastRecoveredAt: closures.length ? closures[closures.length - 1] : null,
    },
  };
}

export function incidentListDTO(
  r: IncidentSearchResult<IncidentVerdict | CsIncidentVerdict>, tier: IncidentTier, now: Date, fromClamped: boolean, opts?: IncidentDetailOptions,
): IncidentListDTO {
  return {
    tier, items: r.items.map((v) => incidentRowDTO(v, tier, opts?.subjectRefOf)), total: r.total, page: r.page, pageSize: r.pageSize,
    truncated: r.truncated, scanned: r.scanned, facets: r.facets, checkedAt: now.toISOString(), fromClamped,
  };
}

export interface IncidentDetailOptions {
  /** CS tier: the server-side PRIV-ref of a customer id (lib/platform/opaque-user-ref.ts). Absent ⇒ the fail-closed word. */
  subjectRefOf?: (userId: string) => string;
}

export function incidentDetailDTO(
  inv: IncidentInvestigation<IncidentVerdict | CsIncidentVerdict>, tier: IncidentTier, now: Date, opts?: IncidentDetailOptions,
): IncidentDetailDTO {
  const dto: IncidentDetailDTO = {
    tier,
    incident: incidentRowDTO(inv.verdict, tier, opts?.subjectRefOf),
    evidence: inv.evidence ? { ...inv.evidence } : null,
    resolutionReasonCode: inv.resolutionReasonCode,
    timeline: { source: inv.timeline.source, truncated: inv.timeline.truncated, events: inv.timeline.events.map((e) => ({ ...e })) },
    affected: { ...inv.affected },
    related: inv.related.map((l) => ({ id: l.id, kind: l.kind, incident: l.incident ? incidentRowDTO(l.incident, tier, opts?.subjectRefOf) : null })),
    recurrences: inv.recurrences.map((v) => incidentRowDTO(v, tier, opts?.subjectRefOf)),
    recurrencesTruncated: inv.recurrencesTruncated,
    archive: { ...inv.archive },
    recovery: recoveryActionsFor(inv, tier),
    lifecycleActions: lifecycleActionsFor(inv.verdict, tier),
    summary: incidentSummaryOf(inv),
    diagnosis: incidentDiagnosisOf(inv),
    component: incidentComponentOf(inv, tier),
    checkedAt: now.toISOString(),
  };
  if (tier === "cs") {
    const userId = "subjectUserId" in inv.verdict ? inv.verdict.subjectUserId : null;
    dto.subjectRef = userId ? (opts?.subjectRefOf ? opts.subjectRefOf(userId) : OPAQUE_USER_REF_FALLBACK) : null;
  }
  return dto;
}
