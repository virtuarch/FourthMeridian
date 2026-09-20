/**
 * lib/ai/conversation/scenario-change.test.ts
 *
 * HOW FAR A SCENARIO POSITION IS FROM WHERE IT OPENED — proved over the ledger.
 *
 * ⚠️ THE FAILURE THIS CLOSES WAS A SUBTRACTION IN PROSE. "About 65k higher by next
 * June" was the projected net worth minus the opening one, composed by the model
 * in 4 of 8 runs because a scenario result stated both levels and never the
 * movement between them. The movement is now a field, and what is pinned here is
 * that the field is nothing but its operands: `opening + abs = position`, on
 * every line of every row, to the cent.
 *
 *   npx tsx lib/ai/conversation/scenario-change.test.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  lineChange, positionChange, compactChange, openingPosition, checkpointPosition, CHANGE_LINES,
} from './scenario-change';
import { runScenarioLedger, expandContributions,
  type LedgerOpening, type SpinePoint } from './scenario-ledger';
import { MONEY_EPSILON } from '@/lib/data/snapshot-window';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}
const cents = (n: number) => Math.round(n * 100);

const ASOF = '2026-09-13';
const OPENING: LedgerOpening = {
  asOfISO: ASOF, liquid: 15_000, investments: 20_000, debt: 4_000, otherAssets: 1_000 };

/** Month-ends with cash rising 2,345.67 a month — deliberately not a round figure. */
const PATH: [string, number][] = Array.from({ length: 24 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 9 + i + 1, 0));
  return [d.toISOString().slice(0, 10), 15_000 + (i + 1) * 2_345.67] as [string, number];
});
function ledgerOver(opts: {
  opening?: LedgerOpening;
  contributions?: Parameters<typeof expandContributions>[0];
  returns?: { fromISO: string; toISO: string; annualPct: number }[];
} = {}) {
  const spine: SpinePoint[] = PATH.map(([date, liquid]) => ({ date, liquid, isCheckpoint: true }));
  const horizon = PATH[PATH.length - 1][0];
  const { movements } = expandContributions(opts.contributions ?? [], ASOF, horizon);
  return runScenarioLedger({ opening: opts.opening ?? OPENING, spine, contributions: movements,
    outflows: [], returns: opts.returns ?? [] });
}

console.log('1. one line');
{
  const c = lineChange(36_791.23, 101_975.4)!;
  check('abs is to − from, and the operands travel with it',
    c.from === 36_791.23 && c.to === 101_975.4 && c.abs === 65_184.17, JSON.stringify(c));
  check('pct is abs over |from|, two places', c.pct === 177.17, String(c.pct));
  check('a fall is negative, in the line\'s own direction', lineChange(4_000, 1_000)!.abs === -3_000
    && lineChange(4_000, 1_000)!.pct === -75);
  check('a negative base divides by its magnitude, so the sign of pct follows the sign of abs',
    lineChange(-2_000, -1_000)!.abs === 1_000 && lineChange(-2_000, -1_000)!.pct === 50);
  check('float dust in the operands does not reach the figure',
    lineChange(0.1 + 0.2, 1_000.3)!.abs === 1_000);
}

console.log('2. a base of nothing has no percentage');
{
  check('zero ⇒ pct null, abs still stated', lineChange(0, 500)!.pct === null && lineChange(0, 500)!.abs === 500);
  check('a debt of 2.8e-14 is a debt of nothing ⇒ pct null, never 1.7e18',
    lineChange(2.842170943040401e-14, 500)!.pct === null);
  check('the boundary is the repository\'s one money tolerance',
    lineChange(MONEY_EPSILON - 0.001, 10)!.pct === null && lineChange(MONEY_EPSILON + 0.001, 10)!.pct !== null);
  check('a side that is not a number yields no change at all, not a zero',
    lineChange(null, 5) === null && lineChange(5, undefined) === null && lineChange(5, NaN) === null);
}

console.log('3. a position against the opening, over the real ledger');
{
  const l = ledgerOver({ returns: [{ fromISO: ASOF, toISO: '2028-09-30', annualPct: 7 }],
    contributions: [{ from: '2026-10-31', amount: 1_000, cadence: 'monthly' }] });
  const from = openingPosition(l.opening);
  let reproduces = true, identity = true, detail = '';
  for (const c of l.checkpoints) {
    const ch = positionChange(from, checkpointPosition(c))!;
    const at = checkpointPosition(c);
    for (const line of CHANGE_LINES) {
      const x = ch[line]!;
      if (cents(x.from + x.abs) !== cents(at[line] as number) || x.from !== from[line] || x.to !== at[line]) {
        reproduces = false; detail += `${c.date} ${line}; `; }
    }
    // otherAssets is held flat, so net worth moves by the three lines that move.
    const parts = ch.liquid!.abs + ch.investments!.abs - ch.debt!.abs;
    if (Math.abs(parts - ch.netWorth!.abs) > 0.02) { identity = false; detail += `${c.date} nw ${parts} vs ${ch.netWorth!.abs}; `; }
  }
  check(`opening + abs = the row, on every line of all ${l.checkpoints.length} rows, to the cent`, reproduces, detail);
  check('net worth moves by liquid + investments − debt (other assets are held flat)', identity, detail);

  const last = l.checkpoints[l.checkpoints.length - 1];
  const full = positionChange(from, checkpointPosition(last))!;
  check('the block names its two dates', full.between.from === ASOF && full.between.to === last.date);
  check('the meaning states the debt convention and forbids the subtraction',
    /debt.*MORE owed/.test(full.meaning) && /never subtract/.test(full.meaning));
  const compact = compactChange(from, checkpointPosition(last))!;
  check('a row\'s compact form is the same four `abs` figures and nothing else',
    JSON.stringify(compact) === JSON.stringify(Object.fromEntries(CHANGE_LINES.map((k) => [k, full[k]!.abs]))));
}

