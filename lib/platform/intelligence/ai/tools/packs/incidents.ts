/**
 * lib/platform/intelligence/ai/tools/packs/incidents.ts  (Platform AI P8 — the incidents pack: contracts + mappers)
 *
 * Design v2 §2, §5, §6.5, §9; MVP PA-1 item 2. Tools over the EXISTING incident intelligence module
 * (lib/platform/incidents/intelligence — the accessors brokenNow / needsVerification / search /
 * investigate, injected; tools/packs/incidents.server.ts wires the Production ones) and its existing
 * presentation projections (lib/platform/incidents/investigation-dto.ts incidentDetailDTO — summary /
 * diagnosis; components/platform/incidents/lifecycle-model.ts lifecycleClosureOf). Every verdict
 * (state, severity, brokenNow, spread, recurrence, closure, cause) is the module's — deriveIncidentVerdicts
 * runs inside the accessors; NOTHING is re-derived here.
 *
 * TIERS (the incident audience rules, lib/platform/incidents/intelligence/audience.ts):
 *   incident_overview          AGGREGATE  PLATFORM_OPS | CUSTOMER_SUCCESS  counts only (identity-free)
 *   list_incidents             RECORD     PLATFORM_OPS  OPS tier           identity-free records
 *   investigate_incident       RECORD     PLATFORM_OPS  OPS tier           one incident by handle (2 calls)
 *   list_incidents_cs          RECORD     CUSTOMER_SUCCESS  CS tier        + the affected customer's T1 ref;
 *   investigate_incident_cs    RECORD     CUSTOMER_SUCCESS  CS tier          T2 (name / email) only via
 *                                                                           authz/record-render.ts; audited
 *                                                                           PLATFORM_AI_RECORD_VIEWED (I-5)
 * The OPS tools read with the PLATFORM_OPS audience token of THIS call's fresh guard: an OPS verdict has no
 * customer id by construction (the module's projection), so the OPS records carry no linkage and are
 * declared customerLinkable:false (the Platform Ops incidents workspace reads the same tier, unaudited).
 * Only the CS tools — whose verdicts carry subjectUserId — link a customer, and audit every one.
 *
 * WHAT A RECORD CARRIES (I-3, evidence/record-envelope.ts): closed codes from the module's own
 * vocabularies and lib/platform/incidents/codes.ts (CAUSE_CODES, RESOLUTION_REASON_CODES, STATE_CODES via
 * the timeline, ACTION_CODES, OUTCOME_CODES), counts, ISO times, booleans, and (CS only) the keyed T1
 * opaque ref. The mappers read NAMED fields only and never read: the verdict's `label` / `operationLabel`
 * (they may embed account labels, account-label.ts), `detail`, operator / transition / resolution notes,
 * provider error messages (only the module's ALLOWLISTED provider code), `affected.institution`
 * (PlaidItem.institutionName), any id (incident / item / account / event / execution / user — except the
 * CS linkage the audit needs and the incident id as the record's server-side rid). A value outside its
 * code set becomes null (or the set's OTHER), never echoed.
 *
 * INFERRED-CAUSE CONTRACT (design v2 §9): each record carries `causeStatus` (CONFIRMED | HYPOTHESIS | NONE)
 * and `cause` (a CAUSE_CODES key). The model may state a cause as fact only when causeStatus is CONFIRMED;
 * anything else is written inside {{inferred}}…{{/inferred}} (rendered "Likely: …"). compose/causal.ts
 * enforces it deterministically (UNMARKED_CAUSAL): an unmarked causal sentence not backed by a CONFIRMED
 * cause of an incident placed in it is marked "Likely:".
 *
 * PURE: no I/O, no clock, no env — every read is the injected `IncidentsPackReaders`.
 */

