/**
 * lib/ai/conversation/runtime-state-capacity.test.ts — FM-AUDIT-018
 *
 * Scenario / planning state must never disappear SILENTLY because it does not fit
 * the carrier. Pinned against the real cipher and the real seal:
 *
 *   1. capacity — the compact encoding carries more state in the SAME ceiling;
 *   2. near / at / over the limit — the largest state that fits is carried whole;
 *      one byte more is replaced by a sealed continuity marker, never cleared;
 *   3. no silent clause loss — the marker names what was dropped (an executed
 *      scenario, N staged clauses) and accumulates across repeated losses;
 *   4. multi-turn accumulation — staged clauses grow turn by turn until the carrier
 *      overflows, and the loss is reported THAT turn (fresh) and carried forward
 *      (not fresh) until a scenario runs again;
 *   5. mutation / rerun — a new scenario that fits replaces the loss;
 *   6. fresh-chat isolation — the marker is bound like any seal;
 *   7. the next turn is TOLD — the continuity notice, and project_cash refuses to
 *      answer the lost plan's question from the current trend.
 *
 * Standalone tsx script. No DB (the tool refuses before any read).
 */

process.env.ENCRYPTION_KEY = 'b'.repeat(64);
delete process.env.DATABASE_URL;

import {
  sealRuntimeStateWithReport, openRuntimeState, MAX_SEALED_CHARS, conversationTail,
  type RuntimeState,
} from './runtime-state';
import { continuityMessage, injectContinuity, CONTINUITY_MARKER } from './continuity';
import { emptyPlan, stagePlan } from './pending-plan';
import { turnEvidence } from './memory-model';
import type { ActiveScenario } from './active-scenario';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
process.on('unhandledRejection', (err) => {
  if (/Prisma/.test((err as { constructor?: { name?: string } })?.constructor?.name ?? '')) return;
  console.error('  ✗ unexpected unhandled rejection:', String(err)); process.exit(1);
});

const B = { userId: 'usr_1', spaceId: 'spc_1', tail: 'tail_a' };
const scenario = (padding = 0): ActiveScenario => ({
  assumptions: { to: '2030-12-31', outflows: [{ date: '2027-06-01', amount: 20_000, label: 'car' }], note: 'p'.repeat(padding) },
  result: { asOf: '2026-09-21', to: '2030-12-31', liquid: 51_598.84, investments: 210_004.11, debt: 0, netWorth: 261_602.95 },
  covers: '2030-12-31. No other date was computed.',
} as unknown as ActiveScenario);
const seal = (s: RuntimeState) => sealRuntimeStateWithReport(s, B);

