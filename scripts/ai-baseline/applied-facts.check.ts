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
 * ⚠️ NO LIVE MONEY OR DATE IS PINNED HERE ANY MORE. The first version carried the
 * Space's own observed spending, `4346.48`, as a literal — as an INPUT, and again
 * inside a regex, and once more hidden in a tolerance ("the move is < $100", true
 * only while the observed rate stays near the literal). It also read as of
 * 2026-09-12 to a horizon of 2026-12-31. The observed monthly figure is now READ
 * from the ledger's own echo (`assumptions.spending.monthly`, "the same observed
 * rate project_cash uses"), the overrides are multiples of it, and the as-of,
 * horizon and one-off date are derived from today (or `CHECK_AS_OF`).
 *
 * ⚠️ IT USED TO WRITE INTO THE SPACE IT READS, AND SAID NOTHING ABOUT IT. §5 called
 * `checkpointProjection` on the named Space, which stores a `liquid-<horizon>`
 * CHECKPOINT — superseding the user's real one with a projection made under an
 * ASSUMED spending figure — and then asserted `count >= before`, which cannot
 * fail. §5 now writes to a THROWAWAY Space and user, created here and deleted in
 * a `finally` (the memory-store.check.ts precedent), and asserts the row itself.
 * Everything else is read-only. `SpaceMemory` on the named Space is counted
 * before and after, and must not move.
 *
 *   npm run ai:applied-facts-check
 */

