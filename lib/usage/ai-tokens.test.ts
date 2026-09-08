/**
 * lib/usage/ai-tokens.test.ts  (Platform Ops cost accounting — Slice 1)
 *
 * THE SUBSET INVARIANT, PROVEN. Standalone tsx (house pattern), no DB, no network.
 *
 * The defect this file exists to prevent is specific and expensive: pricing
 * `prompt + cached` instead of `prompt − cached`. That form does not merely
 * mis-state a bill — it reports a LARGER cost than pricing the raw prompt alone,
 * so a "cost fix" would make the number worse while looking like an improvement.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  aiUsageUnits, uncachedPromptTokens, nonReasoningCompletionTokens,
  AI_USAGE_UNITS, type OpenAiUsage,
} from "@/lib/usage/ai-tokens";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = path.resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
/** Source with comments stripped, so prose about a rule never satisfies a scan for it. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const unitsOf = (u: OpenAiUsage) => Object.fromEntries(aiUsageUnits(u).map((x) => [x.unit, x.count]));

// A real gpt-5.5 usage object from the measured corpus (S2 T3, 98% cached).
const REAL: OpenAiUsage = {
  prompt_tokens: 25_967, completion_tokens: 491, total_tokens: 26_458,
  prompt_tokens_details: { cached_tokens: 25_216 },
  completion_tokens_details: { reasoning_tokens: 184 },
};

console.log("1. the subset invariant");
{
  // ⚠️ THE WHOLE POINT. Subtraction, never addition.
  check("uncached input is prompt MINUS cached",
    uncachedPromptTokens(25_967, 25_216) === 751);
  check("…and never prompt PLUS cached",
    uncachedPromptTokens(25_967, 25_216) !== 25_967 + 25_216);
  check("…and never the raw prompt",
    uncachedPromptTokens(25_967, 25_216) !== 25_967);
  check("uncached + cached reconstructs the prompt exactly",
    uncachedPromptTokens(REAL.prompt_tokens!, REAL.prompt_tokens_details!.cached_tokens!)
      + REAL.prompt_tokens_details!.cached_tokens! === REAL.prompt_tokens!);

  // The wrong form is strictly worse than doing nothing — that is why it is easy
  // to ship and hard to notice.
  const rightWay = uncachedPromptTokens(25_967, 25_216) * 5 + 25_216 * 0.5;
  const wrongWay = 25_967 * 5 + 25_216 * 0.5;
  const noCaching = 25_967 * 5;
  check("pricing the subtraction is cheaper than pricing the raw prompt",
    rightWay < noCaching);
  check("…while the addition form is MORE expensive than no caching at all",
    wrongWay > noCaching);

  check("a fully cached prompt leaves nothing at the full rate",
    uncachedPromptTokens(1000, 1000) === 0);
  check("no caching leaves the whole prompt at the full rate",
    uncachedPromptTokens(1000, 0) === 1000);
  // Defensive: a contradictory pair must never yield a negative quantity that a
  // later multiplication would turn into a negative cost.
  check("cached greater than prompt clamps to zero, never negative",
    uncachedPromptTokens(100, 250) === 0);
  check("absent or malformed inputs are zero, not NaN",
    uncachedPromptTokens(NaN, 5) === 0 && uncachedPromptTokens(100, NaN) === 100);
}

console.log("2. reasoning is explanatory, not additive");
{
  // Reasoning tokens are ALREADY inside completion_tokens and bill at the output
  // rate. Pricing them separately double counts.
  check("non-reasoning output is completion MINUS reasoning",
    nonReasoningCompletionTokens(491, 184) === 307);
  check("…and the two halves reconstruct completion exactly",
    nonReasoningCompletionTokens(491, 184) + 184 === 491);
  check("reasoning cannot exceed completion in the derivation",
    nonReasoningCompletionTokens(100, 250) === 0);
}

console.log("3. what one call contributes to the counter");
{
  const u = unitsOf(REAL);
  check("all five units are produced", aiUsageUnits(REAL).length === 5);
  check("calls is one per invocation", u[AI_USAGE_UNITS.CALLS] === 1);
  check("prompt_tokens is the provider's own total, not the uncached part",
    u[AI_USAGE_UNITS.PROMPT_TOKENS] === 25_967);
  check("cached_prompt_tokens is captured", u[AI_USAGE_UNITS.CACHED_PROMPT_TOKENS] === 25_216);
  check("completion_tokens is captured", u[AI_USAGE_UNITS.COMPLETION_TOKENS] === 491);
  check("reasoning_tokens is captured", u[AI_USAGE_UNITS.REASONING_TOKENS] === 184);

  // ⚠️ STORED PARTS, NOT STORED DERIVATIONS. A stored total can drift from the
  // parts it came from — the "two competing figures" defect.
  const names = aiUsageUnits(REAL).map((x) => x.unit);
  check("no derived unit is stored (no uncached, no totals)",
    !names.some((n) => /uncached|total/.test(n)), names.join(","));

  // An absent detail block must write NO row, never a false zero: recordApiUsage
  // treats a zero count as a no-op.
  const plain = unitsOf({ prompt_tokens: 900, completion_tokens: 100 });
  check("a model that reports no caching yields a zero cached count",
    plain[AI_USAGE_UNITS.CACHED_PROMPT_TOKENS] === 0);
  check("…and a zero count is a no-op at the recorder",
    /n <= 0\) return/.test(code(read("lib/usage/record.ts"))));
  check("a null detail block does not throw",
    unitsOf({ prompt_tokens: 5, prompt_tokens_details: null })[AI_USAGE_UNITS.CACHED_PROMPT_TOKENS] === 0);
  check("no usage object contributes nothing at all",
    aiUsageUnits(undefined).length === 0 && aiUsageUnits(null).length === 0);
  check("fractional or negative provider values are floored to a whole non-negative count",
    unitsOf({ prompt_tokens: 10.9, completion_tokens: -3 })[AI_USAGE_UNITS.PROMPT_TOKENS] === 10
      && unitsOf({ completion_tokens: -3 })[AI_USAGE_UNITS.COMPLETION_TOKENS] === 0);
}

console.log("4. every AI capture path, not just one");
{
  const provider = code(read("lib/ai/provider.ts"));

  // ⚠️ THE CLOSED SET. Before this slice each generator inlined its own three
  // recordApiUsage lines, and they had already drifted: reasoning_tokens was read
  // in one of three and discarded, cached_tokens in none.
  const generators = ["generateChatReply", "generateWithTools", "generateStructured"];
  for (const g of generators) {
    check(`${g} exists`, new RegExp(`export async function ${g}\\b`).test(provider));
  }
  check("all three generators record through the one helper",
    (provider.match(/recordOpenAiUsage\(/g) ?? []).length === generators.length + 1,
    String((provider.match(/recordOpenAiUsage\(/g) ?? []).length));
  check("…and the helper is the only recordApiUsage call site in the provider",
    (provider.match(/recordApiUsage\(/g) ?? []).length === 1);
  check("no generator hand-writes a token unit any more",
    !/'prompt_tokens'|'completion_tokens'|"prompt_tokens"|"completion_tokens"/.test(provider));

  // The provider boundary is the only place the SDK may be imported, which is
  // what makes "three paths" the complete set rather than the ones we found.
  check("the provider is the only OpenAI import site in production code",
    (provider.match(/from 'openai'/g) ?? []).length === 1);
  check("the widened usage type can see the cached-token detail",
    /usage\?: OpenAiUsage/.test(provider));

  // Capture must never be able to break a generation.
  check("usage recording stays fire-and-forget and non-throwing",
    /void recordApiUsage\(/.test(provider));

  // Slice boundary: capture only. No pricing, no dollars, no new schema here.
  const tokens = code(read("lib/usage/ai-tokens.ts"));
  check("slice 1 stores no dollars and derives no cost",
    !/usd|price|Price|rate|Rate/.test(tokens));
  check("…and reads nothing — it is pure arithmetic",
    !/^import /m.test(tokens));
}

console.log(failures === 0 ? "\nAll ai-tokens checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures ? 1 : 0);
