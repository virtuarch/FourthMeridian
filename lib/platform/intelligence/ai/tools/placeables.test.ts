/**
 * lib/platform/intelligence/ai/tools/placeables.test.ts  (Platform AI — record closed fields + pack aggregate placeables, S2 09io)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/tools/placeables.test.ts
 *
 * S2's binding conditions (09io), each pinned here:
 *   A1  the per-schema allowlist of CLOSED T1 fields (pinned per RECORD tool); the schema validator refuses a
 *       name / email / username / free-text / institution / amount / bool / ref / opaque-ref entry;
 *   A2  a placed closed field carries EXACTLY the value the tool returned this turn; it renders only after the
 *       fresh area check + revalidation + tier (authz/record-render.ts);
 *   A3  an unknown / non-allowlisted / foreign / forged / re-minted placeholder ⇒ the SAME fallback; a failed
 *       render ⇒ the SAME "[no longer available]" (oracle uniformity across every reason); injection tests;
 *   A4  stored as a V3 record segment (closed value only), re-rendered on read; history replays a kind marker;
 *   A5  no new data to the provider: the tool results the model receives are the tool's own + (S2 09jr S-a) ONLY a
 *       `placeholders` map of ready-to-copy strings built from codes (handle / tool + field / path) — never a value;
 *   B1  {{a:…}} fills only from THIS turn's own result of that tool (no call ⇒ unavailable; two disagreeing calls ⇒
 *       unavailable; a second turn starts empty);
 *   B2  the per-tool closed resultPath allowlist (pinned), contractProblems refusals;
 *   B3  tool not called / path not allowed / absent / wrong type / malformed ⇒ the SAME fallback; injection tests;
 *   B4  the digit rule is unchanged (a digit outside a placeholder still replaces the answer);
 *   B5  stored as a FIGURE segment `agg:<tool>:<path>` labelled "as of <stamp>" + one point-in-time note;
 *   B6  a fuzz test (here) and the E0-CI leak scan (eval/cases/placeables.ts);
 *   and: the same treatment for every operator (no operator branching).
 * No database, no network, no env.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { UserRole, type PlatformArea } from "@prisma/client";
import { UNVERIFIED_FALLBACK, runPlatformAiTurn, type PlatformAiBinding, type PlatformAiGenerate } from "../core";
import { createTurnBoundary } from "../authz/boundary";
import { renderRecordSegments, type RecordRenderSource, type RecordRenderViewer } from "../authz/record-render";
import type { FreshGuard } from "../authz/recheck";
import { scopeFromGuard, type ScopedArea } from "../authz/scope";
import {
  captureAggregateResult, extractAggregatePlaceholders, ownValueAt, parseAggregateKey,
  type AggregateCaptures,
} from "../compose/aggregate";
import { CLOSED_CODE_SHAPE, codeWords, formatClosedValue, placeableNameForbidden } from "../compose/closed";
import { RECORD_GONE_TEXT, RECORD_PENDING_TEXT, extractRecordPlaceholders, type TurnRecordRef } from "../compose/record";
import { isStoredAnswer, parseStoredAnswer, serializeStoredAnswer } from "../conversations/answer";
import { replayAnswer } from "../conversations/history";
import { storedAnswerOf } from "../conversations/turn";
import { PLACEABLE_FIELD_TYPES, T2_FIELD_NAMES, validateRecordSchema, type RecordSchema } from "../evidence/record-envelope";
import { contractProblems, type AggregatePathSpec } from "./contract";
import { PLATFORM_AI_TOOL_REGISTRY, type PlatformAiTool } from "./registry";
import { overviewOf } from "./packs/incidents";
import { importsOf } from "./packs/onboarding";
import { overviewOfHealth } from "./packs/connections";

let failures = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 700)}` : ""}`); }
}
const ROOT = process.cwd();
const src = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

// ── 1. A1: the per-schema closed-field allowlist ────────────────────────────

const A1_PINNED: Readonly<Record<string, readonly string[]>> = {
  list_customer_attention: ["reason", "reasons"],
  list_recently_joined: ["joinedAt", "stage", "importHealth", "connections"],
  get_customer_profile: ["joinedAt", "stage", "presence", "lastActive", "connections", "brokenConnections", "openIncidents", "aiTurns30d", "lastEngagedAt"],
  list_incidents: ["state", "severity", "domain", "kind", "provider", "operation", "firstSeenAt", "lastSeenAt", "resolvedAt", "occurrences", "spread", "affectedSources", "generation", "causeStatus", "cause", "closure"],
  investigate_incident: [
    "state", "severity", "domain", "kind", "provider", "operation", "firstSeenAt", "lastSeenAt", "resolvedAt", "occurrences", "spread", "affectedSources", "generation", "causeStatus", "cause", "closure",
    "displayStatus", "remedy", "providerErrorCode", "connectionStatus", "sourceState", "attempts", "attemptsSucceeded", "attemptsFailed", "lastSucceededAt", "lastFailedAt", "earlierEpisodes",
    "closureOutcome", "resolutionReason", "recoveryProofs", "timelineEvents", "lastEventType", "lastActionCode", "lastOutcomeCode",
  ],
  list_incidents_cs: ["state", "severity", "domain", "kind", "provider", "operation", "firstSeenAt", "lastSeenAt", "resolvedAt", "occurrences", "spread", "affectedSources", "generation", "causeStatus", "cause", "closure"],
  investigate_incident_cs: [
    "state", "severity", "domain", "kind", "provider", "operation", "firstSeenAt", "lastSeenAt", "resolvedAt", "occurrences", "spread", "affectedSources", "generation", "causeStatus", "cause", "closure",
    "displayStatus", "remedy", "providerErrorCode", "connectionStatus", "sourceState", "attempts", "attemptsSucceeded", "attemptsFailed", "lastSucceededAt", "lastFailedAt", "earlierEpisodes",
    "closureOutcome", "resolutionReason", "recoveryProofs", "timelineEvents", "lastEventType", "lastActionCode", "lastOutcomeCode",
  ],
  list_onboarding_attention: ["reason", "reasonAt", "registeredAt", "linkErrorCode", "addFailureStage", "importReason", "otherReasons"],
  get_onboarding_timeline: [
    "registeredAt", "verifiedAt", "firstSessionAt", "stage", "bankConnections", "walletConnections", "firstConnectedAt", "importsInProgress", "importsComplete",
    "importsRecovered", "importsFailed", "importsRemoved", "importsInterrupted", "lastImportFailure", "importHealth", "firstWealthRegenAt", "firstAiTurnAt", "firstBriefAt",
  ],
  get_customer_connections: ["provider", "kind", "network", "status", "healthState", "errorCode", "lastSyncedAt", "connectedAt"],
};

/** B2 — per tool: the non-vocabulary paths exactly, and each vocabulary-keyed prefix with its key count. */
const B2_PINNED: Readonly<Record<string, { exact: readonly string[]; prefixes: Readonly<Record<string, number>>; total: number }>> = {
  incident_overview: {
    exact: ["asOf", "brokenNow", "customerActionable", "needsVerification", "widespread"],
    prefixes: { bySeverity: 4, byDomain: 7, causeStatus: 3 },
    total: 19,
  },
  onboarding_overview: {
    exact: ["asOf", "imports.interruptedInProgress", "imports.started", "imports.windowDays", "needsHelp.customers", "needsHelp.testAccounts"],
    prefixes: { "imports.byStatus": 5, "imports.failedReasons": 12, "needsHelp.byReason": 6, "needsHelp.addFailureStages": 4, "needsHelp.stages": 7 },
    total: -1, // + the two link-code tallies (LINK_CODES, the pack's own closed set) — checked below
  },
  connection_health_overview: {
    exact: ["asOf", "neverSyncedListed", "retired.ownerInactive", "retired.revoked", "total"],
    prefixes: { byHealth: 6, "bySource.PLAID": 2, "bySource.WALLET": 2, "bySource.EXCHANGE": 2, "bySource.BROKERAGE": 2, "bySource.OTHER": 2 },
    total: 21,
  },
};

