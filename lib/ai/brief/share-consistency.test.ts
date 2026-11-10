/**
 * lib/ai/brief/share-consistency.test.ts
 *
 * A PART, ITS WHOLE AND THE SHARE BETWEEN THEM MUST AGREE (S2 finding O-2).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/brief/share-consistency.test.ts
 */

import { acceptNarration } from './generate';
import { BRIEF_SCENARIOS } from './fixtures';
import { SHARE_TOLERANCE_PP, inconsistentShares } from './share-consistency';
import type { BriefNarration, BriefObservation, BriefPackage } from './types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// The sentence as Production shipped it.
const PRODUCTION = 'Over half of the investments measured in your stock holdings are in SBSI, which is about 57% of that slice '
  + '(around $12,985 out of $12,985.14).';

console.log('1. the Production example');
{
  const r = inconsistentShares(PRODUCTION);
  check('is rejected', r.length === 1, JSON.stringify(r));
  check('…as a part that is not below its whole', r[0] === 'PART_NOT_BELOW_WHOLE');
  check('the result is codes only — no amount or symbol leaks into what a caller logs',
    !/\d|SBSI/.test(JSON.stringify(r)));
}

console.log('\n2. consistent shares pass');
{
  check('the corrected sentence (part beside whole) passes',
    inconsistentShares('SBSI is about 57% of that slice (around $7,401 out of $12,985.14).').length === 0);
  check('rounded amounts are honoured at the precision they were written ($7.4K of $13K, 57%)',
    inconsistentShares('SBSI is 57% of your measured holdings ($7.4K of $13K).').length === 0);
  check('pair first, percentage after ("…, or 57%")',
    inconsistentShares('You hold $7,401 of your $12,985 in SBSI, or 57%.').length === 0);
  check('percentage written right beside the pair, no "of"',
    inconsistentShares('SBSI is 57% ($7,401 of $12,985.14).').length === 0);
  check('a share of 100% may name the whole as the part',
    inconsistentShares('BTC is 100% of that slice ($28,440 of $28,440.27).').length === 0);
}

console.log(`\n3. tolerance boundaries (±${SHARE_TOLERANCE_PP} percentage points)`);
{
  const s = (pct: number) => inconsistentShares(`SBSI is ${pct}% of that slice ($5,700.00 out of $10,000.00).`);
  check('exact (57%) passes', s(57).length === 0);
  check('+2 points (59%) passes', s(59).length === 0);
  check('-2 points (55%) passes', s(55).length === 0);
  check('+2.1 points (59.1%) is rejected', s(59.1)[0] === 'SHARE_MISMATCH', JSON.stringify(s(59.1)));
  check('-3 points (54%) is rejected', s(54)[0] === 'SHARE_MISMATCH');
  check('+3 points (60%) is rejected', s(60)[0] === 'SHARE_MISMATCH');
  check('a part above its whole is rejected', inconsistentShares('SBSI is 57% of that slice ($14,000 of $12,985).')[0]
    === 'PART_NOT_BELOW_WHOLE');
}

console.log('\n4. what is not judged');
{
  check('a change percentage is not tied to a pair beside it later in the sentence',
    inconsistentShares('Your investments rose 5% this week, and you hold $7,401 of your $12,985 in SBSI.').length === 0);
  check('a pair with no percentage is not judged (nothing to disagree with)',
    inconsistentShares('You hold $7,401 of your $12,985 in SBSI.').length === 0);
  check('non-money percentages are unaffected',
    inconsistentShares('Your cash is up 4% on the week and 3 of 4 accounts updated today.').length === 0);
  check('a percentage of a count pair (no money) is not judged',
    inconsistentShares('About 50% of your accounts (3 of 4) updated today.').length === 0);
  check('a percentage alone is not judged', inconsistentShares('NVDA is 45% of your measured investments.').length === 0);
  check('a pair in another sentence is not tied to the percentage',
    inconsistentShares('NVDA is 45% of your measured investments. You moved $500 of $2,000 to savings.').length === 0);
  check('decimals never split a sentence',
    inconsistentShares('SBSI is 57.0% of that slice ($12,985.14 of $12,985.14).')[0] === 'PART_NOT_BELOW_WHOLE');
}

console.log('\n5. the Brief drops the broken observation — and invents nothing');
{
  const pkg: BriefPackage = structuredClone(BRIEF_SCENARIOS.find((s) => s.id === '06-concentrated')!.pkg);
  pkg.currentState.concentration = { classification: 'HIGHLY_CONCENTRATED', topSymbol: 'SBSI', topWeightPct: 57,
    topValue: 7401.53, populationValue: 12985.14, populationIsComplete: false };
  const ob = (body: string): BriefObservation => ({ kind: 'INVESTMENTS', title: 'One holding leads your stocks',
    body, importance: 'CONTEXT', evidence: ['currentState.concentration'] });
  const n = (obs: BriefObservation[], headline = 'Not much changed yesterday.'): BriefNarration =>
    ({ headline, quiet: true, observations: obs });

  const broken = acceptNarration(pkg, n([ob(PRODUCTION)]));
  check('every figure in the Production sentence is licensed — the licence alone let it through',
    broken.ok && !broken.validation.droppedObservations.some((d) => d.reason === 'UNLICENSED_FIGURE'));
  check('the observation is dropped as INCONSISTENT_SHARE with codes only',
    broken.ok && broken.narration.observations.length === 0
      && broken.validation.droppedObservations[0]?.reason === 'INCONSISTENT_SHARE'
      && broken.validation.droppedObservations[0]?.checks?.join() === 'PART_NOT_BELOW_WHOLE'
      && broken.validation.droppedObservations[0]?.figures === undefined);
  check('…and nothing is written in its place', broken.ok && broken.narration.headline === 'Not much changed yesterday.'
    && JSON.stringify(broken.narration).indexOf('12,985') === -1);

  const fixed = acceptNarration(pkg, n([ob('SBSI is about 57% of the stocks measured (around $7,401 out of $12,985.14).')]));
  check('the faithful sentence, citing the part code now supplies, is kept',
    fixed.ok && fixed.narration.observations.length === 1 && fixed.validation.droppedObservations.length === 0,
    JSON.stringify(fixed.ok ? fixed.validation : fixed));

  const head = acceptNarration(pkg, n([], 'SBSI is 57% of your stocks ($12,985 of $12,985.14).'));
  check('in the headline the Brief is refused, with codes only in the detail',
    !head.ok && head.reason === 'INCONSISTENT_SHARE_HEADLINE' && head.detail.join() === 'PART_NOT_BELOW_WHOLE');
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall share-consistency checks passed');
