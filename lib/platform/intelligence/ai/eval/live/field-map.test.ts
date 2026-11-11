/**
 * lib/platform/intelligence/ai/eval/live/field-map.test.ts  (Platform AI E0-LIVE — the figure-to-field mapping, S2 09hu G2)
 *
 * Pins field-map.ts against cases.ts, the guarded routes and the pack contracts:
 *   · completeness: every guarded (case, oracle field) × every expected tool has exactly one entry;
 *   · every route exists; every MAPPED record field exists in that tool's record schema (same record kind);
 *     every MAPPED aggregate path exists in that tool's result shape (the pack's own mapper over a sample);
 *   · every copied vocabulary equals the pack's own (CLOSED_CODE entries against the record schema);
 *   · the per-pack mapped / unmapped counts and the UNMAPPED list (printed; totals pinned so a change is deliberate);
 *   · field-map.ts is pure and served code never imports eval/live.
 * No database, no network, no env.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/eval/live/field-map.test.ts
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { LIVE_CASES, PA1_PACKS } from "./cases";
import {
  CONNECTION_ERROR_CODES, CONNECTION_STATUS_CODES, FUNNEL_STAGE_KEY_OF_LABEL, IMPORT_HEALTH_CODES, INCIDENT_PROVIDER_CODES, INCIDENT_STATE_CODES,
  LIVE_FIELD_MAP, ROUTE, guardedFacts, oracleKeyFor, projectOracle,
} from "./field-map";
import { PLATFORM_AI_TOOL_REGISTRY } from "../../tools/registry";
import { FUNNEL_STAGE_LABELS } from "@/lib/platform/growth/product-analytics-core";
import { stageKeyOf } from "../../tools/packs/customers";
import { CONNECTION_ERROR_CODES as PACK_CONNECTION_ERROR_CODES, CUSTOMER_CONNECTION_SCHEMA, overviewOfHealth } from "../../tools/packs/connections";
import { INCIDENT_LIST_SCHEMA } from "../../tools/packs/incidents";
import { ONBOARDING_TIMELINE_SCHEMA, importsOf } from "../../tools/packs/onboarding";

let failures = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
const root = process.cwd();
const read = (f: string) => readFileSync(path.join(root, f), "utf8");
const valuesOf = (schema: { fields: Record<string, unknown> }, f: string) => (schema.fields[f] as { values?: readonly string[] } | undefined)?.values ?? null;
const same = (a: readonly unknown[] | null, b: readonly unknown[] | null) => JSON.stringify(a) === JSON.stringify(b);

const guarded = LIVE_CASES.filter((c) => c.oracle.kind === "guarded-route");
/** Guarded facts per pack (one per (case, oracle field)): MAPPED / UNMAPPED. */
const EXPECTED_COUNTS: Record<string, { mapped: number; unmapped: number }> = {
  customers: { mapped: 12, unmapped: 17 },
  incidents: { mapped: 34, unmapped: 15 },
  onboarding: { mapped: 38, unmapped: 5 },
  connections: { mapped: 28, unmapped: 10 },
};

console.log("\nG2 — completeness and shape\n");
{
  const missing: string[] = [];
  for (const c of guarded) {
    if (c.oracle.kind !== "guarded-route") continue;
    for (const field of c.oracle.fields) for (const tool of c.expectedTools) {
      const n = LIVE_FIELD_MAP.filter((e) => e.route === (c.oracle as { route: string }).route && e.field === field && e.tool === tool).length;
      if (n !== 1) missing.push(`${c.id} ${field} ${tool} ×${n}`);
    }
  }
  check(`every guarded (case, field) × expected tool has exactly ONE entry (${guarded.length} guarded cases)`, missing.length === 0, missing);
  const keys = LIVE_FIELD_MAP.map((e) => `${e.route}|${e.field}|${e.tool}`);
  check("no duplicate (route, field, tool) entry", new Set(keys).size === keys.length);
  const used = new Set(guarded.flatMap((c) => c.oracle.kind === "guarded-route" ? c.oracle.fields.flatMap((f) => c.expectedTools.map((t) => `${(c.oracle as { route: string }).route}|${f}|${t}`)) : []));
  check("no dead entry (every entry is used by a guarded case)", keys.every((k) => used.has(k)), keys.filter((k) => !used.has(k)));
  check("every route path is one of ROUTE and its file exists", LIVE_FIELD_MAP.every((e) => (Object.values(ROUTE) as string[]).includes(e.route) && existsSync(path.join(root, e.route))));
  check("every guarded case's route is in ROUTE (the same paths as cases.ts)", guarded.every((c) => (Object.values(ROUTE) as string[]).includes((c.oracle as { route: string }).route)));
  check("every UNMAPPED entry states a reason", LIVE_FIELD_MAP.every((e) => e.status === "MAPPED" || e.reason.length > 10));
}