const OP = "cop0000000000000000000001";
const OTHER_OP = "cop0000000000000000000002";
const AS_OF = "2026-11-09T12:00:00.000Z";
const RID = "crec0000secretrecordid0001";
const FREE_TEXT = "e0placeablesecretnote";
const T2_SENTINEL = "Zelda Quillfeather";

const scopeOf = (area: PlatformArea, op = OP): ScopedArea => scopeFromGuard({ user: { id: op, role: UserRole.USER }, grant: { area, level: "READ" } }, area, op)!;
const binding = (label: string): PlatformAiBinding => ({
  surfaceLabel: label, listMetrics: () => [], describeMetric: () => null, readMetric: async () => null, listPages: () => [], resolvePage: () => null,
});
const guard = (area: PlatformArea, op = OP, cs = false): FreshGuard => ({ auth: { user: { id: op, role: UserRole.USER }, grant: { area, level: "READ" } }, csTier: cs });

// Synthetic test-only tools (never registered): a RECORD tool and an AGGREGATE tool with placeables.
const PROBE_SCHEMA: RecordSchema = {
  kind: "PROBE", t2Fields: ["name"],
  fields: {
    state: { type: "code", values: ["OPEN", "RESOLVED"] }, openedAt: { type: "isoTime" }, attempts: { type: "count" }, closedAt: { type: "isoTime", nullable: true },
    retried: { type: "bool" }, customer: { type: "opaqueRef" },
  },
  placeable: ["state", "openedAt", "attempts", "closedAt"],
};
const PROBE_PATHS: readonly AggregatePathSpec[] = [
  { path: "open", type: "count" }, { path: "byState.OPEN", type: "count" }, { path: "byState.RESOLVED", type: "count" }, { path: "asOf", type: "isoTime" },
  { path: "worst", type: "code", values: ["OPEN", "RESOLVED"] },
];
const base = { pack: "metrics", description: "test", requires: { areas: ["PLATFORM_OPS"], level: "READ", tier: "OPS" }, pii: 1, cost: { toolCalls: 1 } } as const;
const aggOpen = 98765;
const probeOverview: PlatformAiTool = {
  ...base, name: "probe_overview", args: { properties: {} }, scope: "AGGREGATE", customerLinkable: false, pii: 0, placeablePaths: PROBE_PATHS,
  run: async () => ({ status: "CONFIRMED", asOf: AS_OF, open: aggOpen, byState: { OPEN: 3 }, worst: "OPEN", note: FREE_TEXT, labels: [7, 8] }),
} as PlatformAiTool;
const probeList: PlatformAiTool = {
  ...base, name: "probe_list", args: { properties: {} }, scope: "RECORD", customerLinkable: false, recordSchema: PROBE_SCHEMA,
  run: async () => ({
    status: "CONFIRMED", asOf: AS_OF, truncated: false,
    records: [{ ref: { kind: "PROBE", recordId: RID, area: "PLATFORM_OPS", tier: "OPS", linkedUserIds: [] }, fields: { state: "OPEN", openedAt: AS_OF, attempts: 4321, closedAt: null, retried: true, customer: "user #0a1b2c3d" } }],
  }),
} as PlatformAiTool;

function makeBoundary(op = OP) {
  return createTurnBoundary({
    operatorId: op, correlationId: `corr-${op}`, areas: [{ scope: scopeOf("PLATFORM_OPS", op), binding: binding("Ops") }], binding: binding("Ops"),
    recheck: async (area) => (area === "PLATFORM_OPS" ? guard(area, op) : null), packs: ["metrics", "navigation"], packEnabled: () => true,
    registry: [probeOverview, probeList], recordSources: { PROBE: probeSource() },
  });
}

function probeSource(over: Partial<RecordRenderSource> = {}): RecordRenderSource {
  return {
    t2Fields: ["name"], placeable: PROBE_SCHEMA.placeable,
    revalidate: async (rid) => (rid === RID ? "OPS" : null), t1: async () => "probe: case", linkedUserIds: async () => [], t2: async () => T2_SENTINEL,
    ...over,
  };
}

const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 10, reasoningTokens: 0 };
const callStep = (name: string) => ({ content: null, toolCalls: [{ id: `c-${name}`, name, arguments: "{}" }], raw: { role: "assistant", content: null, tool_calls: [{ id: `c-${name}`, type: "function", function: { name, arguments: "{}" } }] }, usage });
const answerStep = (content: string) => ({ content, toolCalls: [], raw: { role: "assistant", content }, usage });
type ToolMsg = { role: string; content: string };

