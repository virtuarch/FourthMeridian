/**
 * lib/platform/intelligence/ai/engine/schema-budget.test.ts  (Platform AI P3 — schema token budget + router decision snapshot)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/engine/schema-budget.test.ts
 *
 * Design v2 §10: the tool schemas sent with ONE model call stay small (~12 schemas ≈ 3k tokens).
 * Tokens are ESTIMATED deterministically as ceil(chars / 4) of the serialised JSON
 * (engine/router.ts estimateSchemaTokens — the repo's convention, lib/ai/conversation).
 *
 * 1. the core packs' schemas (today's six tools, memory ON, the WIDEST page-filter key set) ≤
 *    CORE_SCHEMA_TOKEN_BUDGET; every DECLARED non-core pack's schemas ≤ PACK_SCHEMA_TOKEN_BUDGET
 *    (none yet — a P5+ pack PR that bloats its schemas fails here);
 * 2. the worst case a turn can be offered — core + the ROUTER_MAX_PACKS largest packs (each at
 *    its budget when none is declared) + more_tools over EVERY planned pack — ≤
 *    PLATFORM_AI_SCHEMA_TOKEN_BUDGET;
 * 3. every representative question × memory on/off × area scope: the router's actual offer
 *    (schemas + more_tools when expandable) ≤ PLATFORM_AI_SCHEMA_TOKEN_BUDGET;
 * 4. the router's decisions for a fixed question list are pinned (router-decisions.snapshot.json):
 *    with today's registry (core only) AND with every planned pack declared (the rule table).
 *    Update deliberately: UPDATE_PLATFORM_AI_ROUTER_SNAPSHOT=1.
 * 7. P6 — the onboarding pack (onboardingPackOn): unrelated questions unchanged; the narrowed rule's pinned
 *    false / true positives; Ops-only ⇒ the aggregate only.
 * 5. P5 (PACK-PR-CONDITIONS 2) — the customers pack DECLARED with its flag ON (the real registry,
 *    every area in scope): pinned as `customersPackOn`; every question the customers rule does not
 *    match routes exactly as `today` (the pack changes nothing for unrelated questions), and the
 *    questions it does match are listed in the snapshot for review.
 */

process.env.PLATFORM_AI_ENABLED = "true";

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PlatformArea } from "@prisma/client";
import type { PlatformAiTool } from "../tools/registry";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 600)}` : ""}`); }
}

const SNAPSHOT = path.join(process.cwd(), "lib/platform/intelligence/ai/engine/router-decisions.snapshot.json");
const ALL: PlatformArea[] = ["PLATFORM_OPS", "SECURITY_OPS", "GROWTH_REVENUE", "CUSTOMER_SUCCESS", "MERCHANT_OPS"];

/** Representative operator questions (already-scrubbed shape: no identifiers). */
const QUESTIONS = [
  "How are we looking today?",
  "What's costing me the most money in the past 30 days?",
  "Any open incidents right now?",
  "Why did the refresh pipeline fail overnight?",
  "Which customers need attention?",
  "Are bank connections healthy? Any reauth needed?",
  "How many imports failed during onboarding this week?",
  "Is the email provider bouncing?",
  "How much AI spend and how many tokens today?",
  "Who changed the refresh policy? Show the audit log.",
  "Is the kill switch or the cost freeze on?",
  "How are sign-ups and churn trending?",
  "Any merchant descriptors uncategorised?",
  "Customers hit by incidents after the jobs refresh broke their connections from a provider",
  "Open the platform ops page",
  "Remember that the scheduler is degraded.",
  // P5 — the customers rule's broad words, pinned for review (PACK-PR-CONDITIONS 2).
  "How many users signed up this week?",
  "What does [customer h_AAAAAAAAAAAAAAAA] need?",
  "Is anyone in the attention queue?",
  "Are members of the ops team online?",
  // P5 follow-up (e) — the narrowed rule: false positives that must NOT route customers ...
  "How many users signed up",
  "members of the ops team",
  "Which users have admin access?",
  "How many new users this month?",
  // ... and genuine customer questions that still must.
  "Which account holders need help?",
  "Show member accounts needing attention",
  "Who recently joined?",
  "Any customers with failed imports?",
  // P6 (PACK-PR-CONDITIONS 2) — the onboarding rule, narrowed: operator "activation" questions must NOT route it ...
  "Did the kill switch activation work?",
  "What is the activation status of the incidents pack?",
  // ... and the onboarding questions still must.
  "How is onboarding going for new customers?",
  "Who left linking without connecting?",
  "Any link failures this week?",
];

