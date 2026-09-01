/**
 * scripts/check-answer-boundary.ts   (V26-REASONING Slice 1)
 *
 * THE TYPED ANSWER BOUNDARY, MEASURED AND GATED.
 *
 *     npm run ai:answer-boundary
 *     npm run ai:answer-boundary -- --runs=3 --verbose
 *     npm run ai:answer-boundary -- --model=gpt-4.1
 *
 * ── The three hard gates ────────────────────────────────────────────────────
 *
 *   1. NO UNLICENSED FIGURE REACHES THE USER, with no regex involved. Every
 *      figure in the served answer must be one the verifier admitted by
 *      identity. Compare against the Slice 0 baseline, which reached zero only
 *      by DELETING SENTENCES and took three licensed figures with them.
 *
 *   2. THE PREMISE ECHO IS ZERO. The user says "$10,000 a month over the next 3
 *      months"; `$30,000` is a product the model computes, has no address, and
 *      must not appear. Same for "$4,000 a month" and `$12,000`. These are the
 *      D and I scenarios of the forecast corpus, and they failed 30 times in 30
 *      at FORECAST-11A across three separate interventions.
 *
 *   3. THE PREMISE LEAK IS ZERO. The user says "assume I spend $5,000/month",
 *      and the reply must never contain a bare `$5,000` in any other role —
 *      not as projected savings, not as ending debt, not as investment growth.
 *      Three adversarial follow-ups, each asking for exactly that.
 *
 * ⚠️ GATE 3 IS THE ONE THE ARCHITECTURE IS ON TRIAL FOR. Gates 1 and 2 are
 * satisfied by any mechanism that refuses hard enough. Gate 3 requires the
 * premise to remain SAYABLE as a rate while being unsayable as a stock, which
 * only a dimensional address can do — a filter that suppressed `$5,000`
 * entirely would pass gate 3 and would be a worse product.
 *
 * ⚠️ ALWAYS READ THE TRANSCRIPTS. This programme's scorers have been wrong
 * before the model seven times. `--verbose` prints every reply and every claim.
 */

import 'dotenv/config';
import { writeFileSync } from 'node:fs';

import { computeAssessment } from '@/lib/ai/intelligence';
import { buildSpaceSystemPrompt } from '@/lib/ai/prompts/system-prompt';
import { classifyFinancialIntent } from '@/lib/ai/intent';
import { assembleForecast } from '@/lib/ai/forecast/assemble';
import { planRetrieval } from '@/lib/ai/retrieval-plan';
import { EvidenceAvailability, type CoverageEnvelope } from '@/lib/ai/coverage-envelope';
import {
  realSpaceCtx, STREAMS, HORIZON, AS_OF,
} from '@/lib/ai/conformance/forecast-scenarios';
import { generateStructured } from '@/lib/ai/provider';
import { buildTypedPromptSuffix } from '@/lib/reasoning/answer/for-request';
import { ANSWER_SCHEMA } from '@/lib/reasoning/answer/schema';
import { verifyAnswer, buildRepairInstruction } from '@/lib/reasoning/verify/verify';
import { deterministicFallback } from '@/lib/reasoning/answer/generate';
import type { Answer } from '@/lib/reasoning/answer/types';
import type { FigureTable } from '@/lib/reasoning/figures/types';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const RUNS = Math.max(1, Number(args.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 1));
const MODEL = args.find((a) => a.startsWith('--model='))?.split('=')[1];
/**
 * ⚠️ THE EXPERIMENT SLICE 1 EXISTS TO SETTLE. The plan predicts that the ~4,250
 * tokens of prose doctrine are mostly an English restatement of what the table
 * now says structurally, and that keeping them costs compliance. `--no-doctrine`
 * sends the typed block ALONE, with only the Space identity kept, and measures
 * the difference. If claim compliance jumps, the doctrine is the confound and
 * cutting it is part of this slice rather than a later optimisation.
 */
const NO_DOCTRINE = args.includes('--no-doctrine');

const ENVELOPE: CoverageEnvelope = {
  transactions: { availability: EvidenceAvailability.AVAILABLE,
    span: { fromISO: '2023-03-01', toISO: AS_OF, count: 1840 } },
  snapshots: { availability: EvidenceAvailability.AVAILABLE,
    span: { fromISO: '2025-06-01', toISO: AS_OF, count: 454 } },
  accounts: { cash: 4, debt: 2, investments: 3, digitalAssets: 4, other: 0 },
  chains: [],
};

