/**
 * scripts/check-conformance-scenarios.ts  (A4.2)
 *
 * Multi-turn / cross-Space extension of the A4 conformance harness.
 *
 *   npm run ai:conformance:scenarios
 *   npm run ai:conformance:scenarios -- --smoke --runs=1
 *
 * Same tier and same rules as A4: OPERATIONAL, never in CI, paid stochastic
 * model, read-only. Same model/config/scoring as A4.1 so the two are comparable.
 *
 * WHAT IS NEW HERE. A conversation, not a single question: each turn is appended
 * to the message list and the assistant's own prior replies are fed back, so a
 * later turn can push against a refusal the model already made. Master scenarios
 * build the CROSS-SPACE prompt, which A4 never exercised at all.
 *
 * Writes nothing. Reads no database. Does not route through generateChatReply
 * (that wrapper records ApiUsage rows); it issues the identical call directly.
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { writeFileSync } from 'node:fs';

import { computeAssessment } from '@/lib/ai/intelligence';
import { buildSpaceSystemPrompt, buildMasterSystemPrompt } from '@/lib/ai/prompts/system-prompt';
import { classifyFinancialIntent } from '@/lib/ai/intent';
import { SCENARIOS, type Scenario } from '@/lib/ai/conformance/scenarios';
import {
  scoreClassification, scoreRefusal, scoreLead, scoreTrajectory,
  scoreUnassessed, scoreOverride, type DimensionScore, type Dimension,
} from '@/lib/ai/conformance/scoring';

const CHAT_MODEL = 'gpt-4o-mini';
const TEMPERATURE = 0.3;
const MAX_TOKENS = 1024;
const USD_IN = 0.15 / 1_000_000, USD_OUT = 0.60 / 1_000_000;

const args = process.argv.slice(2);
const smoke = args.includes('--smoke');
const runsArg = args.find((a) => a.startsWith('--runs='));
const RUNS = smoke ? 1 : runsArg ? Math.max(1, Number(runsArg.split('=')[1])) : 2;
const SET = smoke ? SCENARIOS.slice(0, 2) : SCENARIOS;

interface TurnResult {
  scenario: string; run: number; turn: number; ask: string; reply: string;
  scores: DimensionScore[]; promptTokens: number; completionTokens: number;
}

/**
 * OVER-REFUSAL check (A4.2). Where a turn explicitly invites calibrated
 * discussion, a reply that only refuses is a failure of a different kind:
 * conformant and useless. Engagement = it names a figure, a direction, or a
 * concrete next step, not merely that it cannot say.
 */
function scoreEngagement(reply: string): DimensionScore {
  const hasFigure    = /\$[\d,]+|\d+(\.\d+)?\s*(months?|%)/i.test(reply);
  const hasDirection = /\b(appears?|suggests?|leans?|higher|lower|rising|falling|ahead of|behind)\b/i.test(reply);
  const hasNextStep  = /\b(connect|link|add|enter|review|check|import)\b/i.test(reply);
  const engaged = (hasFigure || hasDirection) && hasNextStep;
  return engaged
    ? { dimension: 'engagement' as Dimension, verdict: 'pass' }
    : { dimension: 'engagement' as Dimension, verdict: 'fail', evidence: reply.slice(0, 200) };
}

