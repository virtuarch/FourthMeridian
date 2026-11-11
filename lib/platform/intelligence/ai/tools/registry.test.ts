/**
 * lib/platform/intelligence/ai/tools/registry.test.ts  (Platform AI P1b — the registry facade + schema snapshot)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/tools/registry.test.ts
 *
 * SCHEMA SNAPSHOT: the tool schemas the model is sent are pinned in
 * tools/tool-schemas.snapshot.json. A change to a tool name, description, argument,
 * enum or bound fails this test; update it DELIBERATELY (and say so in the PR) with
 *   UPDATE_PLATFORM_AI_TOOL_SNAPSHOT=1 npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/tools/registry.test.ts
 *
 * 1. the registry declares exactly the six existing tools, each passing contractProblems;
 * 2. each contract agrees with the serialised schema (names, required, enums, bounds);
 * 3. the contract parse is never weaker than the executor's own argument checks
 *    (and agrees exactly for the five tools whose checks live in the executor);
 * 4. run() delegates to the executor unchanged (same result, same trace);
 * 5. the snapshot; 6. static purity of tools/*.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  NOT_FOUND, PLATFORM_AI_MEMORY_TOOLS, PLATFORM_AI_TOOLS, executePlatformAiTool, platformAiToolSchemas,
  type PlatformAiBinding, type PlatformAiMemoryHooks, type ToolEvidence,
} from "../core";
import { contractProblems, parseClosedArgs } from "./contract";
import { CORE_TOOL_NAMES, PLATFORM_AI_REGISTERED_TOOLS, PLATFORM_AI_TOOL_REGISTRY, platformAiRegistrySchemas, platformAiTool } from "./registry";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 600)}` : ""}`); }
}

const ROOT = process.cwd();
const DIR = "lib/platform/intelligence/ai/tools";
const SNAPSHOT = path.join(ROOT, DIR, "tool-schemas.snapshot.json");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

type Fn = { function: { name: string; description: string; parameters: { properties: Record<string, Record<string, unknown>>; required: string[]; additionalProperties: boolean } } };
const PARAM_KEYS = ["view", "window"];

/** A binding that sees nothing (every read NOT_FOUND): only the ARGUMENT checks decide the trace outcome. */
const emptyBinding: PlatformAiBinding = {
  surfaceLabel: "Test", listMetrics: () => [], describeMetric: () => null, readMetric: async () => null, listPages: () => [], resolvePage: () => null,
};
const ev = (): ToolEvidence => ({ envelopes: [], hrefs: new Set(), definitions: [], labels: new Set(), trace: [], pages: new Map() });
const memoryHooks: PlatformAiMemoryHooks = {
  contextMessage: null, recall: () => ({ items: [] }), propose: () => NOT_FOUND, renderPlaceholder: () => null, subjects: () => [],
};

