/**
 * scripts/ai-baseline/goal-seek-return.check.ts — Slice A narration proof (tests 12, 13)
 *
 * "What return do I need between now and Dec 31?" was answered "444% annualized".
 * The arithmetic below the model is proven in
 * lib/ai/conversation/goal-seek-return-representation.test.ts; this samples the
 * MODEL over the same fixture Space and checks which representation it leads with:
 *
 *   GENERIC     a by-date question over 89 days ⇒ the first return figure in the
 *               answer is `returnAtSolution.periodPct`, and the annualized one, if
 *               said at all, comes after it.
 *   ANNUALIZED  the same question asking for an "annualized return" ⇒ the first
 *               figure is `annualizedPct`, and `periodPct` is still given.
 *
 * Every percentage in the answer must be one the tool returned (no model arithmetic).
 *
 * ⚠️ NO DATABASE. The tool reads the shared fixture (fixtures/goal-seek-dogfood.ts);
 * DATABASE_URL is removed before anything loads, so telemetry writes fail closed
 * (non-fatal by design) and nothing in any database is read or written.
 *
 *   npm run ai:goal-seek-check                 # 5 trials per arm
 *   GOAL_SEEK_TRIALS=10 npm run ai:goal-seek-check
 */

delete process.env.DATABASE_URL;
delete process.env.DIRECT_URL;

import type { ToolContext } from '@/lib/ai/conversation/tools';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const TRIALS = Number(process.env.GOAL_SEEK_TRIALS ?? 5);

