/**
 * lib/data/snapshot-window.pct.test.ts
 *
 * WHEN A STOCK CHANGE HAS A PERCENTAGE — decided once, in the authority.
 *
 * Measured in the Daily Brief package for a real Space: a card carrying about ten
 * dollars took a four-figure week of charges and the package shipped a
 * five-digit `debt.pct`. A correct division that says nothing about the change.
 * (The figures below are SYNTHETIC and reproduce the shape: 12.50 → 1,600.) Separately, the same series holds `2.842170943040401e-14` on
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
  check('float residue on a settled balance is not a base', pctOfOpening(1600, 2.842170943040401e-14) === null);
  check('anything under half a cent is not a base', pctOfOpening(10, MONEY_EPSILON / 2) === null && pctOfOpening(10, -0.004) === null);
  check('half a cent and up IS a base', pctOfOpening(0.01, 0.01) === 100);
  check('never Infinity or NaN', [pctOfOpening(1, 0), pctOfOpening(NaN, 10), pctOfOpening(1, Infinity)].every((v) => v === null));
  const dust = observedChange(pt('2026-09-13', 2.842170943040401e-14), pt('2026-09-20', 1600));
  check('observedChange carries the rule: abs is measured, pct refused', dust?.pct === null && Math.abs(dust.abs - 1600) < 1e-9);
}

console.log('\n2. ordinary changes are untouched');
{
  check('a rise', pctOfOpening(250, 1000) === 25);
  check('a fall', pctOfOpening(-250, 1000) === -25);
  check('a negative opening divides by its magnitude', pctOfOpening(500, -2000) === 25);
  check('paid off completely is −100%, with or without the option',
    pctOfOpening(-3210.55, 3210.55) === -100 && pctOfOpening(-3210.55, 3210.55, { baseMustCoverChange: true }) === -100);
  check('the default keeps a large percentage — existing consumers show the opening beside it',
    pctOfOpening(1587.5, 12.5) === 12700);
}

console.log('\n3. a base smaller than the movement (opt-in) — the ratio describes the base, not the change');
{
  const o = { baseMustCoverChange: true };
  check('the shape of the measured case: 12.50 → 1,600 has no percentage', pctOfOpening(1587.5, 12.5, o) === null);
  check('…nor the month: 150 → 1,600', pctOfOpening(1450, 150, o) === null);
  check('exactly doubling still has one (the base covers the change)', pctOfOpening(1000, 1000, o) === 100);
  check('more than doubling does not', pctOfOpening(1000.01, 1000, o) === null);
  check('a sign crossing has none', pctOfOpening(15_000, -5_000, o) === null);
  check('no constant: the same rule at every scale',
    pctOfOpening(1_587_500, 12_500, o) === null && pctOfOpening(0.12, 0.10, o) === null && pctOfOpening(2_000, 100_000, o) === 2);
  check('a fall can never trip it on a positive series', pctOfOpening(-99_999, 100_000, o) !== null);
}

console.log('\n4. both change functions take the option and still report the values they used');
{
  const series = [pt('2026-08-20', 150), pt('2026-09-13', 12.5), pt('2026-09-20', 1600)];
  const plain = canonicalWindowChange(series, 'PAST_WEEK');
  const strict = canonicalWindowChange(series, 'PAST_WEEK', { baseMustCoverChange: true });
  check('default: the percentage is computed', plain !== null && plain.pct === 12700);
  check('opt-in: withheld, and the opening it was withheld over is still reported',
    strict !== null && strict.pct === null && strict.fromValue === 12.5 && strict.toValue === 1600
    && strict.abs === 1587.5);
  const obs = observedChange(series[1], series[2], { baseMustCoverChange: true });
  check('observedChange likewise', obs !== null && obs.pct === null && obs.fromValue === 12.5);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
