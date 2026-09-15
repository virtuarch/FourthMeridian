/**
 * lib/platform/ai/invocations-core.test.ts  (PLATFORM OPS OBSERVABILITY)
 *
 * The AI operations fold reconciles to the authority by construction:
 *   · counts and token totals are exact sums of the groups;
 *   · dollars equal `priceAiUsage` over the same (provider, model, day) rows,
 *     with cached tokens priced at the cached rate — never a second formula;
 *   · an unknown model is unpriced (usd null, tokens counted as unpriced),
 *     never zero; cache share is null without prompt tokens;
 *   · buckets partition the total: every bucket family sums back to it.
 */

import { buildAiOperations, parseAiWindow, windowStart, type InvocationGroup, UNATTRIBUTED_SURFACE } from "./invocations-core";
import { priceAiUsage } from "@/lib/usage/pricing";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) < 1e-9;

function group(over: Partial<InvocationGroup>): InvocationGroup {
  return {
    provider: "OPENAI", model: "gpt-5.1", surface: "chat", environment: "development", day: "2026-09-15",
    invocations: 10, promptTokens: 100_000, cachedPromptTokens: 80_000, completionTokens: 5_000,
    reasoningTokens: 1_000, toolCalls: 12, latencyMsTotal: 20_000, latencyMsMax: 4_000, ...over,
  };
}

const groups: InvocationGroup[] = [
  group({}),
  group({ surface: "brief", invocations: 2, promptTokens: 30_000, cachedPromptTokens: 0, completionTokens: 2_000, reasoningTokens: 0, toolCalls: 0, latencyMsTotal: 9_000, latencyMsMax: 6_000 }),
  group({ surface: null, model: "gpt-5-mini", day: "2026-09-14", invocations: 3, promptTokens: 3_000, cachedPromptTokens: 1_000, completionTokens: 300, reasoningTokens: 0, toolCalls: 1, latencyMsTotal: 1_500, latencyMsMax: 700 }),
  group({ surface: "harness", model: "unknown-model", environment: "production", invocations: 1, promptTokens: 1_000, cachedPromptTokens: 0, completionTokens: 100, reasoningTokens: 0, toolCalls: 0, latencyMsTotal: 500, latencyMsMax: 500 }),
];

console.log("totals · exact sums");
{
  const r = buildAiOperations(groups);
  check("invocations = 16", r.totals.invocations === 16);
  check("prompt tokens sum", r.totals.promptTokens === 134_000);
  check("cached tokens sum", r.totals.cachedPromptTokens === 81_000);
  check("completion tokens sum", r.totals.completionTokens === 7_400);
  check("reasoning tokens sum", r.totals.reasoningTokens === 1_000);
  check("tool calls sum", r.totals.toolCalls === 13);
  check("mean latency = total ÷ invocations", r.totals.meanLatencyMs === Math.round(31_000 / 16));
  check("max latency", r.totals.maxLatencyMs === 6_000);
  check("cache share = cached ÷ prompt", near(r.totals.cacheShare, 81_000 / 134_000));
  check("unpriced tokens = the unknown model's prompt + completion", r.totals.unpricedTokens === 1_100);
}

console.log("dollars · the one rate card");
{
  const r = buildAiOperations(groups);
  const rows = groups.flatMap((g) => [
    { provider: g.provider, metric: `chat.completions:${g.model}`, unit: "prompt_tokens", day: g.day, count: g.promptTokens },
    { provider: g.provider, metric: `chat.completions:${g.model}`, unit: "cached_prompt_tokens", day: g.day, count: g.cachedPromptTokens },
    { provider: g.provider, metric: `chat.completions:${g.model}`, unit: "completion_tokens", day: g.day, count: g.completionTokens },
  ]);
  const authority = priceAiUsage(rows);
  check("totals.usd equals priceAiUsage over the same rows", near(r.totals.usd, authority.usd), `${r.totals.usd} vs ${authority.usd}`);
  // gpt-5.1 on 2026-09-15: uncached 1.25/M, cached 0.125/M, output 10/M
  const chat = r.bySurface.find((b) => b.key === "chat")!;
  const expectedChat = (20_000 * 1.25 + 80_000 * 0.125 + 5_000 * 10) / 1_000_000;
  check("cached tokens are priced at the cached rate (subset-aware)", near(chat.usd, expectedChat), `${chat.usd}`);
  const unknown = r.byModel.find((b) => b.key === "OPENAI:unknown-model")!;
  check("an unknown model is unpriced: usd null, never 0", unknown.usd === null && unknown.unpricedTokens === 1_100);
  check("a partially priced total is still a number", r.totals.usd !== null);
  const none = buildAiOperations([group({ model: "unknown-model" })]);
  check("nothing priced ⇒ totals.usd null", none.totals.usd === null);
  check("no prompt tokens ⇒ cache share null", buildAiOperations([group({ promptTokens: 0, cachedPromptTokens: 0 })]).totals.cacheShare === null);
}

console.log("buckets · partitions of the total");
{
  const r = buildAiOperations(groups);
  const sum = (b: readonly { invocations: number; promptTokens: number }[]) => b.reduce((a, x) => a + x.invocations, 0);
  check("bySurface sums to the total", sum(r.bySurface) === 16);
  check("byModel sums to the total", sum(r.byModel) === 16);
  check("byEnvironment sums to the total", sum(r.byEnvironment) === 16);
  check("byDay sums to the total", sum(r.byDay) === 16);
  check("an unattributed surface is a named bucket, not dropped", r.bySurface.some((b) => b.key === UNATTRIBUTED_SURFACE && b.invocations === 3));
  check("surfaces ordered by usd desc", r.bySurface[0].key === "chat");
  check("days ordered by key", r.byDay.map((d) => d.key).join(",") === "2026-09-14,2026-09-15");
  const usdSum = r.bySurface.reduce((a, b) => a + (b.usd ?? 0), 0);
  check("bucket dollars sum to the total dollars", near(usdSum, r.totals.usd));
}

console.log("windows");
{
  check("default window is 7d", parseAiWindow(null) === "7d" && parseAiWindow("bogus") === "7d");
  check("24h honoured", parseAiWindow("24h") === "24h");
  const now = new Date("2026-09-15T12:00:00.000Z");
  check("30d start", windowStart("30d", now).toISOString() === "2026-08-16T12:00:00.000Z");
  check("24h start", windowStart("24h", now).toISOString() === "2026-09-14T12:00:00.000Z");
}

console.log("empty");
{
  const r = buildAiOperations([]);
  check("no groups ⇒ zero counts, null usd, null latency, no buckets",
    r.totals.invocations === 0 && r.totals.usd === null && r.totals.meanLatencyMs === null && r.bySurface.length === 0);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