async function main() {
  console.log("1. the six existing tools, each a valid declaration");
  check("the registry declares exactly the core's tools (4 + 2 memory), in the order offered",
    PLATFORM_AI_REGISTERED_TOOLS.join() === CORE_TOOL_NAMES.join() && CORE_TOOL_NAMES.join() === [...PLATFORM_AI_TOOLS, ...PLATFORM_AI_MEMORY_TOOLS].join() && PLATFORM_AI_TOOL_REGISTRY.length === 6,
    PLATFORM_AI_REGISTERED_TOOLS);
  for (const t of PLATFORM_AI_TOOL_REGISTRY) check(`${t.name}: contractProblems = none`, contractProblems(t as never).length === 0, contractProblems(t as never));
  check("packs: metrics = list_metrics/get_metric · navigation = find_page/open_page · memory = recall/propose",
    PLATFORM_AI_TOOL_REGISTRY.map((t) => `${t.pack}:${t.name}`).join() === "metrics:list_metrics,metrics:get_metric,navigation:find_page,navigation:open_page,memory:recall_memory,memory:propose_memory");
  check("none returns records: AGGREGATE, customerLinkable false, no audit, pii 0, tier OPS, READ, 1 call each",
    PLATFORM_AI_TOOL_REGISTRY.every((t) => t.scope === "AGGREGATE" && t.customerLinkable === false && t.audit === undefined && t.pii === 0
      && t.requires.tier === "OPS" && t.requires.level === "READ" && t.cost.toolCalls === 1));
  check("requires.areas lists every Platform area explicitly (each area's binding scopes them)",
    PLATFORM_AI_TOOL_REGISTRY.every((t) => [...t.requires.areas].sort().join() === "CUSTOMER_SUCCESS,GROWTH_REVENUE,MERCHANT_OPS,PLATFORM_OPS,SECURITY_OPS"));
  check("an unknown tool has no declaration", platformAiTool("get_customer") === null && platformAiTool("") === null && platformAiTool("get_metric")?.name === "get_metric");

  console.log("\n2. each contract agrees with the serialised schema the model sees");
  const schemas = platformAiRegistrySchemas(PARAM_KEYS, { memory: true }) as Fn[];
  check("the facade returns exactly core.ts platformAiToolSchemas (memory on and off)",
    JSON.stringify(schemas) === JSON.stringify(platformAiToolSchemas(PARAM_KEYS, { memory: true }))
    && JSON.stringify(platformAiRegistrySchemas(PARAM_KEYS)) === JSON.stringify(platformAiToolSchemas(PARAM_KEYS)));
  check("memory off ⇒ the four non-memory tools only", (platformAiRegistrySchemas(PARAM_KEYS) as Fn[]).map((s) => s.function.name).join() === PLATFORM_AI_TOOLS.join());
  for (const t of PLATFORM_AI_TOOL_REGISTRY) {
    const s = schemas.find((x) => x.function.name === t.name);
    if (!s) { check(`${t.name}: present in the schema`, false); continue; }
    const p = s.function.parameters;
    const props = Object.keys(p.properties).sort().join(), declared = Object.keys(t.args.properties).sort().join();
    const required = Object.entries(t.args.properties).filter(([, a]) => !a.optional).map(([k]) => k).sort().join();
    const kinds = Object.entries(t.args.properties).every(([k, a]) => {
      const j = p.properties[k];
      switch (a.kind) {
        case "enum": return j.type === "string" && JSON.stringify(j.enum) === JSON.stringify(a.values);
        case "int": return j.type === "integer" && JSON.stringify(j.enum) === JSON.stringify(a.offered) && (a.offered ?? []).every((d) => d >= a.min && d <= a.max);
        case "registryId": return j.type === "string" && (j.maxLength === undefined || j.maxLength === a.maxLength);
        case "guardedText": return j.type === "string" && j.maxLength === a.maxLength;
        case "registryParams": return j.type === "object" && j.additionalProperties === false
          && Object.values(j.properties as Record<string, { maxLength: number }>).every((v) => v.maxLength === a.maxValueLength);
        case "handle": return j.type === "string";
      }
    });
    check(`${t.name}: same argument names, required set, kinds/enums/bounds, no extra properties, same description`,
      props === declared && [...p.required].sort().join() === required && kinds && p.additionalProperties === false && s.function.description === t.description,
      { props, declared, required: p.required });
  }
  check("no schema carries a scope field (surface / area / token / tier / user / customer)",
    schemas.every((s) => Object.keys(s.function.parameters.properties).every((k) => !/surface|area|token|tier|user|customer|email/i.test(k))));

  console.log("\n3. the contract parse is never weaker than the executor's argument checks");
  const corpus: Record<string, string[]> = {
    list_metrics: [`{}`, `{"domain":null}`, `{"domain":"operations"}`, `{"domain":"nope"}`, `{"domain":1}`, `{"domain":"operations","area":"CUSTOMER_SUCCESS"}`],
    get_metric: [`{"id":"incident-broken-now@1"}`, `{"id":"x","window":7}`, `{"id":"x","window":null}`, `{"id":"x","window":0}`, `{"id":"x","window":367}`, `{"id":"x","window":1.5}`,
      `{"id":"x","window":"7"}`, `{"id":"a b"}`, `{"id":"${"a".repeat(121)}"}`, `{"id":"${"a".repeat(120)}"}`, `{}`, `{"id":"x","surface":"CUSTOMER_SUCCESS"}`, `{"id":1}`],
    find_page: [`{"query":"incidents"}`, `{"query":""}`, `{"query":"${"q".repeat(80)}"}`, `{"query":"${"q".repeat(81)}"}`, `{}`, `{"query":5}`, `{"query":"x","area":"SECURITY_OPS"}`],
    open_page: [`{"id":"PLATFORM_OPS:platform-incidents:open"}`, `{"id":"x","params":{"view":"open"}}`, `{"id":"x","params":{"rid":"c123"}}`, `{"id":"x","params":{"view":3}}`,
      `{"id":"x","params":[]}`, `{"id":"x","params":null}`, `{"id":"https://evil.test"}`, `{}`],
    recall_memory: [`{}`, `{"id":"abc123"}`, `{"id":"ABC"}`, `{"id":"a-b"}`, `{"id":"${"a".repeat(41)}"}`, `{"id":null}`, `{"id":"x","note":"y"}`],
    propose_memory: [`{"factType":"WATCHING_ISSUE","subjectRef":"x@1"}`, `{"factType":"WATCHING_ISSUE","subjectRef":"x@1","extra":1}`, `[]`, `nope`,
      `{"factType":"WATCHING_ISSUE","subjectRef":"x@1","note":"${"n".repeat(141)}"}`],
  };
  const generic = [`[]`, `null`, `nope`, `"str"`, `{"__proto__":{"x":1}}`];
  for (const t of PLATFORM_AI_TOOL_REGISTRY) {
    const rows: { raw: string; contract: boolean; executor: boolean }[] = [];
    for (const raw of [...corpus[t.name], ...generic]) {
      const e = ev();
      await executePlatformAiTool(t.name, raw, emptyBinding, e, PARAM_KEYS, [], memoryHooks);
      rows.push({ raw, contract: parseClosedArgs(t.args, raw, { paramKeys: PARAM_KEYS }) !== null, executor: e.trace[0]?.outcome !== "INVALID_ARGS" });
    }
    const weaker = rows.filter((r) => r.contract && !r.executor);
    check(`${t.name}: every argument the executor refuses, the contract refuses too`, weaker.length === 0, weaker);
    if (t.name !== "propose_memory") {
      const differ = rows.filter((r) => r.contract !== r.executor);
      check(`${t.name}: …and they agree exactly (the executor holds all of this tool's argument checks)`, differ.length === 0, differ);
    }
  }

  console.log("\n4. run() is the executor, unchanged");
  {
    const a = ev(), b = ev();
    const viaRegistry = await platformAiTool("get_metric")!.run({ id: "incident-broken-now@1", window: 7 }, { binding: emptyBinding, ev: a, paramKeys: PARAM_KEYS });
    const direct = await executePlatformAiTool("get_metric", JSON.stringify({ id: "incident-broken-now@1", window: 7 }), emptyBinding, b, PARAM_KEYS, []);
    check("same result and same metadata trace as calling the executor directly", JSON.stringify(viaRegistry) === JSON.stringify(direct) && JSON.stringify(a.trace) === JSON.stringify(b.trace), { viaRegistry, trace: a.trace });
    const noMem = await platformAiTool("recall_memory")!.run({}, { binding: emptyBinding, ev: ev(), paramKeys: [] });
    check("a memory tool without memory hooks is NOT_FOUND (as in the executor)", JSON.stringify(noMem) === JSON.stringify(NOT_FOUND));
  }

  console.log("\n5. the schema snapshot (what the model sees is pinned)");
  {
    const current = JSON.stringify({
      note: "Platform AI tool schemas as sent to the model. Update deliberately: UPDATE_PLATFORM_AI_TOOL_SNAPSHOT=1 (see registry.test.ts).",
      paramKeys: PARAM_KEYS,
      memoryOff: platformAiRegistrySchemas(PARAM_KEYS),
      memoryOn: platformAiRegistrySchemas(PARAM_KEYS, { memory: true }),
    }, null, 2) + "\n";
    if (process.env.UPDATE_PLATFORM_AI_TOOL_SNAPSHOT === "1") { writeFileSync(SNAPSHOT, current); console.log(`  (snapshot written: ${path.relative(ROOT, SNAPSHOT)})`); }
    const pinned = existsSync(SNAPSHOT) ? readFileSync(SNAPSHOT, "utf8") : null;
    check("the serialised tool schemas equal the committed snapshot (a change must update it deliberately)", pinned === current,
      pinned === null ? "snapshot missing" : "differs — review the change, then UPDATE_PLATFORM_AI_TOOL_SNAPSHOT=1");
  }

  console.log("\n6. static — tools/* is pure and declares no scope");
  {
    const files = readdirSync(path.join(ROOT, DIR)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => `${DIR}/${f}`);
    check("tools/ is contract.ts + registry.ts", files.sort().join() === `${DIR}/contract.ts,${DIR}/registry.ts`, files);
    for (const f of files) {
      const s = code(readFileSync(path.join(ROOT, f), "utf8"));
      check(`${f}: no db / prisma client / fetch / env / clock`, !/@\/lib\/db|systemDb|\bprisma\.|new PrismaClient|\bfetch\(|@\/lib\/env|process\.env|new Date\(|Date\.now/.test(s));
      check(`${f}: mints nothing, chooses no surface, reads no guard`,
        !/metricAccessFor\(|incidentAudienceFor\(|retrieveMetric\(|retrieveWith\(|atSurface\(|listNavigationTargets\(|resolveNavigationTarget\(|require(?:Fresh)?PlatformAccess\(/.test(s));
    }
    check("core.ts does not import the registry (no cycle; the live loop is unchanged in P1b)", !/tools\/registry|tools\/contract/.test(readFileSync(path.join(ROOT, "lib/platform/intelligence/ai/core.ts"), "utf8")));
  }

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
