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
import { resolvePayDates } from '@/lib/ai/forecast/pay-dates';
import { planRetrieval, Concepts } from '@/lib/ai/retrieval-plan';
import { EvidenceAvailability, type CoverageEnvelope } from '@/lib/ai/coverage-envelope';
import {
  FORECAST_SCENARIOS, realSpaceCtx, STREAMS, HORIZON, AS_OF,
  type ForecastScenario,
} from '@/lib/ai/conformance/forecast-scenarios';
import { guardForecastReply } from '@/lib/ai/forecast/numerical-guard';
import { buildTypedPromptSuffix, minimalPreamble } from '@/lib/reasoning/answer/for-request';
import { ANSWER_SCHEMA } from '@/lib/reasoning/answer/schema';
import { verifyAnswer, buildRepairInstruction } from '@/lib/reasoning/verify/verify';
import { deterministicFallback } from '@/lib/reasoning/answer/generate';
import { generateStructured } from '@/lib/ai/provider';
import type { Answer } from '@/lib/reasoning/answer/types';
import type { FigureTable } from '@/lib/reasoning/figures/types';
import { explainForecast, type CashForecast } from '@/lib/forecast/engine';
import type { AssembledForecast } from '@/lib/ai/forecast/assemble';

// Mirrors lib/ai/provider.ts. Asserted, not assumed — a drift here means the
// harness is measuring a configuration production does not use.
//
// ⚠️ READ FROM THE SAME FLAG PRODUCTION READS (V26-REASONING Slice 2). Hard-coding
// the tier here was correct while `provider.ts` hard-coded it too; now that the
// tier is a decision, a harness that ignores the decision measures a
// configuration nobody runs. `--model=` still overrides, for the comparison.
const PRODUCTION_MODEL = process.env.AI_CHAT_MODEL || 'gpt-4o-mini';
const TEMPERATURE = 0.3;
const MAX_TOKENS = 1024;
/** Reasoning tokens are billed and counted against the same cap. */
const REASONING_MAX_TOKENS = 6000;

/**
 * FORECAST-12 — the tier under test.
 *
 * ⚠️ THE ONLY THING `--model=` CHANGES. The deterministic context, the system
 * prompt, the scenarios, the scoring and the sampling parameters are identical
 * across tiers; a comparison in which the prompt also moved would measure the
 * prompt. Defaults to production, so an un-flagged run is still the real thing.
 */
const CHAT_MODEL = process.argv.slice(2)
  .find((a) => a.startsWith('--model='))?.split('=')[1] ?? PRODUCTION_MODEL;

/** List price per 1M tokens, for an estimate only — never to gate anything. */
const PRICING: Record<string, { in: number; out: number }> = {
  'gpt-4o-mini': { in: 0.15, out: 0.60 },
  'gpt-4o': { in: 2.50, out: 10.00 },
  'gpt-4.1': { in: 2.00, out: 8.00 },
  'gpt-5': { in: 1.25, out: 10.00 },
};

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const runsArg = args.find((a) => a.startsWith('--runs='));
const RUNS = runsArg ? Math.max(1, Number(runsArg.split('=')[1])) : 1;
const only = args.find((a) => a.startsWith('--only='))?.split('=')[1];
const SET = only ? FORECAST_SCENARIOS.filter((s) => s.id === only) : FORECAST_SCENARIOS;

const PRICE = PRICING[CHAT_MODEL] ?? PRICING['gpt-4o-mini'];
const USD_IN = PRICE.in / 1_000_000;
const USD_OUT = PRICE.out / 1_000_000;

interface Result {
  id: string; run: number; reply: string;
  /** FORECAST-15 §1 — the model's own answer, before any enforcement. */
  rawReply: string;
  rawFailures: string[];
  /** What the guard saw, in every mode including shadow. */
  guardFindings: { kind: string; value: number }[];
  guardOutcome: string;
  /** The user-visible answer's failures. Identical to raw in shadow/off. */
  failures: string[]; narration: string[]; promptTokens: number; ms: number;
}

