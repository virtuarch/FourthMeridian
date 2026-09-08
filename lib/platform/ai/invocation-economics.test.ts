/**
 * lib/platform/ai/invocation-economics.test.ts  (cost Slice 3)
 *
 * Invocation → turn → session economics. Standalone tsx, no DB, no network.
 * The write path is exercised against an injected client so the exactly-once and
 * data-minimisation properties are proven without a database.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  rollUp, byTurn, bySession, byModel, byDay, byEnvironment,
  priceInvocation, invocationUsageRows, type InvocationFact,
} from "@/lib/platform/ai/invocation-economics";
import { recordAiInvocation, type AiInvocationWriteClient } from "@/lib/ai/invocation";
import { runWithAiInvocationContext } from "@/lib/ai/invocation-context";
import type { AiRate } from "@/lib/usage/pricing";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const near = (a: number | null, b: number, eps = 1e-9) => a !== null && Math.abs(a - b) < eps;

const RATES: AiRate[] = [
  { provider: "OPENAI", model: "m", effectiveFrom: "2026-06-01", source: "fixture",
    usdPerMillion: { input: 10, cachedInput: 1, output: 100 } },
];
let seq = 0;
function inv(over: Partial<InvocationFact> = {}): InvocationFact {
  seq++;
  return {
    provider: "OPENAI", model: "m", occurredAt: "2026-06-15",
    promptTokens: 1_000_000, cachedPromptTokens: 0, completionTokens: 0, reasoningTokens: 0,
    latencyMs: 100, toolCallCount: 0, environment: "production",
    correlationId: "sessA", turnIndex: 0, surface: "chat", ...over,
  };
}

async function main() {
console.log("1. the write is one immutable insert per invocation");
{
  const writes: Record<string, unknown>[] = [];
  const client: AiInvocationWriteClient = { aiInvocation: { create: async (a) => { writes.push(a.data); return {}; } } };
  const usage = { prompt_tokens: 25_967, completion_tokens: 491,
    prompt_tokens_details: { cached_tokens: 25_216 },
    completion_tokens_details: { reasoning_tokens: 184 } };

  await recordAiInvocation({ provider: "OPENAI", model: "gpt-5.5", usage, latencyMs: 1234,
    toolCallCount: 2, finishReason: "stop", occurredAt: new Date("2026-09-09T10:00:00Z") }, client);
  check("one invocation persists exactly one row", writes.length === 1);

  const w = writes[0];
  check("provider usage is preserved exactly, field for field",
    w.promptTokens === 25_967 && w.cachedPromptTokens === 25_216
      && w.completionTokens === 491 && w.reasoningTokens === 184);
  check("subset semantics survive the write (cached ⊆ prompt, reasoning ⊆ completion)",
    (w.cachedPromptTokens as number) <= (w.promptTokens as number)
      && (w.reasoningTokens as number) <= (w.completionTokens as number));
  check("model attribution is exact, not parsed from a metric string", w.model === "gpt-5.5");
  check("operational facts are kept", w.latencyMs === 1234 && w.toolCallCount === 2 && w.finishReason === "stop");
  check("environment is stamped at write time", typeof w.environment === "string" && (w.environment as string).length > 0);

  // ⚠️ NO DERIVED VALUE IS STORED — a stored derivation can drift from its parts.
  check("no derived token field is persisted",
    !("uncachedPromptTokens" in w) && !("totalTokens" in w));
  // ⚠️ NO DOLLARS — a stored cost freezes a price into a fact.
  check("no dollar cost is persisted",
    !Object.keys(w).some((k) => /usd|cost|price/i.test(k)), Object.keys(w).join(","));
  // ⚠️ NO CONTENT — telemetry, not conversation memory.
  check("no prompt, response, tool payload, financial value or account id is persisted",
    !Object.keys(w).some((k) => /prompt$|message|content|text|tool.*(arg|result)|balance|amount|account|user|space/i.test(k)),
    Object.keys(w).join(","));

  // A failing write must never surface to the caller.
  const boom: AiInvocationWriteClient = { aiInvocation: { create: async () => { throw new Error("db down"); } } };
  let threw = false;
  try { await recordAiInvocation({ provider: "OPENAI", model: "m", usage, latencyMs: 1 }, boom); }
  catch { threw = true; }
  check("a ledger failure never breaks the generation", !threw);
}

console.log("2. correlation comes from ambient context");
{
  const writes: Record<string, unknown>[] = [];
  const client: AiInvocationWriteClient = { aiInvocation: { create: async (a) => { writes.push(a.data); return {}; } } };
  const usage = { prompt_tokens: 10, completion_tokens: 5 };

  await runWithAiInvocationContext({ correlationId: "sess-1", turnIndex: 3, surface: "harness" },
    () => recordAiInvocation({ provider: "OPENAI", model: "m", usage, latencyMs: 1 }, client));
  check("context supplies the grouping keys",
    writes[0].correlationId === "sess-1" && writes[0].turnIndex === 3 && writes[0].surface === "harness");

  // ⚠️ AN UNCORRELATED CALL IS STILL BILLABLE — unlike Plaid's ProviderCall, it
  // is recorded rather than skipped. Cost does not depend on being groupable.
  await recordAiInvocation({ provider: "OPENAI", model: "m", usage, latencyMs: 1 }, client);
  check("an invocation with no context is still recorded", writes.length === 2);
  check("…with null correlation rather than a fabricated one",
    !("correlationId" in writes[1]) && !("turnIndex" in writes[1]));
}

console.log("3. a multi-invocation turn groups correctly");
{
  // One turn, three invocations — the shape a tool loop actually produces.
  const turn = [
    inv({ turnIndex: 0, toolCallCount: 2, promptTokens: 1_000_000 }),
    inv({ turnIndex: 0, toolCallCount: 1, promptTokens: 2_000_000 }),
    inv({ turnIndex: 0, toolCallCount: 0, promptTokens: 3_000_000 }),
  ];
  const turns = byTurn(turn, RATES);
  check("three invocations of one turn make ONE turn row", turns.length === 1);
  check("…counting every invocation exactly once", turns[0].invocations === 3);
  check("…and summing their tool calls", turns[0].toolCalls === 3);

  // ⚠️ THE IDENTITY. Turn cost must equal the sum of its invocations' costs.
  const each = turn.map((i) => priceInvocation(i, RATES).usd as number);
  check("turn cost = Σ invocation costs",
    near(turns[0].usd, each.reduce((a, b) => a + b, 0)) && near(turns[0].usd, 60));

  const sessions = bySession(turn, RATES);
  check("session cost = Σ turn costs", sessions.length === 1 && near(sessions[0].usd, turns[0].usd as number));
}

console.log("4. sessions and turns cannot cross-group");
{
  const mixed = [
    inv({ correlationId: "A", turnIndex: 0, promptTokens: 1_000_000 }),
    inv({ correlationId: "A", turnIndex: 1, promptTokens: 2_000_000 }),
    inv({ correlationId: "B", turnIndex: 0, promptTokens: 4_000_000 }),
  ];
  const turns = byTurn(mixed, RATES);
  check("same turnIndex in different sessions stays separate", turns.length === 3);
  const sessions = bySession(mixed, RATES);
  check("two sessions, not one", sessions.length === 2);
  const a = sessions.find((s) => s.correlationId === "A")!;
  const b = sessions.find((s) => s.correlationId === "B")!;
  check("session A sums only its own turns", near(a.usd, 30) && a.invocations === 2);
  check("session B is untouched by A", near(b.usd, 40) && b.invocations === 1);
  check("the whole set still sums to the parts", near(rollUp(mixed, RATES).usd, (a.usd as number) + (b.usd as number)));

  // An invocation with no correlation is skipped at the turn grain but is NOT lost.
  const withOrphan = [...mixed, inv({ correlationId: null, turnIndex: null, promptTokens: 1_000_000 })];
  check("an ungroupable invocation does not appear in any turn", byTurn(withOrphan, RATES).length === 3);
  check("…but is still counted in the total", rollUp(withOrphan, RATES).invocations === 4);
  check("…and still costs money", near(rollUp(withOrphan, RATES).usd, 80));
}

console.log("5. retries neither overwrite nor double-count");
{
  // A retried request that eventually succeeds is a SEPARATE billable request.
  // The write path only runs on a response carrying usage, so a failed attempt
  // writes nothing at all — nothing exists to be overwritten.
  const src = code(read("lib/ai/invocation.ts"));
  check("every write is an insert — nothing is updated or upserted",
    /aiInvocation\.create\(/.test(src) && !/update|upsert|delete/.test(src));
  const provider = code(read("lib/ai/provider.ts"));
  check("the fact is written only after usage is returned",
    /if \(!usage\) return;/.test(provider));
  check("…from the ONE chokepoint every generator already uses",
    (provider.match(/recordAiInvocation\(/g) ?? []).length === 1
      && (provider.match(/recordOpenAiUsage\(\{/g) ?? []).length === 3);

  // Two successful invocations in one turn are two rows, not one overwritten row.
  const retried = [inv({ turnIndex: 7, promptTokens: 1_000_000 }), inv({ turnIndex: 7, promptTokens: 1_000_000 })];
  const t = byTurn(retried, RATES)[0];
  check("two successful attempts count twice, not once", t.invocations === 2 && near(t.usd, 20));
}

console.log("6. cost is derived through the Slice 2 authority");
{
  // Subset-aware input, inherited — not reimplemented.
  const cached = inv({ promptTokens: 1_000_000, cachedPromptTokens: 900_000 });
  check("cached input is priced at its own rate, not added to the prompt",
    near(priceInvocation(cached, RATES).usd, (100_000 * 10 + 900_000 * 1) / 1e6));
  const reasoning = inv({ promptTokens: 0, completionTokens: 1_000_000, reasoningTokens: 700_000 });
  check("reasoning tokens add no cost", near(priceInvocation(reasoning, RATES).usd, 100));
  check("…and are not emitted as a priced row",
    !invocationUsageRows(reasoning).some((r) => r.unit === "reasoning_tokens"));

  // ⚠️ EFFECTIVE-DATED: the rate at occurredAt, not today's rate.
  const versioned: AiRate[] = [...RATES,
    { provider: "OPENAI", model: "m", effectiveFrom: "2026-08-01", source: "fixture",
      usdPerMillion: { input: 20, cachedInput: 2, output: 200 } }];
  check("an invocation is priced at the rate effective on its own day",
    near(priceInvocation(inv({ occurredAt: "2026-06-15" }), versioned).usd, 10)
      && near(priceInvocation(inv({ occurredAt: "2026-08-15" }), versioned).usd, 20));
  check("adding a later rate does not reprice an earlier invocation",
    near(priceInvocation(inv({ occurredAt: "2026-06-15" }), versioned).usd,
         priceInvocation(inv({ occurredAt: "2026-06-15" }), RATES).usd as number));

  // ⚠️ UNPRICED IS NOT ZERO.
  const old = inv({ occurredAt: "2020-01-01" });
  check("an invocation predating every rate is unpriced, not zero", priceInvocation(old, RATES).usd === null);
  const mixedDates = rollUp([old, inv({ occurredAt: "2026-06-15" })], RATES);
  check("a rollup reports what it could not price", mixedDates.unpricedInvocations === 1 && near(mixedDates.usd, 10));
  check("a rollup with nothing priceable is null, not 0", rollUp([old], RATES).usd === null);

  const econ = code(read("lib/platform/ai/invocation-economics.ts"));
  check("no parallel pricing engine — it delegates to priceAiUsage",
    /priceAiUsage\(/.test(econ) && !/usdPerMillion\s*[:=]/.test(econ) && !/\/ 1_000_000/.test(econ));
}

console.log("7. model, day and environment attribution");
{
  const set = [
    inv({ model: "m", promptTokens: 1_000_000 }),
    inv({ model: "m", promptTokens: 1_000_000, occurredAt: "2026-06-16" }),
    inv({ model: "other", promptTokens: 1_000_000 }),
  ];
  const rates: AiRate[] = [...RATES,
    { provider: "OPENAI", model: "other", effectiveFrom: "2026-06-01", source: "fixture",
      usdPerMillion: { input: 50, cachedInput: 5, output: 500 } }];
  const models = byModel(set, rates);
  check("models are attributed exactly", models.length === 2);
  check("…and priced at their own rates",
    near(models.find((m) => m.model === "m")!.usd, 20) && near(models.find((m) => m.model === "other")!.usd, 50));
  const days = byDay(set, rates);
  check("days split correctly and stay ordered", days.length === 2 && days[0].day < days[1].day);

  // ⚠️ ENVIRONMENT: one provider account serves local, preview and production, so
  // without this dimension platform spend and production cost-to-serve are the
  // same number.
  const envs = byEnvironment([
    inv({ environment: "production", promptTokens: 1_000_000 }),
    inv({ environment: "development", promptTokens: 3_000_000 }),
  ], RATES);
  check("environments are separable", envs.length === 2);
  check("…so production cost-to-serve is distinguishable from total spend",
    near(envs.find((e) => e.environment === "production")!.usd, 10)
      && near(envs.find((e) => e.environment === "development")!.usd, 30));
  const envSrc = code(read("lib/ai/invocation.ts"));
  check("environment comes from the existing V26-ENV-1 classifier, not a new one",
    /deploymentEnvironment\(\)/.test(envSrc) && /from '@\/lib\/env'/.test(envSrc));
}

console.log("8. ApiUsageCounter is not replaced");
{
  const provider = code(read("lib/ai/provider.ts"));
  check("the day-grain counter is still written on every invocation",
    /recordApiUsage\(/.test(provider) && /aiUsageUnits\(usage\)/.test(provider));
  check("…alongside the invocation fact, from the same chokepoint",
    /recordAiInvocation\(/.test(provider));
  const schema = read("prisma/schema.prisma");
  check("both models exist", /model ApiUsageCounter \{/.test(schema) && /model AiInvocation \{/.test(schema));
  // Comments in the model explain WHY there is no dollar column, so they must be
  // stripped before scanning for one.
  const aiModel = /model AiInvocation \{[\s\S]*?\n\}/.exec(schema)![0]
    .split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("///")).join("\n");
  check("the fact table stores no dollar column", !/usd|cost|price/i.test(aiModel), aiModel.match(/.*(usd|cost|price).*/i)?.[0]);
  check("…and no content-bearing column",
    !/prompt\s*String|message|content|payload/i.test(aiModel));
}

console.log(failures === 0 ? "\nAll invocation-economics checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures ? 1 : 0);
}
void main();
