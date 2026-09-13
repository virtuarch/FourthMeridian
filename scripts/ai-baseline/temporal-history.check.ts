/**
 * scripts/ai-baseline/temporal-history.check.ts
 *
 * THE EXACT DATES, AGAINST THE RECORD THAT GOT THEM WRONG.
 *
 * ⚠️ THE NUMBERS BELOW ARE THIS SPACE'S, AND THEY ARE THE POINT. In the browser
 * dogfood the assistant answered 2026-04-24 to "when did I first hit 0 with my
 * debt this year?" — a day whose debt, in the payload it was reading, was
 * $5,353.81. The first observed zero was 2026-07-22. Both facts were in the same
 * series. This proves the deterministic tool returns the right one, that a
 * retrospective read cannot see it early, and that the CLI and the production
 * route get the identical fact because they run the identical code.
 *
 *   npm run ai:temporal-check
 */

import '@/lib/ai/assemblers';
import { db } from '@/lib/db';
import { findTool, openAiToolSchemas, type ToolContext } from '@/lib/ai/conversation/tools';
import { openTranscript, runStatelessTurn } from '@/lib/ai/conversation/engine';
import { executeTurn } from '@/lib/ai/conversation/turn';
import { newScenarioSlot } from '@/lib/ai/conversation/active-scenario';
import { todayUTCISO } from '@/lib/time/clock';
import type { SpaceContext } from '@/lib/space';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}

type Found = {
  result: { date: string; value: number;
    previousObservation?: { date: string; value: number } } | null;
  unmatched?: string; unavailable?: string; error?: string;
  coverage?: { observationsSearched: number; observationsUnassertable: number };
};

