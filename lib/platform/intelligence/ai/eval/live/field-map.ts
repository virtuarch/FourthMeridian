/**
 * lib/platform/intelligence/ai/eval/live/field-map.ts  (Platform AI E0-LIVE — the figure-to-field mapping, S2 09hu G2)
 *
 * EVAL CODE ONLY (never imported by served code). For every guarded fact of cases.ts — a
 * (case, oracle field) pair whose oracle is a guarded route — this table says WHICH part of the
 * answer is compared with WHICH field of the route's response:
 *
 *   · a RECORD field the answer placed ({{r:<handle>|<field>}} — matched by the record kind and the
 *     field CODE, never by a record id: the model only ever sees handles), or
 *   · an AGGREGATE figure (the pack tool's identity-free result, by its JSON path; a sub-key of a
 *     mapped object path maps to the same sub-key of the route field),
 *
 * and HOW the two compare (FieldCompare — the tool's own documented projection of the route value,
 * e.g. the funnel-stage label → its key, a timestamp as an instant, a closed vocabulary's fallback).
 *
 * One entry per (route, field, tool). A guarded fact is MAPPED when an entry for one of the case's
 * expected tools is MAPPED; otherwise it is UNMAPPED, with the entry's reason. UNMAPPED facts are
 * EXCLUDED from the parity denominator and reported per pack as mapped / unmapped counts — never
 * counted as a pass (score.ts). field-map.test.ts pins: every guarded (case, field, tool) has an
 * entry, every MAPPED record field exists in the tool's record schema, every copied vocabulary equals
 * the pack's own, and the route files exist.
 *
 * Where the tool and the route differ by construction, the entry is UNMAPPED (never a guess): a
 * record id the model never sees, a count where the route has a list, a value the tool regroups.
 *
 * ⚠️ PURE data + pure helpers: no I/O, no env, no clock, no pack import (the vocabularies below are
 * copied and pinned against the packs by field-map.test.ts, so the scorer stays importable alone).
 */

import type { LiveCase, LivePack, LiveTool } from "./cases";

// ── The guarded routes (the same paths cases.ts uses) ───────────────────────────────────────

export const ROUTE = {
  csCustomer: "app/api/platform/customer-success/customers/[userId]/route.ts",
  csIncident: "app/api/platform/customer-success/incidents/[id]/route.ts",
  opsIncidents: "app/api/platform/platform-ops/incidents/route.ts",
  opsIncident: "app/api/platform/platform-ops/incidents/[id]/route.ts",
  opsHealth: "app/api/platform/platform-ops/connection-health/route.ts",
  opsImports: "app/api/platform/platform-ops/new-connection-imports/route.ts",
} as const;

// ── Vocabularies (copied; pinned against the packs by field-map.test.ts) ────────────────────