import type { PlatformArea } from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";
import { ACTION_CODES, CAUSE_CODES, EVENT_TYPES, OUTCOME_CODES, RESOLUTION_REASON_CODES } from "@/lib/platform/incidents/codes";
import type { DisplayStatus } from "@/lib/platform/incidents/display-status";
import { KNOWN_PROVIDER_ERROR_CODES, type RemedyClass } from "@/lib/platform/incidents/explanations";
import type { CsToken, OpsToken } from "@/lib/platform/incidents/intelligence";
import type {
  CsIncidentVerdict, IncidentInvestigation, IncidentSearchQuery, IncidentSearchResult, IncidentState, IncidentStatusFilter,
  IncidentVerdict, Severity, SubjectStateV2, VerdictList,
} from "@/lib/platform/incidents/intelligence/types";
import { incidentDetailDTO } from "@/lib/platform/incidents/investigation-dto";
import { OPERATION_KEYS } from "@/lib/platform/incidents/operation-key";
import type { SyncIssueDomain } from "@/lib/platform/sync-issue-semantics";
import { lifecycleClosureOf, type ClosureOutcome } from "@/components/platform/incidents/lifecycle-model";
import type { FreshGuard } from "../../authz/recheck";
import {
  RECORD_LIST_MAX, boolFlag, code, count, isoTime, opaqueRef,
  type Code, type RawRecord, type RecordFields, type RecordRunResult, type RecordSchema,
} from "../../evidence/record-envelope";
import { RECORD_PLACE_RULE, aggregatePlaceRule, countPaths, type AggregatePathSpec, type PlatformAiToolContract } from "../contract";

/** The record kind every incidents-pack record (and incident subject handle) carries. */
export const INCIDENT_RECORD_KIND = "INCIDENT";
export const INCIDENT_OPS_AREA: PlatformArea = "PLATFORM_OPS";
export const INCIDENT_CS_AREA: PlatformArea = "CUSTOMER_SUCCESS";

/** An incident id (SyncIssue.id — a cuid) as a record id: the accessor's own id shape, bounded. */
export const INCIDENT_RID = /^[A-Za-z0-9_-]{1,64}$/;

export type IncidentToken = OpsToken | CsToken;
type AnyVerdict = IncidentVerdict | CsIncidentVerdict;

/** The readers the pack runs over (Production: incidents.server.ts; tests / E0: fixtures). Every read takes THIS call's token. */
export interface IncidentsPackReaders {
  brokenNow(token: IncidentToken, now: Date): Promise<VerdictList<AnyVerdict>>;
  needsVerification(token: IncidentToken, now: Date): Promise<VerdictList<AnyVerdict>>;
  search(token: IncidentToken, query: IncidentSearchQuery, now: Date): Promise<IncidentSearchResult<AnyVerdict>>;
  investigate(token: IncidentToken, id: string, now: Date): Promise<IncidentInvestigation<AnyVerdict> | null>;
  /** The customer's keyed T1 reference ("user #" + 8 hex), or null without the server key. */
  customerRef(userId: string): string | null;
  now(): Date;
}

/**
 * What a pack tool's run receives (tools/registry.ts LegacyToolContext, the parts it reads). `ev.trace`: the
 * AGGREGATE tool records its own metadata step (codes + a count), as the executor does for the core tools.
 */
export interface IncidentsToolContext {
  readonly fresh?: ReadonlyMap<PlatformArea, FreshGuard>;
  readonly ev?: { readonly trace: { tool: string; outcome: string; refs: string[]; count?: number }[] };
}

// ── Closed vocabularies (the module's own; a value outside ⇒ null / OTHER) ───