/** P6: the onboarding rule's pinned false positives (never onboarding) and true positives (always). */
const ONBOARDING_FALSE_POSITIVES = ["Did the kill switch activation work?", "What is the activation status of the incidents pack?", "How are we looking today?", "Are bank connections healthy? Any reauth needed?"];
const ONBOARDING_TRUE_POSITIVES = [
  "How many imports failed during onboarding this week?", "Any customers with failed imports?", "How is onboarding going for new customers?",
  "Who left linking without connecting?", "Any link failures this week?",
];

/** S2 P5 follow-up (e): the customers rule's pinned false positives (never customers) and true positives (always). */
const CUSTOMERS_FALSE_POSITIVES = [
  "How many users signed up this week?", "How many users signed up", "Are members of the ops team online?",
  "members of the ops team", "Which users have admin access?", "How many new users this month?",
];
const CUSTOMERS_TRUE_POSITIVES = [
  "Which customers need attention?", "What does [customer h_AAAAAAAAAAAAAAAA] need?", "Is anyone in the attention queue?",
  "Which account holders need help?", "Show member accounts needing attention", "Who recently joined?", "Any customers with failed imports?",
];

async function main() {
  const R = await import("./router");
  const { PLATFORM_AI_TOOL_REGISTRY } = await import("../tools/registry");
  const { platformAiToolSchemas, PLATFORM_AI_DENIED_PARAMS } = await import("../core");
  const { NAVIGATION_TARGETS } = await import("@/lib/platform/intelligence/navigation/registry");
  const env = { isPlatformAiEnabled: true, isPlatformAiMemoryEnabled: true };
  const tok = R.estimateSchemaTokens;
  // The widest page-filter key set any binding can produce (every page's params, denied keys removed).
  const WIDEST = [...new Set(NAVIGATION_TARGETS.flatMap((t) => [...t.params]).filter((p) => !PLATFORM_AI_DENIED_PARAMS.includes(p)))].sort();
  const PLANNED = R.ROUTER_RULES.map((r) => r.pack);

  console.log("1. per-pack budgets");
  const core = tok(platformAiToolSchemas(WIDEST, { memory: true }));
  check(`core packs (6 tools, memory on, ${WIDEST.length} filter keys): ${core} ≤ ${R.CORE_SCHEMA_TOKEN_BUDGET} tokens`, core <= R.CORE_SCHEMA_TOKEN_BUDGET);
  const { contractToolSchema } = await import("../tools/contract");
  const nonCore = [...new Set(PLATFORM_AI_TOOL_REGISTRY.map((t) => t.pack as string))].filter((p) => !R.CORE_PACKS.includes(p));
  const packTokens = nonCore.map((p) => tok(PLATFORM_AI_TOOL_REGISTRY.filter((t) => t.pack === p).map((t) => contractToolSchema(t, WIDEST))));
  check(`every declared non-core pack ≤ ${R.PACK_SCHEMA_TOKEN_BUDGET} tokens (declared now: ${nonCore.length})`, packTokens.every((n) => n <= R.PACK_SCHEMA_TOKEN_BUDGET), Object.fromEntries(nonCore.map((p, i) => [p, packTokens[i]])));

  console.log("\n2. the worst case one model call can be offered");
  const more = tok(R.moreToolsSchema(PLANNED));
  const largest = [...packTokens, ...Array(R.ROUTER_MAX_PACKS).fill(R.PACK_SCHEMA_TOKEN_BUDGET)].sort((a, b) => b - a).slice(0, R.ROUTER_MAX_PACKS);
  const worst = core + largest.reduce((a, b) => a + b, 0) + more;
  check(`core ${core} + ${R.ROUTER_MAX_PACKS} packs ${largest.join("+")} + more_tools ${more} = ${worst} ≤ ${R.PLATFORM_AI_SCHEMA_TOKEN_BUDGET}`, worst <= R.PLATFORM_AI_SCHEMA_TOKEN_BUDGET);

  console.log("\n3. the router's actual offer, per question");
  let worstSeen = 0, offers = 0;
  for (const memory of [false, true]) for (const areas of [["PLATFORM_OPS"] as PlatformArea[], ALL]) {
    const router = R.platformAiTurnRouter({ memory }, env);
    for (const q of QUESTIONS) {
      const packs = router.route(q, areas);
      const s = router.schemas({ packs, areas, paramKeys: WIDEST, expandable: router.expandable(packs, areas, 0) });
      worstSeen = Math.max(worstSeen, tok(s));
      offers++;
    }
  }
  check(`${offers} offers (${QUESTIONS.length} questions × memory on/off × 2 scopes): largest ${worstSeen} ≤ ${R.PLATFORM_AI_SCHEMA_TOKEN_BUDGET}`, worstSeen > 0 && worstSeen <= R.PLATFORM_AI_SCHEMA_TOKEN_BUDGET);

  console.log("\n4. router decisions (pinned)");
  // Every planned pack declared, one synthetic all-area tool each (test-only), flags ON: the RULE TABLE's decisions.
  const synthetic: PlatformAiTool[] = [...PLATFORM_AI_TOOL_REGISTRY, ...PLANNED.map((p) => ({
    ...PLATFORM_AI_TOOL_REGISTRY[0], name: `syn_${p}`, pack: p, description: "synthetic (test-only)", args: { properties: {} },
  }) as unknown as PlatformAiTool)];
  const ruled = { registry: synthetic, declared: [...R.CORE_PACKS, ...PLANNED], enabled: () => true };
  const decisions = (deps: Parameters<typeof R.routePlatformAiPacks>[2]) =>
    Object.fromEntries(QUESTIONS.map((q) => [q, R.routePlatformAiPacks({ question: q, areas: ALL, memory: true }, env, deps).join(",")]));
  const current = JSON.stringify({
    note: "Platform AI router decisions (engine/router.ts) for a fixed question list, every area in scope, memory on. Update deliberately: UPDATE_PLATFORM_AI_ROUTER_SNAPSHOT=1 (see schema-budget.test.ts).",
    today: decisions({}),
    everyPlannedPackDeclared: decisions(ruled),
    customersPackOn: decisions({ enabled: (p: string) => R.CORE_PACKS.includes(p) || p === "customers" }),
    incidentsPackOn: decisions({ enabled: (p: string) => R.CORE_PACKS.includes(p) || p === "incidents" }),
    onboardingPackOn: decisions({ enabled: (p: string) => R.CORE_PACKS.includes(p) || p === "onboarding" }),
  }, null, 2) + "\n";
  if (process.env.UPDATE_PLATFORM_AI_ROUTER_SNAPSHOT === "1") { writeFileSync(SNAPSHOT, current); console.log("  (snapshot written)"); }
  const pinned = existsSync(SNAPSHOT) ? readFileSync(SNAPSHOT, "utf8") : null;
  check("router decisions equal the committed snapshot", pinned === current, pinned === null ? "snapshot missing" : "differs — review, then UPDATE_PLATFORM_AI_ROUTER_SNAPSHOT=1");
  check("today: every question routes exactly the core packs", Object.values(decisions({})).every((v) => v === "metrics,navigation,memory"));

  console.log("\n5. P5 — the customers pack declared, flag ON (PACK-PR-CONDITIONS 2)");
  const today = decisions({});
  const withCustomers = decisions({ enabled: (p: string) => R.CORE_PACKS.includes(p) || p === "customers" });
  const rule = R.ROUTER_RULES.find((r) => r.pack === "customers")!.match;
  const unrelated = QUESTIONS.filter((q) => !rule.test(q));
  check(`${unrelated.length} questions the customers rule does not match: routed exactly as today`, unrelated.length >= 10 && unrelated.every((q) => withCustomers[q] === today[q]),
    unrelated.filter((q) => withCustomers[q] !== today[q]));
  check("matched questions: the core packs + customers only (the router only OFFERS; invokeTool stays the authority)",
    QUESTIONS.filter((q) => rule.test(q)).every((q) => withCustomers[q] === "metrics,navigation,memory,customers"));
  const fp = CUSTOMERS_FALSE_POSITIVES.filter((q) => !QUESTIONS.includes(q) || rule.test(q) || withCustomers[q].split(",").includes("customers"));
  check(`P5 follow-up (e): ${CUSTOMERS_FALSE_POSITIVES.length} bare users/members questions never route customers (pack ON)`, fp.length === 0, fp);
  const tp = CUSTOMERS_TRUE_POSITIVES.filter((q) => !QUESTIONS.includes(q) || !rule.test(q) || !withCustomers[q].split(",").includes("customers"));
  check(`P5 follow-up (e): ${CUSTOMERS_TRUE_POSITIVES.length} genuine customer questions still route customers (pack ON)`, tp.length === 0, tp);
  check("a resolved subject marker ([customer h_…]) routes the customers pack", withCustomers["What does [customer h_AAAAAAAAAAAAAAAA] need?"] === "metrics,navigation,memory,customers");
  const outOfScope = R.routePlatformAiPacks({ question: "Which customers need attention?", areas: ["PLATFORM_OPS"], memory: true }, env, { enabled: () => true }).join();
  check("an operator without the CUSTOMER_SUCCESS area is never offered the customers pack", outOfScope === "metrics,navigation,memory", outOfScope);

  console.log("\n6. P8 — the incidents pack declared, flag ON (PACK-PR-CONDITIONS 1 / 3)");
  const withIncidents = decisions({ enabled: (p: string) => R.CORE_PACKS.includes(p) || p === "incidents" });
  const iRule = R.ROUTER_RULES.find((r) => r.pack === "incidents")!.match;
  const iUnrelated = QUESTIONS.filter((q) => !iRule.test(q));
  check(`${iUnrelated.length} questions the incidents rule does not match: routed exactly as today`, iUnrelated.length >= 10 && iUnrelated.every((q) => withIncidents[q] === today[q]),
    iUnrelated.filter((q) => withIncidents[q] !== today[q]));
  check("matched questions: the core packs + incidents only (the router only OFFERS; invokeTool stays the authority)",
    QUESTIONS.filter((q) => iRule.test(q)).length >= 2 && QUESTIONS.filter((q) => iRule.test(q)).every((q) => withIncidents[q] === "metrics,navigation,memory,incidents"));
  const marker = R.routePlatformAiPacks({ question: "What happened with [incident h_AAAAAAAAAAAAAAAA]?", areas: ALL, memory: true }, env, { enabled: (p: string) => R.CORE_PACKS.includes(p) || p === "incidents" }).join();
  check("a resolved incident subject marker ([incident h_…]) routes the incidents pack", marker === "metrics,navigation,memory,incidents", marker);
  const noArea = R.routePlatformAiPacks({ question: "Any open incidents right now?", areas: ["GROWTH_REVENUE"], memory: true }, env, { enabled: () => true }).join();
  check("an operator with neither PLATFORM_OPS nor CUSTOMER_SUCCESS is never offered the incidents pack", noArea === "metrics,navigation,memory", noArea);
  const flagOff = R.routePlatformAiPacks({ question: "Any open incidents right now?", areas: ALL, memory: true }, env).join();
  check("flag unset (the live env here) ⇒ the incidents pack is never offered", flagOff === "metrics,navigation,memory", flagOff);

  console.log("\n7. P6 — the onboarding pack declared, flag ON (PACK-PR-CONDITIONS 1 / 2 / 3)");
  const withOnboarding = decisions({ enabled: (p: string) => R.CORE_PACKS.includes(p) || p === "onboarding" });
  const oRule = R.ROUTER_RULES.find((r) => r.pack === "onboarding")!.match;
  const oUnrelated = QUESTIONS.filter((q) => !oRule.test(q));
  check(`${oUnrelated.length} questions the onboarding rule does not match: routed exactly as today`, oUnrelated.length >= 10 && oUnrelated.every((q) => withOnboarding[q] === today[q]),
    oUnrelated.filter((q) => withOnboarding[q] !== today[q]));
  check("matched questions: the core packs + onboarding only (the router only OFFERS; invokeTool stays the authority)",
    QUESTIONS.filter((q) => oRule.test(q)).length >= 4 && QUESTIONS.filter((q) => oRule.test(q)).every((q) => withOnboarding[q] === "metrics,navigation,memory,onboarding"));
  const ofp = ONBOARDING_FALSE_POSITIVES.filter((q) => !QUESTIONS.includes(q) || oRule.test(q) || withOnboarding[q].split(",").includes("onboarding"));
  check(`${ONBOARDING_FALSE_POSITIVES.length} activation / status / connection questions never route onboarding (pack ON)`, ofp.length === 0, ofp);
  const otp = ONBOARDING_TRUE_POSITIVES.filter((q) => !QUESTIONS.includes(q) || !oRule.test(q) || !withOnboarding[q].split(",").includes("onboarding"));
  check(`${ONBOARDING_TRUE_POSITIVES.length} onboarding questions route onboarding (pack ON)`, otp.length === 0, otp);
  // The OPS aggregate is callable with PLATFORM_OPS alone (counts only); the CS record tools need CUSTOMER_SUCCESS.
  const onbOn = { enabled: (p: string) => R.CORE_PACKS.includes(p) || p === "onboarding" };
  const opsOnly = R.routePlatformAiPacks({ question: "How is onboarding going for new customers?", areas: ["PLATFORM_OPS"], memory: true }, env, onbOn).join();
  check("a PLATFORM_OPS-only operator is offered the onboarding pack (its AGGREGATE tool is callable there)", opsOnly === "metrics,navigation,memory,onboarding", opsOnly);
  const opsSchemas = R.platformAiOfferedSchemas({ packs: ["metrics", "navigation", "onboarding"], areas: ["PLATFORM_OPS"], memory: false, paramKeys: [], expandable: [] }) as { function: { name: string } }[];
  check("…but only the aggregate: the CS record tools are never offered without CUSTOMER_SUCCESS",
    opsSchemas.some((x) => x.function.name === "onboarding_overview") && !opsSchemas.some((x) => ["list_onboarding_attention", "get_onboarding_timeline"].includes(x.function.name)));
  const growthOnly = R.routePlatformAiPacks({ question: "How is onboarding going for new customers?", areas: ["GROWTH_REVENUE"], memory: true }, env, { enabled: () => true }).join();
  check("an operator with neither PLATFORM_OPS nor CUSTOMER_SUCCESS is never offered the onboarding pack", growthOnly === "metrics,navigation,memory", growthOnly);
  const oFlagOff = R.routePlatformAiPacks({ question: "How is onboarding going for new customers?", areas: ALL, memory: true }, env).join();
  check("flag unset (the live env here) ⇒ the onboarding pack is never offered", oFlagOff === "metrics,navigation,memory", oFlagOff);

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