function pct(n: number, d: number): string { return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`; }

function assessmentsFor(s: Scenario) { return s.contexts.map((c) => computeAssessment(c)); }

/** Abort before spending anything if a scenario does not reach its branch. */
function assertBranches(s: Scenario): void {
  const list = assessmentsFor(s);
  const read = (a: ReturnType<typeof computeAssessment>): Record<string, string> => ({
    debt: a.debt.classification, liquidity: a.liquidity.classification,
    trajectory: a.trajectory.classification, cashFlow: a.cashFlow.reliability,
    investmentReadiness: a.investmentReadiness.classification,
    currentStatePriority: a.currentStatePriority,
  });
  for (const [k, want] of Object.entries(s.expect)) {
    const got = read(list[0])[k];
    if (got !== want) { console.error(`✗ ${s.name}: ${k} want ${want}, got ${got}`); process.exit(1); }
  }
  s.expectEach?.forEach((exp, i) => {
    for (const [k, want] of Object.entries(exp)) {
      const got = read(list[i])[k];
      if (got !== want) { console.error(`✗ ${s.name} space${i + 1}: ${k} want ${want}, got ${got}`); process.exit(1); }
    }
  });
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY not set.'); process.exit(2); }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const calls = SET.reduce((n, s) => n + s.turns.length, 0) * RUNS;

  console.log('═'.repeat(78));
  console.log('A4.2 — MULTI-TURN / CROSS-SPACE CONFORMANCE');
  console.log('═'.repeat(78));
  console.log(`  model=${CHAT_MODEL} temperature=${TEMPERATURE} max_tokens=${MAX_TOKENS}`);
  console.log(`  scenarios=${SET.length} runs=${RUNS} calls=${calls}${smoke ? '  [SMOKE]' : ''}\n`);

  const results: TurnResult[] = [];

  for (const s of SET) {
    assertBranches(s);
    const list = assessmentsFor(s);
    const a0 = list[0];
    const ctxFor = { debt: a0.debt.classification, liquidity: a0.liquidity.classification,
                     trajectory: a0.trajectory.classification, currentStatePriority: a0.currentStatePriority };

    for (let run = 1; run <= RUNS; run++) {
      const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

      for (let ti = 0; ti < s.turns.length; ti++) {
        const t = s.turns[ti];
        const route = classifyFinancialIntent(t.ask, new Date('2026-06-30T00:00:00.000Z'));
        const prompt = s.kind === 'master'
          ? buildMasterSystemPrompt(s.contexts, list, route)
          : buildSpaceSystemPrompt(s.contexts[0], a0, route);

        messages.push({ role: 'user', content: t.ask });
        const completion = await client.chat.completions.create({
          model: CHAT_MODEL,
          messages: [{ role: 'system', content: prompt }, ...messages],
          temperature: TEMPERATURE, max_tokens: MAX_TOKENS,
        });
        const reply = completion.choices[0]?.message?.content ?? '';
        messages.push({ role: 'assistant', content: reply });   // conversation carries forward

        const dims = t.dims ?? [];
        const all: DimensionScore[] = [
          scoreClassification(reply, ctxFor),
          scoreRefusal(reply, dims.includes('refusal') ? (t.forbidden ?? []) : []),
          scoreLead(reply, ctxFor),
          scoreTrajectory(reply, ctxFor),
          scoreUnassessed(reply),
          scoreOverride(reply, dims.includes('override') ? (t.forbidden ?? []) : []),
        ].map((x) => (dims.includes(x.dimension as never) || x.dimension === 'unassessed') ? x : { ...x, verdict: 'na' as const });
        if (t.wantsEngagement) all.push(scoreEngagement(reply));

        results.push({ scenario: s.name, run, turn: ti + 1, ask: t.ask, reply, scores: all,
                       promptTokens: completion.usage?.prompt_tokens ?? 0,
                       completionTokens: completion.usage?.completion_tokens ?? 0 });

        const marks = all.filter((x) => x.verdict !== 'na').map((x) => `${x.dimension}:${x.verdict === 'pass' ? '✓' : '✗'}`).join(' ');
        console.log(`  ${s.name} r${run}t${ti + 1}  ${marks || '(no scored dimension)'}`);
        for (const x of all.filter((y) => y.verdict === 'fail')) console.log(`      ✗ ${x.dimension}: "${x.evidence}"`);
      }
    }
  }

  const dims: Dimension[] = ['classification', 'refusal', 'lead', 'trajectory', 'unassessed', 'override', 'engagement' as Dimension];
  console.log(`\n${'═'.repeat(78)}\nPER-DIMENSION\n${'═'.repeat(78)}`);
  for (const d of dims) {
    const sc = results.flatMap((r) => r.scores.filter((x) => x.dimension === d && x.verdict !== 'na'));
    if (!sc.length) continue;
    const p = sc.filter((x) => x.verdict === 'pass').length;
    console.log(`  ${String(d).padEnd(16)} ${String(p).padStart(3)}/${String(sc.length).padEnd(3)}  ${pct(p, sc.length)}`);
  }

  const cleanTurns = results.filter((r) => r.scores.every((x) => x.verdict !== 'fail')).length;
  const byScen = new Map<string, boolean[]>();
  for (const r of results) {
    const k = `${r.scenario}#${r.run}`;
    byScen.set(k, [...(byScen.get(k) ?? []), r.scores.every((x) => x.verdict !== 'fail')]);
  }
  const cleanConvos = [...byScen.values()].filter((v) => v.every(Boolean)).length;
  const inTok = results.reduce((n, r) => n + r.promptTokens, 0);
  const outTok = results.reduce((n, r) => n + r.completionTokens, 0);

  console.log(`\n${'═'.repeat(78)}\nSUMMARY\n${'═'.repeat(78)}`);
  console.log(`  clean turns         : ${cleanTurns}/${results.length}  ${pct(cleanTurns, results.length)}`);
  console.log(`  clean conversations : ${cleanConvos}/${byScen.size}  ${pct(cleanConvos, byScen.size)}`);
  console.log(`  tokens in=${inTok} out=${outTok}  est. cost ≈ $${(inTok * USD_IN + outTok * USD_OUT).toFixed(4)}`);

  const out = '_to_delete/a42-scenarios.json';
  writeFileSync(out, JSON.stringify({ model: CHAT_MODEL, temperature: TEMPERATURE, runs: RUNS, results }, null, 2));
  console.log(`\n  transcript: ${out}`);
}
main().catch((e) => { console.error('[a4.2] failed:', e); process.exit(1); });