const STATES: readonly IncidentState[] = ["active", "acknowledged", "recovering", "stale-unverified", "resolved", "archived"];
const SEVERITIES: readonly Severity[] = ["critical", "error", "warning", "info"];
const DOMAINS = ["transactions", "investments", "imports", "wallet", "reconciliation", "balances", "unknown"] as const satisfies readonly SyncIssueDomain[];
const KINDS = [
  "MISSING_ACCOUNT", "UPSERT_ERROR", "REMOVED_TOMBSTONE", "BALANCE_TX_MISMATCH", "REPLAY_ATTEMPTED", "REPLAY_RECOVERED", "REPLAY_FAILED",
  "INSTRUMENT_IDENTITY_CONFLICT", "TRANSACTION_PERSISTENCE_FAILED", "INVESTMENT_DATA_PERSISTENCE_FAILED", "IMPORT_ROLLBACK_FAILED",
  "WALLET_SYNC_FAILED", "OTHER",
] as const;
const PROVIDERS = ["PLAID", "WALLET", "OTHER"] as const;
const OPERATIONS: readonly string[] = [...new Set(Object.values(OPERATION_KEYS) as string[])];
const SPREADS = ["isolated", "widespread"] as const;
export const CAUSE_STATUSES = ["CONFIRMED", "HYPOTHESIS", "NONE"] as const;
export type CauseStatusCode = (typeof CAUSE_STATUSES)[number];
const CAUSES = Object.keys(CAUSE_CODES);
const CLOSURES = ["recovered", "operator", "connection-removed", "legacy-resolved"] as const;
const DISPLAY: readonly DisplayStatus[] = ["action-needed", "investigating", "recovering", "resolved", "recurring", "active"];
const REMEDIES: readonly RemedyClass[] = ["customer-reconnect", "customer-re-add", "server-retry", "investigate"];
const PROVIDER_CODES: readonly string[] = [...KNOWN_PROVIDER_ERROR_CODES].sort();
const CONNECTION_STATUSES = ["ACTIVE", "NEEDS_REAUTH", "ERROR", "REVOKED", "OTHER"] as const;
const SUBJECT_STATES: readonly SubjectStateV2[] = ["LIVE", "DELETED", "REVOKED", "MISSING", "UNSCOPED"];
const CLOSURE_OUTCOMES: readonly ClosureOutcome[] = ["verified-recovery", "operator-fixed", "operator-closed", "dismissed", "subject-removed", "legacy"];
const RESOLUTION_REASONS = Object.keys(RESOLUTION_REASON_CODES);
const ACTIONS = Object.keys(ACTION_CODES);
const OUTCOMES = Object.keys(OUTCOME_CODES);
const EVENTS = EVENT_TYPES as readonly string[];
const STATUS_FILTER: readonly IncidentStatusFilter[] = ["broken-now", "needs-verification", "history", "all"];

// ── Schemas ──────────────────────────────────────────────────────────────────

const BASE_FIELDS: RecordSchema["fields"] = {
  state: { type: "code", values: STATES },
  severity: { type: "code", values: SEVERITIES },
  domain: { type: "code", values: DOMAINS },
  kind: { type: "code", values: KINDS },
  provider: { type: "code", values: PROVIDERS },
  operation: { type: "code", values: OPERATIONS, nullable: true },
  brokenNow: { type: "bool" },
  customerActionable: { type: "bool" },
  firstSeenAt: { type: "isoTime" },
  lastSeenAt: { type: "isoTime" },
  resolvedAt: { type: "isoTime", nullable: true },
  occurrences: { type: "count" },
  spread: { type: "code", values: SPREADS },
  affectedSources: { type: "count" },
  generation: { type: "count" },
  causeStatus: { type: "code", values: CAUSE_STATUSES },
  cause: { type: "code", values: CAUSES, nullable: true },
  closure: { type: "code", values: CLOSURES, nullable: true },
};

const DETAIL_FIELDS: RecordSchema["fields"] = {
  displayStatus: { type: "code", values: DISPLAY },
  remedy: { type: "code", values: REMEDIES, nullable: true },
  customerActionRequired: { type: "bool" },
  providerErrorCode: { type: "code", values: PROVIDER_CODES, nullable: true },
  providerErrorUnrecognised: { type: "bool" },
  connectionStatus: { type: "code", values: CONNECTION_STATUSES, nullable: true },
  sourceState: { type: "code", values: SUBJECT_STATES },
  attempts: { type: "count", nullable: true },
  attemptsSucceeded: { type: "count", nullable: true },
  attemptsFailed: { type: "count", nullable: true },
  lastSucceededAt: { type: "isoTime", nullable: true },
  lastFailedAt: { type: "isoTime", nullable: true },
  earlierEpisodes: { type: "count" },
  closureOutcome: { type: "code", values: CLOSURE_OUTCOMES, nullable: true },
  resolutionReason: { type: "code", values: RESOLUTION_REASONS, nullable: true },
  recoveryProofs: { type: "count" },
  timelineEvents: { type: "count" },
  lastEventType: { type: "code", values: EVENTS, nullable: true },
  lastActionCode: { type: "code", values: ACTIONS, nullable: true },
  lastOutcomeCode: { type: "code", values: OUTCOMES, nullable: true },
  archived: { type: "bool" },
};