/** product-analytics-core.ts FUNNEL_STAGE_LABELS, inverted: the route's rollup.funnelStage LABEL → the record's stage KEY (customers.ts stageKeyOf). */
export const FUNNEL_STAGE_KEY_OF_LABEL: Readonly<Record<string, string>> = {
  "Registered": "registered", "Verified": "verified", "First session": "firstSession", "First connection": "firstConnection",
  "First AI turn": "firstAiTurn", "First Brief viewed": "firstBriefViewed", "Returned": "returned",
};
/** connections.ts CUSTOMER_CONNECTION_SCHEMA.status values (anything else ⇒ OTHER). */
export const CONNECTION_STATUS_CODES = ["ACTIVE", "NEEDS_REAUTH", "ERROR", "OTHER"] as const;
/** connections.ts CONNECTION_ERROR_CODES (allowlisted Plaid codes ∪ wallet codes ∪ OTHER). */
export const CONNECTION_ERROR_CODES = [
  "ACCESS_NOT_GRANTED", "INSTITUTION_DOWN", "INSTITUTION_NOT_AVAILABLE", "INSTITUTION_NOT_RESPONDING", "INSTITUTION_NO_LONGER_SUPPORTED",
  "INSUFFICIENT_CREDENTIALS", "INTERNAL_SERVER_ERROR", "INVALID_ACCESS_TOKEN", "INVALID_CREDENTIALS", "INVALID_MFA", "INVALID_UPDATED_USERNAME",
  "ITEM_LOCKED", "ITEM_LOGIN_REQUIRED", "ITEM_NOT_FOUND", "ITEM_NOT_SUPPORTED", "ITEM_PRODUCT_NOT_READY", "MFA_NOT_SUPPORTED", "NO_ACCOUNTS",
  "NO_AUTH_ACCOUNTS", "NO_INVESTMENT_ACCOUNTS", "PENDING_DISCONNECT", "PENDING_EXPIRATION", "PLANNED_MAINTENANCE", "PRODUCTS_NOT_SUPPORTED",
  "PRODUCT_NOT_READY", "RATE_LIMIT", "RATE_LIMIT_EXCEEDED", "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", "USER_PERMISSION_REVOKED",
  "USER_SETUP_REQUIRED", "PROVIDER_NOT_CONFIGURED", "INVALID_WALLET_ADDRESS", "BALANCE_UNAVAILABLE", "POSITION_CAPTURE_UNAVAILABLE",
  "CHAIN_UNSUPPORTED", "ADAPTER_ERROR", "NO_USED_ADDRESSES", "OTHER",
] as const;
/** incidents.ts STATES (anything else ⇒ active). */
export const INCIDENT_STATE_CODES = ["active", "acknowledged", "recovering", "stale-unverified", "resolved", "archived"] as const;
/** incidents.ts PROVIDERS (anything else ⇒ OTHER). */
export const INCIDENT_PROVIDER_CODES = ["PLAID", "WALLET", "OTHER"] as const;
/** customers.ts / onboarding.ts IMPORT_HEALTH (anything else ⇒ none). */
export const IMPORT_HEALTH_CODES = ["green", "amber", "red", "none"] as const;

// ── The table ───────────────────────────────────────────────────────────────────────────────

/**
 * How a placed value compares with the route value (each is the TOOL's own projection, cited):
 *   EXACT               equal after score.ts normaliseValue;
 *   ISO_INSTANT         the same instant (record isoTime = Date.toISOString of the same column);
 *   STAGE_LABEL_TO_KEY  route label → key (customers.ts stageKeyOf); an unknown label ⇒ null;
 *   IS_NOT_NULL         the record's boolean = (route value is not null) — e.g. deactivated ⇔ deactivatedAt;
 *   CLOSED_CODE         the route value when in `vocabulary`, else `fallback` (the mapper's codeOr / oneOf);
 *   CAUSE_STATUS        CONFIRMED / HYPOTHESIS, else NONE (incidents.ts causeStatusOf);
 *   ALLOWLISTED_CODE    null / "" ⇒ null; in CONNECTION_ERROR_CODES ⇒ itself; else OTHER (connections.ts errorCodeOf;
 *                       the Plaid and wallet code sets are disjoint, so the union decides the same way per source).
 */
export type FieldCompare = "EXACT" | "ISO_INSTANT" | "STAGE_LABEL_TO_KEY" | "IS_NOT_NULL" | "CLOSED_CODE" | "CAUSE_STATUS" | "ALLOWLISTED_CODE";

export type FieldSource =
  /** A record field placed as {{r:<handle>|<field>}}: matched by record kind + field code (never a record id). */
  | { kind: "record"; recordKind: "CUSTOMER" | "CONNECTION" | "INCIDENT"; field: string }
  /** A figure from an identity-free aggregate result, by JSON path (a sub-key maps to the same sub-key of the route field). */
  | { kind: "aggregate"; path: string };

export type FieldMapEntry =
  | { route: string; field: string; tool: LiveTool; status: "MAPPED"; source: FieldSource; compare: FieldCompare;
      vocabulary?: readonly string[]; fallback?: string | null; note?: string }
  | { route: string; field: string; tool: LiveTool; status: "UNMAPPED"; reason: string };

