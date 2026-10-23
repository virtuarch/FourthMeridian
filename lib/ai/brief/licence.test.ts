/**
 * lib/ai/brief/licence.test.ts
 *
 * EVERY FIGURE A BRIEF STATES MUST BE ONE CODE COMPUTED.
 *
 *   npx tsx lib/ai/brief/licence.test.ts
 */

import { extractFigures, licenceFromPackage, unlicensedFigures } from './licence';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const figs = (s: string) => extractFigures(s).map((f) => `${f.kind}:${f.value}`);

console.log('1. what counts as a figure');
{
  check('"$18.9K" is money at a hundred dollars',
    JSON.stringify(extractFigures('$18.9K')) === JSON.stringify([{ text: '$18.9K', kind: 'MONEY', value: 18900, unit: 100 }]));
  check('"$620.14" is money at a cent', Math.abs((extractFigures('$620.14')[0]?.unit ?? 0) - 0.01) < 1e-12);
  check('"15%" and "15.3 percent" are percentages', figs('down 15% or 15.3 percent').join() === 'PERCENT:15,PERCENT:15.3');
  check('"12,400" is a number', figs('about 12,400 in savings').join() === 'NUMBER:12400');
  check('"3.2 months" is a number', figs('3.2 months of expenses').join() === 'NUMBER:3.2');
  check('"$1.2M" scales', figs('$1.2M').join() === 'MONEY:1200000');
  check('counts are not figures', figs('2 cards, 7 days, 3 weeks, 90-day window').length === 0);
  check('years and ISO dates are not figures', figs('by 2027, since 2026-09-06 at 09:42').length === 0);
  check('digits inside words are not figures', figs('your 401(k), Q3, the 1st, W-2').length === 0);
  check('a trailing sentence period does not break a figure', figs('It was $4,812.66.').join() === 'MONEY:4812.66');
}

console.log('\n2. rounding is honoured');
{
  const L = licenceFromPackage({ liquid: 18920.40, w1: { liquid: { abs: -2169.56, pct: -10.3 } },
    coverageMonths: 3.2, topWeightPct: 45.2 });
  const none = (s: string) => unlicensedFigures(s, L).length === 0;
  check('the exact figure', none('$18,920.40'));
  check('a written rounding — "$18.9K"', none('$18.9K'));
  check('"about $18,900"', none('about $18,900'));
  check('"$19K" rounds to the thousand within 3%', none('$19K'));
  check('a change quoted without its sign', none('down $2,169.56') && none('down about $2,170'));
  check('a percent at its written precision', none('down 10%') && none('10.3%'));
  check('a percentage field', none('45% of the portfolio'));
  const paid = licenceFromPackage({ amount: 4812.66, abs: -2169.56 });
  check('a truncation is a rounding — "$4,812" for 4,812.66 (live golden 02)',
    unlicensedFigures('$4,812', paid).length === 0 && unlicensedFigures('$2,169', paid).length === 0);
  check('…and so is rounding up — "$4,813"', unlicensedFigures('$4,813', paid).length === 0);
  check('…but not a figure a whole unit away — "$4,814"', unlicensedFigures('$4,814', paid).length === 1);
  check('a percent strictly within one unit — 10.3 may be 10% or 11%, not 12%',
    unlicensedFigures('11%', L).length === 0 && unlicensedFigures('12%', L).length === 1);
  check('a non-money number', none('3.2 months'));
}

console.log('\n3. invention is not');
{
  const L = licenceFromPackage({ liquid: 18920.40, w1: { liquid: { abs: -2169.56, pct: -10.3 } }, debt: 7600 });
  const flagged = (s: string) => unlicensedFigures(s, L).map((f) => f.text);
  check('an invented $8,000 against 7,600 is refused', flagged('about $8,000 of debt').join() === '$8,000');
  check('"$20K" is not a rounding of 18,920.40', flagged('$20K').length === 1);
  check('arithmetic the package did not do is refused ($16,750.84)', flagged('from $16,750.84').length === 1);
  check('a percent is licensed only by a percentage field', flagged('18920%').length === 1);
  check('an unlicensed bare number ≥ 1,000', flagged('5000 more').length === 1);
  const withString = licenceFromPackage({ merchant: 'Store 5000', amount: 12 });
  check('strings in the package license nothing', unlicensedFigures('$5,000', withString).length === 1);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