const CUSTOMER_FIELD: RecordSchema["fields"] = { customer: { type: "opaqueRef", nullable: true } };

/**
 * S2 09io A1 — the CLOSED T1 fields the model may place as {{r:h|<field>}} (codes, counts, times; pinned by
 * tools/placeables.test.ts). Never: the CS `customer` ref (an opaque ref), a bool, a T2 name.
 */
export const INCIDENT_BASE_PLACEABLE = [
  "state", "severity", "domain", "kind", "provider", "operation", "firstSeenAt", "lastSeenAt", "resolvedAt", "occurrences", "spread",
  "affectedSources", "generation", "causeStatus", "cause", "closure",
] as const;
export const INCIDENT_DETAIL_PLACEABLE = [
  ...INCIDENT_BASE_PLACEABLE,
  "displayStatus", "remedy", "providerErrorCode", "connectionStatus", "sourceState", "attempts", "attemptsSucceeded", "attemptsFailed",
  "lastSucceededAt", "lastFailedAt", "earlierEpisodes", "closureOutcome", "resolutionReason", "recoveryProofs", "timelineEvents",
  "lastEventType", "lastActionCode", "lastOutcomeCode",
] as const;

export const INCIDENT_LIST_SCHEMA: RecordSchema = { kind: INCIDENT_RECORD_KIND, fields: BASE_FIELDS, placeable: INCIDENT_BASE_PLACEABLE };
export const INCIDENT_DETAIL_SCHEMA: RecordSchema = { kind: INCIDENT_RECORD_KIND, fields: { ...BASE_FIELDS, ...DETAIL_FIELDS }, placeable: INCIDENT_DETAIL_PLACEABLE };
/** CS tier: + the affected customer's T1 ref; T2 (name / email) exists behind the record as NAMES only. */
export const INCIDENT_LIST_CS_SCHEMA: RecordSchema = { kind: INCIDENT_RECORD_KIND, t2Fields: ["name", "email"], fields: { ...BASE_FIELDS, ...CUSTOMER_FIELD }, placeable: INCIDENT_BASE_PLACEABLE };
export const INCIDENT_DETAIL_CS_SCHEMA: RecordSchema = { kind: INCIDENT_RECORD_KIND, t2Fields: ["name", "email"], fields: { ...BASE_FIELDS, ...DETAIL_FIELDS, ...CUSTOMER_FIELD }, placeable: INCIDENT_DETAIL_PLACEABLE };

// ── Mappers (verdict / investigation → closed fields; named fields only, never a spread) ──

const codeOr = <E extends string>(values: readonly E[], v: unknown, fallback: E | null): Code<E> | null =>
  (typeof v === "string" && (values as readonly string[]).includes(v) ? code(values, v) : fallback === null ? null : code(values, fallback));
const safeCount = (n: unknown) => (typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? count(n) : null);
const safeTime = (s: unknown) => (typeof s === "string" && !Number.isNaN(Date.parse(s)) ? isoTime(new Date(s)) : null);

/** causeStatus as the closed code: CONFIRMED / HYPOTHESIS, or NONE (no cause recorded). */
export const causeStatusOf = (v: Pick<IncidentVerdict, "causeStatus">): CauseStatusCode =>
  (v.causeStatus === "CONFIRMED" || v.causeStatus === "HYPOTHESIS" ? v.causeStatus : "NONE");