/** One turn: (optionally) the overview, then the list, then `answer(handle)` (and the same text again for a corrective retry). */
async function turn(answer: (h: string) => string, opts: { op?: string; calls?: string[] } = {}) {
  const b = makeBoundary(opts.op);
  const calls = opts.calls ?? ["probe_overview", "probe_list"];
  const requests: string[] = [];
  let i = 0;
  let handle = "h_none000000000000";
  const generate: PlatformAiGenerate = async ({ messages }) => {
    requests.push(JSON.stringify(messages));
    i++;
    if (i <= calls.length) return callStep(calls[i - 1]) as never;
    const tool = (messages as ToolMsg[]).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content) as { records?: { handle: string }[] });
    handle = tool.find((t) => t.records?.length)?.records?.[0]?.handle ?? handle;
    return answerStep(answer(handle)) as never;
  };
  const out = await runPlatformAiTurn({ question: "How are the probes?", questionScrubbed: true, binding: binding("Ops"), generate, model: "t", classifyBriefing: false, invoke: b.invoke, records: b.recordRef });
  return { ...out, requests, handle, b };
}
const display = (r: Awaited<ReturnType<typeof turn>>) => r.result.answer.map((s) => s.text).join("");

async function main() {
  console.log("1. A1 — the per-schema CLOSED T1 field allowlist (pinned)");
  {
    const recordTools = PLATFORM_AI_TOOL_REGISTRY.filter((t) => t.scope === "RECORD");
    check("every registered RECORD tool has a pinned allowlist, and only those", recordTools.map((t) => t.name).sort().join() === Object.keys(A1_PINNED).sort().join(), recordTools.map((t) => t.name));
    const diff = recordTools.filter((t) => JSON.stringify(t.recordSchema?.placeable ?? []) !== JSON.stringify(A1_PINNED[t.name]));
    check("each RECORD tool's schema `placeable` equals its pinned list", diff.length === 0, diff.map((t) => [t.name, t.recordSchema?.placeable]));
    check("every RECORD schema passes validateRecordSchema (placeable included)", recordTools.every((t) => validateRecordSchema(t.recordSchema!).length === 0), recordTools.map((t) => [t.name, validateRecordSchema(t.recordSchema!)]));
    const bad: string[] = [];
    for (const t of recordTools) {
      const s = t.recordSchema!;
      for (const f of s.placeable ?? []) {
        const spec = s.fields[f];
        if (!(PLACEABLE_FIELD_TYPES as readonly string[]).includes(spec.type)) bad.push(`${t.name}.${f}: type ${spec.type}`);
        if (f === "ref" || (T2_FIELD_NAMES as readonly string[]).includes(f) || placeableNameForbidden(f)) bad.push(`${t.name}.${f}: name`);
        if (spec.type === "code" && !spec.values.every((v) => CLOSED_CODE_SHAPE.test(v))) bad.push(`${t.name}.${f}: a code value outside the closed code shape`);
      }
      for (const [f, spec] of Object.entries(s.fields)) {
        if (["bool", "opaqueRef", "registryName", "handle"].includes(spec.type) && (s.placeable ?? []).includes(f)) bad.push(`${t.name}.${f}: ${spec.type} placeable`);
      }
    }
    check("A1: only code / count / isoTime fields; never ref, a T2 name, a forbidden word, a bool, an opaque ref, a registry (institution) name; every code value is a closed code shape", bad.length === 0, bad);
    const excluded = recordTools.flatMap((t) => Object.entries(t.recordSchema!.fields).filter(([f]) => !(t.recordSchema!.placeable ?? []).includes(f)).map(([, spec]) => `${spec.type}`));
    check("every field NOT placeable is a bool / opaque ref / registry name (nothing closed-and-useful silently left out)", excluded.every((x) => ["bool", "opaqueRef", "registryName"].includes(x)), [...new Set(excluded)]);

    const refuse = (placeable: string[], fields: RecordSchema["fields"] = {}) => validateRecordSchema({ kind: "PROBE", fields: { ok: { type: "count" }, ...fields }, placeable });
    check("the validator refuses: a T2-named field, an email, a username (never a field, never placeable)", refuse(["name"]).length > 0 && refuse(["email"]).length > 0 && refuse(["username"]).length > 0);
    check("…an opaque ref (customer), a registry name (institution), a bool, a handle", refuse(["customer"], { customer: { type: "opaqueRef" } }).some((p) => /not_a_closed_type/.test(p))
      && refuse(["institution"], { institution: { type: "registryName", names: ["Bank"] } }).some((p) => /forbidden_name|not_a_closed_type/.test(p))
      && refuse(["flag"], { flag: { type: "bool" } }).some((p) => /not_a_closed_type/.test(p)) && refuse(["h"], { h: { type: "handle" } }).some((p) => /not_a_closed_type/.test(p)));
    check("…an amount / free-text named count or code (balanceUsd, noteText, displayName, accountId)", ["balanceUsd", "noteText", "displayName", "accountId"].every((f) => refuse([f], { [f]: { type: "count" } }).some((p) => /forbidden_name/.test(p))));
    check("…\"ref\", an undeclared field, a duplicate", refuse(["ref"], { ref: { type: "opaqueRef" } }).length > 0 && refuse(["missing"]).some((p) => /not_a_field/.test(p)) && refuse(["ok", "ok"]).some((p) => /duplicate/.test(p)));
    check("…and accepts a closed count", refuse(["ok"]).length === 0);
  }

  console.log("\n2. B2 — the per-tool CLOSED result-path allowlist (pinned)");
  {
    const aggTools = PLATFORM_AI_TOOL_REGISTRY.filter((t) => (t.placeablePaths?.length ?? 0) > 0);
    check("exactly the three pack AGGREGATE tools declare placeable paths", aggTools.map((t) => t.name).sort().join() === Object.keys(B2_PINNED).sort().join(), aggTools.map((t) => t.name));
    check("every registry tool still passes contractProblems", PLATFORM_AI_TOOL_REGISTRY.every((t) => contractProblems(t as never).length === 0), PLATFORM_AI_TOOL_REGISTRY.map((t) => [t.name, contractProblems(t as never)]).filter(([, p]) => (p as string[]).length));
    for (const t of aggTools) {
      const pin = B2_PINNED[t.name];
      const paths = (t.placeablePaths ?? []).map((p) => p.path);
      const exact = paths.filter((p) => !Object.keys(pin.prefixes).some((pre) => p.startsWith(`${pre}.`) && p.split(".").length === pre.split(".").length + 1)).filter((p) => !/^needsHelp\.(linkExitCodes|addFailureCodes)\./.test(p));
      const byPrefix = Object.fromEntries(Object.keys(pin.prefixes).map((pre) => [pre, paths.filter((p) => p.startsWith(`${pre}.`) && p.split(".").length === pre.split(".").length + 1).length]));
      check(`${t.name}: the non-vocabulary paths are exactly the pinned ones`, JSON.stringify([...exact].sort()) === JSON.stringify(pin.exact), exact);
      check(`${t.name}: each vocabulary-keyed prefix has its pinned key count`, JSON.stringify(byPrefix) === JSON.stringify(pin.prefixes), byPrefix);
      if (pin.total > 0) check(`${t.name}: ${pin.total} paths in all`, paths.length === pin.total, paths.length);
      check(`${t.name}: counts / dates only (no code paths in the packs), never a forbidden segment, never text / institution / list keys`,
        (t.placeablePaths ?? []).every((p) => p.type === "count" || (p.type === "isoTime" && p.path === "asOf"))
          && !paths.some((p) => /nextSteps|unhealthyByInstitution|unhealthyByNetwork|faults|status$|listFloor|floor$|truncated/.test(p)), paths.filter((p) => /nextSteps|Institution|Network|faults/.test(p)));
    }
    const onb = aggTools.find((t) => t.name === "onboarding_overview")!.placeablePaths!.map((p) => p.path);
    const link = onb.filter((p) => p.startsWith("needsHelp.linkExitCodes.")).map((p) => p.split(".")[2]);
    const add = onb.filter((p) => p.startsWith("needsHelp.addFailureCodes.")).map((p) => p.split(".")[2]);
    check("onboarding_overview: the two link-code tallies key the SAME closed code set, uppercase codes only, incl. OTHER", link.length > 10 && JSON.stringify(link) === JSON.stringify(add) && link.every((c) => /^[A-Z][A-Z0-9_]*$/.test(c)) && link.includes("OTHER"), link.length);

    // Every path resolves, with its closed type, in the pack's OWN result (its mapper over a sample).
    const inc = overviewOf({ items: [], truncated: false } as never, { items: [], truncated: false } as never, new Date(AS_OF));
    const health = overviewOfHealth({
      total: 3, counts: { HEALTHY: 1, STALE: 0, DEGRADED: 0, NEEDS_REAUTH: 1, ERROR: 1, REVOKED: 0 }, unhealthy: [], checkedAt: AS_OF, cap: 50, listedScope: "unhealthy",
      retired: { revoked: 1, ownerInactive: 0 }, bySource: { PLAID: { active: 2, revoked: 0, faults: [] }, WALLET: { active: 1, revoked: 1, faults: [] } },
    } as never, new Map());
    const imports = { asOf: AS_OF, imports: importsOf({ windowDays: 7, started: 2, byStatus: { complete: 2 }, failedReasons: {}, interruptedInProgress: 0, floor: false } as never) };
    const sample: Record<string, unknown> = { incident_overview: inc, connection_health_overview: health, onboarding_overview: imports };
    const missing: string[] = [];
    for (const t of aggTools) for (const p of t.placeablePaths ?? []) {
      if (t.name === "onboarding_overview" && p.path.startsWith("needsHelp.")) continue; // CS-only half (the mapper needs the attention fold)
      if (t.name === "connection_health_overview" && /^bySource\.(EXCHANGE|BROKERAGE|OTHER)\./.test(p.path)) continue; // keys present only when the fleet has them
      if (t.name === "onboarding_overview" && p.path.startsWith("imports.failedReasons.")) continue; // a reason key is present only once tallied
      const v = ownValueAt(sample[t.name], p.path);
      if (formatClosedValue(p.type, v) === null) missing.push(`${t.name}:${p.path}`);
    }
    check("every allowlisted path resolves to a value of its closed type in the tool's own result shape", missing.length === 0, missing);

    const agg = (placeablePaths: unknown, over: Record<string, unknown> = {}) => contractProblems({ ...probeOverview, placeablePaths, ...over } as never);
    check("contractProblems refuses: placeablePaths on a RECORD tool", agg(PROBE_PATHS, { scope: "RECORD", recordSchema: PROBE_SCHEMA }).some((p) => /AGGREGATE tool's list only/.test(p)));
    check("…a forbidden segment (nextSteps, unhealthyByInstitution, a.__proto__, balanceUsd, userId)",
      ["needsHelp.nextSteps", "unhealthyByInstitution.x", "a.__proto__", "balanceUsd", "byUser.userId"].every((p) => agg([{ path: p, type: "count" }]).some((x) => /forbidden segment|not a path/.test(x))));
    check("…a non-path (array index, empty, leading dot), a non-closed type, a code path without its set, a duplicate",
      agg([{ path: "items[0]", type: "count" }]).length > 0 && agg([{ path: "", type: "count" }]).length > 0 && agg([{ path: ".x", type: "count" }]).length > 0
        && agg([{ path: "x", type: "text" }]).some((p) => /closed type/.test(p)) && agg([{ path: "x", type: "code" }]).some((p) => /closed set/.test(p))
        && agg([{ path: "x", type: "count" }, { path: "x", type: "count" }]).some((p) => /duplicate/.test(p)));
    check("…but an UPPER_CASE vocabulary code segment is a code, not an id (OAUTH_STATE_ID_MISMATCH)", agg([{ path: "codes.OAUTH_STATE_ID_MISMATCH", type: "count" }]).length === 0);
  }

  console.log("\n3. B1/B2 — the capture: THIS call's own result, allowlisted closed values only");
  {
    const caps: AggregateCaptures = new Map();
    captureAggregateResult(caps, "probe_overview", PROBE_PATHS, { status: "CONFIRMED", asOf: AS_OF, open: 5, byState: { OPEN: 3, RESOLVED: "2" }, worst: "BROKEN", note: FREE_TEXT, extra: 9 });
    const c = caps.get("probe_overview")!;
    check("captured: allowlisted paths with a value of their type only (a string count / an off-set code are not captured; extra keys ignored)",
      JSON.stringify([...c.values.keys()].sort()) === JSON.stringify(["asOf", "byState.OPEN", "open"]) && c.asOf === AS_OF && !JSON.stringify([...c.values.values()]).includes(FREE_TEXT), [...c.values]);
    const z: AggregateCaptures = new Map();
    captureAggregateResult(z, "probe_overview", PROBE_PATHS, { status: "UNAVAILABLE", asOf: AS_OF, open: 5 });
    captureAggregateResult(z, "probe_overview", PROBE_PATHS, Object.assign(Object.create({ open: 5 }), { status: "CONFIRMED" }));
    captureAggregateResult(z, "probe_overview", PROBE_PATHS, [5]);
    captureAggregateResult(z, "probe_overview", PROBE_PATHS, { status: "CONFIRMED", open: -1, byState: { OPEN: 1.5 }, asOf: "yesterday" });
    check("an UNAVAILABLE result, a non-plain object (inherited key), an array, negative / fractional counts, a non-ISO asOf ⇒ nothing captured",
      (z.get("probe_overview")?.values.size ?? 0) === 0 && (z.get("probe_overview")?.asOf ?? null) === null, z.get("probe_overview"));
    const two: AggregateCaptures = new Map();
    captureAggregateResult(two, "probe_overview", PROBE_PATHS, { status: "CONFIRMED", asOf: AS_OF, open: 5, byState: { OPEN: 3 } });
    captureAggregateResult(two, "probe_overview", PROBE_PATHS, { status: "CONFIRMED", asOf: AS_OF, open: 6, byState: { OPEN: 3 }, worst: "OPEN" });
    const tv = two.get("probe_overview")!.values;
    check("two calls in one turn: an agreeing path stays, a disagreeing one becomes unavailable, a path only one call had is unavailable",
      tv.get("byState.OPEN")?.value === 3 && tv.get("open") === null && tv.get("worst") === null, [...tv]);
    check("ownValueAt reads OWN keys of plain objects only (never a prototype / array element)",
      ownValueAt({ a: { b: 1 } }, "a.b") === 1 && ownValueAt({}, "constructor") === undefined && ownValueAt({ a: [1] }, "a.0") === undefined && ownValueAt(Object.create({ x: 1 }), "x") === undefined);
  }

  console.log("\n4. the turn: placed values render from THIS turn's tool results; A5 nothing new reaches the model");
  let good: Awaited<ReturnType<typeof turn>>;
  {
    good = await turn((h) => `{{r:${h}|ref}} is {{r:${h}|state}} since {{r:${h}|openedAt}} after {{r:${h}|attempts}} attempts. Open probes: {{a:probe_overview|open}}, in OPEN {{a:probe_overview|byState.OPEN}}, worst {{a:probe_overview|worst}}.`);
    const text = display(good);
    check("kept (not replaced); every placeholder resolved", !good.result.grounding.replaced && good.result.claims.unresolved === 0 && good.result.claims.claims === 7, good.result.grounding);
    check("aggregate values render as server text in the display answer (count grouping, code words)", text.includes("Open probes: 98,765, in OPEN 3, worst open."), text);
    check("record spans stay the fail-closed marker until the read-time render (never a value in the live text)", text.split(RECORD_PENDING_TEXT).length - 1 === 4 && !text.includes("4,321"), text);
    const recs = good.record.typed.filter((t) => t.kind === "record");
    check("typed record spans: ref carries no value; state / openedAt / attempts carry EXACTLY the tool's values (A2)",
      JSON.stringify(recs.map((r) => [r.f, (r as { v?: unknown }).v ?? null])) === JSON.stringify([["ref", null], ["state", "OPEN"], ["openedAt", AS_OF], ["attempts", 4321]]), recs);
    const figs = good.record.typed.filter((t) => t.kind === "figure");
    check("typed aggregate figures: metric agg:<tool>:<path>, window \"as of <stamp>\", aggregate {tool, resultPath} (derivable for #569)",
      JSON.stringify(figs) === JSON.stringify([
        { kind: "figure", text: "98,765", metric: "agg:probe_overview:open", window: "as of 2026-11-09 12:00 UTC", aggregate: { tool: "probe_overview", resultPath: "open" } },
        { kind: "figure", text: "3", metric: "agg:probe_overview:byState.OPEN", window: "as of 2026-11-09 12:00 UTC", aggregate: { tool: "probe_overview", resultPath: "byState.OPEN" } },
        { kind: "figure", text: "open", metric: "agg:probe_overview:worst", window: "as of 2026-11-09 12:00 UTC", aggregate: { tool: "probe_overview", resultPath: "worst" } },
      ]), figs);
    check("B5: ONE code-written point-in-time note", good.result.notes.filter((n) => /point-in-time/.test(n)).length === 1 && good.result.notes.includes("Overview counts are point-in-time reads (probe overview as of 2026-11-09 12:00 UTC)."), good.result.notes);
    // A5: the tool messages the model received are byte-identical to what each tool returned (the boundary adds nothing).
    const toolMsgs = (good.transcript as ToolMsg[]).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
    // S2 09jr S-a (supersedes 09io A5's "byte-identical"): the ONLY addition is `placeholders` — ready-to-copy strings
    // built from the tool name / handle and the allowlisted path / closed field CODES; no value, no new data class.
    const { placeholders: aggPh, ...aggRest } = toolMsgs[0] as Record<string, unknown>;
    check("S-a: the overview result = the tool's own result + `placeholders` only", JSON.stringify(aggRest) === JSON.stringify(await probeOverview.run({}, {} as never)), toolMsgs[0]);
    check("S-a: the aggregate `placeholders` map = exactly the B2-allowlisted paths this result holds a closed value for → {{a:<tool>|<path>}}",
      JSON.stringify(aggPh) === JSON.stringify({ open: "{{a:probe_overview|open}}", "byState.OPEN": "{{a:probe_overview|byState.OPEN}}", asOf: "{{a:probe_overview|asOf}}", worst: "{{a:probe_overview|worst}}" }), aggPh);
    check("S-a: no placeholder for an absent allowlisted path (byState.RESOLVED), a non-allowlisted key (note, labels) or a value; no duplicated value",
      !/RESOLVED|note|labels|98765|e0placeable/.test(JSON.stringify(aggPh)), aggPh);
    const rec0 = toolMsgs[1].records[0] as Record<string, unknown>;
    check("S-a: the record result carries the handle + the closed fields as before + `placeholders` — no `closed`, `placeable`, value map or id",
      !/"closed"|placeable|crec0000/.test(JSON.stringify(toolMsgs[1])) && JSON.stringify(Object.keys(rec0)) === JSON.stringify(["handle", "kind", "fields", "t2Fields", "placeholders"]), toolMsgs[1]);
    const h0 = rec0.handle as string;
    check("S-a: the record `placeholders` = exactly the A1-allowlisted closed fields with a value → {{r:<handle>|<field>}} (never ref, a T2 name, a bool, an opaque ref, a null field, a value)",
      JSON.stringify(rec0.placeholders) === JSON.stringify({ state: `{{r:${h0}|state}}`, openedAt: `{{r:${h0}|openedAt}}`, attempts: `{{r:${h0}|attempts}}` })
        && !/\|ref\}|\|name\}|retried|customer|closedAt/.test(JSON.stringify(rec0.placeholders)), rec0.placeholders);
    check("nothing the model never had is in the answer (no free-text note, no T2 sentinel)", !text.includes(FREE_TEXT) && !text.includes(T2_SENTINEL));
  }

  console.log("\n5. A3 / B3 — injection: forged / foreign / non-allowlisted placeholders ⇒ the SAME fallback (no oracle)");
  {
    const cases: [string, (h: string) => string, string][] = [
      ["aggregate path not allowlisted (free-text key the tool DID return)", () => "Note {{a:probe_overview|note}}.", "AGGREGATE_UNRESOLVED"],
      ["aggregate tool not called this turn", () => "Count {{a:incident_overview|brokenNow}}.", "AGGREGATE_UNRESOLVED"],
      ["aggregate path allowlisted but absent from the result", () => "Resolved {{a:probe_overview|byState.RESOLVED}}.", "AGGREGATE_UNRESOLVED"],
      ["aggregate prototype / array paths", () => "X {{a:probe_overview|__proto__}} {{a:probe_overview|labels.0}}.", "AGGREGATE_UNRESOLVED"],
      ["malformed aggregate placeholder", () => "X {{a:probe_overview}} {{a: |open}}.", "AGGREGATE_UNRESOLVED"],
      ["record: a bool field (not allowlisted)", (h) => `It is {{r:${h}|retried}}.`, "RECORD_UNRESOLVED"],
      ["record: the opaque customer ref field", (h) => `Owner {{r:${h}|customer}}.`, "RECORD_UNRESOLVED"],
      ["record: a null closed field (no value returned)", (h) => `Closed {{r:${h}|closedAt}}.`, "RECORD_UNRESOLVED"],
      ["record: an unknown field", (h) => `It is {{r:${h}|secretField}}.`, "RECORD_UNRESOLVED"],
      ["record: a forged handle", () => "It is {{r:h_AAAAAAAAAAAAAAAA|state}}.", "RECORD_UNRESOLVED"],
    ];
    const answers: string[] = [];
    for (const [name, a, verdict] of cases) {
      const r = await turn(a);
      answers.push(JSON.stringify(r.result.answer));
      check(`${name} ⇒ ${verdict}, replaced`, r.result.grounding.verdict === verdict && r.result.grounding.replaced, r.result.grounding);
    }
    check("every reason renders the IDENTICAL fallback answer (no existence / allowlist / tool-called oracle)", new Set(answers).size === 1 && answers[0].includes(UNVERIFIED_FALLBACK), [...new Set(answers)]);
    // A handle from ANOTHER turn (the good turn above) — the same fallback.
    const foreign = await turn(() => `It is {{r:${good.handle}|state}}.`);
    check("a handle minted in another turn ⇒ RECORD_UNRESOLVED, the same fallback", foreign.result.grounding.verdict === "RECORD_UNRESOLVED" && JSON.stringify(foreign.result.answer) === answers[0]);
    // A re-minted (history) handle carries no closed value: only ref / T2 place.
    const b = makeBoundary();
    const [h2] = await b.remint([{ rk: "PROBE", rid: RID, a: "PLATFORM_OPS" }]);
    const ref = h2 ? b.recordRef(h2) : null;
    check("a re-minted handle (replay re-authz) has NO closed field: fields = ref + T2 names only", !!ref && JSON.stringify(ref.fields) === JSON.stringify(["ref", "name"]) && ref.closed === undefined, ref);
    const lookup = (hh: string): TurnRecordRef | null => (hh === h2 ? ref : null);
    check("…so {{r:<reminted>|state}} is unresolved", extractRecordPlaceholders(`x {{r:${h2}|state}}`, lookup).unresolved === 1);
    // A tampered lookup (closed value of the wrong shape) never resolves.
    const tampered = (): TurnRecordRef => ({ rk: "PROBE", rid: RID, a: "PLATFORM_OPS", fields: ["ref", "state", "attempts"], closed: { state: { type: "code", value: "a@b.co" }, attempts: { type: "count", value: "12" } } } as never);
    check("a closed value that is not a closed shape (an email-like code, a string count) never resolves", extractRecordPlaceholders("{{r:h_AAAAAAAAAAAAAAAA|state}} {{r:h_AAAAAAAAAAAAAAAA|attempts}}", tampered).unresolved === 2);
  }

  console.log("\n6. B1 — no cross-turn, no re-query; B4 — the digit rule is unchanged; no operator branching");
  {
    const noCall = await turn(() => "Open probes: {{a:probe_overview|open}}.", { calls: ["probe_list"] });
    check("a turn that did not call the tool cannot fill it (even though an earlier turn did)", noCall.result.grounding.verdict === "AGGREGATE_UNRESOLVED" && noCall.result.grounding.replaced);
    const digit = await turn(() => "Open probes: {{a:probe_overview|open}} and 5 more.");
    check("a digit the model writes beside a filled aggregate ⇒ UNGROUNDED_DIGIT, replaced (after the one corrective retry)", digit.result.grounding.replaced && digit.result.grounding.retry?.verdict === "UNGROUNDED_DIGIT", digit.result.grounding);
    const words = await turn(() => "Open probes: {{a:probe_overview|open}}, about two dozen new.");
    check("a number word beside it ⇒ UNGROUNDED_DIGIT too", words.result.grounding.replaced, words.result.grounding);
    const a = await turn((h) => `{{r:${h}|state}}; {{a:probe_overview|open}}.`, { op: OP });
    const b2 = await turn((h) => `{{r:${h}|state}}; {{a:probe_overview|open}}.`, { op: OTHER_OP });
    check("the same tools + answer for two different operators ⇒ the identical display answer (no operator branching)", JSON.stringify(a.result.answer) === JSON.stringify(b2.result.answer) && !a.result.grounding.replaced, [a.result.answer, b2.result.answer]);
    const agg = code(src("lib/platform/intelligence/ai/compose/aggregate.ts")) + code(src("lib/platform/intelligence/ai/compose/closed.ts"));
    check("compose/aggregate.ts + closed.ts name no operator, tier, grant or area (the rule is per tool / per field, never per viewer)", !/operator|csTier|grant|PlatformArea|CUSTOMER_SUCCESS|PLATFORM_OPS/.test(agg));
    const bnd = code(src("lib/platform/intelligence/ai/authz/boundary.ts"));
    check("the boundary captures every AGGREGATE result the same way (one unconditional call on the tool's own output)", /if \(tool\.placeablePaths\?\.length\) \{\s*c\.ev\.aggregates \?\?= new Map\(\);\s*captureAggregateResult\(c\.ev\.aggregates, tool\.name, tool\.placeablePaths, out\);/.test(bnd));
  }

  console.log("\n7. A2/A3 — the read-time render: fresh guard + revalidation + tier, then the turn value; else the uniform marker");
  {
    const seg = (f: string, v?: unknown, over: Record<string, unknown> = {}) => ({ kind: "record" as const, rk: "PROBE", rid: RID, a: "PLATFORM_OPS", f, ...(v !== undefined ? { v } : {}), ...over }) as never;
    const log: string[] = [];
    const viewer = (o: { held?: boolean; src?: Partial<RecordRenderSource>; mode?: RecordRenderViewer["mode"]; op?: string } = {}): RecordRenderViewer => ({
      operatorId: o.op ?? OP, mode: o.mode ?? "history",
      recheck: async (area) => { log.push(`recheck:${area}`); return o.held === false ? null : guard(area, o.op ?? OP); },
      sources: { PROBE: probeSource({ ...o.src, t2: async () => { log.push("t2"); return T2_SENTINEL; }, revalidate: o.src?.revalidate ?? (async (rid) => { log.push("revalidate"); return rid === RID ? "OPS" : null; }) }) },
      audit: async () => { log.push("audit"); },
    });
    const live = await renderRecordSegments([seg("state", "OPEN"), seg("attempts", 4321), seg("openedAt", AS_OF)], viewer());
    check("live: the turn's values, server-formatted (code words, grouped count, UTC stamp), outcome CLOSED",
      JSON.stringify(live) === JSON.stringify([{ text: "open", outcome: "CLOSED" }, { text: "4,321", outcome: "CLOSED" }, { text: "2026-11-09 12:00 UTC", outcome: "CLOSED" }]), live);
    check("…after the fresh area check and the revalidation; no audit and no T2 read for a closed field", log.join() === "recheck:PLATFORM_OPS,revalidate,revalidate,revalidate", log);
    const gone = [
      (await renderRecordSegments([seg("state", "OPEN")], viewer({ held: false })))[0],                                 // area no longer held
      (await renderRecordSegments([seg("state", "OPEN", { rid: "crec0000otherrecordid00002" })], viewer()))[0],         // record gone / not visible
      (await renderRecordSegments([seg("state", "OPEN")], viewer({ src: { revalidate: async () => "CUSTOMER_SUCCESS" } })))[0], // CS-tier record, non-CS viewer
      (await renderRecordSegments([seg("state", "OPEN")], viewer({ src: { placeable: ["attempts"] } })))[0],          // field not allowlisted for the kind
      (await renderRecordSegments([seg("state", "OPEN")], viewer({ src: { placeable: undefined } })))[0],             // source declares none
      (await renderRecordSegments([seg("state", { x: 1 })], viewer()))[0],                                              // a non-closed value
      (await renderRecordSegments([seg("state", "a@b.co")], viewer()))[0],                                             // an email-like "code"
      (await renderRecordSegments([seg("attempts", -3)], viewer()))[0],                                                // a negative count
      (await renderRecordSegments([seg("state")], viewer()))[0],                                                       // a closed field with no value
      (await renderRecordSegments([seg("state", "OPEN", { rk: "UNKNOWN_KIND" })], viewer()))[0],                       // no source for the kind
    ];
    check("EVERY failure renders the identical \"[no longer available]\" (area, gone record, tier, allowlist, value shape, kind) — no oracle",
      gone.every((g) => g.text === RECORD_GONE_TEXT && g.outcome === "GONE"), gone);
    const exp = await renderRecordSegments([seg("state", "OPEN")], viewer({ mode: "export" }));
    check("export renders the closed T1 value too (it is T1, never T2)", exp[0].text === "open");
    const t2 = await renderRecordSegments([seg("name")], viewer());
    check("a T2 field on an OPS (non-CS) guard is still masked exactly as before (the T1 ref)", t2[0].outcome === "MASKED" && !t2[0].text.includes(T2_SENTINEL), t2);
  }

  console.log("\n8. A4 / B5 — storage: V3 closed values, aggregate figures labelled point-in-time; history replays markers only");
  {
    const stored = storedAnswerOf(good.result, good.record);
    const recs = stored.segments.filter((s) => s.kind === "record");
    check("stored V3: record segments keep {rk, rid, a, f} + v for the closed fields only", stored.v === 3
      && JSON.stringify(recs.map((r) => [r.f, (r as { v?: unknown }).v ?? null])) === JSON.stringify([["ref", null], ["state", "OPEN"], ["openedAt", AS_OF], ["attempts", 4321]]), recs);
    const figs = stored.segments.filter((s) => s.kind === "figure");
    check("stored aggregate figures: text + metric agg:<tool>:<path> + window \"as of <stamp>\" (no tool / path / asOf object, no extra key)",
      JSON.stringify(figs[0]) === JSON.stringify({ kind: "figure", text: "98,765", metric: "agg:probe_overview:open", window: "as of 2026-11-09 12:00 UTC" }), figs);
    check("…and the point-in-time note is stored with the notes", stored.notes.some((n) => /point-in-time reads/.test(n)));
    check("the V3 answer serialises and parses back unchanged", JSON.stringify(parseStoredAnswer(serializeStoredAnswer(stored))) === JSON.stringify(stored));
    const withSeg = (s: unknown, v = 3): unknown => ({ v, segments: [s], citations: [], notes: [], stop: "ANSWERED" });
    const r = (o: Record<string, unknown>) => ({ kind: "record", rk: "PROBE", rid: RID, a: "PLATFORM_OPS", ...o });
    check("refused: v on a ref / T2 segment, v that is not a closed shape (object, email-like, float, negative, long), v on V2",
      !isStoredAnswer(withSeg(r({ f: "ref", v: "OPEN" }))) && !isStoredAnswer(withSeg(r({ f: "name", v: "OPEN" }))) && !isStoredAnswer(withSeg(r({ f: "state", v: { a: 1 } })))
        && !isStoredAnswer(withSeg(r({ f: "state", v: "x@y.co" }))) && !isStoredAnswer(withSeg(r({ f: "attempts", v: 1.5 }))) && !isStoredAnswer(withSeg(r({ f: "attempts", v: -1 })))
        && !isStoredAnswer(withSeg(r({ f: "state", v: `A${"b".repeat(80)}` }))) && !isStoredAnswer(withSeg(r({ f: "state", v: "OPEN" }), 2)));
    check("accepted: a closed value on V3", isStoredAnswer(withSeg(r({ f: "state", v: "OPEN" }))) && isStoredAnswer(withSeg(r({ f: "attempts", v: 3 }))));
    const aggOnly = await turn(() => "Open probes: {{a:probe_overview|open}}.");
    check("an answer with aggregate figures only is stored as V1 (no version bump; a figure is a V1 segment)", storedAnswerOf(aggOnly.result, aggOnly.record).v === 1);
    const replay = replayAnswer(stored, new Date(AS_OF));
    check("history replay: no value (no 98,765 / 4,321 / stamp), the record as a kind marker, the aggregate as a re-read-with-its-tool marker",
      !/98|4,321|4321|2026-11-09 12:00/.test(replay.replace(/as of 2026-11-09T12:00Z/g, "")) && replay.includes("[probe]") && replay.includes("[figure from probe_overview, as of 2026-11-09T12:00Z, re-read it with probe_overview]"), replay);
    check("parseAggregateKey: agg keys only (a metric key is not one)", parseAggregateKey("agg:probe_overview:byState.OPEN")?.path === "byState.OPEN" && parseAggregateKey("incident-broken-now@1") === null);
  }

  console.log("\n9. B6 — fuzz: random placeholder text never yields a value the turn's tools did not return, never throws");
  {
    let seed = 0x09c0ffee;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const caps: AggregateCaptures = new Map();
    captureAggregateResult(caps, "probe_overview", PROBE_PATHS, { status: "CONFIRMED", asOf: AS_OF, open: 98765, byState: { OPEN: 3 }, worst: "OPEN", note: FREE_TEXT });
    const allowedTexts = new Set(["98,765", "3", "open", "2026-11-09 12:00 UTC"]);
    const H = "h_AAAAAAAAAAAAAAAB";
    const lookup = (h: string): TurnRecordRef | null => (h === H ? { rk: "PROBE", rid: RID, a: "PLATFORM_OPS", fields: ["ref", "name", "state", "attempts"], closed: { state: { type: "code", value: "OPEN" }, attempts: { type: "count", value: 4321 } } } : null);
    const frags = ["{{a:", "{{ a:", "{{r:", "}}", "|", "probe_overview", "incident_overview", "open", "byState.OPEN", "byState", "note", "__proto__", "constructor", "worst", "asOf",
      H, "h_AAAAAAAAAAAAAAAA", "state", "attempts", "name", "retried", "", "", "", "", "a", "b", " ", ".", "5", "{{", "{", "}", "labels.0", "-",
      "{{a:probe_overview|open}}", "{{a:probe_overview|note}}", "{{a:probe_overview|worst}}", "{{a:incident_overview|brokenNow}}", `{{r:${H}|state}}`, `{{r:${H}|retried}}`, `{{r:${H}|attempts}}`];
    let iterations = 0, problems = 0, resolvedTotal = 0;
    const why: string[] = [];
    const bad = (tag: string, s: string) => { problems++; if (why.length < 5) why.push(`${tag}: ${JSON.stringify(s)}`); };
    const sentinels = (t: string, re: RegExp) => (t.match(re) ?? []).length;
    for (let i = 0; i < 4000; i++) {
      const s = Array.from({ length: 2 + Math.floor(rnd() * 14) }, () => pick(frags)).join("");
      try {
        // As core.ts does: the model's own copies of every private sentinel are stripped first.
        const clean = s.replace(/[-]/g, "");
        const rec = extractRecordPlaceholders(clean, lookup);
        const ag = extractAggregatePlaceholders(rec.text, caps);
        iterations++;
        resolvedTotal += ag.spans.length + rec.spans.length;
        if (ag.spans.some((sp) => !allowedTexts.has(sp.text))) bad("aggregate fill not a captured value", s);
        if (rec.spans.some((sp) => sp.v !== undefined && sp.v !== "OPEN" && sp.v !== 4321)) bad("record value not a returned value", s);
        if (rec.spans.some((sp) => sp.f !== "ref" && sp.f !== "name" && sp.v === undefined)) bad("closed span without its value", s);
        // (record claims count WELL-FORMED placeholders only — the P4 rule; an aggregate claim counts every {{a:…}}, so resolved = claims − unresolved exactly)
        if (ag.unresolved + ag.spans.length !== ag.claims || rec.spans.length > rec.claims) bad("claims", s);
        if (sentinels(ag.text, /[a-t]/g) !== ag.spans.length) bad("aggregate sentinel count ≠ spans (an orphan or a forged one)", s);
        if (ag.text.includes(FREE_TEXT)) bad("free text", s);
      } catch { bad("threw", s); }
    }
    check(`4000 random strings: never throws; every fill is a captured value; claims add up; one sentinel per fill (${resolvedTotal} fills)`, problems === 0 && iterations === 4000 && resolvedTotal > 50, { problems, resolvedTotal, why });

    // Turn-level fuzz: the whole pipeline (sanitiser, digit rule, verdicts, expansion) over random answers.
    let turnProblems = 0, kept = 0;
    const tfrags = ["{{a:probe_overview|open}}", "{{a:probe_overview|note}}", "{{a:probe_overview|byState.OPEN}}", "{{r:H|state}}", "{{r:H|attempts}}", "{{r:H|retried}}", "{{r:H|ref}}",
      "{{a:incident_overview|brokenNow}}", " probes ", " and ", "\uE006a\uE007", "\uE002a\uE003", "{{inferred}}maybe{{/inferred}}", " 7 ", "seven", "OPEN", ".", "{{a:", "}}"];
    for (let i = 0; i < 120; i++) {
      const parts = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => pick(tfrags));
      const r = await turn((h) => parts.join("").replace(/\{\{r:H\|/g, `{{r:${h}|`));
      const t = display(r);
      if (/[\uE000-\uE00F]/.test(t)) turnProblems++;
      if (t.includes(FREE_TEXT)) turnProblems++;
      if (!r.result.grounding.replaced) {
        kept++;
        const figTexts = r.record.typed.filter((x) => x.kind === "figure").map((x) => x.text);
        if (figTexts.some((x) => !allowedTexts.has(x))) turnProblems++;
        // B4: with every server fill removed, no digit is left in the model's own words.
        let rest = t;
        for (const f of figTexts) rest = rest.replace(f, " ");
        if (/\d/.test(rest)) turnProblems++;
      }
    }
    check(`120 random answers through the whole turn: no private char, no unreturned text, fills are captured values, no model digit survives (${kept} kept)`, turnProblems === 0 && kept > 5, { turnProblems, kept });
  }

  console.log("\n10. codeWords / formatting are server code over closed values");
  check("codeWords", codeWords("NEEDS_REAUTH") === "needs reauth" && codeWords("firstConnection") === "first connection" && codeWords("stale-unverified") === "stale unverified");
  check("formatClosedValue refuses anything that is not its type", formatClosedValue("count", "5") === null && formatClosedValue("isoTime", "2026-11-09") === null && formatClosedValue("code", "x y") === null && formatClosedValue("count", 1234567) === "1,234,567");

  if (failures) { console.error(`\n${failures} check(s) failed, ${passed} passed`); process.exit(1); }
  console.log(`\nall ${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
