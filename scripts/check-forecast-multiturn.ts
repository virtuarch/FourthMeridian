/**
 * scripts/check-forecast-multiturn.ts   (FORECAST-12)
 *
 * ACCEPTANCE: does the product hold across a CONVERSATION, not just a turn?
 *
 *   npm run ai:forecast-multiturn
 *   npm run ai:forecast-multiturn -- --model=gpt-4.1 --verbose
 *
 * ⚠️ EVERY TURN IS RE-PLANNED AND RE-ASSEMBLED, exactly as the chat route does
 * it. The plan sees the whole message history (so CF-4 inheritance and
 * FORECAST-10's refinement rule are live), the forecast is rebuilt from that
 * turn's question alone (so FORECAST-10's per-turn assumption doctrine is
 * live), and the prompt is rebuilt each time. A harness that built one prompt
 * and appended turns would be testing a product nobody ships.
 *
 * NOT a gate: paid, stochastic. OPERATIONAL, like its single-turn sibling.
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { computeAssessment } from '@/lib/ai/intelligence';
import { buildSpaceSystemPrompt } from '@/lib/ai/prompts/system-prompt';
import { classifyFinancialIntent } from '@/lib/ai/intent';
import { planRetrieval } from '@/lib/ai/retrieval-plan';
import { assembleForecast } from '@/lib/ai/forecast/assemble';
import { resolveForecastHorizon } from '@/lib/ai/forecast/horizon';
import { EvidenceAvailability, type CoverageEnvelope } from '@/lib/ai/coverage-envelope';
import { AssumptionOrigin } from '@/lib/forecast/policy';
import { addMonths } from '@/lib/perspectives/time-range';
import { realSpaceCtx, STREAMS, AS_OF } from '@/lib/ai/conformance/forecast-scenarios';

const PRODUCTION_MODEL = 'gpt-4o-mini';
const args = process.argv.slice(2);
const CHAT_MODEL = args.find((a) => a.startsWith('--model='))?.split('=')[1] ?? PRODUCTION_MODEL;
const verbose = args.includes('--verbose');
const RUNS = Number(args.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 1);

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

interface Turn {
  say: string;
  /** Checked against THIS turn's reply. */
  forbidden?: { pattern: RegExp; why: string }[];
  required?: { any: RegExp[]; why: string }[];
  /** Checked against the assembled context, not the reply. */
  context?: (c: { horizonTo: string | null; assumptions: number; facts: number;
    concepts: string[] }) => string | null;
}

const CONVERSATIONS: { id: string; turns: Turn[] }[] = [
  {
    id: 'A-refine-then-leave',
    turns: [
      { say: 'Forecast my cash for the next 3 months.',
        context: (c) => c.horizonTo === '2026-11-28' ? null : `horizon ${c.horizonTo}` },
      { say: 'What if I spend $5,000 a month?',
        context: (c) => c.assumptions === 1 ? null : `expected 1 assumption, got ${c.assumptions}`,
        forbidden: [{ pattern: /\$?\s?15,?000\b/, why: 'multiplied the rate by a month count' }] },
      { say: 'What about 6 months?',
        context: (c) => c.horizonTo === '2027-02-28' ? null : `horizon ${c.horizonTo}` },
      { say: 'What are my investments?',
        context: (c) => c.concepts.includes('FORECAST')
          ? 'forecast survived a topic change' : null },
    ],
  },
  {
    id: 'B-assumption-does-not-persist',
    turns: [
      { say: 'Forecast my cash for the next 3 months.' },
      { say: 'Assume my paycheck is net.',
        context: (c) => c.assumptions === 1 ? null : `expected 1 assumption, got ${c.assumptions}` },
      { say: 'What will my cash look like over the next 3 months?',
        context: (c) => c.assumptions === 0 ? null : `assumption persisted: ${c.assumptions}`,
        forbidden: [{ pattern: /(?:end (?:up )?with|ending cash(?::| will| would)? (?:be )?)\s*\$?\s?[\d,]{4,}/i,
          why: 'stated an ending balance without the assumption that licensed it' }] },
    ],
  },
  {
    id: 'C-correction-reaches-authority',
    turns: [
      { say: 'Forecast my cash for the next 3 months.' },
      // FORECAST-13: this turn asks for nothing, so no forecast is assembled —
      // and that is fine, because the sentence stays in the history.
      { say: 'No — $5,286.645 is take-home. And my normal spending is $4,000 a month.' },
      { say: 'So forecast my cash for the next 3 months.',
        context: (c) => c.facts === 2 ? null : `the correction was lost: ${c.facts} facts applied`,
        // ⚠️ SCOPED TO WHAT FACT CONTINUITY DELIVERS. The reply must USE the
        // corrected inputs rather than refuse; whether it then quotes the
        // engine's ending figure or reconstructs one is the D/I premise-echo
        // defect, which FORECAST-14 owns and which this slice must not be
        // scored on. Conflating them would either hide this fix or claim a
        // failure it did not cause.
        required: [
          { any: [/5,?286\.6|take[- ]home/i], why: 'must use the corrected basis' },
          { any: [/4,?000/], why: 'must use the corrected spending level' },
        ],
        forbidden: [{ pattern: /can'?t (?:provide|give|project)|cannot (?:provide|give|project)/i,
          why: 'refused a forecast the user had supplied both inputs for' }] },
    ],
  },
];

