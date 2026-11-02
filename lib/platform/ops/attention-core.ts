/**
 * lib/platform/ops/attention-core.ts  (UX-P1 · Agent 2)
 *
 * WHAT NEEDS ATTENTION — the pure composition behind the Overview's
 * "Attention required" table.
 *
 * ── NOT A SECOND AUTHORITY ───────────────────────────────────────────────────
 * Every row here is a RESTATEMENT of a verdict an existing authority already
 * reached: a connection's `healthState` (lib/connections/health.ts), a job's
 * `status` (lib/jobs/health.ts), a provider's `trust` (provider-health.ts), a
 * resource's `healthState` (resource-freshness.ts), a rule's `firing` in the
 * LATEST evaluate-alerts run (lib/alerts/latest-evaluation.ts) and an active
 * incident's `severity`/`state` (sync-issue-semantics via the D5 projection).
 * This module computes no staleness, no streak and no threshold. The ONE
 * judgement it makes — declared in `SEVERITY_OF` below and nowhere else — is
 * how those vocabularies line up on a single attention scale so the rows can
 * be ranked together. That table is the contract; `basis` on every row says
 * which authority's word it restates.
 *
 * ── RANK ─────────────────────────────────────────────────────────────────────
 * critical  canonical data is not being produced and nothing will fix it alone
 * error     an operation is broken and a person must act
 * warning   a detector fired; someone should look
 * info      forensic only
 * Sorted severity first, then LONGEST-STANDING first (`since` ascending, unknown
 * last), then id for stability. The UI never re-sorts (one ordering authority).
 *
 * ── HONESTY ──────────────────────────────────────────────────────────────────
 * "Firing" is only ever the latest evaluation's verdict; the delivery history
 * is carried SEPARATELY by the reader and never becomes a row. An authority
 * that could not be read is named in `authorities.failed` and contributes no
 * rows — absence of rows from a failed reader is not absence of problems, and
 * the empty state says how many authorities actually answered. Readers that
 * cap their lists report a FLOOR caption.
 *
 * PURE: no DB, no clock read (`now` is a parameter), no I/O.
 */

import type { ConnectionHealthResult, ConnectionHealthRow, HealthState } from "@/lib/connections/health";
import type { JobHealthStatus } from "@/lib/jobs/health";
import type { ProviderHealthResult, ProviderTrust } from "@/lib/platform/provider-health";
import type { ResourceFreshnessResult } from "@/lib/platform/resource-freshness";
import type { AlertLatestEvaluation } from "@/lib/alerts/latest-evaluation";
import type { AlertSeverity } from "@/lib/alerts/rules";
import type { PlatformIncidentProjection } from "@/lib/platform/incidents/platform-projection";
import type { SyncIssueSeverity } from "@/lib/platform/sync-issue-semantics";
import type { ExecutionRowDTO } from "@/lib/platform/refresh/execution-query-core";
import type { AiFailureHealth } from "@/lib/platform/ai/failures";
import type { BriefOps } from "@/lib/platform/ai/brief-ops";
import { platformViewTarget } from "@/lib/platform/workspaces";
import { describePolicyAssignmentIssue, type PolicyAssignmentHealth } from "@/lib/entitlements/assignment-health-core";

/** PLATFORM OPS PHASE 1 UX — alert rules live in Policies › Alerts (the default
 *  Policies view is Policy groups). Jobs / Pipeline targets keep their retired
 *  ids, which resolve to Operations › Jobs / Pipeline (PLATFORM_WORKSPACE_ALIASES). */
const ALERTS_VIEW = platformViewTarget("platform-policies", "alerts");
/** Owner ruling (2026-10-30) — the Policies › Policy groups view, which carries the
 *  unassigned / unknown-assignment COUNTS beside the catalogue. The fix itself is a
 *  Customer Success action (a different Platform area); the row's problem sentence
 *  names it and the opaque reference to search for. */
const POLICY_GROUPS_VIEW = platformViewTarget("platform-policies", "groups");

// ── Vocabulary ────────────────────────────────────────────────────────────────

export type AttentionSeverity = "critical" | "error" | "warning" | "info";

export const ATTENTION_SEVERITY_RANK: Record<AttentionSeverity, number> = { critical: 0, error: 1, warning: 2, info: 3 };

export type AttentionEntityKind = "connection" | "job" | "provider" | "resource" | "alert-rule" | "incident" | "customer";

