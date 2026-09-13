/**
 * lib/ai/brief/state.test.ts
 *
 * FRESH, CHECK_MATERIAL, NEEDS_GENERATION — and what may stand in meanwhile.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/brief/state.test.ts
 */

import { STRUCTURED_TIMEOUT_MS } from '@/lib/ai/provider';
import { GENERATION_LEASE_MS, STALE_FALLBACK_MAX_DAYS } from './policy';
import { claimIsActive, decideArtifactState, fallbackFrom, type BriefRow } from './state';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const TODAY = '2026-09-13';
const NOW = new Date('2026-09-13T12:00:00.000Z');
const row = (over: Partial<BriefRow> = {}): BriefRow => ({
  id: 'r1', spaceId: 's', ownerUserId: 'u', briefDay: TODAY,
  content: { headline: 'Quiet day.' }, generatedAt: new Date('2026-09-13T08:00:00.000Z'),
  balancesAsOf: new Date('2026-09-13T06:00:00.000Z'), historyThrough: '2026-09-12',
  sourceWatermark: 'wm-1', materialDigest: 'dg-1', model: 'gpt-5.1', promptVersion: 'p', correlationId: 'c',
  generationStartedAt: null, lastFailedAt: null, lastFailureReason: null, ...over,
});
const decide = (todayRow: BriefRow | null, latestPrior: BriefRow | null, watermark = 'wm-1', now = NOW) =>
  decideArtifactState({ today: TODAY, now, todayRow, latestPrior, watermark });

console.log('1. policy');
{
  check('the lease outlives the provider deadline with room for assembly and persistence',
    GENERATION_LEASE_MS >= STRUCTURED_TIMEOUT_MS + 20_000, `${GENERATION_LEASE_MS} vs ${STRUCTURED_TIMEOUT_MS}`);
  check('a fallback may be at most two days old', STALE_FALLBACK_MAX_DAYS === 2);
}

console.log('\n2. today');
{
  const fresh = decide(row(), null);
  check('same day, same watermark → FRESH', fresh.state.kind === 'FRESH');
  const moved = decide(row(), null, 'wm-2');
  check('same day, moved watermark → CHECK_MATERIAL', moved.state.kind === 'CHECK_MATERIAL');
  check('…with today\'s own Brief as a usable, age-0 fallback', moved.state.kind === 'CHECK_MATERIAL'
    && moved.state.fallback.usable && moved.state.fallback.ageDays === 0);
  const firstFailed = decide(row({ content: null, generatedAt: null, lastFailedAt: NOW, lastFailureReason: 'TIMEOUT' }), null);
  check('a first generation that failed → NEEDS_GENERATION, with the failure reported',
    firstFailed.state.kind === 'NEEDS_GENERATION' && firstFailed.lastFailure?.reason === 'TIMEOUT');
  const regenFailed = decide(row({ lastFailedAt: new Date('2026-09-13T09:00:00.000Z'), lastFailureReason: 'PROVIDER_ERROR' }), null, 'wm-2');
  check('a failed regeneration keeps the older Brief and reports the failure',
    regenFailed.state.kind === 'CHECK_MATERIAL' && regenFailed.lastFailure?.reason === 'PROVIDER_ERROR');
  const oldFailure = decide(row({ lastFailedAt: new Date('2026-09-13T07:00:00.000Z'), lastFailureReason: 'TIMEOUT' }), null);
  check('a failure older than the last success is history, not state', oldFailure.lastFailure === null);
}

console.log('\n3. no Brief today');
{
  check('nothing at all → NEEDS_GENERATION with no fallback', (() => {
    const d = decide(null, null); return d.state.kind === 'NEEDS_GENERATION' && d.state.fallback === null;
  })());
  const yesterday = row({ briefDay: '2026-09-12', generatedAt: new Date('2026-09-12T08:00:00.000Z'),
    balancesAsOf: new Date('2026-09-12T06:00:00.000Z') });
  const y = decide(null, yesterday, 'wm-9');
  check('a new day needs its own Brief even with yesterday\'s watermark and digest', y.state.kind === 'NEEDS_GENERATION');
  check('…yesterday stands in (LIVE → RECENT overnight is ordinary)', y.state.kind === 'NEEDS_GENERATION'
    && y.state.fallback?.usable === true && y.state.fallback.ageDays === 1 && y.state.fallback.briefDay === '2026-09-12');
  const threeDays = fallbackFrom(row({ briefDay: '2026-09-10' }), TODAY, NOW);
  check('three days old is a record, not a fallback', !threeDays.usable && threeDays.unusableBecause === 'TOO_OLD');
  const twoDays = fallbackFrom(row({ briefDay: '2026-09-11', generatedAt: new Date('2026-09-11T08:00:00.000Z'),
    balancesAsOf: new Date('2026-09-11T06:00:00.000Z') }), TODAY, NOW);
  check('two days old still stands in', twoDays.usable);
  const agedIntoStale = fallbackFrom(row({ briefDay: '2026-09-12', generatedAt: new Date('2026-09-12T08:00:00.000Z'),
    balancesAsOf: new Date('2026-09-06T10:00:00.000Z') }), TODAY, NOW);
  check('a Brief whose balances have since aged into STALE may not lead',
    !agedIntoStale.usable && agedIntoStale.unusableBecause === 'FRESHNESS_DEGRADED');
  const alreadyStale = fallbackFrom(row({ briefDay: '2026-09-12', generatedAt: new Date('2026-09-12T08:00:00.000Z'),
    balancesAsOf: new Date('2026-08-20T10:00:00.000Z') }), TODAY, NOW);
  check('…but one that already described stale balances has not degraded', alreadyStale.usable);
  check('a fallback is returned as stored — never rewritten',
    y.state.kind === 'NEEDS_GENERATION' && y.state.fallback?.row.content === yesterday.content);
}

console.log('\n4. the claim');
{
  check('no claim → inactive', !claimIsActive(row(), NOW));
  check('claimed a minute ago → active', claimIsActive(row({ generationStartedAt: new Date(NOW.getTime() - 60_000) }), NOW));
  check('claimed exactly one lease ago → expired', !claimIsActive(row({ generationStartedAt: new Date(NOW.getTime() - GENERATION_LEASE_MS) }), NOW));
  const inFlight = decide(row({ content: null, generatedAt: null, generationStartedAt: new Date(NOW.getTime() - 5_000) }), null);
  check('a claimed first generation is reported as in flight', inFlight.claimActive && inFlight.state.kind === 'NEEDS_GENERATION');
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