function baseFields(v: AnyVerdict): RecordFields {
  return {
    state: code(STATES, (STATES as readonly string[]).includes(v.state) ? v.state : "active"),
    severity: code(SEVERITIES, (SEVERITIES as readonly string[]).includes(v.severity) ? v.severity : "info"),
    domain: codeOr(DOMAINS, v.domain, "unknown"),
    kind: codeOr(KINDS, v.kind, "OTHER"),
    provider: codeOr(PROVIDERS, v.provider, "OTHER"),
    operation: codeOr(OPERATIONS, v.operation, null),
    brokenNow: boolFlag(v.brokenNow === true),
    customerActionable: boolFlag(v.customerActionable === true),
    firstSeenAt: safeTime(v.firstSeenAt) ?? isoTime(new Date(0)),
    lastSeenAt: safeTime(v.lastSeenAt) ?? safeTime(v.firstSeenAt) ?? isoTime(new Date(0)),
    resolvedAt: safeTime(v.resolvedAt),
    occurrences: safeCount(v.occurrenceCount) ?? count(0),
    spread: codeOr(SPREADS, v.spread?.spread, "isolated"),
    affectedSources: safeCount(v.spread?.affectedSubjects) ?? count(0),
    generation: safeCount(v.recurrence?.generation) ?? count(1),
    causeStatus: code(CAUSE_STATUSES, causeStatusOf(v)),
    // A cause code only beside a recorded status (a stray code with no status is not a cause).
    cause: causeStatusOf(v) === "NONE" ? null : codeOr(CAUSES, v.causeCode, null),
    closure: codeOr(CLOSURES, v.closure, null),
  };
}

function detailFields(inv: IncidentInvestigation<AnyVerdict>, tier: "ops" | "cs", now: Date): RecordFields {
  // The EXISTING projections (the drawer's own): summary, diagnosis, closure — nothing re-derived.
  const dto = incidentDetailDTO(inv, tier, now);
  const closure = lifecycleClosureOf(dto);
  const att = dto.diagnosis.attempts;
  const readable = !!att && att.readable === true;
  const events = inv.timeline.events;
  const last = events.length ? events[events.length - 1] : null;
  const lastWith = (k: "actionCode" | "outcomeCode") => [...events].reverse().find((e) => typeof e[k] === "string")?.[k] ?? null;
  const status = inv.affected.itemStatus;
  return {
    displayStatus: codeOr(DISPLAY, dto.summary.displayStatus, "active"),
    remedy: codeOr(REMEDIES, dto.summary.remedy, null),
    customerActionRequired: boolFlag(dto.summary.customerActionRequired === true),
    providerErrorCode: codeOr(PROVIDER_CODES, dto.diagnosis.providerErrorCode, null),
    providerErrorUnrecognised: boolFlag(dto.diagnosis.providerErrorUnrecognised === true),
    connectionStatus: status === null || status === undefined ? null : codeOr(CONNECTION_STATUSES, status, "OTHER"),
    sourceState: codeOr(SUBJECT_STATES, inv.affected.subjectState, "UNSCOPED"),
    attempts: readable ? safeCount(att!.counts.total) : null,
    attemptsSucceeded: readable ? safeCount(att!.counts.succeeded) : null,
    attemptsFailed: readable ? safeCount(att!.counts.failed) : null,
    lastSucceededAt: readable ? safeTime(att!.lastSucceededAt) : null,
    lastFailedAt: readable ? safeTime(att!.lastFailedAt) : null,
    earlierEpisodes: safeCount(dto.diagnosis.recurrence.earlierEpisodes) ?? count(0),
    closureOutcome: closure ? codeOr(CLOSURE_OUTCOMES, closure.outcome, null) : null,
    resolutionReason: codeOr(RESOLUTION_REASONS, inv.resolutionReasonCode, null),
    recoveryProofs: safeCount(inv.verdict.recovery?.proofCount) ?? count(0),
    timelineEvents: safeCount(events.length) ?? count(0),
    lastEventType: last ? codeOr(EVENTS, last.type, null) : null,
    lastActionCode: codeOr(ACTIONS, lastWith("actionCode"), null),
    lastOutcomeCode: codeOr(OUTCOMES, lastWith("outcomeCode"), null),
    archived: boolFlag(inv.archive?.archived === true),
  };
}

/** The CS linkage: the verdict's subjectUserId (CS tier only; an OPS verdict has none). */
const subjectOf = (v: AnyVerdict): string | null => ("subjectUserId" in v && typeof v.subjectUserId === "string" && v.subjectUserId.length > 0 ? v.subjectUserId : null);

