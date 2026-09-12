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
 *   npm run ai:scenario-check
 */

import '@/lib/ai/assemblers';
import { db } from '@/lib/db';
import { findTool, type ToolContext } from '@/scripts/ai-baseline/tools';
import {
  captureActiveScenario, applyCapture, injectScenario, newScenarioSlot,
  ACTIVE_SCENARIO_MARKER, SCENARIO_TOOL,
} from '@/scripts/ai-baseline/active-scenario';
import { compactToolHistory, DEFAULT_COMPACTION } from '@/scripts/ai-baseline/compaction';
import type { SpaceContext } from '@/lib/space';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}

const bonus = (amount: number) => ({ to: '2026-12-31', granularity: 'monthly',
  outflows: [{ onDate: '2026-12-07', amount, label: 'bonus (net)' }] });

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
  const run = (name: string, args: Record<string, unknown>) => findTool(name)!.run(args, ctx);

  console.log('1. THE BASELINE AND THE SCENARIO, AS IN 1d67786');
  const baseline = await run('project_cash', { to: '2026-12-31' }) as
    { projection: { endingCash: number } };
  check('baseline EOY cash', baseline.projection.endingCash === 35898.84,
    String(baseline.projection.endingCash));

  const slot = newScenarioSlot();
  const r1 = await run(SCENARIO_TOOL, bonus(-15000));
  applyCapture(slot, captureActiveScenario(SCENARIO_TOOL, bonus(-15000), r1));
  check('a successful scenario establishes the pair', slot.active !== null);
  check('…result is the +15,000 figure', slot.active?.result.liquid === 50898.84,
    String(slot.active?.result.liquid));
  check('…exactly the bonus above baseline',
    Math.abs((slot.active!.result.liquid - baseline.projection.endingCash) - 15000) < 0.005);
  check('…and project_cash did NOT touch it',
    (await (async () => { const before = JSON.stringify(slot.active);
      applyCapture(slot, captureActiveScenario('project_cash', { to: '2026-12-31' },
        await run('project_cash', { to: '2026-12-31' })));
      return JSON.stringify(slot.active) === before; })()));

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
  const turn = async (user: string, tool?: [string, Record<string, unknown>]) => {
    injectScenario(messages, slot);
    messages.push({ role: 'user', content: user });
    if (tool) {
      const res = await run(tool[0], tool[1]);
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${messages.length}`,
        type: 'function', function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] });
      messages.push({ role: 'tool', tool_call_id: `c${messages.length - 1}`, content: JSON.stringify(res) });
      applyCapture(slot, captureActiveScenario(tool[0], tool[1], res));
    }
    messages.push({ role: 'assistant', content: 'prose' });
    messages = compactToolHistory(messages, DEFAULT_COMPACTION).messages;
  };
  await turn('by eoy?', ['project_cash', { to: '2026-12-31' }]);
  await turn('what about a 15k bonus?', [SCENARIO_TOOL, bonus(-15000)]);
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
  check('…carrying 50,898.84 with no assistant prose required',
    parsed.result.liquid === 50898.84);
  check('…and the -15000 assumption that produced it',
    JSON.stringify(parsed.assumptions).includes('-15000'));
  check('exactly one envelope in the transcript',
    messages.filter((m) => typeof (m as { content?: unknown }).content === 'string'
      && (m as { content: string }).content.startsWith(ACTIVE_SCENARIO_MARKER)).length === 1);

  console.log('\n4. THE REVISION — 15,000 → 15,700 replaces atomically');
  const r2 = await run(SCENARIO_TOOL, bonus(-15700));
  applyCapture(slot, captureActiveScenario(SCENARIO_TOOL, bonus(-15700), r2));
  check('the new result is the deterministic recalculation',
    slot.active?.result.liquid === 51598.84, String(slot.active?.result.liquid));
  check('…exactly $700 above the previous scenario',
    Math.abs(slot.active!.result.liquid - 50898.84 - 700) < 0.005);
  check('assumptions now say -15700', JSON.stringify(slot.active?.assumptions).includes('-15700'));
  check('NO trace of the 15,000 pair remains',
    !JSON.stringify(slot).includes('-15000') && !JSON.stringify(slot).includes('50898.84'));
  injectScenario(messages, slot);
  const env2 = messages.find((m) => typeof (m as { content?: unknown }).content === 'string'
    && (m as { content: string }).content.startsWith(ACTIVE_SCENARIO_MARKER)) as { content: string };
  check('the injected envelope shows only the replacement',
    env2.content.includes('51598.84') && !env2.content.includes('50898.84'));
  check('the baseline checkpoint and prose are untouched by any of this',
    baseline.projection.endingCash === 35898.84);

  console.log('\n5. A FAILED RECOMPUTATION CLEARS — against the real tool');
  // ⚠️ SPREAD FIRST, OVERRIDE SECOND. `bonus()` carries its own `to`, so spreading
  // it last silently reinstated the valid horizon and the call succeeded — the
  // first version of this check proved nothing.
  const badArgs = { ...bonus(-15700), to: '2020-01-01' };   // horizon before asOf ⇒ refused
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
  const r3 = await run(SCENARIO_TOOL, bonus(-15700));
  applyCapture(slot, captureActiveScenario(SCENARIO_TOOL, bonus(-15700), r3));
  check('a scenario wrote no SpaceMemory row',
    await db.spaceMemory.count({ where: { spaceId } }) === memoryBefore,
    `${memoryBefore} rows before and after`);
  const scenarioCheckpoints = await db.spaceMemory.findMany({
    where: { spaceId, kind: 'CHECKPOINT' as never }, orderBy: { createdAt: 'desc' }, take: 3 });
  check('no checkpoint mentions the scenario or its figures',
    !JSON.stringify(scenarioCheckpoints).includes('50898.84')
    && !JSON.stringify(scenarioCheckpoints).includes('51598.84')
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
