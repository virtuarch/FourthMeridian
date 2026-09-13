/**
 * lib/ai/brief/relevance.test.ts
 *
 * STANDING FACTS DO NOT BECOME WALLPAPER — first introduction, silence while
 * unchanged, re-admission when they change or when today's movement needs them.
 *
 *   npx tsx lib/ai/brief/relevance.test.ts
 */

import { basePackage } from './fixtures';
import { materialDigest } from './digest';
import { CONCENTRATION_WEIGHT_STEP_PCT, RELEVANCE_PRIOR_MAX_DAYS } from './policy';
import {
  applyRelevance, concentrationNovelty, readStandingFacts, standingFactsOf, type StandingFacts,
} from './relevance';
import type { BriefPackage } from './types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const concentrated = (over: Partial<NonNullable<BriefPackage['currentState']['concentration']>> = {}, day = '2026-09-14'): BriefPackage => {
  const p = basePackage();
  p.identity.briefDay = day; p.identity.asOf = day;
  p.currentState.concentration = { classification: 'HIGHLY_CONCENTRATED', topSymbol: 'BTC', topWeightPct: 85,
    populationValue: 28440.27, populationIsComplete: false, ...over };
  // A quiet day: no material investment movement.
  p.recentChanges.d1!.investments = { abs: 240.1, pct: 0.3 };
  p.recentChanges.d1!.digitalAssets = { abs: 20.37, pct: 0.1 };
  p.recentChanges.w1!.investments = { abs: 402.9, pct: 0.5 };
  p.recentChanges.w1!.digitalAssets = { abs: -73.16, pct: -0.3 };
  return p;
};
const yesterday = (facts: StandingFacts | null) => ({ facts, briefDay: '2026-09-13' });

console.log('1. the policy');
{
  check('a concentration is news again after a ten-point move', CONCENTRATION_WEIGHT_STEP_PCT === 10);
  check('an earlier Brief suppresses repeats for thirty days', RELEVANCE_PRIOR_MAX_DAYS === 30);
}

console.log('\n2. first introduction');
{
  const first = applyRelevance(concentrated(), null);
  check('with no earlier Brief the concentration is shown, marked NEW',
    first.pkg.currentState.concentration?.novelty === 'NEW' && first.decision.concentration?.shown === true);
  const noFacts = applyRelevance(concentrated(), yesterday({ v: 1, concentration: null }));
  check('…and when yesterday had no concentration at all', noFacts.pkg.currentState.concentration?.novelty === 'NEW');
  const monthAway = applyRelevance(concentrated(), { facts: standingFactsOf(concentrated()), briefDay: '2026-08-01' });
  check('…and after more than thirty days away', monthAway.pkg.currentState.concentration?.novelty === 'NEW');
}

console.log('\n3. unchanged is not news');
{
  const same = applyRelevance(concentrated(), yesterday(standingFactsOf(concentrated({}, '2026-09-13'))));
  check('the next day, identical concentration and a quiet market → omitted from the model\'s input',
    same.pkg.currentState.concentration === undefined && same.decision.concentration?.novelty === 'UNCHANGED'
      && same.decision.concentration.shown === false);
  const wobble = applyRelevance(concentrated({ topWeightPct: 87.5 }), yesterday(standingFactsOf(concentrated({}, '2026-09-13'))));
  check('a weight wobble inside the step is still unchanged', wobble.pkg.currentState.concentration === undefined);
  const input = concentrated();
  applyRelevance(input, yesterday(standingFactsOf(input)));
  check('the caller\'s package is not mutated', input.currentState.concentration?.topSymbol === 'BTC' && !('novelty' in input.currentState.concentration!));
}

console.log('\n4. changed, or needed today');
{
  const prior = yesterday(standingFactsOf(concentrated({ topWeightPct: 60, classification: 'CONCENTRATED' }, '2026-09-13')));
  const rose = applyRelevance(concentrated(), prior);
  check('60% → 85% with a new classification → shown, marked CHANGED', rose.pkg.currentState.concentration?.novelty === 'CHANGED');
  check('a ten-point move alone is a change',
    concentrationNovelty(standingFactsOf(concentrated({ topWeightPct: 95 })).concentration, yesterday(standingFactsOf(concentrated())).facts) === 'CHANGED');
  check('a different top holding is a change',
    concentrationNovelty(standingFactsOf(concentrated({ topSymbol: 'ETH' })).concentration, yesterday(standingFactsOf(concentrated())).facts) === 'CHANGED');
  const moved = concentrated();
  moved.recentChanges.w1!.digitalAssets = { abs: -3960.05, pct: -15 };
  const explains = applyRelevance(moved, yesterday(standingFactsOf(concentrated())));
  check('unchanged, but crypto moved materially this week → shown, marked UNCHANGED, to explain the move',
    explains.pkg.currentState.concentration?.novelty === 'UNCHANGED' && explains.decision.concentration?.shown === true);
}

console.log('\n5. relevance never moves the digest');
{
  const pkg = concentrated();
  const filtered = applyRelevance(pkg, yesterday(standingFactsOf(pkg))).pkg;
  check('the digest is computed on the full package, so filtering cannot trigger or hide a regeneration',
    materialDigest(pkg) !== materialDigest(filtered) && materialDigest(pkg) === materialDigest(concentrated()));
}

console.log('\n6. persisted facts');
{
  const facts = standingFactsOf(concentrated());
  const content = { headline: 'x', quiet: true, observations: [], standingFacts: facts };
  check('facts round-trip from stored content', JSON.stringify(readStandingFacts(content)) === JSON.stringify(facts));
  check('content from before this slice reads as none', readStandingFacts({ headline: 'x' }) === null);
  check('malformed facts read as none', readStandingFacts({ standingFacts: { v: 2 } }) === null
    && readStandingFacts({ standingFacts: { v: 1, concentration: { classification: 5 } } }) === null);
  check('a quiet day without concentration needs no decision', applyRelevance(basePackage(), null).decision.concentration === null);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