function customerField(v: AnyVerdict, readers: IncidentsPackReaders): RecordFields {
  const u = subjectOf(v);
  const ref = u ? readers.customerRef(u) : null;
  return { customer: ref ? opaqueRef(ref) : null };
}

export function incidentRecord(v: AnyVerdict, tier: "ops" | "cs", fields: RecordFields): RawRecord | null {
  if (typeof v.id !== "string" || !INCIDENT_RID.test(v.id) || v.rowClass !== "incident") return null;
  const subject = tier === "cs" ? subjectOf(v) : null;
  return {
    ref: {
      kind: INCIDENT_RECORD_KIND, recordId: v.id,
      area: tier === "cs" ? INCIDENT_CS_AREA : INCIDENT_OPS_AREA,
      tier: tier === "cs" ? "CUSTOMER_SUCCESS" : "OPS",
      linkedUserIds: subject ? [subject] : [],
    },
    fields,
  };
}

export function mapIncidentList(items: readonly AnyVerdict[], tier: "ops" | "cs", readers: IncidentsPackReaders): RawRecord[] {
  return items.slice(0, RECORD_LIST_MAX).flatMap((v) => {
    const rec = incidentRecord(v, tier, { ...baseFields(v), ...(tier === "cs" ? customerField(v, readers) : {}) });
    return rec ? [rec] : [];
  });
}

export function mapInvestigation(inv: IncidentInvestigation<AnyVerdict>, tier: "ops" | "cs", readers: IncidentsPackReaders, now: Date): RawRecord | null {
  const v = inv.verdict;
  return incidentRecord(v, tier, { ...baseFields(v), ...detailFields(inv, tier, now), ...(tier === "cs" ? customerField(v, readers) : {}) });
}

// ── The aggregate (counts only) ─────────────────────────────────────────────

export interface IncidentOverview {
  readonly status: "CONFIRMED" | "PARTIAL" | "UNAVAILABLE";
  readonly asOf: string;
  readonly truncated: boolean;
  readonly brokenNow: number;
  readonly needsVerification: number;
  readonly bySeverity: Readonly<Record<string, number>>;
  readonly byDomain: Readonly<Record<string, number>>;
  readonly widespread: number;
  readonly customerActionable: number;
  readonly causeStatus: Readonly<Record<CauseStatusCode, number>>;
}

/**
 * S2 09io B2 — incident_overview's CLOSED placeable result paths ({{a:incident_overview|<path>}}): every count it
 * returns, keyed by the module's own vocabularies, and its asOf instant. Pinned by tools/placeables.test.ts.
 */
export const INCIDENT_OVERVIEW_PATHS: readonly AggregatePathSpec[] = [
  { path: "brokenNow", type: "count" }, { path: "needsVerification", type: "count" },
  { path: "widespread", type: "count" }, { path: "customerActionable", type: "count" },
  ...countPaths("bySeverity", SEVERITIES), ...countPaths("byDomain", DOMAINS), ...countPaths("causeStatus", CAUSE_STATUSES),
  { path: "asOf", type: "isoTime" },
];

const tally = <K extends string>(keys: readonly K[], values: readonly string[]): Record<K, number> => {
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  for (const v of values) if ((keys as readonly string[]).includes(v)) out[v as K]++;
  return out;
};

/** Counts over the module's broken-now and needs-verification lists. Every key is a code; every value a count. */
export function overviewOf(broken: VerdictList<AnyVerdict>, stale: VerdictList<AnyVerdict>, now: Date): IncidentOverview {
  const b = broken.items.filter((v) => v.rowClass === "incident");
  const truncated = broken.truncated === true || stale.truncated === true;
  return {
    status: truncated ? "PARTIAL" : "CONFIRMED",
    asOf: now.toISOString(),
    truncated,
    brokenNow: b.length,
    needsVerification: stale.items.filter((v) => v.rowClass === "incident").length,
    bySeverity: tally(SEVERITIES, b.map((v) => v.effectiveSeverity)),
    byDomain: tally(DOMAINS, b.map((v) => ((DOMAINS as readonly string[]).includes(v.domain) ? v.domain : "unknown"))),
    widespread: b.filter((v) => v.spread?.spread === "widespread").length,
    customerActionable: b.filter((v) => v.customerActionable === true).length,
    causeStatus: tally(CAUSE_STATUSES, b.map((v) => causeStatusOf(v))),
  };
}