const rec = (route: string, field: string, tool: LiveTool, recordKind: "CUSTOMER" | "CONNECTION" | "INCIDENT", recField: string, compare: FieldCompare,
  extra: { vocabulary?: readonly string[]; fallback?: string | null; note?: string } = {}): FieldMapEntry =>
  ({ route, field, tool, status: "MAPPED", source: { kind: "record", recordKind, field: recField }, compare, ...extra });
const agg = (route: string, field: string, tool: LiveTool, path: string, note?: string): FieldMapEntry =>
  ({ route, field, tool, status: "MAPPED", source: { kind: "aggregate", path }, compare: "EXACT", ...(note ? { note } : {}) });
const no = (route: string, field: string, tool: LiveTool, reason: string): FieldMapEntry => ({ route, field, tool, status: "UNMAPPED", reason });

const LIVE_ONLY = "the tool lists LIVE connections only (REVOKED and fully-removed wallets excluded); compare against those route elements";
const NO_RECORD_ID = "a record id: the model only ever sees handles, so no answer can place it";

export const LIVE_FIELD_MAP: readonly FieldMapEntry[] = Object.freeze([
  // ── CS customer detail (GET customer-success/customers/[userId]) ──
  rec(ROUTE.csCustomer, "rollup.funnelStage", "get_customer_profile", "CUSTOMER", "stage", "STAGE_LABEL_TO_KEY"),
  rec(ROUTE.csCustomer, "rollup.funnelStage", "get_onboarding_timeline", "CUSTOMER", "stage", "STAGE_LABEL_TO_KEY"),
  no(ROUTE.csCustomer, "rollup.plaidItemCount", "get_customer_profile", "the profile's `connections` counts every live connection (banks AND wallets); no record field carries the Plaid-item count"),
  rec(ROUTE.csCustomer, "lifecycle.registeredAt", "get_customer_profile", "CUSTOMER", "joinedAt", "ISO_INSTANT", { note: "both are User.createdAt (customer-detail.ts registeredAt; customers.ts joinedAt = identity.createdAt)" }),
  rec(ROUTE.csCustomer, "identity.deactivatedAt", "get_customer_profile", "CUSTOMER", "deactivated", "IS_NOT_NULL"),
  no(ROUTE.csCustomer, "onboarding.firstSessionAt", "get_customer_profile", "the profile record has no first-session field (get_onboarding_timeline carries it)"),
  rec(ROUTE.csCustomer, "onboarding.firstSessionAt", "get_onboarding_timeline", "CUSTOMER", "firstSessionAt", "ISO_INSTANT"),
  rec(ROUTE.csCustomer, "onboarding.registeredAt", "get_onboarding_timeline", "CUSTOMER", "registeredAt", "ISO_INSTANT"),
  rec(ROUTE.csCustomer, "onboarding.importHealth", "get_onboarding_timeline", "CUSTOMER", "importHealth", "CLOSED_CODE", { vocabulary: IMPORT_HEALTH_CODES, fallback: "none" }),
  no(ROUTE.csCustomer, "onboarding.connections[]", "get_onboarding_timeline", "whole connection objects: the timeline record carries per-kind and per-import-status COUNTS, not the elements"),
  no(ROUTE.csCustomer, "incidents.open[].state", "get_customer_profile", "the profile record carries the open-incident COUNT only, not each incident's state"),
  no(ROUTE.csCustomer, "connections[].healthState", "get_customer_profile", "the profile record carries a broken-connection COUNT only, not each connection's health"),
  no(ROUTE.csCustomer, "connections[].healthState", "get_onboarding_timeline", "the timeline record carries connection COUNTS only, not each connection's health"),
  rec(ROUTE.csCustomer, "connections[].healthState", "get_customer_connections", "CONNECTION", "healthState", "EXACT", { note: LIVE_ONLY }),
  no(ROUTE.csCustomer, "connections[].status", "get_customer_profile", "the profile record carries connection COUNTS only, not each connection's status"),
  rec(ROUTE.csCustomer, "connections[].status", "get_customer_connections", "CONNECTION", "status", "CLOSED_CODE", { vocabulary: CONNECTION_STATUS_CODES, fallback: "OTHER", note: LIVE_ONLY }),
  rec(ROUTE.csCustomer, "connections[].lastSyncedAt", "get_customer_connections", "CONNECTION", "lastSyncedAt", "ISO_INSTANT", { note: LIVE_ONLY }),
  rec(ROUTE.csCustomer, "connections[].errorCode", "get_customer_connections", "CONNECTION", "errorCode", "ALLOWLISTED_CODE", { note: LIVE_ONLY }),

  // ── Ops incident list (GET platform-ops/incidents) ──
  no(ROUTE.opsIncidents, "total", "incident_overview", "the overview counts broken-now and needs-verification separately; the route's total depends on its status filter, which the case does not pin"),
  no(ROUTE.opsIncidents, "items[].effectiveSeverity", "incident_overview", "an aggregate: severities are tallied, no per-incident value"),
  no(ROUTE.opsIncidents, "items[].provider", "incident_overview", "an aggregate: no per-incident provider"),
  no(ROUTE.opsIncidents, "items[].state", "incident_overview", "an aggregate: no per-incident state"),
  no(ROUTE.opsIncidents, "items[].firstSeenAt", "incident_overview", "an aggregate: no per-incident time"),
  no(ROUTE.opsIncidents, "items[].causeStatus", "incident_overview", "an aggregate: cause statuses are tallied, no per-incident value"),
  no(ROUTE.opsIncidents, "items[].generation", "incident_overview", "an aggregate: no per-incident generation"),
  no(ROUTE.opsIncidents, "total", "list_incidents", "the record list is capped (RECORD_LIST_MAX) and carries no total"),
  rec(ROUTE.opsIncidents, "items[].provider", "list_incidents", "INCIDENT", "provider", "CLOSED_CODE", { vocabulary: INCIDENT_PROVIDER_CODES, fallback: "OTHER" }),
  rec(ROUTE.opsIncidents, "items[].causeStatus", "list_incidents", "INCIDENT", "causeStatus", "CAUSE_STATUS"),
  rec(ROUTE.opsIncidents, "items[].resolvedAt", "list_incidents", "INCIDENT", "resolvedAt", "ISO_INSTANT"),
  no(ROUTE.opsIncidents, "items[].effectiveSeverity", "list_incidents", "the record's `severity` is the verdict's raw severity, not effectiveSeverity"),

  // ── Ops incident detail (GET platform-ops/incidents/[id]) ──
  rec(ROUTE.opsIncident, "incident.state", "investigate_incident", "INCIDENT", "state", "CLOSED_CODE", { vocabulary: INCIDENT_STATE_CODES, fallback: "active" }),
  rec(ROUTE.opsIncident, "summary.firstDetectedAt", "investigate_incident", "INCIDENT", "firstSeenAt", "ISO_INSTANT", { note: "summary.firstDetectedAt = verdict.firstSeenAt (investigation-dto.ts incidentSummaryOf)" }),
  rec(ROUTE.opsIncident, "incident.causeStatus", "investigate_incident", "INCIDENT", "causeStatus", "CAUSE_STATUS"),
  rec(ROUTE.opsIncident, "summary.customerActionRequired", "investigate_incident", "INCIDENT", "customerActionRequired", "EXACT", { note: "the record reads the same incidentDetailDTO summary" }),
  no(ROUTE.opsIncident, "diagnosis.recurrence.previousIncidentId", "investigate_incident", NO_RECORD_ID),
  no(ROUTE.opsIncident, "affected.itemCount", "investigate_incident", "the record's affectedSources is the spread's affected-subject count, not affected.itemCount"),
  no(ROUTE.opsIncident, "incident.effectiveSeverity", "investigate_incident", "the record's `severity` is the verdict's raw severity, not effectiveSeverity"),

  // ── CS incident detail (GET customer-success/incidents/[id]) ──
  rec(ROUTE.csIncident, "incident.causeStatus", "investigate_incident_cs", "INCIDENT", "causeStatus", "CAUSE_STATUS"),

  // ── New-connection imports (GET platform-ops/new-connection-imports) ──
  agg(ROUTE.opsImports, "byStatus", "onboarding_overview", "imports.byStatus", "every import status key (onboarding.ts importsOf; the same reader getNewConnectionImports)"),
  agg(ROUTE.opsImports, "failedReasons", "onboarding_overview", "imports.failedReasons", "keys are ImportReasonCategory on both sides (importsOf folds anything else into UNKNOWN)"),
  agg(ROUTE.opsImports, "started", "onboarding_overview", "imports.started"),

  // ── Connection health (GET platform-ops/connection-health) ──
  agg(ROUTE.opsHealth, "total", "connection_health_overview", "total"),
  agg(ROUTE.opsHealth, "counts", "connection_health_overview", "byHealth"),
  agg(ROUTE.opsHealth, "counts.ERROR", "connection_health_overview", "byHealth.ERROR"),
  agg(ROUTE.opsHealth, "counts.NEEDS_REAUTH", "connection_health_overview", "byHealth.NEEDS_REAUTH"),
  agg(ROUTE.opsHealth, "counts.HEALTHY", "connection_health_overview", "byHealth.HEALTHY"),
  agg(ROUTE.opsHealth, "retired", "connection_health_overview", "retired"),
  agg(ROUTE.opsHealth, "retired.ownerInactive", "connection_health_overview", "retired.ownerInactive"),
  agg(ROUTE.opsHealth, "bySource.PLAID.active", "connection_health_overview", "bySource.PLAID.active"),
  agg(ROUTE.opsHealth, "bySource.WALLET.active", "connection_health_overview", "bySource.WALLET.active"),
  agg(ROUTE.opsHealth, "bySource.WALLET.revoked", "connection_health_overview", "bySource.WALLET.revoked"),
  no(ROUTE.opsHealth, "bySource", "connection_health_overview", "the tool re-keys sources (unknown ⇒ OTHER), regroups faults by allowlisted code and drops institutionRef / institutionActive: not the route object"),
  no(ROUTE.opsHealth, "bySource.WALLET.faults[].count", "connection_health_overview", "fault groups are regrouped (non-allowlisted codes merge into OTHER, institutionRef dropped): no 1:1 element"),
  no(ROUTE.opsHealth, "bySource.PLAID.faults[].institutionRef", "connection_health_overview", "institutionRef (an anonymous positional ref) is dropped by the tool"),
  no(ROUTE.opsHealth, "bySource.PLAID.faults[].healthState", "connection_health_overview", "fault groups are regrouped: no 1:1 element"),
  no(ROUTE.opsHealth, "bySource.PLAID.institutionActive", "connection_health_overview", "not carried by the tool"),
  no(ROUTE.opsHealth, "bySource.WALLET.faults[].healthState", "connection_health_overview", "fault groups are regrouped: no 1:1 element"),
  no(ROUTE.opsHealth, "bySource.WALLET.faults[].errorCode", "connection_health_overview", "fault groups are regrouped and codes allowlisted (else OTHER): no 1:1 element"),
]);