export interface AttentionEntity {
  kind: AttentionEntityKind;
  /** Institution / job name / provider label / resource label / rule title / subject label /
   *  a customer's OPAQUE `user …abc123` reference (never an email, name or whole id). */
  label: string;
  /** An OPAQUE reference the actions need (a connection id). Never a customer id. */
  ref?: string;
}

export type AttentionEvidence =
  /** A RefreshExecution the operator can inspect in place. */
  | { kind: "execution"; id: string; workspace: "platform-refresh" }
  /** The workspace that holds the full read. (`ai` / `brief` — BETA V1 user-impact rows.) */
  | { kind: "connection" | "job" | "provider" | "resource" | "alert" | "incident" | "ai" | "brief" | "policy-assignment"; id?: string; workspace: string };

export type AttentionAction =
  | { kind: "open-workspace"; workspace: string }
  | { kind: "resync" | "request-reauth"; connectionId: string; source: string }
  /** A doorway to Jobs — the manual run stays on the Jobs surface. */
  | { kind: "run-now"; job: string };

export interface AttentionItem {
  id: string;
  severity: AttentionSeverity;
  entity: AttentionEntity;
  /** One line, in words, naming the authority's own state. */
  problem: string;
  /** ISO instant the condition is known to have held since; null when not recorded. */
  since: string | null;
  evidence: AttentionEvidence;
  actions: readonly AttentionAction[];
  /** Which authority's verdict this row restates, and what `since` means for it. */
  basis: string;
}

export const ATTENTION_AUTHORITIES = [
  "connection-health",
  "job-health",
  "provider-health",
  "resource-freshness",
  "alert-evaluation",
  "incidents",
  // Owner ruling (2026-10-30) — missing / invalid customer policy-group assignments.
  "policy-assignments",
] as const;
export type AttentionAuthority = (typeof ATTENTION_AUTHORITIES)[number];

// ── Inputs (already read by their authorities; null = could not be read) ─────

/** The slice of a job-health report this composition reads. */
export interface AttentionJobReport {
  job: string;
  status: JobHealthStatus;
  expectedEveryHours: number;
  consecutiveFailures: number;
  lastStartedAt: string | null;
  lastFailureAt: string | null;
  lastFailureSummary: string | null;
}

export interface AttentionInputs {
  connections: ConnectionHealthResult | null;
  jobs: { jobs: readonly AttentionJobReport[] } | null;
  providers: ProviderHealthResult | null;
  resources: ResourceFreshnessResult | null;
  /** `latest: null` = evaluator never ran (an answer); outer null = loader failed. */
  alerts: { latest: AlertLatestEvaluation | null; titles: Readonly<Record<string, string>> } | null;
  incidents: { items: readonly PlatformIncidentProjection[]; activeTotal: number; truncated: boolean } | null;
  /** Owner ruling (2026-10-30) — the policy-assignment read (lib/platform/policy-assignment-health.ts).
   *  Absent (undefined) is treated exactly like null: NOT read, so the authority is named as failed. */
  policyAssignments?: PolicyAssignmentHealth | null;
}

export interface AttentionCore {
  items: readonly AttentionItem[];
  counts: Record<AttentionSeverity, number>;
  authorities: { checked: AttentionAuthority[]; failed: AttentionAuthority[] };
  /** Captions for every reader that returned a floor rather than a total. */
  floors: string[];
}

// ── THE declared severity table (the only judgement in this file) ────────────

export const SEVERITY_OF = {
  connection: {
    ERROR: "critical",        // the provider refuses; nothing syncs until a person acts
    NEEDS_REAUTH: "error",    // the customer must reconnect; a known path exists
    DEGRADED: "warning",      // an error without a status flip — may self-heal
    STALE: "warning",         // overdue against policy
  } as Partial<Record<HealthState, AttentionSeverity>>,
  job: {
    dead: "critical",
    failing: "error",
    overdue: "warning",
  } as Partial<Record<JobHealthStatus, AttentionSeverity>>,
  provider: {
    FAILING: "error",
    STALE: "warning",
    DEGRADED: "warning",
  } as Partial<Record<ProviderTrust, AttentionSeverity>>,
  resource: {
    empty: "error",           // mirrors lib/alerts/evaluate.ts (critical there, but an archive is not customer data)
    stale: "warning",
  } as Partial<Record<"empty" | "stale", AttentionSeverity>>,
  alert: {
    critical: "critical",
    warning: "warning",
  } as Record<AlertSeverity, AttentionSeverity>,
  incident: {
    critical: "critical",
    error: "error",
    warning: "warning",
    info: "info",
  } as Record<SyncIssueSeverity, AttentionSeverity>,
  /** Owner ruling (2026-10-30): enforced ⇒ the customer is being refused paid features now (a
   *  person must act); not enforced ⇒ the exposure is visible BEFORE the switch is turned on. */
  policyAssignment: {
    enforced: "error",
    dormant: "warning",
  } as Record<"enforced" | "dormant", AttentionSeverity>,
} as const;