console.log('4. debt keeps its own sign');
{
  // Nothing pays the debt down and nothing accrues on an aggregate with no lines: it is flat.
  const flat = positionChange(openingPosition(ledgerOver().opening), checkpointPosition(ledgerOver().checkpoints[5]))!;
  check('a debt that did not move is 0, not omitted', flat.debt!.abs === 0 && flat.debt!.pct === 0);
  const paid = positionChange(
    { date: ASOF, liquid: 15_000, investments: 20_000, debt: 4_000, netWorth: 32_000 },
    { date: '2027-09-30', liquid: 15_000, investments: 20_000, debt: 1_000, netWorth: 35_000 })!;
  check('debt falling 3,000 is abs −3,000 while net worth is +3,000 — never re-signed',
    paid.debt!.abs === -3_000 && paid.netWorth!.abs === 3_000);
  const zeroDebt = positionChange(
    { date: ASOF, liquid: 1, investments: 1, debt: 0, netWorth: 2 },
    { date: '2027-09-30', liquid: 1, investments: 1, debt: 250, netWorth: -248 })!;
  check('debt opening at zero: abs stated, pct null', zeroDebt.debt!.abs === 250 && zeroDebt.debt!.pct === null);
}

console.log('5. conservation at 0% still holds');
{
  // A contribution RELOCATES cash. At a 0% return it cannot change net worth, so the
  // net-worth change with the rule equals the change without it — on every row.
  const without = ledgerOver();
  const withRule = ledgerOver({ contributions: [{ from: '2026-10-31', amount: 1_500, cadence: 'monthly' }] });
  const a = openingPosition(without.opening), b = openingPosition(withRule.opening);
  let conserved = true, moved = false, detail = '';
  withRule.checkpoints.forEach((c, i) => {
    const w = compactChange(b, checkpointPosition(c))!;
    const o = compactChange(a, checkpointPosition(without.checkpoints[i]))!;
    if (cents(w.netWorth!) !== cents(o.netWorth!)) { conserved = false; detail += `${c.date}; `; }
    if (cents(w.liquid! + w.investments!) !== cents(o.liquid! + o.investments!)) { conserved = false; detail += `${c.date} lines; `; }
    if (w.investments! > 0 && w.liquid! < o.liquid!) moved = true;
  });
  check('net-worth change is identical with and without the rule, on every row', conserved, detail);
  check('…while liquid and investments each moved by the relocated amount', moved);
}

console.log('6. what is not a change');
{
  const p = { date: ASOF, liquid: 1, investments: 2, debt: 3, netWorth: 0 };
  check('one date is not a change: null, never a block of zeros', positionChange(p, { ...p }) === null
    && compactChange(p, { ...p }) === null);
  const holed = positionChange(p, { date: '2027-01-31', liquid: null, investments: 5, debt: 3, netWorth: null })!;
  check('a line the spine could not produce is omitted, the others are kept',
    holed.liquid === undefined && holed.netWorth === undefined && holed.investments!.abs === 3);
  check('nothing on either side ⇒ null',
    positionChange({ date: ASOF, liquid: null, investments: null, debt: null, netWorth: null },
      { date: '2027-01-31', liquid: null, investments: null, debt: null, netWorth: null }) === null);
}

console.log('7. it is wired, and beside — never inside — what the envelope reads');
{
  const tools = readFileSync(join(__dirname, 'tools.ts'), 'utf8');
  const present = tools.slice(tools.indexOf('function presentScenario('), tools.indexOf('const SCENARIO_QUALIFICATION'));
  check('every scenario result states the horizon\'s change once, in full',
    /changeSinceOpening: last \? positionChange\(/.test(present));
  check('…and every row carries the compact form, the ledger\'s own fields kept as they were',
    /\{ \.\.\.c, changeSinceOpening \}/.test(present));
  const crossing = tools.slice(tools.indexOf('const scenarioCrossing'), tools.indexOf('// ── 12. Goal seek'));
  check('the crossing and the never-crosses position carry it as a SIBLING of `composition`',
    (crossing.match(/changeSinceOpening: changeAt\(/g) ?? []).length === 2);
  const composition = crossing.slice(crossing.indexOf('const composition ='), crossing.indexOf('const changeAt'));
  check('`composition` itself — the six numbers active-scenario.ts reads — has not grown a field',
    !/changeSinceOpening/.test(composition) && /liquid:.*investments:[\s\S]*debt:[\s\S]*netWorth:/.test(composition));
  const self = readFileSync(join(__dirname, 'scenario-change.ts'), 'utf8');
  check('the module is pure: the money tolerance and ledger TYPES are all it imports',
    (self.match(/^import /gm) ?? []).length === 2 && /import type \{[^}]*\} from '.\/scenario-ledger'/.test(self));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nscenario-change: all checks passed');
