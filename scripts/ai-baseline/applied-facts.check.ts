/**
 * scripts/ai-baseline/applied-facts.check.ts
 *
 * THE INVARIANT: EVERY FACT `project_cash` REPORTS AS APPLIED ACTUALLY MOVED THE
 * NUMBER, AND NOTHING ELSE CAN GET INTO THAT CHANNEL.
 *
 * The hole this closes (1d67786 §7): `statedAs` was passed verbatim as the
 * WORDING of the SPENDING_LEVEL statement, and `assembleForecast` quotes that
 * wording into `appliedFacts`. So a sentence about a $15k bonus arrived attached
 * to a $4,346.48 spending figure, the projection moved $10.43, and the result
 * said `spending baseline 4346.48 USD: "user has a $15k net bonus on 2026-12-07
 * added on top of current pattern"` — then carried that into the durable
 * checkpoint's `basis.userAssumptions`.
 *
 * Needs a database (these are real projections over the live corpus), so it sits
 * outside the DB-free suite — the memory-store.check.ts precedent.
 *
 *   npm run ai:applied-facts-check
 */

import '@/lib/ai/assemblers';
import { db } from '@/lib/db';
import { findTool, type ToolContext } from '@/scripts/ai-baseline/tools';
import type { SpaceContext } from '@/lib/space';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}

type Cash = {
  projection: { endingCash: number; basis: { spending: Record<string, unknown> } } | null;
  appliedUserFacts: string[];
};
const TO = '2026-12-31';

/** Every string in the result that could be read as "this was applied". */
function appliedChannels(r: Cash): string {
  return JSON.stringify({
    appliedUserFacts: r.appliedUserFacts,
    spendingBasis: r.projection?.basis?.spending ?? null,
  });
}

