/**
 * lib/platform/intelligence/ai/eval/live/cases.test.ts  (Platform AI E0-LIVE — case-catalogue integrity)
 *
 * Pins design E0-LIVE v1 §4 under S2 09ec (R-3, R-7), 09gs and 09gt:
 *   · exactly 50 turns per PA-1 pack; unique ids; plants ⊆ the fixture's payload columns;
 *   · every expected fact id exists in scripts/e0-live/fixture-spec.ts (expectedFacts ∪ LIVE_ONLY_FACTS);
 *   · no fixture identity (sentinel names, e-mail / cuid shapes, E0-CI T2 sentinels) and no real
 *     institution name (the fixture-institution census) anywhere in the catalogue;
 *   · the tool → tier map equals the pack contracts;
 *   · every non-ciOnly case with an oracle names an EXISTING guarded route under app/api, read as the
 *     same operator and session, whose guard area matches the declared tier, which matches the case's
 *     pack audience; R-7: no live case expects a CS list tool.
 * No database, no network, no env.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/eval/live/cases.test.ts
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  LIVE_CASES, LIVE_TOOL_TIER, PA1_PACKS, PLACEHOLDER, TURNS_PER_PACK, isCiOnly, operatorTier, turnCounts,
  type LiveCase, type LiveTool,
} from "./cases";
import { E0_T2_SENTINELS } from "../fixtures";
import { expectedFacts, LIVE_ONLY_FACTS, PAYLOAD_COLUMNS, SENTINEL_FIRST, SENTINEL_LAST } from "@/scripts/e0-live/fixture-spec";
import { customersPackTools } from "../../tools/packs/customers";
import { incidentsPackTools } from "../../tools/packs/incidents";
import { onboardingPackTools } from "../../tools/packs/onboarding";
import { connectionsPackTools } from "../../tools/packs/connections";

let failures = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
const ROOT = process.cwd();
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

console.log("\ne0-live cases — shape\n");
const counts = turnCounts();
for (const p of PA1_PACKS) check(`${p}: exactly ${TURNS_PER_PACK} turns`, counts[p]?.total === TURNS_PER_PACK, counts[p]);
check("suite R present (rev operator only)", LIVE_CASES.some((c) => c.pack === "revocation") && LIVE_CASES.filter((c) => c.pack === "revocation").every((c) => c.operator === "rev" && (c.attempts ?? 0) > 0));
check("rev operator only in suite R", LIVE_CASES.filter((c) => c.operator === "rev").every((c) => c.pack === "revocation"));
const ids = LIVE_CASES.map((c) => c.id);
check("case ids are unique", new Set(ids).size === ids.length, ids.filter((x, i) => ids.indexOf(x) !== i));
check("case ids follow L.<pack>.…", ids.every((x) => /^L\.(cust|inc|onb|conn|rev)\.[A-Za-z0-9.-]+$/.test(x)));
check("every case has ≥1 turn and ≥1 gate", LIVE_CASES.every((c) => c.turns.length > 0 && c.gates.length > 0));
check("every case carries the leak + injection gates", LIVE_CASES.every((c) => c.gates.includes("IDENTITY_LEAK") && c.gates.includes("INJECTION_CONTAINMENT")));
check("plants ⊆ the fixture payload columns", LIVE_CASES.every((c) => (c.plants ?? []).every((p) => (PAYLOAD_COLUMNS as readonly string[]).includes(p))));
check("expected tools are known pack tools", LIVE_CASES.every((c) => c.expectedTools.every((t) => t in LIVE_TOOL_TIER)));
check("subjectLookups is a non-negative integer", LIVE_CASES.every((c) => Number.isInteger(c.subjectLookups) && c.subjectLookups >= 0));

console.log("\ne0-live cases — fact ids and refusals\n");
const FACT_IDS = new Set([...expectedFacts().map((f) => f.id), ...LIVE_ONLY_FACTS.map((f) => f.id)]);
const factIdOf = (c: LiveCase) => (c.expected.kind === "fact" ? c.expected.factId : c.expected.kind === "refusal" ? c.expected.factId : undefined);
const missingFacts = LIVE_CASES.filter((c) => { const f = factIdOf(c); return f !== undefined && !FACT_IDS.has(f); }).map((c) => c.id);
check("every expected fact id exists in fixture-spec (expectedFacts ∪ LIVE_ONLY_FACTS)", missingFacts.length === 0, missingFacts);
check("every refusal expectation names ≥1 code", LIVE_CASES.every((c) => c.expected.kind !== "refusal" || c.expected.codes.length > 0));
check("an adversarial (no-oracle) case never expects a fact", LIVE_CASES.every((c) => c.oracle.kind !== "none" || c.expected.kind !== "fact"));
check("a live fact case has a guarded-route oracle", LIVE_CASES.every((c) => c.expected.kind !== "fact" || c.oracle.kind !== "none"));
check("causal: CONFIRMED carries its code; others do not", LIVE_CASES.every((c) => !c.causal || (c.causal.status === "CONFIRMED") === (c.causal.code !== undefined)));

console.log("\ne0-live cases — no identities, no real institution names\n");
const blob = JSON.stringify(LIVE_CASES);
const src = read("lib/platform/intelligence/ai/eval/live/cases.ts");
const placeholders = [...blob.matchAll(PLACEHOLDER)];
const badKeys = placeholders.filter((m) => m[2] && !/^C(0[1-9]|[12]\d|30)$/.test(m[2])).map((m) => m[0]);
check("placeholders use fixture keys C01–C30 only", placeholders.length > 0 && badKeys.length === 0, badKeys);
const stray = blob.replace(PLACEHOLDER, "").match(/\{[A-Za-z]+(:[^}]*)?\}/g) ?? [];
check("no unknown placeholder", stray.length === 0, stray);
const sentinelHits = [...SENTINEL_FIRST, ...SENTINEL_LAST, ...E0_T2_SENTINELS].filter((s) => (blob + src).toLowerCase().includes(s.toLowerCase()));
check("no fixture / E0-CI sentinel name, e-mail or id in the catalogue", sentinelHits.length === 0, sentinelHits);
check("no e-mail shape", !/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(blob));
check("no cuid / uuid shape", !/\bc[a-z0-9]{24}\b/.test(blob) && !/\b[0-9a-f]{8}-[0-9a-f]{4}-/i.test(blob));
check("no run tag / nonce / injection marker in the catalogue", !/fm-e0-live-\d|E0LINJ-|e0l\.\d/.test(blob + src));
const census = read("scripts/fixture-institution-census.test.ts");
const listOf = (name: string) => {
  const body = new RegExp(`const ${name}: readonly string\\[\\] = \\[([\\s\\S]*?)\\];`).exec(census)?.[1] ?? "";
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
};
const REAL = [...listOf("INSTITUTION_NAMES"), ...listOf("CARD_PRODUCT_NAMES")];
check("the census lists were read (sanity)", REAL.length > 50, REAL.length);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const realHits = REAL.filter((n) => [n, n.toUpperCase()].some((v) => new RegExp(`(^|[^A-Za-z0-9_])${esc(v)}($|[^A-Za-z0-9_])`).test(blob + src)));
check("census: no real institution / card-product name in the catalogue", realHits.length === 0, realHits);

console.log("\ne0-live cases — tool tiers equal the pack contracts\n");
const stub = {} as never;
const contracts = [...customersPackTools(stub), ...incidentsPackTools(stub), ...onboardingPackTools(stub), ...connectionsPackTools(stub)];
const contractTier = new Map(contracts.map((t) => [t.name, t.requires.tier === "OPS" ? "OPS" : "CS"]));
const tierMismatch = Object.entries(LIVE_TOOL_TIER).filter(([n, t]) => contractTier.get(n) !== t).map(([n]) => n);
check("LIVE_TOOL_TIER matches every pack tool's requires.tier", tierMismatch.length === 0, tierMismatch);
check("every PA-1 pack tool is in LIVE_TOOL_TIER", [...contractTier.keys()].every((n) => n in LIVE_TOOL_TIER), [...contractTier.keys()].filter((n) => !(n in LIVE_TOOL_TIER)));

console.log("\ne0-live cases — oracles via guarded routes only (R-3, 09gs, 09gt)\n");
const AREA_OF = { CS: "CUSTOMER_SUCCESS", OPS: "PLATFORM_OPS" } as const;
const CS_LISTS: ReadonlySet<LiveTool> = new Set(["list_customer_attention", "list_recently_joined", "list_incidents_cs", "list_onboarding_attention"]);
const oracleProblems: string[] = [];
for (const c of LIVE_CASES) {
  const o = c.oracle;
  if (o.kind === "ci-only" || o.kind === "none") {
    if (!o.reason.trim()) oracleProblems.push(`${c.id}: ${o.kind} without a reason`);
    continue;
  }
  if (!o.route.startsWith("app/api/") || !o.route.endsWith("/route.ts")) { oracleProblems.push(`${c.id}: route is not an app/api route file`); continue; }
  if (!existsSync(path.join(ROOT, o.route))) { oracleProblems.push(`${c.id}: route file does not exist`); continue; }
  if (o.method !== "GET") oracleProblems.push(`${c.id}: oracle is not a GET`);
  if (o.oracleAuth !== "same-operator-session") oracleProblems.push(`${c.id}: oracle not read as the same operator + session`);
  if (o.fields.length === 0) oracleProblems.push(`${c.id}: no oracle field`);
  const body = read(o.route);
  const getAt = body.indexOf("export async function GET");
  const getBody = getAt >= 0 ? body.slice(getAt) : "";
  const guard = /require(?:Fresh)?PlatformAccess\(\s*"([A-Z_]+)"\s*,\s*"READ"\s*\)/.exec(getBody);
  if (!guard) oracleProblems.push(`${c.id}: the route's GET has no requirePlatformAccess / requireFreshPlatformAccess guard`);
  else if (guard[1] !== AREA_OF[o.tier]) oracleProblems.push(`${c.id}: declared tier ${o.tier} but the route guards ${guard[1]}`);
  const opTier = operatorTier(c.operator);
  if (opTier !== "BOTH" && opTier !== o.tier) oracleProblems.push(`${c.id}: oracle tier ${o.tier} ≠ the operator's tier ${opTier}`);
  const packTier = c.expectedTools.length ? LIVE_TOOL_TIER[c.expectedTools[0]] : null;
  if (packTier !== o.tier) oracleProblems.push(`${c.id}: oracle tier ${o.tier} ≠ the pack audience ${packTier}`);
  for (const [k, v] of Object.entries(o.params ?? {})) {
    if (!o.route.includes(`[${k}]`)) oracleProblems.push(`${c.id}: param ${k} is not a segment of the route`);
    if (!new RegExp(PLACEHOLDER.source).test(v)) oracleProblems.push(`${c.id}: param ${k} is not a fixture placeholder`);
  }
  const dynamic = [...o.route.matchAll(/\[([A-Za-z]+)\]/g)].map((m) => m[1]);
  if (!dynamic.every((d) => o.params && d in o.params)) oracleProblems.push(`${c.id}: a dynamic route segment has no param`);
}
check("every non-ciOnly oracle is an existing guarded app/api route, same operator + session, tier = guard area = pack audience", oracleProblems.length === 0, oracleProblems);
const liveCsLists = LIVE_CASES.filter((c) => !isCiOnly(c) && c.expectedTools.some((t) => CS_LISTS.has(t))).map((c) => c.id);
check("R-7: no live case expects a CS list tool", liveCsLists.length === 0, liveCsLists);
check("an Ops-operator case never expects a CS-tier tool", LIVE_CASES.every((c) => c.operator !== "ops" || c.expectedTools.every((t) => LIVE_TOOL_TIER[t] === "OPS")));
check("a CS-operator live case with an e-mail placeholder spends ≥1 subject lookup",
  LIVE_CASES.every((c) => c.operator !== "cs" || isCiOnly(c) || !c.turns.some((t) => /\{email:/.test(t)) || c.subjectLookups >= 1));

console.log("\ne0-live cases — counts (turns; codes only)\n");
for (const [p, n] of Object.entries(counts)) console.log(`  ${p.padEnd(12)} total=${n.total} live=${n.live} ciOnly=${n.ciOnly}`);
console.log("  ciOnly cases:");
for (const c of LIVE_CASES.filter(isCiOnly)) console.log(`    ${c.id} (${c.turns.length} turn) — ${c.oracle.kind === "ci-only" ? c.oracle.reason : ""}`);

if (failures) { console.error(`\n${failures} check(s) failed, ${passed} passed`); process.exit(1); }
console.log(`\nall ${passed} checks passed`);
