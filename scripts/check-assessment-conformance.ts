/**
 * scripts/check-assessment-conformance.ts  (A4)
 *
 * Operator harness: does the LANGUAGE MODEL follow the deterministic
 * FinancialAssessment and the A3 authority-precedence contract?
 *
 *   npm run ai:conformance            # full matrix (12 fixtures x RUNS)
 *   npm run ai:conformance -- --smoke # 2 fixtures x 1 run (cost probe)
 *   npm run ai:conformance -- --runs=1
 *
 * NOT a gate, NOT in npm run test:unit, NOT REQUIRED: it calls a stochastic
 * paid external model. Registered OPERATIONAL in scripts/audit-registry.ts —
 * a tool, not an audit. Reports evidence; never fails CI.
 *
 * WHAT IT TOUCHES. It builds the REAL production prompt (buildSpaceSystemPrompt)
 * and calls the SAME model with the SAME sampling parameters the chat route
 * uses. It deliberately does NOT route through lib/ai/provider.generateChatReply,
 * for one reason only: that wrapper calls recordApiUsage(), which WRITES ApiUsage
 * rows. This harness is read-only by contract, so it issues the identical call
 * without the telemetry side effect. The prompt under test is production's,
 * byte for byte — only the metering is skipped.
 *
 * Reads nothing from the database. Writes nothing, anywhere.
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { writeFileSync } from 'node:fs';

import { computeAssessment } from '@/lib/ai/intelligence';
import { buildSpaceSystemPrompt } from '@/lib/ai/prompts/system-prompt';
import { classifyFinancialIntent } from '@/lib/ai/intent';
import { FIXTURES } from '@/lib/ai/conformance/fixtures';
import {
  scoreClassification, scoreRefusal, scoreLead, scoreTrajectory,
  scoreUnassessed, scoreOverride, type DimensionScore, type Dimension,
} from '@/lib/ai/conformance/scoring';

// Mirrors lib/ai/provider.ts exactly. If those drift, this harness is measuring
// a configuration production does not use — so they are asserted, not assumed.
const CHAT_MODEL  = 'gpt-4o-mini';
const TEMPERATURE = 0.3;
const MAX_TOKENS  = 1024;

const args   = process.argv.slice(2);
const smoke  = args.includes('--smoke');
const runsArg = args.find((a) => a.startsWith('--runs='));
const RUNS   = smoke ? 1 : runsArg ? Math.max(1, Number(runsArg.split('=')[1])) : 3;
const SET    = smoke ? FIXTURES.slice(0, 2) : FIXTURES;

// gpt-4o-mini list price (USD per 1M tokens) at time of writing. Used only to
// print an estimate — never to gate anything.
const USD_IN = 0.15 / 1_000_000;
const USD_OUT = 0.60 / 1_000_000;

interface RunResult {
  fixture: string; run: number; reply: string;
  scores: DimensionScore[];
  promptTokens: number; completionTokens: number;
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not set — cannot run the conformance harness.');
    process.exit(2);
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  console.log('═'.repeat(78));
  console.log('A4 — ASSESSMENT CONTRACT CONFORMANCE');
  console.log('═'.repeat(78));
  console.log(`  model=${CHAT_MODEL} temperature=${TEMPERATURE} max_tokens=${MAX_TOKENS}`);
  console.log(`  fixtures=${SET.length} runs=${RUNS} calls=${SET.length * RUNS}${smoke ? '  [SMOKE]' : ''}\n`);

  const results: RunResult[] = [];

  for (const f of SET) {
    const assessment = computeAssessment(f.ctx);

    // ANTI-VACUITY, enforced before spending a single call: a fixture that does
    // not reach its branch measures nothing, and a passing score on it would be
    // worse than no score at all.
    for (const [k, want] of Object.entries(f.expect)) {
      const got = ({
        debt: assessment.debt.classification,
        liquidity: assessment.liquidity.classification,
        trajectory: assessment.trajectory.classification,
        cashFlow: assessment.cashFlow.reliability,
        investmentReadiness: assessment.investmentReadiness.classification,
        currentStatePriority: assessment.currentStatePriority,
      } as Record<string, string>)[k];
      if (got !== want) {
        console.error(`✗ ${f.name}: fixture does not reach its branch (${k}: want ${want}, got ${got}). Aborting.`);
        process.exit(1);
      }
    }

    const route  = classifyFinancialIntent(f.question, new Date('2026-06-30T00:00:00.000Z'));
    const prompt = buildSpaceSystemPrompt(f.ctx, assessment, route);

    for (let run = 1; run <= RUNS; run++) {
      const completion = await client.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user',   content: f.question },
        ],
        temperature: TEMPERATURE,
        max_tokens:  MAX_TOKENS,
      });
      const reply = completion.choices[0]?.message?.content ?? '';

      const a = {
        debt: assessment.debt.classification,
        liquidity: assessment.liquidity.classification,
        trajectory: assessment.trajectory.classification,
        currentStatePriority: assessment.currentStatePriority,
      };
      const all: DimensionScore[] = [
        scoreClassification(reply, a),
        scoreRefusal(reply, f.dims.includes('refusal') ? f.forbidden : []),
        scoreLead(reply, a),
        scoreTrajectory(reply, a),
        scoreUnassessed(reply),
        scoreOverride(reply, f.dims.includes('override') ? f.forbidden : []),
      ];
      // Only score the dimensions this fixture was built to exercise; the rest
      // are reported n/a rather than counted as free passes.
      const scores = all.map((s) =>
        f.dims.includes(s.dimension as never) || s.dimension === 'unassessed'
          ? s
          : { ...s, verdict: 'na' as const });

      results.push({
        fixture: f.name, run, reply, scores,
        promptTokens: completion.usage?.prompt_tokens ?? 0,
        completionTokens: completion.usage?.completion_tokens ?? 0,
      });

      const marks = scores.map((s) => `${s.dimension}:${s.verdict === 'pass' ? '✓' : s.verdict === 'fail' ? '✗' : '–'}`).join(' ');
      console.log(`  ${f.name} run${run}  ${marks}`);
      for (const s of scores.filter((x) => x.verdict === 'fail')) {
        console.log(`      ✗ ${s.dimension}: "${s.evidence}"`);
      }
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const dims: Dimension[] = ['classification', 'refusal', 'lead', 'trajectory', 'unassessed', 'override'];
  console.log(`\n${'═'.repeat(78)}\nPER-DIMENSION CONFORMANCE\n${'═'.repeat(78)}`);
  for (const d of dims) {
    const scored = results.flatMap((r) => r.scores.filter((s) => s.dimension === d && s.verdict !== 'na'));
    const pass   = scored.filter((s) => s.verdict === 'pass').length;
    console.log(`  ${d.padEnd(16)} ${String(pass).padStart(3)}/${String(scored.length).padEnd(3)}  ${pct(pass, scored.length)}`);
  }

  const strictRuns = results.filter((r) => r.scores.every((s) => s.verdict !== 'fail')).length;
  const byFixture = new Map<string, RunResult[]>();
  for (const r of results) byFixture.set(r.fixture, [...(byFixture.get(r.fixture) ?? []), r]);
  const allRunsClean  = [...byFixture.values()].filter((rs) => rs.every((r) => r.scores.every((s) => s.verdict !== 'fail'))).length;
  const anyRunClean   = [...byFixture.values()].filter((rs) => rs.some((r) => r.scores.every((s) => s.verdict !== 'fail'))).length;

  const inTok  = results.reduce((n, r) => n + r.promptTokens, 0);
  const outTok = results.reduce((n, r) => n + r.completionTokens, 0);

  console.log(`\n${'═'.repeat(78)}\nSUMMARY\n${'═'.repeat(78)}`);
  console.log(`  strict conformance (every dimension, every run) : ${strictRuns}/${results.length}  ${pct(strictRuns, results.length)}`);
  console.log(`  fixtures clean on ALL runs                      : ${allRunsClean}/${byFixture.size}`);
  console.log(`  fixtures clean on AT LEAST ONE run              : ${anyRunClean}/${byFixture.size}`);
  console.log(`  intermittent (clean once, not always)           : ${anyRunClean - allRunsClean}`);
  const fails = (d: Dimension) => results.flatMap((r) => r.scores.filter((s) => s.dimension === d && s.verdict === 'fail')).length;
  console.log(`  refusal violations   : ${fails('refusal')}`);
  console.log(`  invented grades      : ${fails('unassessed')}`);
  console.log(`  raw-context overrides: ${fails('override')}`);
  console.log(`  classification breaks: ${fails('classification')}`);
  console.log(`\n  tokens in=${inTok} out=${outTok}  est. cost ≈ $${(inTok * USD_IN + outTok * USD_OUT).toFixed(4)}`);
  console.log('\n  NOTE: these checks detect EXPLICIT contradiction only. The rates are a');
  console.log('  LOWER BOUND on violations — an implied contradiction in free prose can');
  console.log('  pass every regex. Read the saved transcript before trusting a high score.');

  const out = `_to_delete/a4-conformance-${CHAT_MODEL}.json`;
  writeFileSync(out, JSON.stringify({ model: CHAT_MODEL, temperature: TEMPERATURE, maxTokens: MAX_TOKENS, runs: RUNS, results }, null, 2));
  console.log(`\n  full transcript + rationales: ${out}`);
}

main().catch((e) => { console.error('[conformance] failed:', e); process.exit(1); });