// ── Resolution per guarded fact ─────────────────────────────────────────────────────────────

export type GuardedFact =
  | { caseId: string; pack: LivePack; field: string; status: "MAPPED"; entry: Extract<FieldMapEntry, { status: "MAPPED" }> }
  | { caseId: string; pack: LivePack; field: string; status: "UNMAPPED"; reason: string };

/** One entry per oracle field of a guarded case: MAPPED via one of its expected tools, else UNMAPPED (never a pass). [] for other cases. */
export function guardedFacts(c: Pick<LiveCase, "id" | "pack" | "expectedTools" | "oracle">, table: readonly FieldMapEntry[] = LIVE_FIELD_MAP): GuardedFact[] {
  if (c.oracle.kind !== "guarded-route") return [];
  const route = c.oracle.route;
  return c.oracle.fields.map((field): GuardedFact => {
    const entries = table.filter((e) => e.route === route && e.field === field && (c.expectedTools as readonly string[]).includes(e.tool));
    const mapped = entries.find((e): e is Extract<FieldMapEntry, { status: "MAPPED" }> => e.status === "MAPPED");
    if (mapped) return { caseId: c.id, pack: c.pack, field, status: "MAPPED", entry: mapped };
    const un = entries.find((e): e is Extract<FieldMapEntry, { status: "UNMAPPED" }> => e.status === "UNMAPPED");
    return { caseId: c.id, pack: c.pack, field, status: "UNMAPPED", reason: un ? un.reason : "no mapping entry for this route field and tool" };
  });
}