console.log("\nG2 — MAPPED sources exist in the tool contracts\n");
{
  const bad: string[] = [];
  for (const e of LIVE_FIELD_MAP) {
    if (e.status !== "MAPPED") continue;
    const tool = PLATFORM_AI_TOOL_REGISTRY.find((t) => t.name === e.tool);
    if (!tool) { bad.push(`${e.tool}: not registered`); continue; }
    if (e.source.kind === "record") {
      const schema = tool.recordSchema;
      if (tool.scope !== "RECORD" || !schema) { bad.push(`${e.tool}: not a RECORD tool`); continue; }
      if (schema.kind !== e.source.recordKind) bad.push(`${e.tool}: kind ${schema.kind} ≠ ${e.source.recordKind}`);
      if (!Object.prototype.hasOwnProperty.call(schema.fields, e.source.field)) bad.push(`${e.tool}.${e.source.field}: not a record field`);
      if (e.compare === "CLOSED_CODE" && !same(e.vocabulary ?? null, valuesOf(schema, e.source.field))) bad.push(`${e.tool}.${e.source.field}: vocabulary differs from the record schema`);
      if (e.compare === "CLOSED_CODE" && !(e.vocabulary ?? []).includes(String(e.fallback))) bad.push(`${e.tool}.${e.source.field}: fallback not in the vocabulary`);
    } else if (tool.scope !== "AGGREGATE") bad.push(`${e.tool}: an aggregate path on a ${tool.scope} tool`);
  }
  check("every MAPPED record field is a field of that tool's record schema (same kind); CLOSED_CODE vocabularies equal the schema's", bad.length === 0, bad);

  // Aggregate paths exist in the tool's real result shape (the pack's own mappers over a sample).
  const at = (o: unknown, p: string) => p.split(".").reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), o);
  const health = overviewOfHealth({
    total: 3, counts: { HEALTHY: 1, STALE: 0, DEGRADED: 0, NEEDS_REAUTH: 1, ERROR: 1, REVOKED: 0 }, unhealthy: [], checkedAt: "2026-11-12T00:00:00.000Z", cap: 50, listedScope: "unhealthy",
    retired: { revoked: 1, ownerInactive: 0 },
    bySource: { PLAID: { active: 2, revoked: 0, faults: [] }, WALLET: { active: 1, revoked: 1, faults: [] } },
  } as unknown as Parameters<typeof overviewOfHealth>[0], new Map());
  const imports = { imports: importsOf({ windowDays: 7, started: 2, byStatus: { complete: 2 }, failedReasons: {}, interruptedInProgress: 0, floor: false } as unknown as Parameters<typeof importsOf>[0]) };
  const sample: Record<string, unknown> = { connection_health_overview: health, onboarding_overview: imports };
  const missingPaths: string[] = [];
  for (const e of LIVE_FIELD_MAP) {
    if (e.status !== "MAPPED" || e.source.kind !== "aggregate") continue;
    if (at(sample[e.tool], e.source.path) === undefined) missingPaths.push(`${e.tool}:${e.source.path}`);
  }
  check("every MAPPED aggregate path exists in that tool's result (overviewOfHealth / importsOf over a sample)", missingPaths.length === 0, missingPaths);
}

console.log("\nG2 — copied vocabularies equal the packs'\n");
{
  check("FUNNEL_STAGE_KEY_OF_LABEL inverts FUNNEL_STAGE_LABELS and agrees with stageKeyOf",
    Object.entries(FUNNEL_STAGE_LABELS).every(([k, l]) => FUNNEL_STAGE_KEY_OF_LABEL[l] === k && stageKeyOf(l) === k) && Object.keys(FUNNEL_STAGE_KEY_OF_LABEL).length === Object.keys(FUNNEL_STAGE_LABELS).length);
  check("CONNECTION_STATUS_CODES = the CONNECTION record's status values", same(CONNECTION_STATUS_CODES, valuesOf(CUSTOMER_CONNECTION_SCHEMA, "status")));
  check("CONNECTION_ERROR_CODES = connections.ts CONNECTION_ERROR_CODES", same(CONNECTION_ERROR_CODES, PACK_CONNECTION_ERROR_CODES));
  check("CONNECTION_ERROR_CODES = the CONNECTION record's errorCode values", same(CONNECTION_ERROR_CODES, valuesOf(CUSTOMER_CONNECTION_SCHEMA, "errorCode")));
  check("INCIDENT_STATE_CODES / INCIDENT_PROVIDER_CODES = the INCIDENT record's values", same(INCIDENT_STATE_CODES, valuesOf(INCIDENT_LIST_SCHEMA, "state")) && same(INCIDENT_PROVIDER_CODES, valuesOf(INCIDENT_LIST_SCHEMA, "provider")));
  check("IMPORT_HEALTH_CODES = the timeline record's importHealth values", same(IMPORT_HEALTH_CODES, valuesOf(ONBOARDING_TIMELINE_SCHEMA, "importHealth")));
  check("CAUSE_STATUS projection = incidents.ts causeStatusOf (null / other ⇒ NONE)",
    projectOracle({ compare: "CAUSE_STATUS" }, null) === "NONE" && projectOracle({ compare: "CAUSE_STATUS" }, "HYPOTHESIS") === "HYPOTHESIS" && projectOracle({ compare: "CAUSE_STATUS" }, "SOMETHING") === "NONE");
  check("ALLOWLISTED_CODE projection: allowlisted ⇒ itself, unknown ⇒ OTHER, none ⇒ null",
    projectOracle({ compare: "ALLOWLISTED_CODE" }, "ITEM_LOGIN_REQUIRED") === "ITEM_LOGIN_REQUIRED" && projectOracle({ compare: "ALLOWLISTED_CODE" }, "WHATEVER_ELSE") === "OTHER" && projectOracle({ compare: "ALLOWLISTED_CODE" }, "") === null);
}

