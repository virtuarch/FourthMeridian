/**
 * scripts/ai-baseline/active-scenario.check.ts
 *
 * THE REPLAY PROOF AND THE 1d67786 REPRODUCTION, AGAINST REAL DATA.
 *
 * `active-scenario.test.ts` pins the state machine purely and runs in CI. This
 * proves the thing a fixture cannot: that a stored result is REPRODUCIBLE from
 * its stored assumptions. That is the coupling guarantee stated without a hash —
 * re-run what the envelope says it assumed, and demand the figures back.
 *
 * ⚠️ A VERIFIER, NOT A RUNTIME MECHANISM. Nothing in the turn loop replays
 * anything; that would cost a scenario computation per turn and would faithfully
 * replay a stale assumption set. Replay belongs here, where it is allowed to be
 * slow and is allowed to fail loudly.
 *
 * ⚠️ NO LIVE MONEY OR DATE IS PINNED HERE ANY MORE. The first version asserted
 * the Space's figures as they stood the day it was written — baseline 35,898.84,
 * scenario 50,898.84, revision 51,598.84, as of 2026-09-12 to a horizon of
 * 2026-12-31 — and a week of real activity failed seven of them with nothing
 * wrong. Worse, two others went VACUOUS without anyone seeing it: "no trace of
 * 50898.84 remains" passes for ever once the live figure is 49,619.55. A pin that
 * drifts does not only fail falsely; it also stops guarding.
 *
 * What those pins were standing in for is stated directly instead, from the
 * baseline `B` this run reads (same taxonomy as `liquid-floor.check.ts`):
 *
 *   SEMANTIC      a +15,000 one-off ends the horizon at B + 15,000 TO THE CENT,
 *                 and leaves investments and debt where the no-assumption ledger
 *                 had them; 15,700 ends at B + 15,700; the revision is exactly
 *                 $700 above the scenario it replaced; a failed run clears.
 *   STRUCTURAL    one envelope, last, carrying the pair; after the revision the
 *                 old figure's own string is gone from the slot and the
 *                 envelope (and was demonstrably THERE before — never vacuous);
 *                 raw results elided; nothing persisted.
 *   RELATIONAL    `project_cash` and the ledger's no-assumption run end at the
 *                 same cash (two tools, one spine); a replay of the stored
 *                 assumptions returns the stored figures; the baseline re-read
 *                 after every scenario is the baseline read before them.
 *
 * The as-of is today (or `CHECK_AS_OF`), and the horizon and bonus date are
 * derived from it, so the script is the same test in any month.
 * Live values are printed for the reader and asserted nowhere.
 *
 *   npm run ai:scenario-check
 *   CHECK_AS_OF=2026-11-15 npm run ai:scenario-check     # crosses a year end
 */

import '@/lib/ai/assemblers';
import { db } from '@/lib/db';
import { findTool, monthEndsBetween, type ToolContext } from '@/lib/ai/conversation/tools';
import {
  captureActiveScenario, applyCapture, injectScenario, newScenarioSlot,
  ACTIVE_SCENARIO_MARKER, SCENARIO_TOOL,
} from '@/lib/ai/conversation/active-scenario';
import { compactToolHistory, DEFAULT_COMPACTION } from '@/lib/ai/conversation/compaction';
import type { SpaceContext } from '@/lib/space';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}

const DAY = 86_400_000;
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const near = (a: unknown, b: unknown) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.005;
const isCents = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && Math.round(n * 100) / 100 === n;

/**
 * ⚠️ DERIVED FROM THE AS-OF, NEVER WRITTEN DOWN. The fourth month-end after the
 * as-of and a one-off 24 days before it — which, as of 2026-09-12, is exactly the
 * 2026-12-31 horizon and 2026-12-07 bonus of the 1d67786 conversation. A literal
 * horizon would have turned every assertion here into a refusal on 2027-01-01.
 */
const ASOF = process.env.CHECK_AS_OF ?? new Date().toISOString().slice(0, 10);
const HORIZON = monthEndsBetween(ASOF, shift(ASOF, 200))[3];
const BONUS_ON = shift(HORIZON, -24);
const BONUS = 15_000;
const REVISED = 15_700;

