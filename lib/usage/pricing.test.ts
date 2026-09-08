/**
 * lib/usage/pricing.test.ts  (Platform Ops cost accounting — Slice 2)
 *
 * SUBSET-AWARE, TIME-VERSIONED AI PRICING. Standalone tsx, no DB, no network.
 *
 * Two defect classes are pinned here, and both are silent in production:
 *   1. pricing `prompt + cached` instead of `prompt − cached` — which reports a
 *      LARGER cost than ignoring caching entirely, so it looks like a fix;
 *   2. a rate change silently repricing history that the old rate applied to.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  priceAiUsage, rateAt, modelFromMetric, isPricingConfigured, AI_RATES,
  type AiRate, type UsageRowLike,
} from "@/lib/usage/pricing";
import { uncachedPromptTokens } from "@/lib/usage/ai-tokens";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = path.resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
/** Source with comments stripped — prose explaining why a thing is gone must not
 *  satisfy a scan for that thing's absence (the house `code()` idiom). */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const near = (a: number | null, b: number, eps = 1e-9) => a !== null && Math.abs(a - b) < eps;

/** A fixture table, so the assertions never depend on the shipped rates. */
const R = (model: string, from: string, i: number, c: number, o: number): AiRate =>
  ({ provider: "OPENAI", model, effectiveFrom: from, source: "fixture",
     usdPerMillion: { input: i, cachedInput: c, output: o } });
const RATES: AiRate[] = [R("m", "2026-01-01", 10, 1, 100)];
const row = (unit: string, count: number, day = "2026-06-01", metric = "chat.completions:m"): UsageRowLike =>
  ({ provider: "OPENAI", metric, unit, day, count });

console.log("1. the subset invariant, priced");
{
  // 100% UNCACHED — the whole prompt at the full input rate.
  const allUncached = priceAiUsage([row("prompt_tokens", 1_000_000), row("completion_tokens", 0)], RATES);
  check("100% uncached input prices at the input rate", near(allUncached.usd, 10));

  // 100% CACHED — the whole prompt at the cached rate, nothing at the full rate.
  const allCached = priceAiUsage([row("prompt_tokens", 1_000_000), row("cached_prompt_tokens", 1_000_000)], RATES);
  check("100% cached input prices at the cached rate", near(allCached.usd, 1));
  check("…which is a tenth of the uncached cost, not an addition to it",
    near(allCached.usd, (allUncached.usd as number) / 10));

  // PARTIALLY CACHED — 900k cached, 100k not.
  const partial = priceAiUsage([row("prompt_tokens", 1_000_000), row("cached_prompt_tokens", 900_000)], RATES);
  check("partially cached input prices each part at its own rate",
    near(partial.usd, (100_000 * 10 + 900_000 * 1) / 1e6));
  check("…strictly between the all-cached and all-uncached cases",
    (partial.usd as number) > (allCached.usd as number) && (partial.usd as number) < (allUncached.usd as number));

  // ⚠️ THE DEFECT. Adding a cached price to a prompt price reports MORE than
  // ignoring caching altogether — a "cost fix" that raises the number.
  const doubleCounted = (1_000_000 * 10 + 900_000 * 1) / 1e6;
  check("cached input is NOT double-counted", !near(partial.usd, doubleCounted));
  check("…and the double-counted form would have exceeded the no-caching cost",
    doubleCounted > (allUncached.usd as number));
  check("the reducer agrees with the Slice 1 invariant helper",
    near(partial.usd, (uncachedPromptTokens(1_000_000, 900_000) * 10 + 900_000 * 1) / 1e6));

  // MALFORMED: cached > prompt must not manufacture negative usage or credit.
  const malformed = priceAiUsage([row("prompt_tokens", 100), row("cached_prompt_tokens", 250)], RATES);
  check("cached greater than prompt cannot create negative usage or cost",
    (malformed.usd as number) >= 0 && near(malformed.usd, (100 * 1) / 1e6));
}

console.log("2. output pricing, and reasoning as telemetry only");
{
  const base = priceAiUsage([row("completion_tokens", 1_000_000)], RATES);
  check("output prices on completion_tokens", near(base.usd, 100));

  // ⚠️ reasoning_tokens are ALREADY inside completion_tokens.
  const withReasoning = priceAiUsage(
    [row("completion_tokens", 1_000_000), row("reasoning_tokens", 700_000)], RATES);
  check("reasoning tokens add NO cost", near(withReasoning.usd, base.usd as number));
  const reasoningOnly = priceAiUsage([row("reasoning_tokens", 1_000_000)], RATES);
  check("…and cannot be priced on their own", reasoningOnly.usd === null);
  const callsOnly = priceAiUsage([row("calls", 500)], RATES);
  check("a call is not a billable unit", callsOnly.usd === null);
}