async function main() {
  const spaceId = process.env.CHECK_SPACE_ID ?? 'cmrrm846r000j7znwsl67gt1g';
  const space = await db.space.findUniqueOrThrow({ where: { id: spaceId } });
  const owner = await db.spaceMember.findFirstOrThrow({
    where: { spaceId, role: 'OWNER', status: 'ACTIVE' } });
  const spaceCtx = { userId: owner.userId, spaceId, role: 'OWNER',
    permissions: { canInvite: true, canManage: true, canWrite: true, canRead: true, isOwner: true },
    space: { id: space.id, name: space.name, type: space.type, category: space.category,
      isPublic: space.isPublic, reportingCurrency: space.reportingCurrency },
  } as unknown as SpaceContext;
  const ctx: ToolContext = { spaceCtx, spaceId, asOfISO: '2026-09-12' };
  const cash = (args: Record<string, unknown>) =>
    findTool('project_cash')!.run(args, ctx) as Promise<Cash>;

  console.log('1. BASELINE');
  const base = await cash({ to: TO });
  check('an ordinary projection produces a figure', typeof base.projection?.endingCash === 'number',
    String(base.projection?.endingCash));
  check('…and applies no user facts', base.appliedUserFacts.length === 0,
    JSON.stringify(base.appliedUserFacts));
  check('…and reports its spending source as OBSERVED, not USER_STATED',
    base.projection?.basis.spending.source === 'OBSERVED');

  console.log('\n2. THE SUPPORTED OVERRIDE — coupled to the number (mutation proof)');
  const over = await cash({ to: TO, assumedMonthlySpending: 6000 });
  check('the result CHANGES', over.projection!.endingCash !== base.projection!.endingCash,
    `${base.projection!.endingCash} → ${over.projection!.endingCash}`);
  check('exactly one applied fact', over.appliedUserFacts.length === 1,
    JSON.stringify(over.appliedUserFacts));
  check('…it names the amount that was applied', over.appliedUserFacts[0].includes('6000'));
  check('…and the spending basis switches to USER_STATED',
    over.projection!.basis.spending.source === 'USER_STATED');
  // The three questions the invariant demands an answer to.
  check('WHAT INPUT?  assumedMonthlySpending, named in the fact',
    /spending baseline 6000 USD/.test(over.appliedUserFacts[0]), over.appliedUserFacts[0]);
  check('WHERE DID IT ENTER?  as the SPENDING_LEVEL statement — removing it restores the baseline',
    (await cash({ to: TO })).projection!.endingCash === base.projection!.endingCash);
  check('WHAT DID IT AFFECT?  endingCash, monotonically in the spending direction',
    (await cash({ to: TO, assumedMonthlySpending: 9000 })).projection!.endingCash
      < over.projection!.endingCash);

  console.log('\n3. NEGATIVE — THE DISCOVERED BONUS, THROUGH EVERY PATH THAT REMAINS');
  // The exact shape from the reproduction, now with no `statedAs` to carry it.
  const bonusAttempts: Record<string, unknown>[] = [
    { to: TO, statedAs: 'I get a $15k net bonus on Dec 7' },
    { to: TO, assumedMonthlySpending: 4346.48, statedAs: 'user has a $15k net bonus on 2026-12-07 added on top of current pattern' },
  ];
  for (const [i, args] of bonusAttempts.entries()) {
    const r = await cash(args);
    const ch = appliedChannels(r);
    check(`attempt ${i + 1}: no "bonus" anywhere in an applied channel`, !/bonus/i.test(ch), ch.slice(0, 120));
    check(`attempt ${i + 1}: no 15k / 15,000 implied`, !/15,?000|\$?15k/i.test(ch));
    if (args.assumedMonthlySpending === undefined) {
      check(`attempt ${i + 1}: cash is EXACTLY the ordinary result`,
        r.projection!.endingCash === base.projection!.endingCash,
        `${r.projection!.endingCash} vs ${base.projection!.endingCash}`);
      check(`attempt ${i + 1}: nothing is reported as applied`, r.appliedUserFacts.length === 0);
    } else {
      // A supported override WAS supplied alongside the prose: the override applies,
      // the prose does not, and the fact describes the override only.
      check(`attempt ${i + 1}: the fact describes the SPENDING figure, not the sentence`,
        r.appliedUserFacts.length === 1 && /spending baseline 4346\.48 USD/.test(r.appliedUserFacts[0]),
        r.appliedUserFacts[0]);
      check(`attempt ${i + 1}: and the move is the spending override's, nowhere near $15,000`,
        Math.abs(r.projection!.endingCash - base.projection!.endingCash) < 100,
        `Δ ${(r.projection!.endingCash - base.projection!.endingCash).toFixed(2)}`);
    }
  }

  console.log('\n4. NEGATIVE — ARBITRARY PROSE, NOT A SPECIAL CASE FOR "BONUS"');
  for (const prose of [
    '$20k inheritance in November', 'sell $5k of crypto next month', 'buy a $30k car',
    'my rent increases in October', 'I will invest $500 every weekday',
  ]) {
    const r = await cash({ to: TO, statedAs: prose });
    check(`"${prose}" → result unchanged`,
      r.projection!.endingCash === base.projection!.endingCash);
    check(`"${prose}" → nothing applied`,
      r.appliedUserFacts.length === 0 && !appliedChannels(r).includes(prose.slice(0, 12)));
  }

  console.log('\n5. CHECKPOINT PROPAGATION — the durable record cannot inherit prose');
  const { checkpointProjection } = await import('@/scripts/ai-baseline/memory-tools');
  const withProse = await cash({ to: TO, assumedMonthlySpending: 4346.48,
    statedAs: 'user has a $15k net bonus on 2026-12-07' });
  const before = await db.spaceMemory.count({ where: { spaceId } });
  await checkpointProjection({ spaceId, asOfISO: '2026-09-12', spaceCtx: { userId: owner.userId } },
    'project_cash', withProse);
  const latest = await db.spaceMemory.findFirst({
    where: { spaceId, kind: 'CHECKPOINT' as never }, orderBy: { createdAt: 'desc' } });
  const payload = JSON.stringify((latest as { payload?: unknown } | null)?.payload ?? {});
  check('a checkpoint was written (the path is live)',
    await db.spaceMemory.count({ where: { spaceId } }) >= before);
  check('its basis.userAssumptions carries no bonus prose', !/bonus/i.test(payload), payload.slice(0, 200));
  check('…and no $15k', !/15,?000|15k/i.test(payload));

  console.log('\n6. SCENARIO CONTROL — the same hypothetical IS representable, deterministically');
  const scen = await findTool('scenario_projection')!.run(
    { to: TO, granularity: 'monthly',
      outflows: [{ onDate: '2026-12-07', amount: -15000, label: 'net bonus' }] }, ctx) as {
        checkpoints: { liquid: { amount: number } }[];
        assumptions: { outflows: { count: number; settled: { amount: number }[] } };
      };
  const scenEnd = scen.checkpoints.slice(-1)[0].liquid.amount;
  check('the scenario ledger applies the full $15,000',
    Math.abs((scenEnd - base.projection!.endingCash) - 15000) < 0.01,
    `${base.projection!.endingCash} → ${scenEnd}  (Δ ${(scenEnd - base.projection!.endingCash).toFixed(2)})`);
  check('…and reports it as a structured movement, not a sentence',
    scen.assumptions.outflows.count === 1 && scen.assumptions.outflows.settled[0].amount === -15000);

  console.log('\n7. THE SCHEMAS NO LONGER INVITE IT');
  const { openAiToolSchemas } = await import('@/scripts/ai-baseline/tools');
  for (const name of ['project_cash', 'scenario_projection', 'scenario_goal_seek']) {
    const t = (openAiToolSchemas() as { function: { name: string; parameters: unknown } }[])
      .find((x) => x.function.name === name)!;
    check(`${name} exposes no free-text \`statedAs\``,
      !JSON.stringify(t.function.parameters).includes('statedAs'));
  }

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main();
