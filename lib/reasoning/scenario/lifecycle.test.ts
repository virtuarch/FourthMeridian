/**
 * lib/reasoning/scenario/lifecycle.test.ts
 *
 * V26-REASONING Slice 4 — THE FIVE RULES, GATED.
 *
 * ⚠️ THE STRUCTURAL HALF OF THE CONVERSATION GATE LIVES HERE, where it costs
 * nothing and cannot flake. `scripts/check-conversation-gate.ts` runs the same
 * seven turns and additionally reads the SERVED REPLY, which needs a paid
 * stochastic model and is therefore a tool rather than a CI gate — the same
 * split this repository has made three times before.
 *
 * Everything below is decided by the resolution, not by the prose.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { realSpaceCtx, STREAMS, HORIZON, AS_OF } from '@/lib/ai/conformance/forecast-scenarios';
import { resolveTurn, effectiveQuestion } from './turn';
import { deriveConversationState } from './derive';
import {
  DeltaDimension, DeltaStatus, BASE, activeDeltas, currentScenario,
} from './types';
import { MeasureId } from '../measure/types';
import { renderFigureTable } from '../render';
import { buildFigureTable } from '../figures/table';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const ctx = realSpaceCtx();
const TURNS = [
  'How much will I probably have by December?',
  'Nah, assume I spend $5K/month.',
  'What would my net worth be?',
  'What if Bitcoin goes up 10%?',
  'And what about February?',
  "Okay, what's realistic though?",
  'So what will Bitcoin be worth in December?',
];

function upTo(n: number) {
  const history = TURNS.slice(0, n).map((c) => ({ role: 'user', content: c }));
  let lastAnswer: Parameters<typeof resolveTurn>[0]['lastAnswer'] = null;
  let r = resolveTurn({ messages: [history[0]], ctx, streams: STREAMS,
    asOfISO: AS_OF, defaultHorizon: HORIZON, lastAnswer });
  for (let i = 1; i < history.length; i++) {
    lastAnswer = {
      measureIds: [...new Set(r.measures.map((m) => m.id))],
      scenarioIds: [r.scenario.id],
      horizonISO: r.state.horizon?.iso ?? null,
    };
    r = resolveTurn({ messages: history.slice(0, i + 1), ctx, streams: STREAMS,
      asOfISO: AS_OF, defaultHorizon: HORIZON, lastAnswer });
  }
  return r;
}

const T = Array.from({ length: 7 }, (_, i) => upTo(i + 1));
const val = (n: number, id: string) => {
  const m = T[n].measures.find((x) => x.id === id && x.at.kind === 'DATE');
  return m && m.resolution.kind === 'VALUE' ? m.resolution.value : null;
};

// ═══════════════════════════════════════════════════════════════════════════
// A. THE SEVEN TURNS
// ═══════════════════════════════════════════════════════════════════════════

eq('A1 turn 1 is BASE with December set',
  [T[0].scenario.id, T[0].state.horizon?.iso.slice(0, 7)], ['BASE', '2026-12']);
check('A1b and invents no assumption from a plain question', activeDeltas(T[0].state).length === 0);

check('A2 turn 2 derives an ACTIVE $5,000/month spending delta', (() => {
  const d = activeDeltas(T[1].state).find((x) => x.dimension === DeltaDimension.SPENDING);
  return !!d && d.payload.kind === 'MONTHLY_AMOUNT' && d.payload.value === 5000;
})(), JSON.stringify(activeDeltas(T[1].state)));

// ⚠️ "$5K" IS A NUMBER PEOPLE TYPE, AND FOUR SEPARATE PATTERNS IN THIS CODEBASE
// COULD NOT READ IT. `statements.ts` extracted $5.00 from "assume I spend
// $5K/month" and the forecast projected $20.53 of spending over four months and
// an ending balance of $57,788 — nothing refused, nothing flagged, the arithmetic
// correct and the premise wrong by three orders of magnitude.
check('A2b and the FORECAST sees $5,000 too, not $5',
  (val(1, MeasureId.LIQUID_CASH) ?? 0) < (val(0, MeasureId.LIQUID_CASH) ?? 0) + 20_000,
  `${val(0, MeasureId.LIQUID_CASH)} -> ${val(1, MeasureId.LIQUID_CASH)}`);
check('A2c and the figure MOVES — a delta that changes nothing is a label',
  Math.abs((val(1, MeasureId.LIQUID_CASH) ?? 0) - (val(0, MeasureId.LIQUID_CASH) ?? 0)) > 1);

eq('A3 turn 3 asks net worth at the SAME horizon',
  [T[2].measures.some((m) => m.id === MeasureId.NET_WORTH),
    T[2].state.horizon?.iso.slice(0, 7)], [true, '2026-12']);
check('A3b and the spending assumption SURVIVES the follow-up',
  activeDeltas(T[2].state).some((d) => d.dimension === DeltaDimension.SPENDING));
// ⚠️ THE BRIEF, VERBATIM: "I do NOT want: 'I cannot project your year-end net
// worth because future Bitcoin prices are unknown.'"
check('A3c and it does not refuse because a leg is unknown',
  val(2, MeasureId.NET_WORTH) !== null);

eq('A4 turn 4 has TWO active deltas', activeDeltas(T[3].state).length, 2);
check('A4b the second is an investment return of +10%', (() => {
  const d = activeDeltas(T[3].state).find((x) => x.dimension === DeltaDimension.INVESTMENT_RETURN);
  return !!d && d.payload.kind === 'RETURN_PCT' && d.payload.pct === 10;
})());

eq('A5 turn 5 moves the horizon to February and keeps BOTH deltas',
  [T[4].state.horizon?.iso.slice(0, 7), activeDeltas(T[4].state).length], ['2027-02', 2]);

eq('A6 turn 6 dismisses everything and returns to BASE',
  [activeDeltas(T[5].state).length, T[5].scenario.id, T[5].dismissedThisTurn],
  [0, BASE.id, true]);
// ⚠️ DISMISSED, NOT DELETED. A state that erased them could not tell the user
// what it stopped assuming.
eq('A6b and the dismissed deltas are FLAGGED, not erased',
  T[5].state.deltas.filter((d) => d.status === DeltaStatus.DISMISSED).length, 2);

check('A7 turn 7 offers illustrations rather than a single number',
  T[6].measures.filter((m) => m.scenarioId.startsWith('ILLUSTRATION')).length >= 2);
check('A7b and says plainly that nobody can know',
  T[6].withheld.some((w) => /nobody can know/i.test(w.detail)));
check('A7c and no future crypto figure claims to be MEASURED',
  T[6].measures.filter((m) => m.at.kind === 'DATE')
    .every((m) => m.resolution.kind !== 'VALUE' || m.resolution.standing !== 'MEASURED'));

// ═══════════════════════════════════════════════════════════════════════════
// B. THE FIVE RULES
// ═══════════════════════════════════════════════════════════════════════════

// ── Rule 1: every ACTIVE delta appears in the answer it prices ──────────────
check('B1 every ACTIVE delta is passed to narration as framing',
  T.every((r) => r.framing.length >= activeDeltas(r.state).length));
check('B1b and the rendered table demands it be named',
  /you MUST name these in your answer/.test(
    renderFigureTable({ figures: [], withheld: [] }, ['assume I spend $5,000/month'])));

// ── Rule 2: supersede, never overwrite ─────────────────────────────────────
const superseded = deriveConversationState([
  { role: 'user', content: 'Assume I spend $5,000/month.' },
  { role: 'user', content: 'Actually, assume I spend $6,000/month.' },
], AS_OF);
eq('B2 a later statement SUPERSEDES rather than replaces',
  superseded.deltas.map((d) => d.status), ['SUPERSEDED', 'ACTIVE']);
check('B2b and the superseded one names its replacement',
  superseded.deltas[0].supersededBy === superseded.deltas[1].id);
eq('B2c only the later one is active', activeDeltas(superseded).length, 1);

// ── Rule 3: DISMISS_ALL is first-class ─────────────────────────────────────
check('B3 dismissal happens BEFORE the same turn\'s own deltas are collected', (() => {
  // "Forget that — what if I spend $6,000/month?" must dismiss the OLD one and
  // keep the NEW one, not dismiss the delta the same sentence just created.
  const s = deriveConversationState([
    { role: 'user', content: 'Assume I spend $5,000/month.' },
    { role: 'user', content: 'Forget that. What if I spend $6,000/month?' },
  ], AS_OF);
  const active = activeDeltas(s);
  return active.length === 1 && active[0].payload.kind === 'MONTHLY_AMOUNT'
    && active[0].payload.value === 6000;
})());

// ── Rule 4: an assumption licenses a calculation; it never rewrites a fact ──
//
// ⚠️ THE PRESENT IS UNTOUCHED BY EVERY SCENARIO. `assemble.ts` already enforces
// this and it is one of the best invariants in the codebase; carrying it here
// means a scenario can change what December looks like and can never change
// what today is.
const todayAcross = T.map((r) => {
  const m = r.measures.find((x) => x.id === MeasureId.DIGITAL_ASSETS_VALUE && x.at.kind === 'NOW');
  return m && m.resolution.kind === 'VALUE' ? m.resolution.value : null;
}).filter((v) => v !== null);
eq('B4 no scenario changes a present fact', new Set(todayAcross).size, 1);

// ── Rule 5: scoped to the conversation, never persisted ────────────────────
const DERIVE_SRC = readFileSync(join(process.cwd(), 'lib/reasoning/scenario/derive.ts'), 'utf8');
const TURN_SRC = readFileSync(join(process.cwd(), 'lib/reasoning/scenario/turn.ts'), 'utf8');
check('B5 the scenario layer reaches no database and no store',
  !/lib\/db|prisma|localStorage|redis|cache\./i.test(DERIVE_SRC + TURN_SRC));
check('B5b and holds no module-level mutable state',
  !/^(let|var)\s/m.test(DERIVE_SRC.replace(/\/\*[\s\S]*?\*\//g, '')));

// ⚠️ USER MESSAGES ONLY. PARITY-3 measured a net-worth follow-up rebuilding on a
// figure the assistant had itself invented, five times out of five, in BOTH
// entry modes. A number the model produced last turn is not evidence.
check('B6 nothing the assistant said can create an assumption', (() => {
  const s = deriveConversationState([
    { role: 'user', content: 'How much will I have?' },
    { role: 'assistant', content: 'Assuming you spend $9,999/month, about $1.' },
    { role: 'user', content: 'And in February?' },
  ], AS_OF);
  return activeDeltas(s).length === 0;
})());

// ═══════════════════════════════════════════════════════════════════════════
// C. HOW AN ASSUMPTION REACHES A FIGURE
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ THE USER'S OWN SENTENCE, REPLAYED — never our paraphrase. `assembleForecast`
// reads suppositions from `question` alone (FORECAST-13 drew that line
// deliberately), so an ACTIVE delta is carried by replaying `statedAs` verbatim.
// That is what keeps a scenario's figure identical to the figure the same
// sentence produced on the turn it was said.

check('C1 an active spending delta is replayed verbatim into the question',
  effectiveQuestion('What would my net worth be?', activeDeltas(T[2].state))
    .includes(activeDeltas(T[2].state)[0].statedAs));
check('C2 and an investment-return delta is NOT — it reaches the measure layer instead',
  !effectiveQuestion('x', [{
    id: 'd', dimension: DeltaDimension.INVESTMENT_RETURN, statedAs: 'up 10%',
    statedAtTurn: 0, effectiveFrom: null, effectiveUntil: null,
    status: DeltaStatus.ACTIVE, payload: { kind: 'RETURN_PCT', pct: 10 },
  }]).includes('up 10%'));

// ═══════════════════════════════════════════════════════════════════════════
// D. NO UNADDRESSED NUMBER IN A LABEL
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ THIS FAILED TWICE IN ONE SLICE AND BOTH TIMES DISCARDED A CORRECT ANSWER.
// An illustrative band carried "10%" in its LABEL, and a dismissal notice
// carried "$5K" in its TEXT. Both put a number in front of the model inside
// content that has no fid, the model wrote it, the sweep found it unaddressed,
// and the whole answer went. A label is prose the model reads; every number in
// it needs an address or must not be there.

check('D1 no rendered label or withheld line carries an unaddressed money token', (() => {
  const r = T[5];
  const table = buildFigureTable({
    forecast: r.forecast, ctx, measures: r.measures, turnWithheld: r.withheld,
  });
  const rendered = renderFigureTable(table, r.framing);
  const values = new Set(table.figures.map((f) => f.value));
  // Strip the VALUE column, which is addressed by construction, then sweep.
  const prose = rendered.split('\n')
    .map((l) => (/^[fp]\d+\s/.test(l) ? l.replace(/^\S+\s+\S+/, '') : l))
    .join('\n');
  const tokens = [...prose.matchAll(/(?:\$|\bUSD\s*)([\d,]+(?:\.\d+)?)\s*([kKmM])?/g)]
    .map((m) => {
      const n = Number(m[1].replace(/,/g, ''));
      const k = (m[2] ?? '').toLowerCase();
      return k === 'k' ? n * 1000 : k === 'm' ? n * 1_000_000 : n;
    });
  const orphans = tokens.filter((t) => !values.has(t));
  return orphans.length === 0;
})());

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