const bonus = (amount: number) => ({ to: HORIZON, granularity: 'monthly',
  outflows: [{ onDate: BONUS_ON, amount, label: 'bonus (net)' }] });

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
  const run = (name: string, args: Record<string, unknown>) => findTool(name)!.run(args, ctx);
  console.log(`Space ${spaceId} as of ${ASOF} → horizon ${HORIZON}, one-off on ${BONUS_ON}\n`);
  check('the derived horizon is a month-end after the as-of, and the one-off falls between them',
    typeof HORIZON === 'string' && ASOF < BONUS_ON && BONUS_ON < HORIZON && shift(HORIZON, 1).endsWith('-01'),
    `${ASOF} < ${BONUS_ON} < ${HORIZON}`);

  console.log('\n1. THE BASELINE AND THE SCENARIO, AS IN 1d67786');
  const baseline = await run('project_cash', { to: HORIZON }) as
    { projection: { endingCash: number } };
  /** ⚠️ `B` IS READ, NEVER WRITTEN DOWN. A primitive copy, so section 4 can prove the object was not mutated. */
  const B = baseline.projection.endingCash;
  check('project_cash answers the baseline with a finite figure, in cents', isCents(B), String(B));
  type Ledger = { asOf: string; horizon: { to: string }; checkpoints: { liquid: { amount: number };
    netWorth: { amount: number }; investments: { amount: number }; debt: { amount: number } }[] };
  const plain = await run(SCENARIO_TOOL, { to: HORIZON, granularity: 'monthly' }) as Ledger;
  const plainEnd = plain.checkpoints[plain.checkpoints.length - 1];
  check('…and the ledger with no assumption ends at the SAME cash — two tools, one spine',
    plainEnd.liquid.amount === B, `${plainEnd.liquid.amount} vs ${B}`);

  const slot = newScenarioSlot();
  const r1 = await run(SCENARIO_TOOL, bonus(-BONUS));
  applyCapture(slot, captureActiveScenario(SCENARIO_TOOL, bonus(-BONUS), r1));
  check('a successful scenario establishes the pair', slot.active !== null);
  check(`…result is the baseline plus ${BONUS}, to the cent`, isCents(slot.active?.result.liquid)
    && near(slot.active?.result.liquid, B + BONUS), `${slot.active?.result.liquid} vs ${B} + ${BONUS}`);
  check('…the bonus is CASH: investments and debt are where the no-assumption ledger had them',
    slot.active?.result.investments === plainEnd.investments.amount && slot.active?.result.debt === plainEnd.debt.amount,
    `${slot.active?.result.investments} / ${slot.active?.result.debt}`);
  check('…so net worth moved by the bonus and nothing else',
    near(slot.active?.result.netWorth, plainEnd.netWorth.amount + BONUS), `${slot.active?.result.netWorth} vs ${plainEnd.netWorth.amount} + ${BONUS}`);
  check('…placed at the as-of and the horizon it was asked for',
    slot.active?.result.asOf === ASOF && slot.active?.result.to === HORIZON, `${slot.active?.result.asOf} → ${slot.active?.result.to}`);
  check('…and project_cash did NOT touch it',
    (await (async () => { const before = JSON.stringify(slot.active);
      applyCapture(slot, captureActiveScenario('project_cash', { to: HORIZON },
        await run('project_cash', { to: HORIZON })));
      return JSON.stringify(slot.active) === before; })()));
  /** The +15,000 figure, as this run produced it, and the string a transcript would carry. */
  const L1 = slot.active!.result.liquid;
  console.log(`   live: baseline ${B}, with the one-off ${L1}`);

  console.log('\n2. REPLAY — the result is reproducible from the stored assumptions');
  const replayed = await run(SCENARIO_TOOL, slot.active!.assumptions) as
    { checkpoints: { liquid: { amount: number }; netWorth: { amount: number };
      investments: { amount: number }; debt: { amount: number } }[] };
  const last = replayed.checkpoints[replayed.checkpoints.length - 1];
  for (const [k, stored, fresh] of [
    ['liquid', slot.active!.result.liquid, last.liquid.amount],
    ['investments', slot.active!.result.investments, last.investments.amount],
    ['debt', slot.active!.result.debt, last.debt.amount],
    ['netWorth', slot.active!.result.netWorth, last.netWorth.amount],
  ] as [string, number, number][]) {
    check(`${k} replays exactly`, stored === fresh, `${stored} vs ${fresh}`);
  }

  console.log('\n3. THE 1d67786 SEQUENCE — the figure survives compaction');
  let messages: unknown[] = [{ role: 'system', content: 'x' }, { role: 'user', content: 'orientation' }];
  const turn = async (user: string, tool?: [string, Record<string, unknown>], prose = 'prose') => {
    injectScenario(messages, slot);
    messages.push({ role: 'user', content: user });
    if (tool) {
      const res = await run(tool[0], tool[1]);
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${messages.length}`,
        type: 'function', function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] });
      messages.push({ role: 'tool', tool_call_id: `c${messages.length - 1}`, content: JSON.stringify(res) });
      applyCapture(slot, captureActiveScenario(tool[0], tool[1], res));
    }
    messages.push({ role: 'assistant', content: prose });
    messages = compactToolHistory(messages, DEFAULT_COMPACTION).messages;
  };
  const BASELINE_PROSE = `On your current trend you end the period with ${B} in cash.`;
  await turn('by eoy?', ['project_cash', { to: HORIZON }], BASELINE_PROSE);
  await turn('what about a 15k bonus?', [SCENARIO_TOOL, bonus(-BONUS)]);
  await turn('ga but exempt, yes fica');          // toolless
  await turn('exactly');                          // toolless — window now past the scenario
  injectScenario(messages, slot);
  messages.push({ role: 'user', content: 'how much should I invest?' });

  const tools = messages.filter((m) => (m as { role?: string }).role === 'tool');
  check('every raw tool result HAS aged out — compaction untouched',
    tools.length > 0 && tools.every((m) => String((m as { content: string }).content).includes('"elided":true')));
  const env = messages.find((m) => typeof (m as { content?: unknown }).content === 'string'
    && (m as { content: string }).content.startsWith(ACTIVE_SCENARIO_MARKER)) as { content: string };
  check('the envelope is still there', env !== undefined);
  const parsed = JSON.parse(env.content.slice(ACTIVE_SCENARIO_MARKER.length));
  check('…carrying the baseline-plus-bonus figure with no assistant prose required',
    parsed.result.liquid === L1 && near(parsed.result.liquid, B + BONUS) && env.content.includes(String(L1)),
    String(parsed.result.liquid));
  check('…which no surviving assistant sentence states — the envelope is its ONLY carrier',
    !messages.some((m) => (m as { role?: string }).role === 'assistant'
      && String((m as { content?: unknown }).content ?? '').includes(String(L1))));
  check('…and the -15000 assumption that produced it',
    JSON.stringify(parsed.assumptions).includes(`-${BONUS}`));
  check('exactly one envelope in the transcript',
    messages.filter((m) => typeof (m as { content?: unknown }).content === 'string'
      && (m as { content: string }).content.startsWith(ACTIVE_SCENARIO_MARKER)).length === 1);

  console.log('\n4. THE REVISION — 15,000 → 15,700 replaces atomically');
  // ⚠️ NOT VACUOUS: the string being declared absent below was PRESENT a moment ago.
  check('before the revision, the slot does carry the 15,000 pair',
    JSON.stringify(slot).includes(`-${BONUS}`) && JSON.stringify(slot).includes(String(L1)));
  const r2 = await run(SCENARIO_TOOL, bonus(-REVISED));
  applyCapture(slot, captureActiveScenario(SCENARIO_TOOL, bonus(-REVISED), r2));
  const L2 = slot.active?.result.liquid as number;
  check(`the new result is the deterministic recalculation: the baseline plus ${REVISED}, to the cent`,
    isCents(L2) && near(L2, B + REVISED), `${L2} vs ${B} + ${REVISED}`);
  check('…exactly $700 above the previous scenario', near(L2 - L1, REVISED - BONUS), `${L2} − ${L1}`);
  check(`assumptions now say -${REVISED}`, JSON.stringify(slot.active?.assumptions).includes(`-${REVISED}`));
  check('NO trace of the 15,000 pair remains', String(L1) !== String(L2)
    && !JSON.stringify(slot).includes(`-${BONUS}`) && !JSON.stringify(slot).includes(String(L1)));
  injectScenario(messages, slot);
  const envelopes = messages.filter((m) => typeof (m as { content?: unknown }).content === 'string'
    && (m as { content: string }).content.startsWith(ACTIVE_SCENARIO_MARKER)) as { content: string }[];
  const env2 = envelopes[0];
  check('the injected envelope shows only the replacement — still one, still last',
    envelopes.length === 1 && messages[messages.length - 1] === env2
    && env2.content.includes(String(L2)) && !env2.content.includes(String(L1))
    && JSON.parse(env2.content.slice(ACTIVE_SCENARIO_MARKER.length)).result.liquid === L2);
  check('the baseline checkpoint and prose are untouched by any of this',
    baseline.projection.endingCash === B
    && messages.some((m) => (m as { role?: string }).role === 'assistant' && (m as { content: string }).content === BASELINE_PROSE)
    && BASELINE_PROSE.includes(String(B)));
  const reread = await run('project_cash', { to: HORIZON }) as { projection: { endingCash: number } };
  check('…and the baseline READ AGAIN after both scenarios is the baseline read before them — a scenario changes nothing it reads',
    reread.projection.endingCash === B, `${reread.projection.endingCash} vs ${B}`);
  console.log(`   live: revised ${L2}`);

  console.log('\n5. A FAILED RECOMPUTATION CLEARS — against the real tool');
  // ⚠️ SPREAD FIRST, OVERRIDE SECOND. `bonus()` carries its own `to`, so spreading
  // it last silently reinstated the valid horizon and the call succeeded — the
  // first version of this check proved nothing.
  const badArgs = { ...bonus(-REVISED), to: '2020-01-01' };   // horizon before asOf ⇒ refused
  const bad = await run(SCENARIO_TOOL, badArgs);
  const cap = captureActiveScenario(SCENARIO_TOOL, badArgs, bad);
  check('the tool refused rather than computing', cap.action === 'CLEAR',
    cap.action === 'CLEAR' ? cap.reason : JSON.stringify(bad).slice(0, 120));
  applyCapture(slot, cap);
  check('the previous VALID result is discarded, not retained', slot.active === null);
  injectScenario(messages, slot);
  check('…and the envelope disappears from the transcript entirely',
    !messages.some((m) => typeof (m as { content?: unknown }).content === 'string'
      && (m as { content: string }).content.startsWith(ACTIVE_SCENARIO_MARKER)));

  console.log('\n6. NOTHING WAS PERSISTED');
  const memoryBefore = await db.spaceMemory.count({ where: { spaceId } });
  const r3 = await run(SCENARIO_TOOL, bonus(-REVISED));
  applyCapture(slot, captureActiveScenario(SCENARIO_TOOL, bonus(-REVISED), r3));
  check('the recomputation after the refusal re-establishes the SAME pair — the ledger holds no state between runs',
    slot.active?.result.liquid === L2, `${slot.active?.result.liquid} vs ${L2}`);
  check('a scenario wrote no SpaceMemory row',
    await db.spaceMemory.count({ where: { spaceId } }) === memoryBefore,
    `${memoryBefore} rows before and after`);
  const scenarioCheckpoints = await db.spaceMemory.findMany({
    where: { spaceId, kind: 'CHECKPOINT' as never }, orderBy: { createdAt: 'desc' }, take: 3 });
  check('no checkpoint mentions the scenario or its figures',
    !JSON.stringify(scenarioCheckpoints).includes(String(L1))
    && !JSON.stringify(scenarioCheckpoints).includes(String(L2))
    && !JSON.stringify(scenarioCheckpoints).includes('bonus'));

  console.log('\n7. SIZE, MEASURED ON THE REAL ENVELOPE');
  injectScenario(messages, slot);
  const content = (messages[messages.length - 1] as { content: string }).content;
  console.log(`  envelope: ${content.length} B / ~${Math.ceil(content.length / 4)} tok`);
  console.log(`  raw scenario result it replaces: ${JSON.stringify(r3).length} B / `
    + `~${Math.ceil(JSON.stringify(r3).length / 4)} tok`);

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
main();