async function main(): Promise<void> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) { console.error('OPENAI_API_KEY is not set.'); process.exit(2); }
  const client = new OpenAI({ apiKey: key });
  let pass = 0, fail = 0;

  for (let run = 1; run <= RUNS; run++) {
    for (const convo of CONVERSATIONS) {
      const history: { role: 'user' | 'assistant'; content: string }[] = [];
      console.log(`\n── ${convo.id}${RUNS > 1 ? ` (run ${run})` : ''} ──`);

      for (const turn of convo.turns) {
        const ctx = realSpaceCtx();
        const messages = [...history, { role: 'user' as const, content: turn.say }];
        const plan = planRetrieval({
          messages, envelope: ENVELOPE, now: new Date(`${AS_OF}T12:00:00.000Z`) });

        const isForecast = plan.concepts.includes('FORECAST');
        const horizon = isForecast
          ? (resolveForecastHorizon(turn.say, AS_OF) ?? {
            fromISO: AS_OF, toISO: addMonths(AS_OF, 3),
            origin: AssumptionOrigin.SYSTEM_POLICY, statedAs: 'default 3-month horizon' })
          : null;
        const forecast = horizon
          ? assembleForecast({ ctx, streams: STREAMS, horizon, asOfISO: AS_OF,
            question: turn.say, messages })
          : undefined;

        const probe = {
          horizonTo: horizon?.toISO ?? null,
          assumptions: forecast?.policy.assumptions
            .filter((a) => a.origin === AssumptionOrigin.USER_REQUESTED).length ?? 0,
          facts: forecast?.appliedFacts.length ?? 0,
          concepts: [...plan.concepts] as string[],
        };

        const issues: string[] = [];
        const ctxIssue = turn.context?.(probe);
        if (ctxIssue) issues.push(`CONTEXT — ${ctxIssue}`);

        const prompt = buildSpaceSystemPrompt(
          ctx, computeAssessment(ctx), classifyFinancialIntent(turn.say),
          undefined, undefined, turn.say, plan, forecast);
        const res = await client.chat.completions.create({
          model: CHAT_MODEL, temperature: 0.3, max_tokens: 1024,
          messages: [{ role: 'system', content: prompt }, ...messages],
        });
        const reply = res.choices[0]?.message?.content ?? '';

        for (const f of turn.forbidden ?? []) {
          const m = f.pattern.exec(reply);
          if (m) issues.push(`FORBIDDEN — ${f.why} ⟨${m[0].slice(0, 40)}⟩`);
        }
        for (const r of turn.required ?? []) {
          if (!r.any.some((p) => p.test(reply))) issues.push(`MISSING — ${r.why}`);
        }

        if (issues.length === 0) pass++; else fail++;
        console.log(`  ${issues.length ? '✗' : '✓'} "${turn.say.slice(0, 52)}"`
          + `  [concepts ${probe.concepts.join('+')} · horizon ${probe.horizonTo ?? '—'}`
          + ` · assumptions ${probe.assumptions} · facts ${probe.facts}]`);
        for (const i of issues) console.log(`      ${i}`);
        if (verbose) console.log(`      ${reply.slice(0, 300).replace(/\n/g, ' ')}`);

        history.push({ role: 'user', content: turn.say },
          { role: 'assistant', content: reply });
      }
    }
  }
  console.log(`\n[${CHAT_MODEL}] ${pass}/${pass + fail} turns clean`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