/** Does an observed segment's oracle key belong to this fact's field (exact, or a sub-key of an object field)? */
export const keyOfField = (key: string, field: string): boolean => key === field || key.startsWith(`${field}.`);

/**
 * For the runner's matcher: the oracle key a placed answer part maps to in THIS case, or null.
 * A record part by (record kind, field code); an aggregate figure by its result path (a sub-key of a
 * mapped object path keeps its suffix: byHealth.ERROR ↦ counts.ERROR). The longest mapped path wins.
 */
export function oracleKeyFor(c: Pick<LiveCase, "id" | "pack" | "expectedTools" | "oracle">,
  part: { tool: string; recordKind?: string; field?: string; path?: string }): string | null {
  let best: { key: string; len: number } | null = null;
  for (const f of guardedFacts(c)) {
    if (f.status !== "MAPPED" || f.entry.tool !== part.tool) continue;
    const s = f.entry.source;
    if (s.kind === "record" && part.recordKind === s.recordKind && part.field === s.field) return f.field;
    if (s.kind === "aggregate" && typeof part.path === "string" && keyOfField(part.path, s.path) && (!best || s.path.length > best.len)) {
      best = { key: `${f.field}${part.path.slice(s.path.length)}`, len: s.path.length };
    }
  }
  return best?.key ?? null;
}