// ⚠️ THE REAL PLANNER, because FORECAST-11A's suppression is driven by it.
// Passing `undefined` measured a prompt production never builds.
const ENVELOPE: CoverageEnvelope = {
  // ⚠️ COMPLETE, NOT MINIMAL. The first version carried only the two fields
  // `planRetrieval` reads, so passing it to the prompt builder threw inside
  // `describeCoverageEnvelope` — which is how the missing CF-5 block was found
  // in the first place. A stub shaped to one consumer is a fidelity gap waiting
  // for the second consumer.
  transactions: { availability: EvidenceAvailability.AVAILABLE,
    span: { fromISO: '2023-03-01', toISO: AS_OF, count: 1840 } },
  snapshots: { availability: EvidenceAvailability.AVAILABLE,
    span: { fromISO: '2025-06-01', toISO: AS_OF, count: 454 } },
  accounts: { cash: 4, debt: 2, investments: 3, digitalAssets: 4, other: 0 },
  chains: [],
};

/**
 * FORECAST-14 — `--guard=repair` exercises the production boundary end to end.
 * Default `off` measures the bare model, which is how the failure was found and
 * how a regression would be.
 */
const GUARD = (args.find((a) => a.startsWith('--guard='))?.split('=')[1] ?? 'off') as
  'off' | 'shadow' | 'repair';

/**
 * V26-REASONING Slice 1 — `--answer-mode=typed` runs the SAME corpus, the SAME
 * fixture and the SAME prompt through the typed answer boundary instead of
 * through free prose plus the regex guards.
 *
 * ⚠️ IT IS THE COMPARISON, NOT A SECOND HARNESS. The plan's acceptance is
 * exactly this: run the corpus in both modes and compare how many unlicensed
 * figures reach the user, and at what cost to the answers. Building a separate
 * corpus for the new path would have measured a different question.
 *
 * `--guard` is ignored under `typed`, and deliberately: the three prose guards
 * are bypassed on that path, so running one here would measure a configuration
 * production cannot produce.
 */
const ANSWER_MODE = (args.find((a) => a.startsWith('--answer-mode='))?.split('=')[1] ?? 'prose') as
  'prose' | 'typed';
/**
 * V26-REASONING Slice 7 — `--prompt-shape=minimal` drops the ~4,250 tokens of
 * doctrine that the typed figure table replaces, and measures what that costs on
 * the corpus rather than on the seven adversarial cases alone.
 */
const PROMPT_SHAPE = (args.find((a) => a.startsWith('--prompt-shape='))?.split('=')[1] ?? 'full') as
  'full' | 'minimal';

function buildPrompt(s: ForecastScenario): {
  prompt: string; question: string; forecast: AssembledForecast; table: FigureTable;
} {
  const ctx = realSpaceCtx();
  const question = s.question;
  const plan = planRetrieval({
    messages: [...(s.priorTurns ?? []).map((c) => ({ role: 'user', content: c })),
      { role: 'user', content: question }],
    envelope: ENVELOPE, now: new Date(`${AS_OF}T12:00:00.000Z`),
  });
  // FORECAST-16 — a pay-date question builds the capability, NOT a forecast:
  // that is the whole point of the seam, and a harness that built both would be
  // measuring a prompt production never assembles.
  const payDates = plan.concepts.includes(Concepts.PAY_DATES)
    ? resolvePayDates(STREAMS, AS_OF, question) : undefined;
  const forecast = assembleForecast({
    ctx, streams: STREAMS, horizon: HORIZON, asOfISO: AS_OF,
    question,
    additionalEvents: s.extraEvents ?? [],
  });
  const assessment = computeAssessment(ctx);
  const route = classifyFinancialIntent(question);
  const history = [...(s.priorTurns ?? []).map((c) => ({ role: 'user', content: c })),
    { role: 'user', content: question }];
  // ⚠️ A PAY-DATE TURN BUILDS NO FORECAST IN PRODUCTION, so it must build none
  // here. FORECAST-16's whole finding is that the two capabilities are separate
  // — folding pay dates into the forecast ask is what made a pay-date question
  // answer "Ending cash: REFUSED" — and the route reflects that: `forecast` is
  // undefined on a PAY_DATES turn. Handing the typed table a forecast the route
  // would not have built licenses seven paycheck AMOUNTS on a question that
  // asked only for DATES, which is precisely what the S* scenarios forbid.
  const typed = buildTypedPromptSuffix({
    forecast: payDates ? undefined : forecast, ctx, assessment, messages: history,
    scope: payDates ? 'PAY_DATES' : 'FULL',
  });
  const base = buildSpaceSystemPrompt(
      // ⚠️ ARGUMENT-FOR-ARGUMENT WITH app/api/ai/chat/route.ts. `debtPayments`
      // is the one deliberate omission: production passes a per-liability
      // rollup fetched from the database, and this harness reads none. It
      // renders an extra disclosure block and touches no forecast decision.
      ctx, assessment, route, undefined, ENVELOPE, question, plan,
      payDates ? undefined : forecast, payDates);
  return {
    forecast, question, table: typed.table,
    prompt: ANSWER_MODE !== 'typed' ? base
      : PROMPT_SHAPE === 'minimal'
        ? `${minimalPreamble(ctx.space?.name, AS_OF)}\n${typed.suffix}`
        : `${base}\n${typed.suffix}`,
  };
}