/** Every percentage figure in prose, in order, as numbers ("+51.2%", "444 %", "51.16 percent"). */
function percents(text: string): number[] {
  return [...text.matchAll(/([+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(?:%|percent)/g)].map((m) => Number(m[1].replace(/,/g, '')));
}
/** Does a prose figure name this value, at any rounding a sentence might use? */
const names = (said: number, value: number) => Math.abs(Math.abs(said) - value) <= Math.max(0.6, value * 0.01);

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY is not set'); process.exit(2); }
  const { openAiToolSchemas } = await import('@/lib/ai/conversation/tools');
  const { executeTurn, SYSTEM_INSTRUCTION } = await import('@/lib/ai/conversation/turn');
  const { newScenarioSlot } = await import('@/lib/ai/conversation/active-scenario');
  const { emptyPlan } = await import('@/lib/ai/conversation/pending-plan');
  const { CHAT_MODEL } = await import('@/lib/ai/conversation/engine');
  const { goalSeekFixtureReads, GOAL_SEEK_FIXTURE } = await import('@/lib/ai/conversation/fixtures/goal-seek-dogfood');
  const { ASOF, OPENING_INV } = GOAL_SEEK_FIXTURE;
  const reads = await goalSeekFixtureReads();
  // A target that needs ≈ +51% on the investments by 31 December (≈ 444%/yr).
  const target = Math.round(OPENING_INV * Math.pow(5.4431, 89 / 365));

  const arms = [
    { arm: 'GENERIC', lead: 'periodPct' as const,
      q: process.env.GOAL_SEEK_GENERIC_Q
        ?? `What return do I need on my investments between now and Dec 31 to reach ${target.toLocaleString('en-US')}?` },
    { arm: 'ANNUALIZED', lead: 'annualizedPct' as const,
      q: `What annualized return would my investments need to reach ${target.toLocaleString('en-US')} by Dec 31?` },
  ];

  for (const { arm, lead, q } of arms) {
    console.log(`\n${arm}: "${q}"`);
    let led = 0, both = 0, called = 0, clean = 0, wrongMeasure = 0;
    for (let i = 0; i < TRIALS; i++) {
      const toolCtx: ToolContext = { asOfISO: ASOF, spaceId: 'fixture', spaceCtx: { spaceId: 'fixture', userId: 'fixture' } as never,
        memoryClient: {} as never, readClient: {} as never, cashSpineReads: reads,
        plan: { pending: emptyPlan(), scenarioRan: false } };
      // The production transcript opens with the Space's orientation; this is the fixture's, in that shape, so
      // the model does not reach for a database read the fixture cannot answer.
      const orientation = `FINANCIAL ORIENTATION\n${JSON.stringify({ asOf: ASOF, position: { liquid: 20_000,
        investments: OPENING_INV, debt: 0, netWorth: 20_000 + OPENING_INV } }, null, 1)}`;
      const messages: unknown[] = [{ role: 'system', content: `${SYSTEM_INSTRUCTION}\n\nToday is ${ASOF}.` },
        { role: 'user', content: orientation }];
      const turn = await executeTurn({ messages, user: q, index: 0, model: CHAT_MODEL, toolSchemas: openAiToolSchemas(),
        toolCtx, scenario: newScenarioSlot(), correlationId: `goal-seek-check-${arm}-${i}`, surface: 'goal-seek-check' });
      const gs = [...turn.toolCalls].reverse().find((c) => c.name === 'scenario_goal_seek')?.result as Rec | undefined;
      const rep = gs?.returnAtSolution as Rec | undefined;
      const text = turn.assistant ?? '';
      const said = percents(text);
      if (!rep) {
        console.log(`    trial ${i}: no solved goal seek (${turn.toolCalls.map((c) => c.name).join(', ') || 'no tools'}) | said ${said.join(', ')}`);
        if (process.env.GOAL_SEEK_VERBOSE) console.log(text.split('\n').map((l) => `      > ${l}`).join('\n'));
        continue;
      }
      // ⚠️ A NET-WORTH SOLVE OF AN INVESTMENTS QUESTION IS ALREADY MET AT 0%, AND 0 "NAMES" BOTH
      // REPRESENTATIONS. It answers a different question; it is counted, said, and kept out of the
      // lead denominator rather than passing it vacuously.
      if (gs!.measure !== 'investments' || gs!.outcome !== 'SOLVED') {
        wrongMeasure++;
        console.log(`    trial ${i}: solved measure ${gs!.measure} (${gs!.outcome}) — not the investments question`);
        continue;
      }
      called++;
      const period = rep.periodPct as number, annual = rep.annualizedPct as number;
      const first = said.find((p) => names(p, period) || names(p, annual));
      const leadOk = first !== undefined && names(first, lead === 'periodPct' ? period : annual);
      // Either way the period return is in the answer: as the lead, or as the context.
      const hasBoth = said.some((p) => names(p, period));
      // Every return-sized figure said is one the tool returned (or the search bound it disclosed).
      const known = [period, annual, rep.growthFactor * 100 - 100, gs!.required as number].filter(Number.isFinite);
      const stray = said.filter((p) => Math.abs(p) >= 20 && !known.some((k) => names(p, k)));
      if (leadOk) led++;
      if (hasBoth) both++;
      if (stray.length === 0) clean++;
      console.log(`    trial ${i}: period ${period} annual ${annual} | said ${said.join(', ')} | lead ${leadOk ? 'OK' : 'WRONG'}${stray.length ? ` | stray ${stray.join(', ')}` : ''}`);
      if (process.env.GOAL_SEEK_VERBOSE) console.log(text.split('\n').map((l) => `      > ${l}`).join('\n'));
    }
    // Which measure the model hands the tool is a routing property, not this slice's; it is reported, not gated.
    console.log(`    observed: ${wrongMeasure}/${TRIALS} trials solved a measure other than investments`);
    check(`${arm}: the goal seek ran and solved in most trials`, called >= Math.ceil(TRIALS * 0.7), `${called}/${TRIALS}`);
    // ⚠️ A SAMPLED PROPERTY, GATED AT 80% AND REPORTED RAW. 20 trials per arm at ship: 19/20 each.
    check(`${arm}: led with ${lead}`, called > 0 && led >= Math.ceil(called * 0.8), `${led}/${called}`);
    check(`${arm}: ${lead === 'periodPct' ? 'gave the period return' : 'kept the period return as context'}`, both === called && called > 0, `${both}/${called}`);
    check(`${arm}: no return figure the tool did not return`, clean === called && called > 0, `${clean}/${called}`);
  }

  console.log(failures === 0 ? '\nall goal-seek narration checks passed' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
