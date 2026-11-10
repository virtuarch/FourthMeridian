/**
 * lib/platform/intelligence/ai/engine/router.test.ts  (Platform AI P2 — per-pack flags + router stub, I-8 / D-8)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/engine/router.test.ts
 *
 * 1. strictPlatformAiPackFlag: ON only for master "true" AND pack "true" (unset / "1" / "TRUE" / " true" ⇒ OFF);
 * 2. lib/env.ts: one getter per future pack, each exactly that rule over its own variable (source
 *    scan) — and the live getters over a mixed environment;
 * 3. the existing packs' flags (metrics + navigation = PLATFORM_AI_ENABLED, memory = the memory flag)
 *    and the core routing (flag-ON packs; memory only with the turn's hooks);
 * 4. P3 — the keyword router over SYNTHETIC packs (test-only, never registered): core always, rule
 *    order, ≤ ROUTER_MAX_PACKS, flag-OFF / out-of-scope / undeclared never routed, RECORD needs every area;
 * 5. P3 — more_tools: expandable set + both bounds; through a REAL turn boundary: offered only when
 *    expandable, closed enum, cannot unlock a flag-OFF / out-of-scope pack, per-call recheck, bound;
 * 6. P3 — no behaviour change: with today's registry + flags, every question routes the core packs
 *    and the offered schemas are byte-identical to core.ts platformAiToolSchemas (no more_tools).
 */

const PACKS = ["CUSTOMERS", "ONBOARDING", "CONNECTIONS", "INCIDENTS", "JOBS", "PROVIDERS", "AI_USAGE", "AUDIT_HISTORY", "POLICIES", "GROWTH", "MERCHANTS"] as const;
const MIXED: Record<(typeof PACKS)[number], string | undefined> = {
  CUSTOMERS: "true", ONBOARDING: "1", CONNECTIONS: "TRUE", INCIDENTS: " true", JOBS: undefined, PROVIDERS: "yes",
  AI_USAGE: "false", AUDIT_HISTORY: "on", POLICIES: "", GROWTH: "True", MERCHANTS: undefined,
};
process.env.PLATFORM_AI_ENABLED = "true";
for (const p of PACKS) { if (MIXED[p] === undefined) delete process.env[`PLATFORM_AI_PACK_${p}_ENABLED`]; else process.env[`PLATFORM_AI_PACK_${p}_ENABLED`] = MIXED[p]; }

import { readFileSync } from "node:fs";
import path from "node:path";
import { UserRole, type PlatformArea } from "@prisma/client";
import type { PlatformAiBinding, ToolEvidence } from "../core";
import type { PlatformAiTool } from "../tools/registry";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const camel = (p: string) => p.split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join("");