/** Reported, never counted. See ForecastScenario.narration. */
function narrationNotes(s: ForecastScenario, reply: string): string[] {
  return (s.narration ?? []).filter((n) => n.pattern.test(reply)).map((n) => n.why);
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
  let inTok = 0;
  let outTok = 0;

  for (const s of SET) {
    const { prompt, question, forecast, table } = buildPrompt(s);
    const payDatesOnly = planRetrieval({
      messages: [{ role: 'user', content: question }],
      envelope: ENVELOPE, now: new Date(`${AS_OF}T12:00:00.000Z`),
    }).concepts.includes(Concepts.PAY_DATES);
    const messages = [
      { role: 'system' as const, content: prompt },
      ...(s.priorTurns ?? []).map((c) => ({ role: 'user' as const, content: c })),
      { role: 'user' as const, content: question },
    ];
    for (let run = 1; run <= RUNS; run++) {
      const t0 = Date.now();
      if (ANSWER_MODE === 'typed') {
        // ── The typed boundary, exactly as the route runs it ────────────────
        const userTurns = messages.filter((m) => m.role === 'user')
          .map((m) => ({ role: 'user' as const, content: m.content }));
        let served = '';
        let outcome: string = 'clean';
        let calls = 1;
        let firstFailures: string[] = [];
        try {
          const first = await generateStructured<Answer>(
            prompt, userTurns, ANSWER_SCHEMA, { model: CHAT_MODEL });
          const v1 = verifyAnswer(first, table);
          firstFailures = v1.failures.map((f) => `${f.kind}:${f.offending ?? ''}`);
          if (v1.ok) served = first.prose;
          else {
            calls = 2;
            const rep = await generateStructured<Answer>(
              `${prompt}\n\n${buildRepairInstruction(v1.failures)}`, userTurns,
              ANSWER_SCHEMA, { model: CHAT_MODEL });
            if (verifyAnswer(rep, table).ok) { served = rep.prose; outcome = 'repaired'; }
            else { served = deterministicFallback(table); outcome = 'fallback'; }
          }
        } catch (err) {
          served = ''; outcome = `error:${err instanceof Error ? err.message : ''}`;
        }
        const ms = Date.now() - t0;
        const failures = score(s, served);
        results.push({ id: s.id, run, reply: served, rawReply: served,
          rawFailures: failures, guardFindings: [], guardOutcome: outcome,
          failures, narration: narrationNotes(s, served),
          promptTokens: Math.ceil(prompt.length / 4), ms });
        console.log(`${failures.length === 0 ? '✓' : '✗'} ${s.id} (run ${run}, `
          + `~${Math.ceil(prompt.length / 4)} tok, ${calls} call(s)) [${outcome}]`);
        for (const f of failures) console.log(`    ${f}`);
        if (outcome !== 'clean' && firstFailures.length > 0) {
          console.log(`    first: ${firstFailures.slice(0, 3).join(' | ')}`);
        }
        if (verbose) console.log(`\n--- reply ---\n${served}\n-------------\n`);
        continue;
      }
      // gpt-5 and the reasoning tiers reject `temperature` and rename the token
      // cap; everything else takes the chat route's own parameters unchanged.
      const isReasoning = /^(gpt-5|o[134])/.test(CHAT_MODEL);
      const res = await client.chat.completions.create(isReasoning
        // ⚠️ A REASONING TIER NEEDS ITS OWN CEILING. At the chat route's 1024
        // the whole budget went to reasoning tokens and gpt-5 returned an EMPTY
        // string ten times out of ten — which the scorer read as ten failures.
        // A tier that cannot answer at all is not a tier that answered badly.
        ? { model: CHAT_MODEL, max_completion_tokens: REASONING_MAX_TOKENS, messages }
        : { model: CHAT_MODEL, temperature: TEMPERATURE, max_tokens: MAX_TOKENS, messages });
      const ms = Date.now() - t0;
      inTok += res.usage?.prompt_tokens ?? 0;
      outTok += res.usage?.completion_tokens ?? 0;
      const rawReply = res.choices[0]?.message?.content ?? '';
      let reply = rawReply;
      // FORECAST-15 §1 — the guard runs in EVERY mode so the shadow rate is
      // measurable; only 'repair' changes what the user would see.
      let guardOutcome = 'none';
      let guardFindings: { kind: string; value: number }[] = [];
      let guardNote = '';
      if (GUARD !== 'off' && !payDatesOnly && !('refused' in forecast.forecast)) {
        const fc = forecast.forecast as CashForecast;
        const g = guardForecastReply(reply, fc, GUARD, () => explainForecast(fc));
        guardFindings = g.findings.map((f) => ({ kind: String(f.kind), value: f.value }));
        guardOutcome = g.outcome;
        reply = g.reply;
        if (g.outcome !== 'clean') guardNote = ` [${g.outcome}]`;
      }
      const failures = score(s, reply);
      const rawFailures = score(s, rawReply);
      const narration = narrationNotes(s, reply);
      results.push({ id: s.id, run, reply, rawReply, rawFailures,
        guardFindings, guardOutcome, failures, narration,
        promptTokens: res.usage?.prompt_tokens ?? 0, ms });
      const mark = failures.length === 0 ? '✓' : '✗';
      const rawMark = rawFailures.length === 0 ? '·' : 'R';
      console.log(`${mark}${rawMark} ${s.id} (run ${run}, prompt ${res.usage?.prompt_tokens} tok)${guardNote}`);
      for (const f of failures) console.log(`    ${f}`);
      for (const n of narration) console.log(`    · narration: ${n}`);
      if (verbose) console.log(`\n--- reply ---\n${reply}\n-------------\n`);
    }
  }

  const failed = results.filter((r) => r.failures.length > 0);
  const byId = new Map<string, number>();
  for (const r of failed) byId.set(r.id, (byId.get(r.id) ?? 0) + 1);

  // FORECAST-15 — the four numbers the rollout decision needs, kept apart.
  const rawViolations = results.filter((r) => r.rawFailures.length > 0).length;
  const detected = results.filter((r) => r.guardFindings.length > 0).length;
  const outcomes = results.reduce<Record<string, number>>((a, r) => {
    a[r.guardOutcome] = (a[r.guardOutcome] ?? 0) + 1; return a; }, {});
  console.log(`\n  RAW model failures: ${rawViolations}/${results.length}`
    + `  ·  guard detected: ${detected}/${results.length}`
    + `  ·  outcomes ${JSON.stringify(outcomes)}`);

  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`\n[${CHAT_MODEL}] ${results.length - failed.length}/${results.length} clean`
    + `  ·  est $${((inTok * USD_IN) + (outTok * USD_OUT)).toFixed(4)}`
    + `  ·  avg prompt ${Math.round(results.reduce((t, r) => t + r.promptTokens, 0) / results.length)} tok`
    + `  ·  latency p50 ${lat[Math.floor(lat.length / 2)]}ms p95 ${lat[Math.floor(lat.length * 0.95)]}ms`);
  const narrationCount = results.filter((r) => r.narration.length > 0).length;
  if (narrationCount) {
    console.log(`\nNarration notes (reported, not failures): ${narrationCount}/${results.length}`);
  }
  if (byId.size) {
    console.log('\nFailing scenarios:');
    for (const [id, n] of byId) console.log(`  ${id}: ${n}/${RUNS}`);
  }
  writeFileSync(`/tmp/forecast-conformance-${CHAT_MODEL}.json`, JSON.stringify(results, null, 2));
  writeFileSync('/tmp/forecast-conformance.json', JSON.stringify(results, null, 2));
  console.log(`\ntranscripts → /tmp/forecast-conformance-${CHAT_MODEL}.json`);
}

void main();