async function main(): Promise<void> {
  // ── 1. capacity ──────────────────────────────────────────────────────────
  console.log('1. capacity under the SAME ceiling');
  const largestFitting = (() => {
    let lo = 0, hi = 6_000;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (seal({ scenario: scenario(mid) }).carried === 'FULL') lo = mid; else hi = mid - 1; }
    return lo;
  })();
  const plainAtLimit = JSON.stringify({ v: 3, iat: Date.now(), ...B, scenario: scenario(largestFitting) }).length;
  check(`the ceiling is unchanged (${MAX_SEALED_CHARS} chars — a browser cookie is 4,096 incl. the name)`, MAX_SEALED_CHARS === 3_900);
  check(`~2,850+ bytes of state fit where hex fitted ~1,915 (measured ${plainAtLimit})`, plainAtLimit >= 2_850, `${plainAtLimit}`);

  // ── 2. near / at / over ──────────────────────────────────────────────────
  console.log('2. near, at and over the limit');
  const near = seal({ scenario: scenario(largestFitting - 200) });
  check('near the limit: carried whole', near.carried === 'FULL' && openRuntimeState(near.sealed, B)?.scenario !== null);
  const at = seal({ scenario: scenario(largestFitting) });
  check('AT the limit (the largest state that fits): carried whole, within 3 chars of the ceiling',
    at.carried === 'FULL' && (at.sealed?.length ?? 0) <= MAX_SEALED_CHARS && (at.sealed?.length ?? 0) >= MAX_SEALED_CHARS - 3,
    `${at.sealed?.length}`);
  const over = seal({ scenario: scenario(largestFitting + 1) });
  check('ONE byte over: NOT cleared — a continuity marker is sealed instead', over.carried === 'LOST' && typeof over.sealed === 'string');
  check('…the marker is always under the ceiling', (over.sealed?.length ?? Infinity) <= MAX_SEALED_CHARS);
  check('…it reports it is a fresh loss, and how large the state would have been',
    over.fresh === true && (over.loss?.wouldHaveSealedTo ?? 0) > MAX_SEALED_CHARS);
  const opened = openRuntimeState(over.sealed, B);
  check('…and opens to NO scenario plus the loss — never to a half-state', opened?.scenario === null && opened?.continuity?.droppedScenario === true);

  // ── 3. no silent clause loss ─────────────────────────────────────────────
  console.log('3. what was dropped is named');
  const ev = turnEvidence(['raise 10% from Jan, keep $20k, invest half the rest'], []);
  const staged = stagePlan(emptyPlan(), { stage: {
    incomeChanges: [{ op: 'SCALE', from: '2027-01-01', multiplier: 1.1 }],
  } }, { turn: 0, evidence: ev }).plan;
  const both = seal({ scenario: scenario(largestFitting + 50), pending: staged });
  check('an executed scenario AND staged clauses overflowing: both counted',
    both.carried === 'LOST' && both.loss?.droppedScenario === true && both.loss?.droppedPendingClauses === staged.clauses.length && staged.clauses.length > 0,
    JSON.stringify(both.loss));
  const again = seal({ scenario: scenario(largestFitting + 50), pending: staged, continuity: both.loss! });
  check('a second loss ACCUMULATES the count, never resets it',
    again.loss?.droppedPendingClauses === 2 * staged.clauses.length && again.loss?.droppedScenario === true);

  // ── 4. multi-turn accumulation ───────────────────────────────────────────
  console.log('4. multi-turn accumulation');
  let plan = emptyPlan();
  let firstLossTurn = -1;
  for (let turn = 1; turn <= 40; turn++) {
    const month = String((turn % 12) + 1).padStart(2, '0');
    plan = stagePlan(plan, { stage: { outflows: [{ onDate: `2027-${month}-15`, amount: 1_000 + turn, label: `event ${turn}` }] } },
      { turn, evidence: turnEvidence([`$${(1_000 + turn).toLocaleString('en-US')} on 2027-${month}-15`], []) }).plan;
    const r = seal({ scenario: scenario(2_000), pending: plan });
    if (r.carried === 'LOST') { firstLossTurn = turn; break; }
  }
  check('a growing plan eventually overflows, and that turn is REPORTED (fresh), not silent',
    firstLossTurn > 0, `first loss at turn ${firstLossTurn}`);
  const lost = seal({ scenario: scenario(largestFitting + 1) }).loss!;
  const carriedForward = seal({ scenario: null, continuity: lost });
  check('a later turn with nothing new CARRIES the loss forward (not fresh — the user was told once)',
    carriedForward.carried === 'LOST' && carriedForward.fresh === false && openRuntimeState(carriedForward.sealed, B)?.continuity?.droppedScenario === true);

  // ── 5. mutation / rerun ──────────────────────────────────────────────────
  console.log('5. a new scenario replaces the loss');
  const rerun = seal({ scenario: scenario(10) });
  const reopened = openRuntimeState(rerun.sealed, B);
  check('after a fitting re-run the carrier holds the new scenario and NO loss',
    rerun.carried === 'FULL' && reopened?.scenario !== null && reopened?.continuity === undefined);

  // ── 6. fresh-chat isolation ──────────────────────────────────────────────
  console.log('6. the marker is bound like any seal');
  check('another conversation / a new chat / another user / another Space cannot open the marker',
    openRuntimeState(over.sealed, { ...B, tail: 'tail_b' }) === null
      && openRuntimeState(over.sealed, { ...B, tail: conversationTail([]) }) === null
      && openRuntimeState(over.sealed, { ...B, userId: 'usr_2' }) === null
      && openRuntimeState(over.sealed, { ...B, spaceId: 'spc_2' }) === null);

  // ── 7. the next turn is told ─────────────────────────────────────────────
  console.log('7. the next turn is TOLD, and the trend path stays closed');
  const msg = continuityMessage(lost);
  check('the notice says the plan is NOT in force and names what was lost',
    msg.content.startsWith(CONTINUITY_MARKER) && /"inForce":false/.test(msg.content) && /scenario that ran/.test(msg.content));
  const transcript: unknown[] = [{ role: 'system', content: 'sys' }];
  injectContinuity(transcript, lost); injectContinuity(transcript, lost);
  check('the notice is replaced, never appended twice', transcript.filter((m) => (m as { content: string }).content.startsWith(CONTINUITY_MARKER)).length === 1);
  injectContinuity(transcript, null);
  check('…and removed when there is no loss', transcript.length === 1);
  const { findTool } = await import('./tools');
  const pc = findTool('project_cash')!;
  const r = await pc.run({ to: '2027-06-30' }, { asOfISO: '2026-09-21', spaceId: 's', spaceCtx: {},
    plan: { pending: emptyPlan(), scenarioRan: false, continuity: lost } } as never) as Record<string, unknown>;
  check('project_cash REFUSES to answer a lost plan\'s question from the current trend',
    typeof r.unavailable === 'string' && /could not be carried/.test(r.unavailable as string), JSON.stringify(r).slice(0, 200));
  const engine = (await import('node:fs')).readFileSync('lib/ai/conversation/engine.ts', 'utf8');
  check('the engine keeps the loss until a scenario RUNS again (source)',
    /continuity: args\.continuity && !\(slot\.active && slot\.active !== args\.scenario\) \? args\.continuity : null/.test(engine));
  const route = (await import('node:fs')).readFileSync('app/api/ai/chat/route.ts', 'utf8');
  check('the route tells the client ONLY on a fresh loss, and carries the loss into the next turn',
    /seal\.carried === 'LOST' && seal\.fresh && seal\.loss/.test(route) && /continuity: carried\?\.continuity \?\? null/.test(route));

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall runtime-state capacity checks passed');
  process.exit(0);
}

main().catch((e) => { console.error('  ✗ crashed:', e instanceof Error ? e.stack : String(e)); process.exit(1); });
