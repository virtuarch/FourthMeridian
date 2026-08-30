/**
 * scripts/check-forecast-conformance.ts   (FORECAST-11)
 *
 * Operator harness: does the LANGUAGE MODEL narrate the deterministic FORECAST
 * context, or does it quietly compute a forecast of its own?
 *
 *   npm run ai:forecast-conformance
 *   npm run ai:forecast-conformance -- --runs=3
 *   npm run ai:forecast-conformance -- --only=A-facts-only --verbose
 *
 * NOT a gate, NOT in the unit suite: it calls a stochastic paid model.
 * Registered OPERATIONAL — a tool, not an audit.
 *
 * ⚠️ IT BUILDS THE REAL PROMPT. `buildSpaceSystemPrompt` with a real
 * `assembleForecast` result and a real `computeAssessment`, at the same model
 * and sampling parameters the chat route uses. It does NOT route through
 * `generateChatReply`, for one reason: that wrapper writes ApiUsage rows, and
 * this harness is read-only by contract. Same call, no telemetry.
 *
 * ⚠️ ALWAYS READ THE TRANSCRIPTS. A4's first scorer reported 0% on a run that
 * was in fact perfect — negation, proximity and word-boundary bugs in the
 * regexes, not model failures. `--verbose` prints every reply, and a scorer
 * that disagrees with the transcript is the thing that is wrong.
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { writeFileSync } from 'node:fs';

import { computeAssessment } from '@/lib/ai/intelligence';
import { buildSpaceSystemPrompt } from '@/lib/ai/prompts/system-prompt';
import { classifyFinancialIntent } from '@/lib/ai/intent';
import { assembleForecast } from '@/lib/ai/forecast/assemble';
import {
  FORECAST_SCENARIOS, realSpaceCtx, STREAMS, HORIZON, AS_OF,
  type ForecastScenario,
} from '@/lib/ai/conformance/forecast-scenarios';

// Mirrors lib/ai/provider.ts. Asserted, not assumed — a drift here means the
// harness is measuring a configuration production does not use.
const CHAT_MODEL = 'gpt-4o-mini';
const TEMPERATURE = 0.3;
const MAX_TOKENS = 1024;

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const runsArg = args.find((a) => a.startsWith('--runs='));
const RUNS = runsArg ? Math.max(1, Number(runsArg.split('=')[1])) : 1;
const only = args.find((a) => a.startsWith('--only='))?.split('=')[1];
const SET = only ? FORECAST_SCENARIOS.filter((s) => s.id === only) : FORECAST_SCENARIOS;

const USD_IN = 0.15 / 1_000_000;
const USD_OUT = 0.60 / 1_000_000;

interface Result {
  id: string; run: number; reply: string;
  failures: string[]; promptTokens: number;
}

function buildPrompt(s: ForecastScenario): { prompt: string; question: string } {
  const ctx = realSpaceCtx();
  const question = s.question;
  const forecast = assembleForecast({
    ctx, streams: STREAMS, horizon: HORIZON, asOfISO: AS_OF,
    question,
    additionalEvents: s.extraEvents ?? [],
  });
  const assessment = computeAssessment(ctx);
  const route = classifyFinancialIntent(question);
  return {
    prompt: buildSpaceSystemPrompt(
      ctx, assessment, route, undefined, undefined, question, undefined, forecast),
    question,
  };
}

function score(s: ForecastScenario, reply: string): string[] {
  const failures: string[] = [];
  for (const f of s.forbidden) {
    const m = f.pattern.exec(reply);
    if (m) failures.push(`FORBIDDEN — ${f.why}  ⟨${m[0].slice(0, 60)}⟩`);
  }
  for (const r of s.required) {
    if (!r.any.some((p) => p.test(reply))) failures.push(`MISSING — ${r.why}`);
  }
  return failures;
}

async function main(): Promise<void> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) { console.error('OPENAI_API_KEY is not set.'); process.exit(2); }
  const client = new OpenAI({ apiKey: key });

  const results: Result[] = [];
  let inTok = 0, outTok = 0;

  for (const s of SET) {
    const { prompt, question } = buildPrompt(s);
    const messages = [
      { role: 'system' as const, content: prompt },
      ...(s.priorTurns ?? []).map((c) => ({ role: 'user' as const, content: c })),
      { role: 'user' as const, content: question },
    ];
    for (let run = 1; run <= RUNS; run++) {
      const res = await client.chat.completions.create({
        model: CHAT_MODEL, temperature: TEMPERATURE, max_tokens: MAX_TOKENS, messages,
      });
      const reply = res.choices[0]?.message?.content ?? '';
      inTok += res.usage?.prompt_tokens ?? 0;
      outTok += res.usage?.completion_tokens ?? 0;
      const failures = score(s, reply);
      results.push({ id: s.id, run, reply, failures,
        promptTokens: res.usage?.prompt_tokens ?? 0 });
      const mark = failures.length === 0 ? '✓' : '✗';
      console.log(`${mark} ${s.id} (run ${run}, prompt ${res.usage?.prompt_tokens} tok)`);
      for (const f of failures) console.log(`    ${f}`);
      if (verbose) console.log(`\n--- reply ---\n${reply}\n-------------\n`);
    }
  }

  const failed = results.filter((r) => r.failures.length > 0);
  const byId = new Map<string, number>();
  for (const r of failed) byId.set(r.id, (byId.get(r.id) ?? 0) + 1);

  console.log(`\n${results.length - failed.length}/${results.length} clean`
    + `  ·  est $${((inTok * USD_IN) + (outTok * USD_OUT)).toFixed(4)}`
    + `  ·  avg prompt ${Math.round(results.reduce((t, r) => t + r.promptTokens, 0) / results.length)} tok`);
  if (byId.size) {
    console.log('\nFailing scenarios:');
    for (const [id, n] of byId) console.log(`  ${id}: ${n}/${RUNS}`);
  }
  writeFileSync('/tmp/forecast-conformance.json', JSON.stringify(results, null, 2));
  console.log('\ntranscripts → /tmp/forecast-conformance.json');
}

void main();