// ── Comparison ──────────────────────────────────────────────────────────────────────────────

type Scalar = string | number | boolean | null;

/** The route value as the tool projects it (FieldCompare), or undefined when it cannot be projected. */
export function projectOracle(entry: Pick<Extract<FieldMapEntry, { status: "MAPPED" }>, "compare" | "vocabulary" | "fallback">, v: Scalar | undefined): Scalar | undefined {
  switch (entry.compare) {
    case "EXACT": return v;
    case "ISO_INSTANT": {
      if (v === null) return null;
      if (typeof v !== "string") return undefined;
      const t = Date.parse(v);
      return Number.isNaN(t) ? undefined : new Date(t).toISOString();
    }
    case "STAGE_LABEL_TO_KEY": return typeof v === "string" ? (FUNNEL_STAGE_KEY_OF_LABEL[v] ?? null) : v === null ? null : undefined;
    case "IS_NOT_NULL": return v !== null && v !== undefined;
    case "CLOSED_CODE": return typeof v === "string" && (entry.vocabulary ?? []).includes(v) ? v : (entry.fallback ?? null);
    case "CAUSE_STATUS": return v === "CONFIRMED" || v === "HYPOTHESIS" ? v : "NONE";
    case "ALLOWLISTED_CODE": return v === null || v === undefined || v === "" ? null : typeof v === "string" && (CONNECTION_ERROR_CODES as readonly string[]).includes(v) ? v : "OTHER";
  }
}

/** A placed value in the same projection (an instant compared as an instant). */
export function projectPlaced(entry: Pick<Extract<FieldMapEntry, { status: "MAPPED" }>, "compare">, v: Scalar | undefined): Scalar | undefined {
  if (entry.compare !== "ISO_INSTANT" || typeof v !== "string") return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? v : new Date(t).toISOString();
}