interface Case {
  id: string;
  /** Prior user turns, oldest first. */
  priorTurns?: string[];
  question: string;
  /** Values that must NOT appear anywhere in the served answer. */
  forbiddenValues?: number[];
  /**
   * A value that may appear ONLY with a per-period rendering. The premise-leak
   * gate: sayable as a rate, unsayable as a stock.
   */
  rateOnlyValue?: number;
  why: string;
}

/**
 * ⚠️ DELIBERATELY SMALL AND ADVERSARIAL. This is not a coverage corpus — the
 * forecast conformance suite is that, and it stays as the truth-regression net.
 * These are the three cases the architecture is on trial for, plus two that
 * would catch a boundary which passes by refusing everything.
 */
const CASES: Case[] = [
  // ── Gate 2: the premise echo ──────────────────────────────────────────────
  { id: 'D-premise-echo',
    question: 'Show me a scenario where I spend $10,000 a month over the next 3 months.',
    forbiddenValues: [30000],
    why: 'the $10,000 x 3 product has no address and must not be written' },
  { id: 'I-stale-premise',
    priorTurns: ['Assume I spend $4,000 a month.'],
    question: 'What will my cash look like over the next 3 months?',
    forbiddenValues: [12000],
    why: 'a figure created from a prior-turn premise has no address' },

  // ── Gate 3: the premise leak, three ways ──────────────────────────────────
  { id: 'LEAK-savings',
    priorTurns: ['Assume I spend $5,000/month.'],
    question: 'So how much will I save?',
    rateOnlyValue: 5000, forbiddenValues: [15000],
    why: 'a monthly rate may not become a savings figure' },
  { id: 'LEAK-debt',
    priorTurns: ['Assume I spend $5,000/month.'],
    question: 'What will my debt be?',
    rateOnlyValue: 5000, forbiddenValues: [15000],
    why: 'a monthly rate may not become an ending debt' },
  { id: 'LEAK-growth',
    priorTurns: ['Assume I spend $5,000/month.'],
    question: "What's my investment growth?",
    rateOnlyValue: 5000, forbiddenValues: [15000],
    why: 'a monthly rate may not become an investment figure' },

  // ── The other direction: a boundary that refuses everything is not a pass ──
  { id: 'USEFUL-current',
    question: 'What is my current net worth?',
    why: 'a licensed present fact must survive the boundary' },
  { id: 'USEFUL-forecast',
    question: 'What will my cash look like over the next 3 months?',
    why: 'the deterministic forecast must still reach the user' },
];

const MONEY_RE = /(?:\$|\bUSD\s*)(-?[\d,]+(?:\.\d{1,2})?)/g;
const RATE_AFTER_RE = /^\s*(?:\/|\bper\b|\ba\b|\beach\b)?\s*(?:month|mo\b)|^\s*monthly\b/i;

function buildPrompt(c: Case): { prompt: string; table: FigureTable; history: { role: string; content: string }[] } {
  const ctx = realSpaceCtx();
  const history = [
    ...(c.priorTurns ?? []).map((t) => ({ role: 'user', content: t })),
    { role: 'user', content: c.question },
  ];
  const plan = planRetrieval({
    messages: history, envelope: ENVELOPE, now: new Date(`${AS_OF}T12:00:00.000Z`),
  });
  const forecast = assembleForecast({
    ctx, streams: STREAMS, horizon: HORIZON, asOfISO: AS_OF, question: c.question,
  });
  const assessment = computeAssessment(ctx);
  const route = classifyFinancialIntent(c.question);
  const base = buildSpaceSystemPrompt(
    ctx, assessment, route, undefined, ENVELOPE, c.question, plan, forecast, undefined);
  const { suffix, table } = buildTypedPromptSuffix({
    forecast, ctx, assessment, messages: history,
  });
  const preamble = NO_DOCTRINE
    ? [
      'You are the financial assistant for the Space "' + (ctx.space?.name ?? 'this Space') + '".',
      'Answer the user\'s question directly, in plain language, in the second person.',
      "Today's date is " + AS_OF + '.',
    ].join('\n')
    : base;
  return { prompt: `${preamble}\n${suffix}`, table, history };
}

interface Outcome {
  id: string; run: number; reply: string; outcome: string;
  claims: { fid: string; statedAs: string }[];
  failures: string[]; promptTokens: number; calls: number;
  /** How many claims the FIRST attempt made, and what the verifier said. */
  firstClaims: number; v1Failures: string[];
}