async function main() {
  const spaceId = process.env.CHECK_SPACE_ID ?? 'cmrrm846r000j7znwsl67gt1g';
  const space = await db.space.findUniqueOrThrow({ where: { id: spaceId } });
  const owner = await db.spaceMember.findFirstOrThrow({
    where: { spaceId, role: 'OWNER', status: 'ACTIVE' } });
  const agent = await db.aiAgent.findUnique({ where: { spaceId }, select: { id: true } });
  const spaceCtx = { userId: owner.userId, spaceId, role: 'OWNER',
    permissions: { canInvite: true, canManage: true, canWrite: true, canRead: true, isOwner: true },
    space: { id: space.id, name: space.name, type: space.type, category: space.category,
      isPublic: space.isPublic, reportingCurrency: space.reportingCurrency },
  } as unknown as SpaceContext;

  const asOfISO = todayUTCISO();
  const tool = findTool('find_in_balance_history')!;
  const ctx: ToolContext = { spaceCtx, spaceId, asOfISO };
  const YEAR = { from: '2026-01-01', to: asOfISO };
  const ask = (args: Record<string, unknown>, over: Partial<ToolContext> = {}) =>
    tool.run(args, { ...ctx, ...over }) as Promise<Found>;

  console.log('1. THE QUESTION THAT WAS ANSWERED WRONG');
  {
    const r = await ask({ metric: 'debt', operation: 'first_below', threshold: 0, ...YEAR });
    check('first observed zero debt in 2026 is 2026-07-22', r.result?.date === '2026-07-22', r.result?.date);
    check('…and the value returned with it IS zero', r.result?.value === 0);
    check('…it is not 2026-04-24', r.result?.date !== '2026-04-24');
    check('…and 2026-04-24 really does hold $5,353.81, so the old answer was self-contradicting',
      (await ask({ metric: 'debt', operation: 'first_below', threshold: 5353.81,
        from: '2026-04-24', to: '2026-04-24' })).result?.value === 5353.81);
    check('the previous observation is named — what it crossed from',
      r.result?.previousObservation?.date === '2026-07-21'
        && r.result?.previousObservation?.value === 89.46);
    check('every observation in the year was searched, not a sample',
      (r.coverage?.observationsSearched ?? 0) >= 240, `${r.coverage?.observationsSearched}`);
  }

  console.log('\n2. THE REST OF THE FAMILY');
  {
    const last = await ask({ metric: 'debt', operation: 'last_below', threshold: 0, ...YEAR });
    check('the last observed zero is the most recent one, not the first',
      last.result?.date === '2026-09-12', last.result?.date);
    const below1k = await ask({ metric: 'debt', operation: 'first_below', threshold: 1000, ...YEAR });
    check('debt first fell below $1,000 on 2026-07-17', below1k.result?.date === '2026-07-17', below1k.result?.date);
    check('…at $17.12, from $3,555.05 the day before',
      below1k.result?.value === 17.12000000000003
        && below1k.result?.previousObservation?.date === '2026-07-16');
    const max = await ask({ metric: 'debt', operation: 'maximum', ...YEAR });
    check('the highest debt of the year is 2026-01-29 at $37,437.04',
      max.result?.date === '2026-01-29' && max.result?.value === 37437.04,
      `${max.result?.date} ${max.result?.value}`);
    const min = await ask({ metric: 'liquid', operation: 'minimum', ...YEAR });
    check('the lowest liquid balance is 2026-05-20 at $3,968.05',
      min.result?.date === '2026-05-20' && Math.abs((min.result?.value ?? 0) - 3968.05) < 0.005,
      `${min.result?.date} ${min.result?.value}`);
  }

  console.log('\n3. HONEST ABOUT WHAT IT CANNOT SAY');
  {
    check('a threshold nothing ever met is NO_OBSERVATION_MEETS_THE_CONDITION',
      (await ask({ metric: 'debt', operation: 'first_above', threshold: 1e9, ...YEAR }))
        .unmatched === 'NO_OBSERVATION_MEETS_THE_CONDITION');
    check('…which is a different answer from a range with no observations at all',
      (await ask({ metric: 'debt', operation: 'minimum', from: '2019-01-01', to: '2019-06-01' }))
        .unavailable === 'NO_OBSERVATIONS_IN_RANGE');
    check('a crossing operation with no threshold refuses rather than guessing one',
      typeof (await ask({ metric: 'debt', operation: 'first_below', ...YEAR })).error === 'string');
    check('an unknown metric is refused',
      typeof (await ask({ metric: 'vibes', operation: 'minimum' })).error === 'string');
  }

  console.log('\n4. THE INFORMATION CEILING HOLDS');
  {
    const early = await ask({ metric: 'debt', operation: 'first_below', threshold: 0, ...YEAR },
      { asOfISO: '2026-05-01' });
    check('asked as of 2026-05-01, July cannot be seen',
      early.result === null && early.unmatched === 'NO_OBSERVATION_MEETS_THE_CONDITION');
    check('…and the search really was bounded, not merely filtered afterwards',
      (early.coverage?.observationsSearched ?? 999) < 150, `${early.coverage?.observationsSearched}`);
    const midJuly = await ask({ metric: 'debt', operation: 'first_below', threshold: 0, ...YEAR },
      { asOfISO: '2026-07-22' });
    check('asked on the day itself, the day itself is the answer',
      midJuly.result?.date === '2026-07-22');
  }

  console.log('\n5. ONE RUNTIME, TWO CLIENTS, ONE FACT');
  {
    // ⚠️ THE PRODUCTION PATH AND THE TERMINAL PATH, BOTH DRIVEN HERE. The route
    // calls `runStatelessTurn`; the operator session opens a transcript and calls
    // `executeTurn`. If those ever answered differently, a dogfood session would
    // stop describing the product.
    const question = 'when did i first hit 0 with my debt this year?';
    const viaRoute = await runStatelessTurn({
      spaceCtx, agentId: agent?.id ?? 'temporal-check', user: question, history: [],
      asOfISO, surface: 'temporal-check', correlationId: 'temporal-check' });

    const open = await openTranscript({ spaceCtx, agentId: agent?.id ?? 'temporal-check',
      asOfISO, model: 'gpt-5.1' });
    const viaCli = await executeTurn({
      messages: open.messages, user: question, index: 0, model: 'gpt-5.1',
      toolSchemas: openAiToolSchemas(), toolCtx: { spaceCtx, spaceId, asOfISO },
      scenario: newScenarioSlot(), correlationId: 'temporal-check', surface: 'temporal-check' });

    const factOf = (calls: readonly { name: string; result: unknown }[]) => {
      const c = calls.find((x) => x.name === 'find_in_balance_history');
      return (c?.result as Found | undefined)?.result?.date ?? null;
    };
    const routeFact = factOf(viaRoute.record.toolCalls);
    const cliFact = factOf(viaCli.toolCalls);
    check('the production path reached the deterministic tool', routeFact !== null);
    check('the terminal path reached it too', cliFact !== null);
    check('both got the same date', routeFact === cliFact, `${routeFact} / ${cliFact}`);
    check('…and it is 2026-07-22', routeFact === '2026-07-22');
    for (const [label, answer] of [['route', viaRoute.answer], ['cli', viaCli.assistant]] as const) {
      check(`the ${label} answer states it`, /2026-07-22|July 22/.test(answer ?? ''));
      check(`…and never says April 24`, !/2026-04-24|April 24/.test(answer ?? ''));
    }
    console.log(`     route › ${(viaRoute.answer ?? '').slice(0, 130).replace(/\n/g, ' ')}…`);
    console.log(`     cli   › ${(viaCli.assistant ?? '').slice(0, 130).replace(/\n/g, ' ')}…`);
  }

  console.log('\n6. A CARD PAYMENT READS AS ONE EVENT');
  {
    const tx = await findTool('get_transactions')!.run(
      { from: '2026-07-16', to: '2026-07-16', sort: 'oldest', limit: 25 }, ctx) as {
        rows: { amount: number; account?: string; counterpartyAccount?: string }[] };
    const legs = tx.rows.filter((r) => Math.abs(r.amount) === 5000);
    check('both legs of the $5,000 payment are still in the ledger', legs.length === 2);
    check('…one on each account, each naming the other',
      legs.length === 2 && legs[0].account === legs[1].counterpartyAccount
        && legs[1].account === legs[0].counterpartyAccount,
      legs.map((l) => `${l.amount}@${l.account}→${l.counterpartyAccount}`).join(' '));
    check('…and they are opposite signs, so nothing was collapsed',
      legs.length === 2 && legs[0].amount === -legs[1].amount);
    const ordinary = tx.rows.find((r) => r.account && !r.counterpartyAccount);
    check('an ordinary purchase names its account and no counterparty', ordinary !== undefined);
  }

  console.log('\n7. A MONTHLY SPENDING FIGURE IS MEASURED OVER WHOLE MONTHS');
  {
    const sp = await findTool('get_spending')!.run({ from: '2026-03-13', to: asOfISO }, ctx) as {
      monthlySpending?: { completeMonths: number; mean: number;
        lowest: { month: string; spending: number }; highest: { month: string; spending: number } };
      byMonth: { month: string; partialMonth: boolean }[];
    };
    const m = sp.monthlySpending;
    check('it is present', m !== undefined);
    check('partial months are excluded from the count',
      m?.completeMonths === sp.byMonth.filter((x) => !x.partialMonth).length, `${m?.completeMonths}`);
    check('the spread is real and wide — a mean alone would describe neither end',
      (m?.highest.spending ?? 0) > 2 * (m?.lowest.spending ?? 1),
      `${m?.lowest.month} ${m?.lowest.spending} → ${m?.highest.month} ${m?.highest.spending}`);
    check('the payoff month is the LOWEST spending month, not the highest',
      m?.lowest.month === '2026-07', m?.lowest.month);
  }

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main();