import '@/lib/ai/assemblers';
import { db } from '@/lib/db';
import { findTool, monthEndsBetween, type ToolContext } from '@/lib/ai/conversation/tools';
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
const DAY = 86_400_000;
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const ASOF = process.env.CHECK_AS_OF ?? new Date().toISOString().slice(0, 10);
/** The fourth month-end after the as-of, and a one-off 24 days before it (2026-12-31 / 12-07 as of 2026-09-12). */
const TO = monthEndsBetween(ASOF, shift(ASOF, 200))[3];
const BONUS_ON = shift(TO, -24);
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  const ctx: ToolContext = { spaceCtx, spaceId, asOfISO: ASOF };
  const cash = (args: Record<string, unknown>) =>
    findTool('project_cash')!.run(args, ctx) as Promise<Cash>;
  console.log(`Space ${spaceId} as of ${ASOF} → ${TO}\n`);
  const memoryBefore = await db.spaceMemory.count({ where: { spaceId } });

  console.log('1. BASELINE');
  const base = await cash({ to: TO });
  check('an ordinary projection produces a figure', typeof base.projection?.endingCash === 'number',
    String(base.projection?.endingCash));
  check('…and applies no user facts', base.appliedUserFacts.length === 0,
    JSON.stringify(base.appliedUserFacts));
  check('…and reports its spending source as OBSERVED, not USER_STATED',
    base.projection?.basis.spending.source === 'OBSERVED');
  // ⚠️ THE OBSERVED MONTHLY FIGURE, READ — NEVER REMEMBERED. The ledger echoes the
  // rate it shares with project_cash; everything below that needs "about what he
  // already spends" or "clearly more than that" is built from this.
  const ledger = await findTool('scenario_projection')!.run({ to: TO, granularity: 'monthly' }, ctx) as {
    assumptions: { spending: { source: string; monthly: number } } };
  const OBSERVED = ledger.assumptions.spending.monthly;
  check('the ledger echoes the observed monthly figure this projection ran at',
    ledger.assumptions.spending.source === 'OBSERVED' && Number.isFinite(OBSERVED) && OBSERVED > 0
      && Math.abs(OBSERVED - Number(base.projection?.basis.spending.dailyRate) * 365 / 12) < 0.01, String(OBSERVED));
  const HIGHER = Math.round(OBSERVED * 1.5), HIGHEST = Math.round(OBSERVED * 2);

  console.log('\n2. THE SUPPORTED OVERRIDE — coupled to the number (mutation proof)');
  const over = await cash({ to: TO, assumedMonthlySpending: HIGHER });
  check('the result CHANGES', over.projection!.endingCash !== base.projection!.endingCash,
    `${base.projection!.endingCash} → ${over.projection!.endingCash}`);
  check('exactly one applied fact', over.appliedUserFacts.length === 1,
    JSON.stringify(over.appliedUserFacts));
  check('…it names the amount that was applied', over.appliedUserFacts[0].includes(String(HIGHER)));
  check('…and the spending basis switches to USER_STATED',
    over.projection!.basis.spending.source === 'USER_STATED');
  // The three questions the invariant demands an answer to.
  check('WHAT INPUT?  assumedMonthlySpending, named in the fact',
    over.appliedUserFacts[0].includes(`spending baseline ${HIGHER} USD`), over.appliedUserFacts[0]);
  check('WHERE DID IT ENTER?  as the SPENDING_LEVEL statement — removing it restores the baseline',
    (await cash({ to: TO })).projection!.endingCash === base.projection!.endingCash);
  const highest = await cash({ to: TO, assumedMonthlySpending: HIGHEST });
  check('WHAT DID IT AFFECT?  endingCash, monotonically in the spending direction',
    highest.projection!.endingCash < over.projection!.endingCash && over.projection!.endingCash < base.projection!.endingCash,
    `${base.projection!.endingCash} > ${over.projection!.endingCash} > ${highest.projection!.endingCash}`);
  // Spending is a RATE over the horizon, so a stated figure costs cash in proportion:
  // three stated levels lie on one line. (Anchored on the observed figure RESTATED,
  // not on the baseline — an observed rate and the same rate stated to the cent
  // differ by the rounding of a daily rate, a few dollars over the horizon.)
  const restated = await cash({ to: TO, assumedMonthlySpending: OBSERVED });
  const perDollar = (a: Cash, b: Cash, step: number) => (a.projection!.endingCash - b.projection!.endingCash) / step;
  check('…and LINEARLY: each extra dollar a month costs the same cash at every level, to the cent',
    Math.abs(perDollar(restated, over, HIGHER - OBSERVED) - perDollar(over, highest, HIGHEST - HIGHER)) < 0.01,
    `${perDollar(restated, over, HIGHER - OBSERVED).toFixed(4)} vs ${perDollar(over, highest, HIGHEST - HIGHER).toFixed(4)} per $/mo`);

  console.log('\n3. NEGATIVE — THE DISCOVERED BONUS, THROUGH EVERY PATH THAT REMAINS');
  // The exact shape from the reproduction, now with no `statedAs` to carry it.
  const bonusAttempts: Record<string, unknown>[] = [
    { to: TO, statedAs: 'I get a $15k net bonus on Dec 7' },
    { to: TO, assumedMonthlySpending: OBSERVED, statedAs: `user has a $15k net bonus on ${BONUS_ON} added on top of current pattern` },
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
        r.appliedUserFacts.length === 1 && new RegExp(`spending baseline ${escapeRe(String(OBSERVED))} USD`).test(r.appliedUserFacts[0]),
        r.appliedUserFacts[0]);
      // Restating the observed figure to the cent moves cash only by the rounding of a daily rate.
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
  const { checkpointProjection } = await import('@/lib/ai/conversation/memory-tools');
  const withProse = await cash({ to: TO, assumedMonthlySpending: OBSERVED,
    statedAs: `user has a $15k net bonus on ${BONUS_ON}` });
  // ⚠️ A THROWAWAY SPACE, SO THE REAL ONE'S MEMORY IS NEVER WRITTEN. The projection
  // was computed over the real Space; the checkpoint of it is stored somewhere
  // that is deleted in the `finally`, cascade and all.
  const TAG = `applied-facts-check-${Date.now()}`;
  const scratchUser = await db.user.create({ data: { email: `${TAG}@example.invalid` } });
  const scratch = await db.space.create({ data: { name: TAG, type: 'PERSONAL', category: 'PERSONAL',
    members: { create: [{ userId: scratchUser.id, role: 'OWNER' }] } } });
  try {
    const written = await checkpointProjection({ spaceId: scratch.id, asOfISO: ASOF, spaceCtx: { userId: scratchUser.id } },
      'project_cash', withProse);
    const rows = await db.spaceMemory.findMany({ where: { spaceId: scratch.id } });
    const row = rows[0] as { kind?: string; subject?: string; payload?: { value?: number; horizon?: string;
      basis?: { userAssumptions?: unknown[]; spendingSource?: string } } } | undefined;
    const payload = JSON.stringify(row?.payload ?? {});
    check('a checkpoint was written (the path is live) — exactly one, for this horizon',
      rows.length === 1 && row?.kind === 'CHECKPOINT' && written?.subject === `liquid-${TO}` && row?.subject === `liquid-${TO}`,
      `${rows.length} row(s), ${row?.subject}`);
    check('…holding the figure the projection stated, and the horizon it stated it for',
      row?.payload?.value === withProse.projection!.endingCash && row?.payload?.horizon === TO, String(row?.payload?.value));
    check('its basis.userAssumptions is the applied override and nothing else',
      JSON.stringify(row?.payload?.basis?.userAssumptions) === JSON.stringify(withProse.appliedUserFacts)
        && withProse.appliedUserFacts.length === 1 && row?.payload?.basis?.spendingSource === 'USER_STATED', payload.slice(0, 200));
    check('…so it carries no bonus prose', !/bonus/i.test(payload), payload.slice(0, 200));
    check('…and no $15k', !/15,?000|15k/i.test(payload));
  } finally {
    await db.space.delete({ where: { id: scratch.id } });
    await db.user.delete({ where: { id: scratchUser.id } });
    check('teardown cascades the throwaway checkpoint away',
      (await db.spaceMemory.count({ where: { spaceId: scratch.id } })) === 0);
  }

  console.log('\n6. SCENARIO CONTROL — the same hypothetical IS representable, deterministically');
  const scen = await findTool('scenario_projection')!.run(
    { to: TO, granularity: 'monthly',
      outflows: [{ onDate: BONUS_ON, amount: -15000, label: 'net bonus' }] }, ctx) as {
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
  const { openAiToolSchemas } = await import('@/lib/ai/conversation/tools');
  for (const name of ['project_cash', 'scenario_projection', 'scenario_goal_seek']) {
    const t = (openAiToolSchemas() as { function: { name: string; parameters: unknown } }[])
      .find((x) => x.function.name === name)!;
    check(`${name} exposes no free-text \`statedAs\``,
      !JSON.stringify(t.function.parameters).includes('statedAs'));
  }

  console.log('\n8. THE NAMED SPACE WAS ONLY READ');
  check('its SpaceMemory did not move', (await db.spaceMemory.count({ where: { spaceId } })) === memoryBefore,
    `${memoryBefore} row(s) before and after`);

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main();
