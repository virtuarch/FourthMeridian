/**
 * lib/platform/intelligence/ai/eval/live/cases.test.ts  (Platform AI E0-LIVE — case-catalogue integrity)
 *
 * Pins design E0-LIVE v1 §4 under S2 09ec (R-3, R-7), 09gs and 09gt:
 *   · S2 09ha Q1: ≥50 LIVE cases per PA-1 pack, ≤3 live cases per distinct fact (no padding by
 *     rephrasing), the ciOnly turns unchanged; unique ids; plants ⊆ the fixture's payload columns;
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
  CI_ONLY_TURNS, LIVE_CASES, LIVE_CASES_MIN_PER_PACK, LIVE_TOOL_TIER, MAX_LIVE_CASES_PER_FACT, PA1_PACKS, PLACEHOLDER, SERVER_TIER_OF, liveTierOf,
  distinctFactKey, formatGlobalFactLine, isCiOnly, liveGlobalFactReport, livePackCounts, operatorTier, turnCounts, type LiveCase, type LiveTool,
} from "./cases";
import { E0_T2_SENTINELS } from "../fixtures";
import { expectedFacts, LIVE_ONLY_FACTS, PAYLOAD_COLUMNS, SENTINEL_FIRST, SENTINEL_LAST } from "@/scripts/e0-live/fixture-spec";
import { customersPackTools } from "../../tools/packs/customers";
import { incidentsPackTools } from "../../tools/packs/incidents";
import { onboardingPackTools } from "../../tools/packs/onboarding";
import { connectionsPackTools } from "../../tools/packs/connections";
import { TOOL_TIERS } from "../../tools/contract";

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
const packs = livePackCounts();
for (const p of PA1_PACKS) {
  check(`${p}: ≥${LIVE_CASES_MIN_PER_PACK} live cases (S2 09ha Q1)`, (packs[p]?.liveCases ?? 0) >= LIVE_CASES_MIN_PER_PACK, packs[p]);
  check(`${p}: ≥${LIVE_CASES_MIN_PER_PACK} live turns`, (counts[p]?.live ?? 0) >= LIVE_CASES_MIN_PER_PACK, counts[p]);
  check(`${p}: ciOnly turns unchanged (${CI_ONLY_TURNS[p]})`, counts[p]?.ciOnly === CI_ONLY_TURNS[p], counts[p]);
  check(`${p}: total turns = live + ciOnly`, counts[p]?.total === (counts[p]?.live ?? 0) + (counts[p]?.ciOnly ?? 0), counts[p]);
}
check("ciOnly turns total 40 (09ha Q1)", PA1_PACKS.reduce((n, p) => n + (counts[p]?.ciOnly ?? 0), 0) === 40);
check("every ciOnly case is single-turn", LIVE_CASES.filter(isCiOnly).every((c) => c.turns.length === 1));
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

console.log("\ne0-live cases — ≤3 live cases per distinct fact (S2 09ha Q1)\n");
const overCap: string[] = [];
for (const p of PA1_PACKS) {
  const tally = new Map<string, string[]>();
  for (const c of LIVE_CASES.filter((x) => x.pack === p && !isCiOnly(x))) tally.set(distinctFactKey(c), [...(tally.get(distinctFactKey(c)) ?? []), c.id]);
  for (const [, cs] of tally) if (cs.length > MAX_LIVE_CASES_PER_FACT) overCap.push(cs.join(" + "));
  check(`${p}: ≤${MAX_LIVE_CASES_PER_FACT} live cases per distinct fact`, (packs[p]?.maxLiveCasesPerFact ?? 0) <= MAX_LIVE_CASES_PER_FACT, packs[p]);
}
check("no distinct fact over the cap (case ids)", overCap.length === 0, overCap);

console.log("\ne0-live cases — GLOBAL fact line (S2 09hc; information, not a gate)\n");
const globalReport = liveGlobalFactReport();
const pa1Live = LIVE_CASES.filter((c) => (PA1_PACKS as readonly string[]).includes(c.pack) && !isCiOnly(c));
check("global: live cases = the PA-1 live cases (suite R excluded)", globalReport.liveCases === pa1Live.length && globalReport.liveCases === PA1_PACKS.reduce((n, p) => n + (packs[p]?.liveCases ?? 0), 0));
check("global: distinct live facts = distinct keys over all PA-1 live cases", globalReport.distinctLiveFacts === new Set(pa1Live.map(distinctFactKey)).size);
check("global: distinct overall ≤ Σ per-pack distinct (a fact reused across packs counts once)",
  globalReport.distinctLiveFacts <= PA1_PACKS.reduce((n, p) => n + (packs[p]?.distinctLiveFacts ?? 0), 0));
check("global: every listed fact is used >3× globally, with its case ids and packs", globalReport.overused.every((o) =>
  o.uses > MAX_LIVE_CASES_PER_FACT && o.caseIds.length === o.uses && o.caseIds.every((id) => pa1Live.some((c) => c.id === id && distinctFactKey(c) === o.factKey))
  && o.packs.length > 0 && o.packs.every((p) => o.caseIds.some((id) => pa1Live.find((c) => c.id === id)?.pack === p))));
check("global: every fact used >3× globally is listed (none missed)", (() => {
  const tally = new Map<string, number>();
  for (const c of pa1Live) tally.set(distinctFactKey(c), (tally.get(distinctFactKey(c)) ?? 0) + 1);
  return [...tally].filter(([, n]) => n > MAX_LIVE_CASES_PER_FACT).length === globalReport.overused.length;
})());
check("global: a fact reused across two packs >3× is listed, while each pack stays under the per-pack cap", (() => {
  const base = pa1Live.find((c) => c.oracle.kind === "guarded-route");
  if (!base) return false;
  const synth: LiveCase[] = (["customers", "connections"] as const).flatMap((pack) => [1, 2].map((i) => ({ ...base, id: `L.x.${pack}.${i}`, pack })));
  const r = liveGlobalFactReport(synth);
  return r.liveCases === 4 && r.distinctLiveFacts === 1 && r.overused.length === 1 && r.overused[0].uses === 4
    && r.overused[0].packs.join() === "connections,customers" && /facts used >3× globally: 1 — /.test(formatGlobalFactLine(r));
})());
check("global: ciOnly and suite-R cases are not counted", (() => {
  const ci = LIVE_CASES.find(isCiOnly);
  const rev = LIVE_CASES.find((c) => c.pack === "revocation");
  return !!ci && !!rev && liveGlobalFactReport([ci, rev]).liveCases === 0 && /facts used >3× globally: 0$/.test(formatGlobalFactLine(liveGlobalFactReport([ci, rev])));
})());
check("global: the line carries no fixture identity (codes and placeholders only)", (() => {
  const line = formatGlobalFactLine(globalReport);
  return !/@|\bc[a-z0-9]{24}\b|[0-9a-f]{8}-[0-9a-f]{4}-/.test(line);
})());
check("global: the line carries NO fact key (S2 09hu G8: keys only in the private RUN-LOG), but every over-used case id", (() => {
  const line = formatGlobalFactLine(globalReport);
  return globalReport.overused.every((o) => !line.includes(o.factKey) && o.caseIds.every((id) => line.includes(id)))
    && !/\b(fact|probe):|app\/api\//.test(line);
})());
check("distinctFactKey: rephrasing the same oracle read is the same fact", (() => {
  const a = LIVE_CASES.find((c) => c.oracle.kind === "guarded-route");
  return !!a && distinctFactKey({ ...a, id: "L.x.y", turns: ["a different phrasing"] }) === distinctFactKey(a);
})());
check("distinctFactKey: another subject or another field is another fact", (() => {
  const a = LIVE_CASES.find((c) => c.oracle.kind === "guarded-route" && !!c.oracle.params);
  if (!a || a.oracle.kind !== "guarded-route") return false;
  const otherSubject = { ...a, oracle: { ...a.oracle, params: { ...Object.fromEntries(Object.keys(a.oracle.params ?? {}).map((k) => [k, "{userId:C30}"])) } } };
  const otherField = { ...a, oracle: { ...a.oracle, fields: [...a.oracle.fields, "checkedAt"] } };
  return distinctFactKey(otherSubject) !== distinctFactKey(a) && distinctFactKey(otherField) !== distinctFactKey(a);
})());
check("distinctFactKey: an adversarial probe keys on its refs, plants and outcome — not its wording", (() => {
  const a = LIVE_CASES.find((c) => c.oracle.kind === "none" && c.pack !== "revocation");
  return !!a && distinctFactKey({ ...a, turns: [a.turns[0] + " Please."] }) === distinctFactKey(a);
})());

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
// S2 09jr: the server tier is canonical; the catalogue's short form maps strictly (an unknown server tier ⇒ null ⇒ a mismatch).
const contractTier = new Map(contracts.map((t) => [t.name, liveTierOf(t.requires.tier)]));
check("liveTierOf / SERVER_TIER_OF: OPS ↔ OPS, CUSTOMER_SUCCESS ↔ CS, both ways; anything else ⇒ null",
  liveTierOf("OPS") === "OPS" && liveTierOf("CUSTOMER_SUCCESS") === "CS" && liveTierOf("CS") === null && liveTierOf("cs") === null && liveTierOf(undefined) === null
    && SERVER_TIER_OF.CS === "CUSTOMER_SUCCESS" && SERVER_TIER_OF.OPS === "OPS" && (["OPS", "CS"] as const).every((t) => liveTierOf(SERVER_TIER_OF[t]) === t));
check("SERVER_TIER_OF's values are EXACTLY the served TOOL_TIERS (server vocabulary canonical)", JSON.stringify(Object.values(SERVER_TIER_OF).sort()) === JSON.stringify([...TOOL_TIERS].sort()));
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
console.log("  per pack (cases): total / live / distinct live facts / max per fact / ciOnly");
for (const [p, n] of Object.entries(packs)) console.log(`  ${p.padEnd(12)} ${n.cases} / ${n.liveCases} / ${n.distinctLiveFacts} / ${n.maxLiveCasesPerFact} / ${n.ciOnly}`);
console.log(`  ${formatGlobalFactLine(liveGlobalFactReport())}`);
console.log("  ciOnly cases:");
for (const c of LIVE_CASES.filter(isCiOnly)) console.log(`    ${c.id} (${c.turns.length} turn) — ${c.oracle.kind === "ci-only" ? c.oracle.reason : ""}`);

if (failures) { console.error(`\n${failures} check(s) failed, ${passed} passed`); process.exit(1); }
console.log(`\nall ${passed} checks passed`);