console.log("\nG2 — the runner's matcher (oracleKeyFor)\n");
{
  const chain = LIVE_CASES.find((c) => c.id === "L.cust.chain.C17")!;
  check("a CONNECTION record's healthState in a profile → connections chain maps to connections[].healthState",
    oracleKeyFor(chain, { tool: "get_customer_connections", recordKind: "CONNECTION", field: "healthState" }) === "connections[].healthState");
  check("…the profile tool itself places no such field (UNMAPPED there) ⇒ null",
    oracleKeyFor(chain, { tool: "get_customer_profile", recordKind: "CUSTOMER", field: "brokenConnections" }) === null);
  const fleet = LIVE_CASES.find((c) => c.id === "L.conn.fleet.1")!;
  check("an aggregate sub-key keeps its suffix under the mapped object field (byHealth.ERROR ↦ counts.ERROR)",
    oracleKeyFor(fleet, { tool: "connection_health_overview", path: "byHealth.ERROR" }) === "counts.ERROR");
  check("a record id field can never be matched (no source carries one)", !LIVE_FIELD_MAP.some((e) => e.status === "MAPPED" && e.source.kind === "record" && /id$|Id$|ref$/.test(e.source.field)));
}

console.log("\nG2 — per-pack mapped / unmapped report\n");
{
  const facts = guarded.flatMap((c) => guardedFacts(c));
  const byPack: Record<string, { mapped: number; unmapped: number }> = {};
  for (const p of PA1_PACKS) byPack[p] = { mapped: 0, unmapped: 0 };
  for (const f of facts) { const b = (byPack[f.pack] ??= { mapped: 0, unmapped: 0 }); if (f.status === "MAPPED") b.mapped++; else b.unmapped++; }
  console.log(`    facts by pack: ${JSON.stringify(byPack)}`);
  const unmappedList = [...new Set(facts.filter((f) => f.status === "UNMAPPED").map((f) => `${f.pack} ${f.field} [${f.caseId}]`))];
  for (const u of unmappedList) console.log(`    UNMAPPED ${u}`);
  check("one fact per guarded (case, oracle field)", facts.length === guarded.reduce((a, c) => a + (c.oracle.kind === "guarded-route" ? c.oracle.fields.length : 0), 0));
  check("pinned per-pack counts (a change to the mapping or the cases is deliberate)", JSON.stringify(byPack) === JSON.stringify(EXPECTED_COUNTS), byPack);
}

console.log("\nG2 — purity and isolation\n");
{
  const src = read("lib/platform/intelligence/ai/eval/live/field-map.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("field-map.ts is pure: no fs / env / db / network / clock / server-only, and no pack import",
    !/from "node:|require\(|process\.env|prisma|fetch\(|Date\.now|new Date\(\)|"server-only"|tools\/packs/.test(src) && (src.match(/^import /gm) ?? []).length === 1);
  const offenders: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (n === "node_modules" || n.startsWith(".")) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) && !p.includes(`${path.sep}eval${path.sep}`) && /eval\/live/.test(readFileSync(p, "utf8"))) offenders.push(path.relative(root, p));
    }
  };
  for (const d of ["app", "lib", "components"]) walk(path.join(root, d));
  check("no served (non-test, non-eval) file imports eval/live", offenders.length === 0, offenders);
}

if (failures) { console.error(`\n${failures} check(s) failed, ${passed} passed`); process.exit(1); }
console.log(`\nall ${passed} checks passed`);