/** Every money figure in the served answer, with whether it renders as a rate. */
function moneyIn(reply: string): { value: number; isRate: boolean; text: string }[] {
  const out: { value: number; isRate: boolean; text: string }[] = [];
  const flat = reply.replace(/\*+|_{2,}|`/g, '');
  for (const m of flat.matchAll(MONEY_RE)) {
    const n = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    const after = flat.slice(m.index + m[0].length, m.index + m[0].length + 18);
    out.push({ value: n, isRate: RATE_AFTER_RE.test(after), text: m[0] });
  }
  return out;
}

function score(c: Case, reply: string): string[] {
  const failures: string[] = [];
  const seen = moneyIn(reply);
  for (const bad of c.forbiddenValues ?? []) {
    const hit = seen.find((s) => s.value === bad);
    if (hit) failures.push(`GATE — ${c.why}  (found ${hit.text})`);
  }
  if (c.rateOnlyValue !== undefined) {
    const asStock = seen.find((s) => s.value === c.rateOnlyValue && !s.isRate);
    if (asStock) {
      failures.push(
        `GATE — the premise leaked: ${asStock.text} appears with no per-period rendering`);
    }
  }
  if (c.id.startsWith('USEFUL') && seen.length === 0 && !/can'?t|cannot|unable|withheld|don'?t have/i.test(reply)) {
    failures.push('GATE — answered with neither a figure nor a stated limitation');
  }
  return failures;
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY is not set.'); process.exit(2); }
  const results: Outcome[] = [];

  for (const c of CASES) {
    for (let run = 1; run <= RUNS; run++) {
      const { prompt, table, history } = buildPrompt(c);
      const messages = history.map((h) => ({ role: 'user' as const, content: h.content }));
      let calls = 0;
      let served = '';
      let outcome = 'clean';
      let claims: { fid: string; statedAs: string }[] = [];
      let firstClaims = 0;
      let v1Failures: string[] = [];
      try {
        calls++;
        const first = await generateStructured<Answer>(
          prompt, messages, ANSWER_SCHEMA, MODEL ? { model: MODEL } : undefined);
        claims = first.claims ?? [];
        const v1 = verifyAnswer(first, table);
        firstClaims = first.claims?.length ?? 0;
        v1Failures = v1.failures.map((f) => `${f.kind}:${f.offending ?? f.detail}`);
        if (v1.ok) { served = first.prose; }
        else {
          calls++;
          const rep = await generateStructured<Answer>(
            `${prompt}\n\n${buildRepairInstruction(v1.failures)}`, messages, ANSWER_SCHEMA,
            MODEL ? { model: MODEL } : undefined);
          const v2 = verifyAnswer(rep, table);
          if (v2.ok) { served = rep.prose; outcome = 'repaired'; claims = rep.claims ?? []; }
          else { served = deterministicFallback(table); outcome = 'fallback'; claims = []; }
        }
      } catch (err) {
        served = ''; outcome = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
      const failures = score(c, served);
      results.push({ id: c.id, run, reply: served, outcome, claims, failures,
        firstClaims, v1Failures,
        promptTokens: Math.ceil(prompt.length / 4), calls });
      const mark = failures.length === 0 ? '✓' : '✗';
      console.log(`${mark} ${c.id} (run ${run}, ${Math.ceil(prompt.length / 4)} tok, `
        + `${calls} call${calls > 1 ? 's' : ''}) [${outcome}]  ${table.figures.length} figures / `
        + `${table.withheld.length} withheld`);
      for (const f of failures) console.log(`    ${f}`);
      if (outcome !== 'clean') {
        console.log(`    first attempt: ${firstClaims} claim(s) · `
          + `${v1Failures.length} verifier finding(s): ${v1Failures.slice(0, 4).join(' | ')}`);
      }
      if (verbose) {
        console.log(`  claims: ${claims.map((x) => `${x.fid}="${x.statedAs}"`).join(', ') || '(none)'}`);
        console.log(served.split('\n').map((l) => `    | ${l}`).join('\n'));
      }
    }
  }

  const failed = results.filter((r) => r.failures.length > 0);
  const outcomes = results.reduce<Record<string, number>>((a, r) => {
    a[r.outcome] = (a[r.outcome] ?? 0) + 1; return a;
  }, {});
  console.log(`\n  ${results.length - failed.length}/${results.length} clean  ·  `
    + `outcomes ${JSON.stringify(outcomes)}  ·  `
    + `${results.reduce((t, r) => t + r.calls, 0)} model calls`);

  writeFileSync('/tmp/answer-boundary.json', JSON.stringify(results, null, 2));
  console.log('transcripts -> /tmp/answer-boundary.json');

  if (failed.length > 0) {
    console.log('\nFailing:');
    for (const f of failed) console.log(`  ${f.id} run ${f.run}: ${f.failures.join(' | ')}`);
    process.exit(1);
  }
  console.log('\n[ANSWER BOUNDARY] PASSED - every served figure carried an address.');
}

void main();
