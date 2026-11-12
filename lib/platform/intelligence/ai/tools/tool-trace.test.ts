/**
 * lib/platform/intelligence/ai/tools/tool-trace.test.ts  (S2 09hu G1 — the response's metadata-only tool trace)
 *
 * Pins tools/tool-trace.ts:
 *   · THE CLOSED KEY SET: every entry has exactly { tool, pack, tier, outcome, calls } — adding a key fails here;
 *   · the closed outcome set and the documented mapping from every PlatformAiTraceStep outcome (+ the boundary's
 *     `refused` flag);
 *   · no value can carry a record id, ref, handle, argument or model text: tool ∈ registry ∪ {more_tools, unknown},
 *     pack ∈ TOOL_PACKS ∪ {meta}, tier ∈ TOOL_TIERS ∪ {NONE}, calls a positive integer (a fuzz over hostile steps);
 *   · aggregation per (tool, outcome);
 *   · the wiring: the ask route and the conversations' turn runner both attach it, the handler splits it off
 *     BEFORE the settle (nothing stored), no operator-specific branch exists, and the conversations client
 *     ignores the extra field.
 * No database, no network, no env.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/tools/tool-trace.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { PlatformAiTraceStep } from "../core";
import { TOOL_PACKS, TOOL_TIERS } from "./contract";
import { PLATFORM_AI_REGISTERED_TOOLS } from "./registry";
import {
  TOOL_TRACE_KEYS, TOOL_TRACE_OUTCOMES, platformAiToolTrace, toolTraceOutcome,
  type PlatformAiToolTraceEntry,
} from "./tool-trace";
import { parsePair } from "@/components/platform/platform-ai-conversations-model";

let failures = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const step = (tool: string, outcome: string, extra: Record<string, unknown> = {}) => ({ tool, outcome, refs: [], ...extra }) as unknown as PlatformAiTraceStep;

const ALLOWED_TOOLS = new Set<string>([...PLATFORM_AI_REGISTERED_TOOLS, "more_tools", "unknown"]);
const ALLOWED_PACKS = new Set<string>([...TOOL_PACKS, "meta"]);
const ALLOWED_TIERS = new Set<string>([...TOOL_TIERS, "NONE"]);
const valid = (e: PlatformAiToolTraceEntry) =>
  JSON.stringify(Object.keys(e)) === JSON.stringify([...TOOL_TRACE_KEYS])
  && ALLOWED_TOOLS.has(e.tool) && ALLOWED_PACKS.has(e.pack) && ALLOWED_TIERS.has(e.tier)
  && (TOOL_TRACE_OUTCOMES as readonly string[]).includes(e.outcome) && Number.isSafeInteger(e.calls) && e.calls >= 1;

console.log("\nG1 — the closed key set and the closed outcome set\n");
check("TOOL_TRACE_KEYS is EXACTLY tool, pack, tier, outcome, calls (adding a key is a deliberate S2 change)",
  JSON.stringify(TOOL_TRACE_KEYS) === JSON.stringify(["tool", "pack", "tier", "outcome", "calls"]));
check("TOOL_TRACE_OUTCOMES is EXACTLY ok, refused, not_found, unavailable",
  JSON.stringify(TOOL_TRACE_OUTCOMES) === JSON.stringify(["ok", "refused", "not_found", "unavailable"]));
{
  const t = platformAiToolTrace([step("get_metric", "MEASURED", { refs: ["incident-broken-now@1"], drillLink: true, count: 3, windowIgnored: true, unavailable: "WINDOW_NOT_OFFERED" })]);
  check("an entry has exactly the closed key set — refs / count / drillLink / windowIgnored / unavailable are dropped",
    t.length === 1 && JSON.stringify(Object.keys(t[0])) === JSON.stringify([...TOOL_TRACE_KEYS]), t);
  check("…and the entry is frozen (no key can be added downstream)", Object.isFrozen(t[0]));
}

console.log("\nG1 — the outcome mapping (every trace outcome)\n");
{
  const expect: Record<string, string> = {
    OK: "ok", MEASURED: "ok", ESTIMATED: "ok", PARTIAL: "ok", UNAVAILABLE: "unavailable",
    NOT_FOUND: "not_found", INVALID_ARGS: "refused", BUDGET: "refused",
  };
  for (const [o, want] of Object.entries(expect)) check(`${o} → ${want}`, toolTraceOutcome(step("get_metric", o)) === want);
  check("NOT_FOUND flagged `refused` by the boundary → refused", toolTraceOutcome(step("list_incidents", "NOT_FOUND", { refused: true })) === "refused");
  check("an outcome outside the type (impossible) never reads ok", toolTraceOutcome(step("get_metric", "SOMETHING")) === "unavailable");
}

console.log("\nG1 — registry-only values; nothing from the model, no ref / id / handle\n");
{
  const t = platformAiToolTrace([step("get_metric", "MEASURED"), step("find_page", "OK"), step("investigate_incident", "OK"), step("get_customer_profile", "NOT_FOUND", { refused: true }), step("more_tools", "OK")]);
  check("registered tools carry their registry pack and tier; more_tools is meta / NONE",
    JSON.stringify(t.map((e) => `${e.tool}|${e.pack}|${e.tier}|${e.outcome}`)) === JSON.stringify([
      "get_metric|metrics|OPS|ok", "find_page|navigation|OPS|ok", "investigate_incident|incidents|OPS|ok", "get_customer_profile|customers|CUSTOMER_SUCCESS|refused", "more_tools|meta|NONE|ok",
    ]), t);
  const hostile = ["h_AAAAAAAAAAAAAAAA", "cabc123def456ghi789jkl0mn", "someone@example.org", "incident-broken-now@1", "get_customer'; drop", "{{m:x}}", "a".repeat(300)];
  const t2 = platformAiToolTrace(hostile.map((x) => step(x, "OK", { refs: [x], count: 7 })));
  check("a tool name outside the registry reads `unknown` (never the model's text), meta / NONE",
    t2.length === 1 && t2[0].tool === "unknown" && t2[0].pack === "meta" && t2[0].tier === "NONE" && t2[0].calls === hostile.length, t2);
  check("no hostile string (handle, cuid, e-mail, metric key, injection) survives anywhere in the JSON", !hostile.some((x) => JSON.stringify(t2).includes(x)));

  // Fuzz: random steps with random tool names (registered, meta, hostile), outcomes, flags and refs.
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const names = [...PLATFORM_AI_REGISTERED_TOOLS, "more_tools", "unknown", ...hostile];
  const outcomes = ["OK", "MEASURED", "ESTIMATED", "PARTIAL", "UNAVAILABLE", "NOT_FOUND", "INVALID_ARGS", "BUDGET"];
  let allValid = true, leaked = false, total = 0;
  for (let i = 0; i < 300; i++) {
    const steps = Array.from({ length: 1 + rnd(12) }, () => step(names[rnd(names.length)], outcomes[rnd(outcomes.length)], { refs: [hostile[rnd(hostile.length)]], ...(rnd(3) === 0 ? { refused: true } : {}) }));
    const out = platformAiToolTrace(steps);
    total += steps.length;
    if (!out.every(valid)) allValid = false;
    if (hostile.some((x) => JSON.stringify(out).includes(x))) leaked = true;
    if (out.reduce((a, e) => a + e.calls, 0) !== steps.length) allValid = false;
  }
  check(`fuzz (${total} steps): every entry valid (closed keys, registry tool / pack / tier, closed outcome, calls ≥ 1) and calls sum to the steps`, allValid);
  check("fuzz: no ref / id / handle / model text ever reaches the trace", !leaked);
  check("not an array (defensive) ⇒ []", platformAiToolTrace(null as never).length === 0);
}

console.log("\nG1 — aggregation per (tool, outcome)\n");
{
  const t = platformAiToolTrace([step("get_metric", "MEASURED"), step("get_metric", "PARTIAL"), step("get_metric", "UNAVAILABLE"), step("find_page", "OK"), step("get_metric", "BUDGET")]);
  check("get_metric ok ×2, unavailable ×1, find_page ok ×1, get_metric refused ×1 — first-seen order",
    JSON.stringify(t.map((e) => `${e.tool}:${e.outcome}×${e.calls}`)) === JSON.stringify(["get_metric:ok×2", "get_metric:unavailable×1", "find_page:ok×1", "get_metric:refused×1"]), t);
  check("an empty turn ⇒ []", platformAiToolTrace([]).length === 0);
}

console.log("\nG1 — wiring: both routes, response only, no per-operator branch, the client tolerates it\n");
{
  const ask = code(read("app/api/platform/ai/ask/route.ts"));
  check("the ask route passes the projection to the handler", /toolTrace: platformAiToolTrace,/.test(ask));
  const core = code(read("lib/platform/intelligence/ai/core.ts"));
  check("core.ts adds it to the 200 body from the turn's metadata trace (and imports no registry)",
    /const \{ trace, \.\.\.answer \} = result;/.test(core) && /body: \{ \.\.\.answer, \.\.\.\(deps\.toolTrace \? \{ toolTrace: deps\.toolTrace\(trace\) \} : \{\}\) \}/.test(core)
    && !/tools\/registry|tools\/tool-trace/.test(core));
  const runner = code(read("app/api/platform/ai/conversations/turn-runner.ts"));
  check("the conversations' turn runner computes it from the turn's metadata trace", /const toolTrace = platformAiToolTrace\(run\.result\?\.trace \?\? \[\]\);/.test(runner));
  const h = code(read("lib/platform/intelligence/ai/conversations/handlers.ts"));
  const rs = h.slice(h.indexOf("async function runAndSettle("), h.indexOf("async function admit("));
  // B1: the same destructure also splits off figureSources (tools/figure-sources.test.ts).
  const split = "const { toolTrace, figureSources, ...outcome } = run;";
  check("the handler splits the trace off BEFORE the settle (the stored outcome never carries it)",
    rs.indexOf(split) > 0 && rs.indexOf(split) < rs.indexOf("settleTurn(v.operatorId, conversationId, pair.assistant.id, outcome)"), rs);
  check("create AND append responses carry the trace of the turn they ran (a replay carries none)",
    (h.match(/pairResponse\(\d+, [^;]*r\.memoryProposal, r\.toolTrace, r\.figureSources\)/g) ?? []).length === 2);
  const store = code(read("lib/platform/intelligence/ai/conversations/store.ts"));
  check("the conversations store never mentions a tool trace (persist nothing new)", !/toolTrace/.test(store));
  const src = code(read("lib/platform/intelligence/ai/tools/tool-trace.ts"));
  check("the projection has no operator / synthetic / env branch (identical for every operator)", !/operator|synthetic|process\.env|@\/lib\/env|userId|role/i.test(src));
  const pair = { userMessage: { id: "u1", role: "USER", status: "COMPLETE", createdAt: "2026-11-12T00:00:00.000Z", completedAt: null, content: "q", citations: [], notes: [], failureCode: null, unavailable: false, stale: false },
    assistantMessage: { id: "a1", role: "ASSISTANT", status: "COMPLETE", createdAt: "2026-11-12T00:00:00.000Z", completedAt: null, content: [{ kind: "text", text: "a" }], citations: [], notes: [], failureCode: null, unavailable: false, stale: false } };
  const without = parsePair(pair);
  const withTrace = parsePair({ ...pair, toolTrace: platformAiToolTrace([step("get_metric", "MEASURED")]) });
  check("the conversations client parses a pair the same with or without toolTrace (the field is ignored)", without !== null && JSON.stringify(without) === JSON.stringify(withTrace), { without, withTrace });
}

if (failures) { console.error(`\n${failures} check(s) failed, ${passed} passed`); process.exit(1); }
console.log(`\nall ${passed} checks passed`);