// ── The contracts ────────────────────────────────────────────────────────────

/** THIS call's fresh audience token for the tier (minted by the guarded caller, authz/recheck.server.ts), or a refusal. */
export function incidentTokenOf(ctx: IncidentsToolContext, tier: "ops" | "cs"): IncidentToken {
  const area = tier === "cs" ? INCIDENT_CS_AREA : INCIDENT_OPS_AREA;
  const g = ctx.fresh?.get(area);
  const t = g?.incidentToken;
  const want = tier === "cs" ? "CUSTOMER_SUCCESS" : "PLATFORM_OPS";
  if (!g || !t || t.audience !== want || (tier === "cs" && g.csTier !== true)) throw new Error("incidents pack: no fresh audience guard for this tier");
  return t;
}

const result = (status: RecordRunResult["status"], now: Date, records: RawRecord[], truncated: boolean): RecordRunResult =>
  ({ status, asOf: isoTime(now), records, truncated });

const STATUS_ARG = { kind: "enum", values: STATUS_FILTER, optional: true, description: "default broken-now" } as const;
const SEVERITY_ARG = { kind: "enum", values: SEVERITIES, optional: true } as const;

/** The one sentence every incidents tool states (the inferred-cause contract, design v2 §9). */
const CAUSE_RULE = "State a cause as fact ONLY when causeStatus is CONFIRMED (and place the incident {{r:h|ref}} in that sentence); otherwise wrap it in {{inferred}}…{{/inferred}}.";

const viewed = { action: AuditAction.PLATFORM_AI_RECORD_VIEWED, detail: { surface: "platform-ai", recordKind: INCIDENT_RECORD_KIND } } as const;

function listRun(readers: IncidentsPackReaders, tier: "ops" | "cs") {
  return async (args: Readonly<Record<string, unknown>>, ctx: IncidentsToolContext): Promise<RecordRunResult> => {
    const token = incidentTokenOf(ctx, tier);
    const now = readers.now();
    const query: IncidentSearchQuery = {
      status: (args.status as IncidentStatusFilter | undefined) ?? "broken-now", severity: (args.severity as Severity | undefined) ?? null,
      provider: null, operation: null, code: null, from: null, to: null, page: 1,
    };
    const r = await readers.search(token, query, now);
    const records = mapIncidentList(r.items, tier, readers);
    return result(records.length === 0 ? "MISSING" : r.truncated ? "PARTIAL" : "CONFIRMED", now, records, r.total > records.length || r.truncated === true);
  };
}

function investigateRun(readers: IncidentsPackReaders, tier: "ops" | "cs") {
  return async (args: Readonly<Record<string, unknown>>, ctx: IncidentsToolContext): Promise<RecordRunResult> => {
    const token = incidentTokenOf(ctx, tier);
    const now = readers.now();
    const id = String(args.incident);
    // The boundary resolved the handle to the incident id; the accessor re-reads it for THIS token (null ⇒ not visible).
    const inv = INCIDENT_RID.test(id) ? await readers.investigate(token, id, now) : null;
    const rec = inv && inv.verdict.id === id ? mapInvestigation(inv, tier, readers, now) : null;
    return result(rec ? "CONFIRMED" : "MISSING", now, rec ? [rec] : [], false);
  };
}