async function main() {
  const { env, strictPlatformAiPackFlag } = await import("@/lib/env");
  const { platformAiPackEnabled, routePlatformAiPacks } = await import("./router");

  console.log("1. the strict rule");
  const values: (string | undefined)[] = [undefined, "", "1", "TRUE", "True", " true", "true ", "yes", "on", "false", "true"];
  for (const m of values) for (const v of values) {
    const want = m === "true" && v === "true";
    if (strictPlatformAiPackFlag(m, v) !== want) check(`master=${JSON.stringify(m)} pack=${JSON.stringify(v)}`, false);
  }
  check("ON only for master === \"true\" AND pack === \"true\" (121 combinations)", true);

  console.log("\n2. lib/env.ts getters");
  const envSrc = readFileSync(path.join(process.cwd(), "lib/env.ts"), "utf8");
  for (const p of PACKS) {
    const re = new RegExp(`get isPlatformAiPack${camel(p)}Enabled\\(\\) \\{ return strictPlatformAiPackFlag\\(_e\\.PLATFORM_AI_ENABLED, _e\\.PLATFORM_AI_PACK_${p}_ENABLED\\); \\}`);
    check(`isPlatformAiPack${camel(p)}Enabled = strict(master, PLATFORM_AI_PACK_${p}_ENABLED); the variable is read from process.env`,
      re.test(envSrc) && new RegExp(`PLATFORM_AI_PACK_${p}_ENABLED: process\\.env\\.PLATFORM_AI_PACK_${p}_ENABLED,`).test(envSrc));
  }
  const live = Object.fromEntries(PACKS.map((p) => [p, (env as unknown as Record<string, boolean>)[`isPlatformAiPack${camel(p)}Enabled`]]));
  check("live, master ON: only the pack set to exactly \"true\" is ON (\"1\", \"TRUE\", \" true\", \"True\", unset ⇒ OFF)",
    Object.entries(live).filter(([, v]) => v === true).map(([k]) => k).join() === "CUSTOMERS" && Object.values(live).every((v) => typeof v === "boolean"), live);
  check("no pack getter can be ON with the master flag OFF", !values.some((v) => strictPlatformAiPackFlag(undefined, v)) && !strictPlatformAiPackFlag("false", "true"));

  console.log("\n3. existing packs + the router stub");
  const fakeEnv = (master: boolean, memory: boolean) => ({ isPlatformAiEnabled: master, isPlatformAiMemoryEnabled: memory });
  check("metrics + navigation follow PLATFORM_AI_ENABLED (ON wherever Platform AI is ON — behaviour unchanged)",
    platformAiPackEnabled("metrics", fakeEnv(true, false)) && platformAiPackEnabled("navigation", fakeEnv(true, false))
    && !platformAiPackEnabled("metrics", fakeEnv(false, false)) && !platformAiPackEnabled("navigation", fakeEnv(false, true)));
  check("memory follows the existing memory flag (and the master)",
    platformAiPackEnabled("memory", fakeEnv(true, true)) && !platformAiPackEnabled("memory", fakeEnv(true, false)) && !platformAiPackEnabled("memory", fakeEnv(false, true)));
  check("an undeclared pack ⇒ OFF", !platformAiPackEnabled("merchants" as never, fakeEnv(true, true)));
  // P5 (PACK-PR-CONDITIONS 3): customers is wired to ITS strict getter (master AND PLATFORM_AI_PACK_CUSTOMERS_ENABLED).
  const withCustomers = (master: boolean, pack: boolean | undefined) => ({ ...fakeEnv(master, false), ...(pack === undefined ? {} : { isPlatformAiPackCustomersEnabled: pack }) });
  check("customers pack flag = isPlatformAiPackCustomersEnabled (and the master); absent getter ⇒ OFF",
    platformAiPackEnabled("customers", withCustomers(true, true)) && !platformAiPackEnabled("customers", withCustomers(true, false))
    && !platformAiPackEnabled("customers", withCustomers(false, true)) && !platformAiPackEnabled("customers", withCustomers(true, undefined)));
  check("customers pack flag over the LIVE env: PLATFORM_AI_PACK_CUSTOMERS_ENABLED=\"true\" here ⇒ ON (the getter, not another variable)",
    platformAiPackEnabled("customers") === env.isPlatformAiPackCustomersEnabled && env.isPlatformAiPackCustomersEnabled === true);
  const routerSrc = readFileSync(path.join(process.cwd(), "lib/platform/intelligence/ai/engine/router.ts"), "utf8");
  check("PACK_FLAG.customers reads exactly e.isPlatformAiPackCustomersEnabled (source pin)",
    /customers: \(e\) => e\.isPlatformAiEnabled === true && e\.isPlatformAiPackCustomersEnabled === true,/.test(routerSrc));
  // P8 (PACK-PR-CONDITIONS 3): incidents is wired to ITS strict getter (master AND PLATFORM_AI_PACK_INCIDENTS_ENABLED).
  const withIncidents = (master: boolean, pack: boolean | undefined) => ({ ...fakeEnv(master, false), ...(pack === undefined ? {} : { isPlatformAiPackIncidentsEnabled: pack }) });
  check("incidents pack flag = isPlatformAiPackIncidentsEnabled (and the master); absent getter ⇒ OFF; the customers getter does not turn it on",
    platformAiPackEnabled("incidents", withIncidents(true, true)) && !platformAiPackEnabled("incidents", withIncidents(true, false))
    && !platformAiPackEnabled("incidents", withIncidents(false, true)) && !platformAiPackEnabled("incidents", withIncidents(true, undefined))
    && !platformAiPackEnabled("incidents", withCustomers(true, true)) && !platformAiPackEnabled("customers", withIncidents(true, true)));
  check("incidents pack flag over the LIVE env: PLATFORM_AI_PACK_INCIDENTS_ENABLED=\" true\" here ⇒ OFF (strict; default OFF)",
    platformAiPackEnabled("incidents") === env.isPlatformAiPackIncidentsEnabled && env.isPlatformAiPackIncidentsEnabled === false);
  check("PACK_FLAG.incidents reads exactly e.isPlatformAiPackIncidentsEnabled (source pin)",
    /incidents: \(e\) => e\.isPlatformAiEnabled === true && e\.isPlatformAiPackIncidentsEnabled === true,/.test(routerSrc));
  // P6 (PACK-PR-CONDITIONS 3): onboarding is wired to ITS strict getter (master AND PLATFORM_AI_PACK_ONBOARDING_ENABLED).
  const withOnboarding = (master: boolean, pack: boolean | undefined) => ({ ...fakeEnv(master, false), ...(pack === undefined ? {} : { isPlatformAiPackOnboardingEnabled: pack }) });
  check("onboarding pack flag = isPlatformAiPackOnboardingEnabled (and the master); absent getter ⇒ OFF; another pack's getter does not turn it on",
    platformAiPackEnabled("onboarding", withOnboarding(true, true)) && !platformAiPackEnabled("onboarding", withOnboarding(true, false))
    && !platformAiPackEnabled("onboarding", withOnboarding(false, true)) && !platformAiPackEnabled("onboarding", withOnboarding(true, undefined))
    && !platformAiPackEnabled("onboarding", withCustomers(true, true)) && !platformAiPackEnabled("onboarding", withIncidents(true, true))
    && !platformAiPackEnabled("customers", withOnboarding(true, true)) && !platformAiPackEnabled("incidents", withOnboarding(true, true)));
  check("onboarding pack flag over the LIVE env: PLATFORM_AI_PACK_ONBOARDING_ENABLED=\"1\" here ⇒ OFF (strict; default OFF)",
    platformAiPackEnabled("onboarding") === env.isPlatformAiPackOnboardingEnabled && env.isPlatformAiPackOnboardingEnabled === false);
  check("PACK_FLAG.onboarding reads exactly e.isPlatformAiPackOnboardingEnabled (source pin)",
    /onboarding: \(e\) => e\.isPlatformAiEnabled === true && e\.isPlatformAiPackOnboardingEnabled === true,/.test(routerSrc));
  // P7 (PACK-PR-CONDITIONS 3): connections is wired to ITS strict getter (master AND PLATFORM_AI_PACK_CONNECTIONS_ENABLED).
  const withConnections = (master: boolean, pack: boolean | undefined) => ({ ...fakeEnv(master, false), ...(pack === undefined ? {} : { isPlatformAiPackConnectionsEnabled: pack }) });
  check("connections pack flag = isPlatformAiPackConnectionsEnabled (and the master); absent getter ⇒ OFF; another pack's getter does not turn it on",
    platformAiPackEnabled("connections", withConnections(true, true)) && !platformAiPackEnabled("connections", withConnections(true, false))
    && !platformAiPackEnabled("connections", withConnections(false, true)) && !platformAiPackEnabled("connections", withConnections(true, undefined))
    && !platformAiPackEnabled("connections", withCustomers(true, true)) && !platformAiPackEnabled("connections", withOnboarding(true, true))
    && !platformAiPackEnabled("customers", withConnections(true, true)) && !platformAiPackEnabled("onboarding", withConnections(true, true)));
  check("connections pack flag over the LIVE env: PLATFORM_AI_PACK_CONNECTIONS_ENABLED=\"TRUE\" here ⇒ OFF (strict; default OFF)",
    platformAiPackEnabled("connections") === env.isPlatformAiPackConnectionsEnabled && env.isPlatformAiPackConnectionsEnabled === false);
  check("PACK_FLAG.connections reads exactly e.isPlatformAiPackConnectionsEnabled (source pin)",
    /connections: \(e\) => e\.isPlatformAiEnabled === true && e\.isPlatformAiPackConnectionsEnabled === true,/.test(routerSrc));
  const OPS: PlatformArea[] = ["PLATFORM_OPS"];
  const r = (memory: boolean, e: ReturnType<typeof fakeEnv>, q: string | null = null, areas: PlatformArea[] = OPS) => routePlatformAiPacks({ question: q, areas, memory }, e).join();
  check("core routing: memory only with the turn's memory hooks",
    r(false, fakeEnv(true, true)) === "metrics,navigation"
    && r(true, fakeEnv(true, true)) === "metrics,navigation,memory"
    && r(true, fakeEnv(true, false)) === "metrics,navigation"
    && r(true, fakeEnv(false, true)) === "");
  check("core routing: no area in scope ⇒ nothing offered", r(true, fakeEnv(true, true), "how are incidents?", []) === "");

  await p3(fakeEnv);

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

// ── P3 ───────────────────────────────────────────────────────────────────────

const SYN_PACKS = ["metrics", "navigation", "memory", "incidents", "connections", "jobs", "customers", "providers", "growth"];
const synTool = (name: string, pack: string, areas: PlatformArea[], scope: "AGGREGATE" | "RECORD" = "AGGREGATE"): PlatformAiTool => ({
  name, pack, description: `synthetic ${pack} tool (test-only)`, args: { properties: { n: { kind: "int", min: 1, max: 5, optional: true } } },
  requires: { areas, level: "READ", tier: "OPS" }, scope, customerLinkable: false, pii: 0, cost: { toolCalls: 1 },
  ...(scope === "RECORD" ? { recordSchema: { kind: "SYN", fields: { state: { type: "code", values: ["A"] } } } } : {}),
  run: async () => ({ ok: name }),
} as unknown as PlatformAiTool);

type FakeEnv = (m: boolean, mem: boolean) => { isPlatformAiEnabled: boolean; isPlatformAiMemoryEnabled: boolean };

async function p3(fakeEnv: FakeEnv) {
  const R = await import("./router");
  const { PLATFORM_AI_TOOL_REGISTRY } = await import("../tools/registry");
  const { platformAiToolSchemas } = await import("../core");
  const ALL: PlatformArea[] = ["PLATFORM_OPS", "SECURITY_OPS", "GROWTH_REVENUE", "CUSTOMER_SUCCESS", "MERCHANT_OPS"];
  const synRegistry: PlatformAiTool[] = [
    // P8: the real incidents pack is replaced by its synthetic stand-in here (these checks pin the rule table).
    // P6: the real onboarding pack is not in SYN_PACKS (undeclared here ⇒ inert), kept out for clarity.
    // P7: the real connections pack is replaced by its synthetic stand-in (syn_connections) too.
    ...PLATFORM_AI_TOOL_REGISTRY.filter((t) => t.pack !== "incidents" && t.pack !== "onboarding" && t.pack !== "connections"),
    synTool("syn_incidents", "incidents", ["PLATFORM_OPS"]),
    synTool("syn_connections", "connections", ["PLATFORM_OPS", "CUSTOMER_SUCCESS"], "RECORD"),
    synTool("syn_jobs", "jobs", ["PLATFORM_OPS"]),
    synTool("syn_customers", "customers", ["CUSTOMER_SUCCESS"]),
    synTool("syn_providers", "providers", ["PLATFORM_OPS"]),
    synTool("syn_growth", "growth", ["GROWTH_REVENUE"]),
  ];
  const e = fakeEnv(true, true);
  const deps = (off: readonly string[] = []) => ({ registry: synRegistry, declared: SYN_PACKS, enabled: (p: string) => !off.includes(p) });
  const route = (q: string | null, areas: PlatformArea[], off: string[] = []) => R.routePlatformAiPacks({ question: q, areas, memory: false }, e, deps(off)).join();

  console.log("\n4. P3 — the keyword router (synthetic packs)");
  check("no question ⇒ core packs only", route(null, ALL) === "metrics,navigation");
  check("a matched question adds its pack after the core packs", route("Any open incidents right now?", ALL) === "metrics,navigation,incidents");
  check("several matches ⇒ RULE order, at most ROUTER_MAX_PACKS (3)",
    R.ROUTER_MAX_PACKS === 3 && route("customers hit by incidents after the jobs refresh broke their connections from a provider", ALL) === "metrics,navigation,incidents,connections,jobs");
  check("a flag-OFF pack is never routed (the next matching pack takes its place)",
    route("customers hit by incidents after the jobs refresh broke their connections", ALL, ["incidents"]) === "metrics,navigation,connections,jobs,customers");
  check("an out-of-scope pack is never routed (customers needs CUSTOMER_SUCCESS)", route("which customers need attention?", ["PLATFORM_OPS"]) === "metrics,navigation");
  check("a RECORD pack needs EVERY required area (connections: Ops + CS)",
    route("connections failing?", ["PLATFORM_OPS"]) === "metrics,navigation" && route("connections failing?", ["PLATFORM_OPS", "CUSTOMER_SUCCESS"]) === "metrics,navigation,connections");
  check("a core pack whose flag is OFF is not offered either", route("incidents?", ALL, ["navigation"]) === "metrics,incidents");
  check("an undeclared pack's rule is inert (merchants has a rule, no declaration)", route("merchant descriptors?", ALL) === "metrics,navigation");
  check("a throwing flag is OFF", R.routePlatformAiPacks({ question: "incidents", areas: ALL, memory: false }, e,
    { ...deps(), enabled: (p) => { if (p === "incidents") throw new Error("x"); return true; } }).join() === "metrics,navigation");
  check("deterministic: the same input ⇒ the same packs (100 runs)", new Set(Array.from({ length: 100 }, () => route("jobs and incidents and growth", ALL))).size === 1);
  const envSrc = readFileSync(path.join(process.cwd(), "lib/env.ts"), "utf8");
  check("every rule names a planned pack with its lib/env.ts flag (no invented pack, no core pack)",
    R.ROUTER_RULES.every((x) => !R.CORE_PACKS.includes(x.pack) && envSrc.includes(`PLATFORM_AI_PACK_${x.pack.toUpperCase()}_ENABLED: process.env`)));

  console.log("\n5. P3 — more_tools");
  const exp = (routed: string[], areas: PlatformArea[], n: number, off: string[] = []) => R.expandablePlatformAiPacks({ routed, areas, expansions: n }, e, deps(off)).join();
  check("expandable = declared, flag ON, callable in scope, not routed, not core", exp(["metrics", "navigation"], ["PLATFORM_OPS"], 0) === "incidents,jobs,providers");
  check("expandable never lists a flag-OFF or out-of-scope pack", exp(["metrics", "navigation"], ["PLATFORM_OPS"], 0, ["jobs"]) === "incidents,providers");
  check(`bound: ${R.MORE_TOOLS_MAX_EXPANSIONS} expansions ⇒ nothing expandable`, R.MORE_TOOLS_MAX_EXPANSIONS === 2 && exp(["metrics"], ALL, 2) === "");
  check("bound: ROUTER_MAX_PACKS non-core packs routed ⇒ nothing expandable", exp(["metrics", "incidents", "jobs", "providers"], ALL, 0) === "");
  check("today's declared packs ⇒ nothing is ever expandable (more_tools never offered)",
    R.expandablePlatformAiPacks({ routed: ["metrics"], areas: ALL, expansions: 0 }, e).length === 0);

  // Through a REAL turn boundary.
  const { createTurnBoundary } = await import("../authz/boundary");
  const { scopeFromGuard } = await import("../authz/scope");
  const OP = "cop000000000000000000000001";
  const scopeOf = (area: PlatformArea) => scopeFromGuard({ user: { id: OP, role: UserRole.USER }, grant: { area, level: "READ" } }, area, OP)!;
  const binding = {} as PlatformAiBinding;
  const ev = (): ToolEvidence => ({ envelopes: [], hrefs: new Set(), definitions: [], labels: new Set(), trace: [], pages: new Map() });
  const mk = (held: PlatformArea[], revoked = new Set<PlatformArea>()) => {
    const rechecks: PlatformArea[] = [];
    const flagOff = new Set<string>();
    const enabled = (p: string) => !flagOff.has(p);
    const router = R.platformAiTurnRouter({ memory: false }, e, { registry: synRegistry, declared: SYN_PACKS, enabled });
    const b = createTurnBoundary({
      operatorId: OP, correlationId: "corr-p3", areas: held.map((a) => ({ scope: scopeOf(a), binding })), binding,
      recheck: async (a) => { rechecks.push(a); return revoked.has(a) ? null : { auth: { user: { id: OP, role: UserRole.USER }, grant: { area: a, level: "READ" } }, csTier: false }; },
      packs: R.routePlatformAiPacks({ question: null, areas: held, memory: false }, e, { registry: synRegistry, declared: SYN_PACKS, enabled }),
      router, packEnabled: enabled, registry: synRegistry,
    });
    return { b, rechecks, flagOff };
  };
  type Fn = { function: { name: string; parameters: { properties: { pack?: { enum: string[] } } } } };
  const names = (schemas: unknown[]) => (schemas as Fn[]).map((s) => s.function.name);
  const moreEnum = (schemas: unknown[]) => (schemas as Fn[]).find((s) => s.function.name === "more_tools")?.function.parameters.properties.pack?.enum ?? null;
  const NF = JSON.stringify({ found: false });
  const call = (b: ReturnType<typeof createTurnBoundary>, n: string, a: unknown) => b.invoke(n, JSON.stringify(a), { ev: ev(), paramKeys: [], asked: [] });
  const isNF = async (p: Promise<unknown>) => JSON.stringify(await p) === NF;
  {
    const { b, rechecks } = mk(["PLATFORM_OPS"]);
    b.tools!.route("How are jobs doing?");
    const s1 = b.tools!.schemas([]);
    check("routed question: its pack's tools + more_tools over the remaining expandable packs (closed enum)",
      names(s1).join() === "list_metrics,get_metric,find_page,open_page,syn_jobs,more_tools" && moreEnum(s1)?.join() === "incidents,providers", names(s1));
    check("a tool of an un-routed pack is NOT_FOUND before more_tools", await isNF(call(b, "syn_incidents", {})));
    check("more_tools with a pack outside the enum (out-of-scope customers) ⇒ NOT_FOUND, nothing added",
      (await isNF(call(b, "more_tools", { pack: "customers" }))) && !b.routedPacks().includes("customers" as never));
    check("more_tools with extra / missing args ⇒ NOT_FOUND",
      (await isNF(call(b, "more_tools", { pack: "incidents", x: 1 }))) && (await isNF(call(b, "more_tools", {}))));
    const before = rechecks.length;
    const added = await call(b, "more_tools", { pack: "incidents" }) as { added?: string; tools?: string[] };
    check("more_tools adds an in-scope flag-ON pack, rechecking its areas fresh", added.added === "incidents" && added.tools?.join() === "syn_incidents" && rechecks.length > before, added);
    check("…its tool now runs, and the schemas offer it", !(await isNF(call(b, "syn_incidents", {}))) && names(b.tools!.schemas([])).includes("syn_incidents"));
    const second = await call(b, "more_tools", { pack: "providers" }) as { added?: string };
    check("a second expansion is allowed (bound 2)", second.added === "providers");
    check("bound reached: more_tools no longer offered, and refused", !names(b.tools!.schemas([])).includes("more_tools") && (await isNF(call(b, "more_tools", { pack: "growth" }))));
    b.tools!.route("growth customers connections");
    check("route() after a tool call changes nothing", b.routedPacks().join() === "metrics,navigation,jobs,incidents,providers", b.routedPacks());
    check("trace: codes only (more_tools / router / outcome code)", b.trace().filter((t) => t.tool === "more_tools").every((t) => t.pack === "router" && /^[A-Z_]+$/.test(t.outcome)));
  }
  {
    const { b, flagOff } = mk(["PLATFORM_OPS"]);
    b.tools!.route("What is broken?");
    flagOff.add("providers");
    check("more_tools cannot unlock a pack whose flag went OFF mid-turn",
      (await isNF(call(b, "more_tools", { pack: "providers" }))) && !b.routedPacks().includes("providers" as never));
    const { b: b2 } = mk(["PLATFORM_OPS"], new Set<PlatformArea>(["PLATFORM_OPS"]));
    b2.tools!.route("hello");
    check("more_tools whose area recheck is refused ⇒ NOT_FOUND, nothing added",
      (await isNF(call(b2, "more_tools", { pack: "jobs" }))) && !b2.routedPacks().includes("jobs" as never));
    check("…and with the scope now empty nothing is offered at all", b2.tools!.schemas([]).length === 0);
  }
  {
    const { b } = mk(["PLATFORM_OPS"]);
    b.tools!.route("incidents, jobs and providers please");
    check("3 packs keyword-routed ⇒ more_tools not offered, and refused",
      !names(b.tools!.schemas([])).includes("more_tools") && (await isNF(call(b, "more_tools", { pack: "jobs" }))));
  }
  {
    const b = createTurnBoundary({ operatorId: OP, correlationId: "c", areas: [{ scope: scopeOf("PLATFORM_OPS"), binding }], binding, recheck: async () => null, packs: ["metrics"], packEnabled: () => true });
    check("no router ⇒ no tools offer, and more_tools is an unknown tool", b.tools === undefined && (await isNF(call(b, "more_tools", { pack: "jobs" }))));
  }

  console.log("\n6. P3 — no behaviour change with today's registry + flags");
  const QUESTIONS = ["How are we looking today?", "What's costing me the most money in the past 30 days?", "Any incidents?", "customers needing attention", "open the jobs page", "Remember that the refresh pipeline is degraded."];
  for (const memory of [false, true]) for (const pk of [[], ["view", "window"]]) {
    const router = R.platformAiTurnRouter({ memory }, e);
    let same = true;
    for (const q of QUESTIONS) {
      const packs = router.route(q, ["PLATFORM_OPS"]);
      const exp0 = router.expandable(packs, ["PLATFORM_OPS"], 0);
      same &&= packs.join() === (memory ? "metrics,navigation,memory" : "metrics,navigation") && exp0.length === 0
        && JSON.stringify(router.schemas({ packs, areas: ["PLATFORM_OPS"], paramKeys: pk, expandable: exp0 })) === JSON.stringify(platformAiToolSchemas(pk, { memory }));
    }
    check(`memory ${memory ? "on" : "off"}, paramKeys [${pk.join()}]: every question ⇒ core packs, schemas byte-identical to core.ts, no more_tools`, same);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