// ── Formatting (pure, clock-injected) ────────────────────────────────────────

export function relativeAge(iso: string | null, now: Date): string {
  if (!iso) return "never recorded";
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "time unreadable";
  const m = Math.round(Math.abs(ms) / 60_000);
  const span = m < 1 ? "under a minute" : m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 60 / 24)} d`;
  return ms >= 0 ? `${span} ago` : `in ${span}`;
}

const TRUST_WORD: Record<ProviderTrust, string> = { OPERATIONAL: "Operational", DEGRADED: "Degraded", STALE: "Stale data", FAILING: "Failing", UNKNOWN: "Unknown" };

// ── Per-authority restatements ───────────────────────────────────────────────

function connectionItems(c: ConnectionHealthResult, now: Date): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const row of c.unhealthy) {
    const severity = SEVERITY_OF.connection[row.healthState];
    if (!severity) continue; // HEALTHY never appears; REVOKED is retired, not unhealthy
    out.push({
      id: `connection:${row.source}:${row.id}`,
      severity,
      entity: { kind: "connection", label: row.label, ref: row.id },
      problem: connectionProblem(row, now),
      since: row.since ?? (row.healthState === "STALE" ? row.lastSyncedAt : null),
      evidence: { kind: "connection", id: row.id, workspace: "platform-providers" },
      actions: connectionActions(row),
      basis: "connection health state (PlaidItem / Connection status judged against the refresh policy); since = the recorded transition, or the last sync for a stale row",
    });
  }
  return out;
}

function connectionProblem(row: ConnectionHealthRow, now: Date): string {
  const code = row.errorCode ? ` (${row.errorCode})` : "";
  switch (row.healthState) {
    case "NEEDS_REAUTH": return `Needs reauthorization — the customer must reconnect${code}.`;
    case "ERROR": return `Provider error${code} — syncing has stopped.`;
    case "DEGRADED": return `Degraded${code} — the last sync recorded an error without changing status.`;
    case "STALE": return row.lastSyncedAt ? `Stale — last synced ${relativeAge(row.lastSyncedAt, now)}, beyond its refresh policy.` : "Never synced — no successful sync is recorded.";
    default: return `${row.healthState}${code}.`;
  }
}

function connectionActions(row: ConnectionHealthRow): AttentionAction[] {
  const actions: AttentionAction[] = [];
  if (row.source === "PLAID") {
    // The resync route refuses a dead credential (409); offer only what can run.
    if (row.healthState !== "NEEDS_REAUTH") actions.push({ kind: "resync", connectionId: row.id, source: row.source });
    actions.push({ kind: "request-reauth", connectionId: row.id, source: row.source });
  }
  actions.push({ kind: "open-workspace", workspace: "platform-providers" });
  return actions;
}

function jobItems(j: { jobs: readonly AttentionJobReport[] }, now: Date): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const job of j.jobs) {
    const severity = SEVERITY_OF.job[job.status];
    if (!severity) continue; // healthy / running / never-ran are not attention (never-ran is operator-decides)
    const problem =
      job.status === "dead" ? `Dead — no run recorded for several times its ${job.expectedEveryHours} h cadence (last started ${relativeAge(job.lastStartedAt, now)}).`
      : job.status === "failing" ? `Failed its last ${job.consecutiveFailures} run${job.consecutiveFailures === 1 ? "" : "s"}${job.lastFailureSummary ? ` — ${job.lastFailureSummary}` : ""}.`
      : `Overdue — expected every ${job.expectedEveryHours} h, last started ${relativeAge(job.lastStartedAt, now)}.`;
    out.push({
      id: `job:${job.job}`,
      severity,
      entity: { kind: "job", label: job.job },
      problem,
      since: job.status === "failing" ? job.lastFailureAt : job.lastStartedAt,
      evidence: { kind: "job", id: job.job, workspace: "platform-jobs" },
      actions: [{ kind: "run-now", job: job.job }, { kind: "open-workspace", workspace: "platform-jobs" }],
      basis: "job health status (JobRun ledger against the registry cadence); since = the last failure for a failing job, else the last recorded start",
    });
  }
  return out;
}

function providerItems(p: ProviderHealthResult): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const prov of p.providers) {
    const severity = SEVERITY_OF.provider[prov.trust];
    if (!severity) continue;
    const note = prov.notes[0] ? ` ${prov.notes[0]}` : "";
    out.push({
      id: `provider:${prov.key}`,
      severity,
      entity: { kind: "provider", label: prov.label },
      problem: `${TRUST_WORD[prov.trust]} — ${prov.freshness.detail}.${note}`,
      since: prov.trust === "FAILING" ? prov.lastFailureAt : prov.trust === "STALE" ? prov.freshness.asOf : null,
      evidence: { kind: "provider", id: prov.key, workspace: "platform-providers" },
      actions: [{ kind: "open-workspace", workspace: "platform-providers" }],
      basis: "provider trust roll-up (execution + content + connection, worst-wins); since = the last failure when failing, the newest data point when stale",
    });
  }
  return out;
}

function resourceItems(r: ResourceFreshnessResult): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const res of r.resources) {
    // A cold archive whose pipeline is known-blocked is trust "unknown" — the
    // alerting authority deliberately does not fire on it, and neither do we.
    if (res.healthState === "empty" && res.trust.level === "unknown") continue;
    const severity = res.healthState === "empty" || res.healthState === "stale" ? SEVERITY_OF.resource[res.healthState] : undefined;
    if (!severity) continue;
    const caveat = res.trust.caveats[0] ? ` ${res.trust.caveats[0]}.` : "";
    const problem =
      res.healthState === "empty"
        ? `Archive is empty — expected data, found none.${caveat}`
        : `Stale — newest ${res.newestObservedDate} (${res.ageDays ?? "?"} d old, threshold ${Math.round(res.staleAfterHours / 24)} d).${caveat}`;
    out.push({
      id: `resource:${res.resource}`,
      severity,
      entity: { kind: "resource", label: res.label },
      problem,
      since: res.healthState === "stale" && res.newestObservedDate ? `${res.newestObservedDate}T00:00:00.000Z` : null,
      evidence: { kind: "resource", id: res.resource, workspace: "platform-providers" },
      actions: [{ kind: "open-workspace", workspace: "platform-providers" }],
      basis: "resource freshness read from stored data (never a job's exit status); since = the newest observed date when stale",
    });
  }
  return out;
}

function alertItems(a: NonNullable<AttentionInputs["alerts"]>): AttentionItem[] {
  if (!a.latest) return [];
  const out: AttentionItem[] = [];
  for (const rule of a.latest.rules) {
    if (!rule.firing) continue;
    const severity = SEVERITY_OF.alert[rule.severity ?? "warning"];
    const title = a.titles[rule.id] ?? rule.id;
    out.push({
      id: `alert:${rule.id}`,
      severity,
      entity: { kind: "alert-rule", label: title },
      problem: `Firing in the latest evaluation — ${rule.breaches} breach${rule.breaches === 1 ? "" : "es"} (${rule.severity ?? "severity not recorded"}).`,
      since: a.latest.evaluatedAtISO,
      evidence: { kind: "alert", id: rule.id, workspace: ALERTS_VIEW },
      actions: [{ kind: "open-workspace", workspace: ALERTS_VIEW }],
      basis: "latest evaluate-alerts run (per-rule outcomes) — the only notion of an active alert; since = that evaluation's time, not the breach's onset",
    });
  }
  return out;
}

function incidentItems(i: NonNullable<AttentionInputs["incidents"]>): AttentionItem[] {
  return i.items
    .filter((inc) => inc.state === "active")
    .map((inc) => ({
      id: `incident:${inc.id}`,
      severity: SEVERITY_OF.incident[inc.severity],
      entity: { kind: "incident", label: inc.subject ?? "Subject unavailable" },
      problem: `${inc.label}${inc.operationLabel ? ` — ${inc.operationLabel}` : ""}${inc.occurrenceCountKnown ? ` · ${inc.occurrenceCount} occurrence${inc.occurrenceCount === 1 ? "" : "s"}` : " · depth unknown"}.`,
      since: inc.firstOccurredAt,
      evidence: inc.refreshExecutionId
        ? { kind: "execution", id: inc.refreshExecutionId, workspace: "platform-refresh" }
        : { kind: "incident", id: inc.id, workspace: "platform-refresh" },
      actions: [{ kind: "open-workspace", workspace: "platform-refresh" }],
      basis: "active sync incident (SyncIssue lifecycle via the semantics authority; subject = institution · account); since = first occurrence",
    }));
}

function policyAssignmentItems(p: PolicyAssignmentHealth): AttentionItem[] {
  const severity = SEVERITY_OF.policyAssignment[p.enforced ? "enforced" : "dormant"];
  return p.items.map((i) => ({
    id: `policy-assignment:${i.reason === "UNASSIGNED" ? "unassigned" : "unknown"}:${i.ref.slice(-6)}`,
    severity,
    entity: { kind: "customer" as const, label: i.ref },
    problem: describePolicyAssignmentIssue(i, p.enforced),
    since: i.since,
    evidence: { kind: "policy-assignment" as const, id: i.reason, workspace: POLICY_GROUPS_VIEW },
    actions: [{ kind: "open-workspace" as const, workspace: POLICY_GROUPS_VIEW }],
    basis: "policy-assignment read (USER accounts with no CustomerPolicyAssignment row; rows whose policyGroup is not in the catalogue) under the POLICY_ASSIGNMENT_FAIL_CLOSED switch; since = the assignment's time for an unknown key, the account's creation for an unassigned one; identity = opaque reference only",
  }));
}

// ── Composition ──────────────────────────────────────────────────────────────

export function sortAttention(items: readonly AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => {
    const rank = ATTENTION_SEVERITY_RANK[a.severity] - ATTENTION_SEVERITY_RANK[b.severity];
    if (rank !== 0) return rank;
    if (a.since && b.since) { const t = a.since.localeCompare(b.since); if (t !== 0) return t; }
    else if (a.since) return -1;
    else if (b.since) return 1;
    return a.id.localeCompare(b.id);
  });
}

export function countBySeverity(items: readonly AttentionItem[]): Record<AttentionSeverity, number> {
  const counts: Record<AttentionSeverity, number> = { critical: 0, error: 0, warning: 0, info: 0 };
  for (const it of items) counts[it.severity]++;
  return counts;
}

export function buildAttention(inputs: AttentionInputs, now: Date): AttentionCore {
  const items: AttentionItem[] = [];
  const checked: AttentionAuthority[] = [];
  const failed: AttentionAuthority[] = [];
  const floors: string[] = [];

  if (inputs.connections) {
    checked.push("connection-health");
    items.push(...connectionItems(inputs.connections, now));
    const unhealthyTotal = inputs.connections.total - (inputs.connections.counts.HEALTHY ?? 0);
    if (unhealthyTotal > inputs.connections.unhealthy.length) {
      floors.push(`Connections: ${inputs.connections.unhealthy.length} of ${unhealthyTotal} unhealthy shown — the health reader caps its list at ${inputs.connections.unhealthy.length} (a floor, not a total).`);
    }
  } else failed.push("connection-health");

  if (inputs.jobs) { checked.push("job-health"); items.push(...jobItems(inputs.jobs, now)); } else failed.push("job-health");
  if (inputs.providers) { checked.push("provider-health"); items.push(...providerItems(inputs.providers)); } else failed.push("provider-health");
  if (inputs.resources) { checked.push("resource-freshness"); items.push(...resourceItems(inputs.resources)); } else failed.push("resource-freshness");
  if (inputs.alerts) { checked.push("alert-evaluation"); items.push(...alertItems(inputs.alerts)); } else failed.push("alert-evaluation");

  if (inputs.incidents) {
    checked.push("incidents");
    items.push(...incidentItems(inputs.incidents));
    if (inputs.incidents.truncated || inputs.incidents.activeTotal > inputs.incidents.items.length) {
      floors.push(`Incidents: ${inputs.incidents.items.length} of ${inputs.incidents.activeTotal}${inputs.incidents.truncated ? "+" : ""} active shown (a floor, not a total).`);
    }
  } else failed.push("incidents");

  if (inputs.policyAssignments) {
    checked.push("policy-assignments");
    items.push(...policyAssignmentItems(inputs.policyAssignments));
    if (inputs.policyAssignments.truncated) {
      floors.push(`Policy assignments: ${inputs.policyAssignments.items.length} of ${inputs.policyAssignments.total} affected customers shown (${inputs.policyAssignments.unassigned} unassigned, ${inputs.policyAssignments.unknown} unknown key) — the list is capped at ${inputs.policyAssignments.cap}; the counts are exact.`);
    }
  } else failed.push("policy-assignments");

  const sorted = sortAttention(items);
  return { items: sorted, counts: countBySeverity(sorted), authorities: { checked, failed }, floors };
}

// ═════════════════════════════════════════════════════════════════════════════
// BETA V1 · USER-IMPACTING FAILURES — "failed operations affecting users"
// ═════════════════════════════════════════════════════════════════════════════
//
// A SECOND, SEPARATE composition on the same surface. The severity table above
// answers "what is broken on the platform"; this group answers "which failures
// reached a customer in the last 24 h". It restates four EXISTING readers —
// never the ledgers — and, like the table, makes no new verdict:
//
//   refresh executions   queryRefreshExecutions (the OPS-2B row seam), FAILED /
//                        PARTIAL since the window start, operator audience
//   AI failures          getAiFailureHealth — FAILED / TIMEOUT / RATE_LIMITED /
//                        QUOTA are COUNTS by outcome (the reader lists no rows)
//   Brief failures       getBriefOps("24h") rows in state FAILED
//   NEEDS_REAUTH         the connection-health rows already in the table
//
// IDENTITY. The design asks for an opaque `user …last6` on each row. None of
// the four readers exposes a user reference today (the refresh seam names an
// item or an account; the AI reader counts; the Brief reader names a Space;
// connection health is identity-free by design), so each row carries the
// OPAQUE reference its reader DOES expose, typed by kind, and the "users
// affected" figure is `null` WITH THE REASON rather than a number invented
// from sources. When a reader gains a `userRef` the row picks it up and the
// figure becomes a count — the shape does not change. Never an email, never a
// username, never a resolvable id.
//
// PURE: no DB, no clock read (`now` is a parameter), no I/O.

export const USER_IMPACT_WINDOW_HOURS = 24;

export type UserImpactKind = "refresh-failed" | "refresh-partial" | "ai-failure" | "brief-failed" | "needs-reauth";

export const USER_IMPACT_KINDS: readonly UserImpactKind[] = ["refresh-failed", "refresh-partial", "ai-failure", "brief-failed", "needs-reauth"];

/** An opaque reference — `${kind} …${tail}` — enough to correlate, never resolvable to a person here. */
export interface UserImpactReference {
  kind: "user" | "item" | "account" | "space" | "connection";
  tail: string;
}

export interface UserImpactRow {
  id: string;
  kind: UserImpactKind;
  /** The failing thing, in words ("Refresh · Plaid item", "AI · provider call", "Brief · generation", "Connection · Chase"). */
  label: string;
  problem: string;
  /** ISO instant of the newest fact behind the row; null when the reader records none. */
  at: string | null;
  /** The reader's own opaque reference, or null when it exposes none. */
  reference: UserImpactReference | null;
  evidence: AttentionEvidence;
  /** How many facts the row stands for (AI outcomes are counted, not listed). */
  count: number;
  basis: string;
}

export const USER_IMPACT_AUTHORITIES = ["refresh-executions", "ai-failures", "brief-ops", "connection-health"] as const;
export type UserImpactAuthority = (typeof USER_IMPACT_AUTHORITIES)[number];

export interface UserImpactInputs {
  /** FAILED / PARTIAL rows the seam returned for the window; `more` when a further page existed. */
  refresh: { rows: readonly ExecutionRowDTO[]; more: boolean } | null;
  ai: AiFailureHealth | null;
  /** The Brief ops read for the 24 h window — counts over every row, `rows` the bounded list. */
  brief: Pick<BriefOps, "counts" | "rows"> | null;
  /** The SAME connection-health read the table used (null = could not be read). */
  connections: ConnectionHealthResult | null;
}

export interface UserImpactCore {
  windowHours: number;
  rows: readonly UserImpactRow[];
  /** Facts per kind (a roll-up row counts for its `count`). */
  counts: Record<UserImpactKind, number>;
  /** Distinct `user` references; null — with the reason — when no reader exposed one. */
  usersAffected: { count: number | null; reason: string | null };
  /** Distinct non-user references (items, accounts, Spaces, connections). */
  sourcesAffected: number;
  authorities: { checked: UserImpactAuthority[]; failed: UserImpactAuthority[] };
  floors: string[];
}

const tail6 = (id: string): string => id.slice(-6);

function refreshImpactRows(r: NonNullable<UserImpactInputs["refresh"]>): UserImpactRow[] {
  const out: UserImpactRow[] = [];
  for (const row of r.rows) {
    const kind: UserImpactKind | null = row.overallStatus === "FAILED" ? "refresh-failed" : row.overallStatus === "PARTIAL" ? "refresh-partial" : null;
    if (!kind) continue; // the seam was asked for FAILED/PARTIAL; anything else is not a user impact
    // PB-7 — a reaped (stale) execution a later success for the same source
    // superseded is RECOVERED: the customer's data landed (recovery-core.ts).
    if (row.recoveredByExecutionId) continue;
    const source = row.sourceKind === "PLAID_ITEM" ? "Plaid item" : `${row.network ?? "wallet"} wallet`;
    const category = row.failureCategory ?? row.failureStage ?? null;
    out.push({
      id: `refresh:${row.id}`,
      kind,
      label: `Refresh · ${source}`,
      problem: `${row.overallStatus === "FAILED" ? "Failed" : "Partial"}${category ? ` — ${category}` : ""}${row.errorSummary ? ` · ${row.errorSummary}` : row.hasError ? " · error recorded" : ""}.`,
      at: row.startedAt,
      reference: row.plaidItemId ? { kind: "item", tail: tail6(row.plaidItemId) } : row.sourceRef ? { kind: "account", tail: tail6(row.sourceRef) } : null,
      evidence: { kind: "execution", id: row.id, workspace: "platform-refresh" },
      count: 1,
      basis: "RefreshExecution.overallStatus via the execution query seam (operator audience); at = the execution's start; the reference is the item or account the seam names — it exposes no user",
    });
  }
  return out;
}

const AI_OUTCOMES: ReadonlyArray<{ key: keyof Pick<AiFailureHealth, "failed" | "timeouts" | "rateLimited" | "quota">; outcome: string; note: string }> = [
  { key: "failed", outcome: "FAILED", note: "provider or transport error" },
  { key: "timeouts", outcome: "TIMEOUT", note: "abandoned at the caller's deadline" },
  { key: "rateLimited", outcome: "RATE_LIMITED", note: "429, retried — one row per attempt" },
  { key: "quota", outcome: "QUOTA", note: "insufficient quota — waiting cannot cure it" },
];

function aiImpactRows(ai: AiFailureHealth): UserImpactRow[] {
  const out: UserImpactRow[] = [];
  for (const o of AI_OUTCOMES) {
    const n = ai[o.key];
    if (n <= 0) continue;
    out.push({
      id: `ai:${o.outcome}`,
      kind: "ai-failure",
      label: "AI · provider call",
      problem: `${n} ${o.outcome} call${n === 1 ? "" : "s"} in ${ai.windowHours} h — ${o.note}.`,
      at: o.outcome === "QUOTA" ? ai.lastQuotaAt : ai.lastFailureAt,
      reference: null,
      evidence: { kind: "ai", workspace: "platform-ai" },
      count: n,
      basis: "AiInvocation.outcome counts from the AI failure reader (zero-token failure rows since 2026-10-07); at = the newest failure of any outcome (QUOTA: its own newest); the reader exposes no user",
    });
  }
  return out;
}

function briefImpactRows(b: NonNullable<UserImpactInputs["brief"]>, since: Date): UserImpactRow[] {
  const out: UserImpactRow[] = [];
  for (const row of b.rows) {
    if (row.state !== "FAILED" || !row.lastFailedAt || Date.parse(row.lastFailedAt) < since.getTime()) continue;
    out.push({
      id: `brief:${row.spaceRef}:${row.briefDay}`,
      kind: "brief-failed",
      label: "Brief · generation",
      problem: `Failed for ${row.briefDay}${row.lastFailureReason ? ` — ${row.lastFailureReason}` : ""}${row.coolingDown ? " · cooling down" : ""}.`,
      at: row.lastFailedAt,
      reference: { kind: "space", tail: row.spaceRef.replace(/^…/, "") },
      evidence: { kind: "brief", workspace: "platform-ai" },
      count: 1,
      basis: "DailyBrief.lastFailedAt newer than generatedAt (Brief ops reader, 24 h window); the reference is the Space the reader names — it exposes no owner",
    });
  }
  return out;
}

function reauthImpactRows(c: ConnectionHealthResult): UserImpactRow[] {
  return c.unhealthy
    .filter((row) => row.healthState === "NEEDS_REAUTH")
    .map((row) => ({
      id: `reauth:${row.source}:${row.id}`,
      kind: "needs-reauth" as const,
      label: `Connection · ${row.label}`,
      problem: `Needs reauthorization — the customer must reconnect${row.errorCode ? ` (${row.errorCode})` : ""}.`,
      at: row.since,
      reference: { kind: "connection" as const, tail: tail6(row.id) },
      evidence: { kind: "connection" as const, id: row.id, workspace: "platform-providers" },
      count: 1,
      basis: "connection health state NEEDS_REAUTH (the same row the severity table carries); at = the recorded transition; the fleet reader is identity-free by design",
    }));
}

/** Newest first; a row with no instant last; id for stability. The UI never re-sorts. */
export function sortUserImpact(rows: readonly UserImpactRow[]): UserImpactRow[] {
  return [...rows].sort((a, b) => {
    if (a.at && b.at) { const t = b.at.localeCompare(a.at); if (t !== 0) return t; }
    else if (a.at) return -1;
    else if (b.at) return 1;
    return a.id.localeCompare(b.id);
  });
}

export const NO_USER_REFERENCE_REASON =
  "no reader on this surface exposes a user reference — refresh executions name an item or account, AI failures are counted, Brief failures name a Space, connection health is identity-free; per-user detail lives in Customer Success";

export function buildUserImpact(inputs: UserImpactInputs, now: Date, windowHours: number = USER_IMPACT_WINDOW_HOURS): UserImpactCore {
  const since = new Date(now.getTime() - windowHours * 3_600_000);
  const rows: UserImpactRow[] = [];
  const checked: UserImpactAuthority[] = [];
  const failed: UserImpactAuthority[] = [];
  const floors: string[] = [];

  if (inputs.refresh) {
    checked.push("refresh-executions");
    rows.push(...refreshImpactRows(inputs.refresh));
    if (inputs.refresh.more) floors.push(`Refresh: ${inputs.refresh.rows.length} FAILED/PARTIAL executions shown — the seam had a further page (a floor, not a total).`);
    const recovered = inputs.refresh.rows.filter((r) => r.recoveredByExecutionId).length;
    if (recovered > 0) floors.push(`Refresh: ${recovered} interrupted execution${recovered === 1 ? "" : "s"} (process ended mid-run) not listed — a later run for the same source succeeded (recovered).`);
  } else failed.push("refresh-executions");

  if (inputs.ai) { checked.push("ai-failures"); rows.push(...aiImpactRows(inputs.ai)); } else failed.push("ai-failures");

  if (inputs.brief) {
    checked.push("brief-ops");
    const briefRows = briefImpactRows(inputs.brief, since);
    rows.push(...briefRows);
    if (inputs.brief.counts.failed > briefRows.length) {
      floors.push(`Brief: ${briefRows.length} of ${inputs.brief.counts.failed} failed rows shown — the ops reader lists a bounded page and its window is the Brief day, not the hour (a floor, not a total).`);
    }
  } else failed.push("brief-ops");

  if (inputs.connections) { checked.push("connection-health"); rows.push(...reauthImpactRows(inputs.connections)); } else failed.push("connection-health");

  const sorted = sortUserImpact(rows);
  const counts: Record<UserImpactKind, number> = { "refresh-failed": 0, "refresh-partial": 0, "ai-failure": 0, "brief-failed": 0, "needs-reauth": 0 };
  const users = new Set<string>();
  const sources = new Set<string>();
  let withoutUser = 0;
  for (const r of sorted) {
    counts[r.kind] += r.count;
    if (r.reference?.kind === "user") users.add(r.reference.tail);
    else {
      withoutUser += 1;
      if (r.reference) sources.add(`${r.reference.kind}:${r.reference.tail}`);
    }
  }
  const usersAffected =
    sorted.length === 0 ? { count: 0, reason: null }
    : users.size === 0 ? { count: null, reason: NO_USER_REFERENCE_REASON }
    : withoutUser > 0 ? { count: users.size, reason: `a floor — ${withoutUser} row${withoutUser === 1 ? "" : "s"} carr${withoutUser === 1 ? "ies" : "y"} no user reference` }
    : { count: users.size, reason: null };

  return { windowHours, rows: sorted, counts, usersAffected, sourcesAffected: sources.size, authorities: { checked, failed }, floors };
}