/** The incidents-pack tools over these readers (the registry uses the Production readers). */
export function incidentsPackTools<Ctx extends IncidentsToolContext>(readers: IncidentsPackReaders): PlatformAiToolContract<Ctx>[] {
  const ops = { pack: "incidents", requires: { areas: [INCIDENT_OPS_AREA], level: "READ", tier: "OPS" }, scope: "RECORD", customerLinkable: false, pii: 1 } as const;
  const cs = { pack: "incidents", requires: { areas: [INCIDENT_CS_AREA], level: "READ", tier: "CUSTOMER_SUCCESS" }, scope: "RECORD", customerLinkable: true, audit: viewed, pii: 2 } as const;
  const handle = { incident: { kind: "handle", recordKind: INCIDENT_RECORD_KIND } } as const;
  return [
    {
      name: "incident_overview", pack: "incidents", scope: "AGGREGATE", customerLinkable: false, pii: 0, cost: { toolCalls: 1 },
      requires: { areas: [INCIDENT_OPS_AREA, INCIDENT_CS_AREA], level: "READ", tier: "OPS" },
      description: "Incident counts now: brokenNow, needsVerification, bySeverity, byDomain, widespread, customerActionable, causeStatus. No records. " + aggregatePlaceRule("incident_overview", "bySeverity.critical"),
      args: { properties: {} },
      placeablePaths: INCIDENT_OVERVIEW_PATHS,
      run: async (_args, ctx) => {
        const c = ctx as IncidentsToolContext;
        const now = readers.now();
        try {
          // Identity-free counts: the Ops token when the call holds Platform Ops, else the CS token (counts only either way).
          const token = c.fresh?.get(INCIDENT_OPS_AREA)?.incidentToken?.audience === "PLATFORM_OPS" ? incidentTokenOf(c, "ops") : incidentTokenOf(c, "cs");
          const [broken, stale] = await Promise.all([readers.brokenNow(token, now), readers.needsVerification(token, now)]);
          const out = overviewOf(broken, stale, now);
          c.ev?.trace.push({ tool: "incident_overview", outcome: "OK", refs: [], count: out.brokenNow });
          return out;
        } catch {
          // No fresh audience token / a failed read: UNAVAILABLE, never a partial count (an AGGREGATE run is not wrapped by the boundary).
          c.ev?.trace.push({ tool: "incident_overview", outcome: "UNAVAILABLE", refs: [] });
          return { status: "UNAVAILABLE", asOf: now.toISOString() };
        }
      },
    },
    {
      ...ops, name: "list_incidents", recordSchema: INCIDENT_LIST_SCHEMA, cost: { toolCalls: 1 },
      description: `Platform Ops incidents, most urgent first, ≤10, identity-free: handle + state, severity, domain, kind, operation, times, spread, causeStatus, cause. ${CAUSE_RULE} ${RECORD_PLACE_RULE}`,
      args: { properties: { status: STATUS_ARG, severity: SEVERITY_ARG } },
      run: listRun(readers, "ops"),
    },
    {
      ...ops, name: "investigate_incident", recordSchema: INCIDENT_DETAIL_SCHEMA, cost: { toolCalls: 2 },
      description: "One incident by handle (a list result or [incident h_…]): + displayStatus, remedy, providerErrorCode, attempts, recovery, closure, last action/outcome codes. " + RECORD_PLACE_RULE,
      args: { properties: handle },
      run: investigateRun(readers, "ops"),
    },
    {
      ...cs, name: "list_incidents_cs", recordSchema: INCIDENT_LIST_CS_SCHEMA, cost: { toolCalls: 1 },
      description: "Customer Success view of list_incidents: + customer (user # ref). Place the customer with {{r:h|name}}. " + RECORD_PLACE_RULE,
      args: { properties: { status: STATUS_ARG, severity: SEVERITY_ARG } },
      run: listRun(readers, "cs"),
    },
    {
      ...cs, name: "investigate_incident_cs", recordSchema: INCIDENT_DETAIL_CS_SCHEMA, cost: { toolCalls: 2 },
      description: "Customer Success view of investigate_incident (+ customer). " + RECORD_PLACE_RULE,
      args: { properties: handle },
      run: investigateRun(readers, "cs"),
    },
  ] as PlatformAiToolContract<Ctx>[];
}

/** The incidents-pack tool names (compose/causal.ts: an incident tool ran this turn ⇒ the causal contract applies). */
export const INCIDENT_TOOL_NAMES: readonly string[] = ["incident_overview", "list_incidents", "investigate_incident", "list_incidents_cs", "investigate_incident_cs"];
