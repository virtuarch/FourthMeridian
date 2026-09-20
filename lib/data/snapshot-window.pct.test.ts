/**
 * lib/data/snapshot-window.pct.test.ts
 *
 * WHEN A STOCK CHANGE HAS A PERCENTAGE — decided once, in the authority.
 *
 * Measured in the Daily Brief package for a real Space: a card carrying $9.75
 * took a $1,163.94 week of charges and the package shipped `debt.pct: 11937.8`
 * (and `773.4` over the month). Both are correct divisions that say nothing
 * about the change. Separately, the same series holds `2.842170943040401e-14` on
 * a day the debt was paid off, which the old `=== 0` guard did not recognise as
 * "no base".
 *
 *   npx tsx lib/data/snapshot-window.pct.test.ts
 */

import {
  MONEY_EPSILON, canonicalWindowChange, observedChange, pctOfOpening, type SeriesPoint,
} from './snapshot-window';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const pt = (iso: string, value: number): SeriesPoint => ({ date: new Date(`${iso}T00:00:00.000Z`), value });

console.log('1. no base, no percentage (aligned with M1 compare: |base| < MONEY_EPSILON)');
{
  check('an exact zero opening gives null', pctOfOpening(500, 0) === null);
  check('float residue on a settled balance is not a base', pctOfOpening(1173.69, 2.842170943040401e-14) === null);
  check('anything under half a cent is not a base', pctOfOpening(10, MONEY_EPSILON / 2) === null && pctOfOpening(10, -0.004) === null);
  check('half a cent and up IS a base', pctOfOpening(0.01, 0.01) === 100);
  check('never Infinity or NaN', [pctOfOpening(1, 0), pctOfOpening(NaN, 10), pctOfOpening(1, Infinity)].every((v) => v === null));
  const dust = observedChange(pt('2026-09-13', 2.842170943040401e-14), pt('2026-09-20', 1173.69));
  check('observedChange carries the rule: abs is measured, pct refused', dust?.pct === null && Math.abs(dust.abs - 1173.69) < 1e-9);
}

console.log('\n2. ordinary changes are untouched');
{
  check('a rise', pctOfOpening(250, 1000) === 25);
  check('a fall', pctOfOpening(-250, 1000) === -25);
  check('a negative opening divides by its magnitude', pctOfOpening(500, -2000) === 25);
  check('paid off completely is −100%, with or without the option',
    pctOfOpening(-3210.55, 3210.55) === -100 && pctOfOpening(-3210.55, 3210.55, { baseMustCoverChange: true }) === -100);
  check('the default keeps a large percentage — existing consumers show the opening beside it',
    Math.round(pctOfOpening(1163.94, 9.75)! * 10) / 10 === 11937.8);
}

console.log('\n3. a base smaller than the movement (opt-in) — the ratio describes the base, not the change');
{
  const o = { baseMustCoverChange: true };
  check('the measured case: 9.75 → 1,173.69 has no percentage', pctOfOpening(1163.94, 9.75, o) === null);
  check('…nor the month: 134.38 → 1,173.69', pctOfOpening(1039.31, 134.38, o) === null);
  check('exactly doubling still has one (the base covers the change)', pctOfOpening(1000, 1000, o) === 100);
  check('more than doubling does not', pctOfOpening(1000.01, 1000, o) === null);
  check('a sign crossing has none', pctOfOpening(15_000, -5_000, o) === null);
  check('no constant: the same rule at every scale',
    pctOfOpening(1_163_940, 9_750, o) === null && pctOfOpening(0.12, 0.10, o) === null && pctOfOpening(2_000, 100_000, o) === 2);
  check('a fall can never trip it on a positive series', pctOfOpening(-99_999, 100_000, o) !== null);
}

console.log('\n4. both change functions take the option and still report the values they used');
{
  const series = [pt('2026-08-20', 134.38), pt('2026-09-13', 9.75), pt('2026-09-20', 1173.69)];
  const plain = canonicalWindowChange(series, 'PAST_WEEK');
  const strict = canonicalWindowChange(series, 'PAST_WEEK', { baseMustCoverChange: true });
  check('default: the percentage is computed', plain !== null && Math.round(plain.pct! * 10) / 10 === 11937.8);
  check('opt-in: withheld, and the opening it was withheld over is still reported',
    strict !== null && strict.pct === null && strict.fromValue === 9.75 && strict.toValue === 1173.69
    && Math.abs(strict.abs - 1163.94) < 1e-9);
  const obs = observedChange(series[1], series[2], { baseMustCoverChange: true });
  check('observedChange likewise', obs !== null && obs.pct === null && obs.fromValue === 9.75);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