console.log("3. rates are versioned by effective date");
{
  const versioned = [R("m", "2026-01-01", 10, 1, 100), R("m", "2026-06-01", 20, 2, 200)];
  check("a day before any rate resolves nothing", rateAt("OPENAI", "m", "2025-12-31", versioned) === null);
  check("a day under the first rate resolves the first",
    rateAt("OPENAI", "m", "2026-05-31", versioned)?.usdPerMillion.input === 10);
  check("effectiveFrom is inclusive", rateAt("OPENAI", "m", "2026-06-01", versioned)?.usdPerMillion.input === 20);
  check("a later day resolves the later rate",
    rateAt("OPENAI", "m", "2026-09-09", versioned)?.usdPerMillion.input === 20);

  // ⚠️ HISTORY IS PRICED AT THE RATE THAT WAS IN FORCE THEN.
  const beforeChange = priceAiUsage([row("prompt_tokens", 1_000_000, "2026-05-31")], versioned);
  const afterChange  = priceAiUsage([row("prompt_tokens", 1_000_000, "2026-06-02")], versioned);
  check("usage before the effective date gets the historical rate", near(beforeChange.usd, 10));
  check("usage after it gets the new rate", near(afterChange.usd, 20));

  // ⚠️ ADDING TODAY'S RATE MUST NOT REPRICE YESTERDAY.
  const oldOnly = [R("m", "2026-01-01", 10, 1, 100)];
  const withNewToday = [...oldOnly, R("m", "2026-09-09", 99, 9, 999)];
  const historical = (rates: AiRate[]) => priceAiUsage([row("prompt_tokens", 1_000_000, "2026-05-31")], rates).usd;
  check("changing today's rate does not silently reprice historical usage",
    near(historical(withNewToday), historical(oldOnly) as number));

  // Usage no rate covers is UNPRICED, never zero.
  const uncovered = priceAiUsage([row("prompt_tokens", 5_000, "2025-01-01")], versioned);
  check("usage predating every rate is unpriced, not zero",
    uncovered.usd === null && uncovered.unpricedTokens === 5_000);
  check("…and the uncovered day is named", uncovered.unpricedDays.includes("2025-01-01"));
  const mixed = priceAiUsage(
    [row("prompt_tokens", 1_000_000, "2026-06-02"), row("prompt_tokens", 5_000, "2025-01-01")], versioned);
  check("a partly covered window prices what it can and reports the rest",
    near(mixed.usd, 20) && mixed.unpricedTokens === 5_000 && mixed.pricedTokens === 1_000_000);
}

console.log("4. grouping, and what may never be priced");
{
  // Each (provider, metric, day) is its own group: two models on one day must not
  // pool their cached tokens against each other's prompts.
  const twoModels = priceAiUsage([
    row("prompt_tokens", 1_000_000, "2026-06-01", "chat.completions:m"),
    row("cached_prompt_tokens", 1_000_000, "2026-06-01", "chat.completions:m"),
    row("prompt_tokens", 1_000_000, "2026-06-01", "chat.completions:n"),
  ], [...RATES, R("n", "2026-01-01", 50, 5, 500)]);
  check("models are priced independently on the same day", near(twoModels.usd, 1 + 50));
  const twoDays = priceAiUsage([
    row("prompt_tokens", 1_000_000, "2026-06-01"), row("cached_prompt_tokens", 1_000_000, "2026-06-02"),
  ], RATES);
  check("a cached row cannot discount a different day's prompt", near(twoDays.usd, 10));

  // ⚠️ PLAID IS STRUCTURALLY EXCLUDED — a bare method name never parses to a
  // model, so it can never be priced. Plaid's billable unit is the Item-month.
  check("a Plaid metric resolves no model", modelFromMetric("transactionsSync") === null);
  check("an OpenAI metric resolves its model", modelFromMetric("chat.completions:gpt-5.5") === "gpt-5.5");
  const plaid = priceAiUsage([{ provider: "PLAID", metric: "transactionsSync", unit: "calls", day: "2026-09-09", count: 900 }], RATES);
  check("Plaid call counters contribute no AI cost", plaid.usd === null);
  check("no shipped rate is for a non-OpenAI provider", AI_RATES.every((r) => r.provider === "OPENAI"));
}

console.log("5. the shipped rate table");
{
  check("pricing is configured", isPricingConfigured() && AI_RATES.length > 0);
  // A cached rate cannot exist without the input rate it discounts — the shape
  // guarantee behind "never register a cached rate before the path is subset-aware".
  check("every rate carries input, cachedInput and output together",
    AI_RATES.every((r) => [r.usdPerMillion.input, r.usdPerMillion.cachedInput, r.usdPerMillion.output]
      .every((v) => typeof v === "number" && v >= 0)));
  check("cached input is never dearer than uncached input",
    AI_RATES.every((r) => r.usdPerMillion.cachedInput <= r.usdPerMillion.input));
  check("every rate is dated and sourced",
    AI_RATES.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.effectiveFrom) && r.source.length > 10));
  check("the models actually in use are priced",
    ["gpt-5.5", "gpt-5.1", "gpt-4.1", "gpt-4o-mini"].every((m) => rateAt("OPENAI", m, "2026-09-09") !== null));
  check("gpt-5.5 is $5.00 / $0.50 / $30.00 per 1M",
    JSON.stringify(rateAt("OPENAI", "gpt-5.5", "2026-09-09")?.usdPerMillion) === JSON.stringify({ input: 5, cachedInput: 0.5, output: 30 }));

  const src = code(read("lib/usage/pricing.ts"));
  check("prices stay in code — no schema, no migration, no database",
    !/prisma|db\.|@\/lib\/db/.test(src) && !/^import /m.test(src));
  check("the per-row helper that could not see the subtraction is gone",
    !/estimateUnitSpendUsd/.test(src));

  // No consumer may reintroduce per-row pricing.
  for (const f of ["lib/platform/ai/ai-usage.ts", "app/api/platform/platform-ops/api-usage/route.ts"]) {
    check(`${f.split("/").pop()} prices through the one reducer`,
      /priceAiUsage\(/.test(code(read(f))) && !/estimateUnitSpendUsd/.test(code(read(f))));
  }
}

console.log(failures === 0 ? "\nAll pricing checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures ? 1 : 0);
