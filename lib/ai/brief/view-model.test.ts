/**
 * lib/ai/brief/view-model.test.ts
 *
 * WHAT THE BROWSER MAY SEE — each server state mapped, and nothing internal leaking.
 *
 * The rows and stored content below deliberately carry every internal the response
 * must not: a watermark, a digest, a claim, a correlation id, a model, a prompt
 * version, a failure reason, observation evidence paths, an owner id and an
 * unexpected extra key. Every response is walked for all of them.
 *
 *   npx tsx lib/ai/brief/view-model.test.ts
 */

import type { BriefResponse } from '@/lib/brief-types';
import type { BriefInspection, EnsureResult } from './lifecycle';
import { fallbackFrom, type ArtifactDecision, type BriefRow } from './state';
import { responseFromEnsure, responseFromInspection } from './view-model';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const TODAY = '2026-09-13';
const NOW = new Date('2026-09-13T12:00:00.000Z');
const content = {
  headline: 'Quiet day.', quiet: true, briefDay: TODAY, generatedAt: '2026-09-13T08:00:00.000Z', evidenceAsOf: TODAY,
  observations: [{ kind: 'DATA_QUALITY', title: 'Reconnect', body: 'One connection needs you.', importance: 'NOTABLE', evidence: ['freshness.needsReauth'] }],
  secretExtra: 'should-not-leak',
};
const row = (over: Partial<BriefRow> = {}): BriefRow => ({
  id: 'row_secret', spaceId: 'space_A', ownerUserId: 'owner_secret', briefDay: TODAY, content,
  generatedAt: new Date('2026-09-13T08:00:00.000Z'), balancesAsOf: new Date('2026-09-13T06:00:00.000Z'),
  historyThrough: '2026-09-12', sourceWatermark: 'wm-secret', materialDigest: 'dg-secret', model: 'gpt-5.1',
  promptVersion: 'brief-prompt-secret', correlationId: 'brief_secret', generationStartedAt: null,
  lastFailedAt: null, lastFailureReason: 'REASON_SECRET', ...over,
});
const metrics = { currency: 'USD', netWorth: 128450.22, asOf: '2026-09-12', estimated: false, monthChange: { abs: 2140.66, pct: 1.7, fromDate: '2026-08-12' } };
const inspection = (decision: Partial<ArtifactDecision> & Pick<ArtifactDecision, 'state'>, over: Partial<BriefInspection> = {}): BriefInspection => ({
  today: TODAY, hasData: true, retryAfterMs: 0, timings: { watermark: 12 },
  decision: { claimActive: false, lastFailure: null, ...decision }, ...over,
});
const read = (i: BriefInspection) => responseFromInspection({ spaceId: 'space_A', inspection: i, now: NOW, metrics });
const all: BriefResponse[] = [];
const keep = (r: BriefResponse) => { all.push(r); return r; };

console.log('1. GET — every state');
{
  const fresh = keep(read(inspection({ state: { kind: 'FRESH', row: row() } })));
  check('FRESH → the Brief, nothing to do', fresh.state === 'FRESH' && !fresh.needsGeneration && fresh.brief?.headline === 'Quiet day.'
    && fresh.brief.fromPriorDay === false && fresh.brief.generatedAt === '2026-09-13T08:00:00.000Z');
  check('…with observations as title, body, kind and importance only',
    JSON.stringify(fresh.brief?.observations) === JSON.stringify([{ kind: 'DATA_QUALITY', title: 'Reconnect', body: 'One connection needs you.', importance: 'NOTABLE' }]));
  check('…the metrics, the Space echoed, and when it was checked',
    fresh.spaceId === 'space_A' && fresh.metrics?.netWorth === 128450.22 && fresh.checkedAt === NOW.toISOString());

  const check_ = keep(read(inspection({ state: { kind: 'CHECK_MATERIAL', row: row(), fallback: fallbackFrom(row(), TODAY, NOW) } })));
  check('CHECK_MATERIAL → CHECK_REQUIRED: keep showing it, ask the server', check_.state === 'CHECK_REQUIRED' && check_.needsGeneration && !!check_.brief);
  const checkClaimed = keep(read(inspection({ claimActive: true, state: { kind: 'CHECK_MATERIAL', row: row(), fallback: fallbackFrom(row(), TODAY, NOW) } })));
  check('…already being regenerated → IN_PROGRESS, no POST', checkClaimed.state === 'IN_PROGRESS' && !checkClaimed.needsGeneration && !!checkClaimed.brief);

  const absent = keep(read(inspection({ state: { kind: 'NEEDS_GENERATION', row: null, fallback: null } })));
  check('nothing at all → ABSENT: skeleton, generate', absent.state === 'ABSENT' && absent.needsGeneration && absent.brief === null);

  const yesterday = row({ briefDay: '2026-09-12', generatedAt: new Date('2026-09-12T08:00:00.000Z'), balancesAsOf: new Date('2026-09-12T06:00:00.000Z') });
  const stale = keep(read(inspection({ state: { kind: 'NEEDS_GENERATION', row: null, fallback: fallbackFrom(yesterday, TODAY, NOW) } })));
  check('a safe earlier Brief → STALE: shown, dated, generate', stale.state === 'STALE' && stale.needsGeneration
    && stale.brief?.fromPriorDay === true && stale.brief.briefDay === '2026-09-12');

  const old = row({ briefDay: '2026-09-09', generatedAt: new Date('2026-09-09T08:00:00.000Z') });
  const tooOld = keep(read(inspection({ state: { kind: 'NEEDS_GENERATION', row: null, fallback: fallbackFrom(old, TODAY, NOW) } })));
  check('an unsafe earlier Brief is never shown → ABSENT', tooOld.state === 'ABSENT' && tooOld.brief === null);

  const claimed = keep(read(inspection({ claimActive: true, state: { kind: 'NEEDS_GENERATION', row: null, fallback: fallbackFrom(yesterday, TODAY, NOW) } })));
  check('another request generating → IN_PROGRESS with the fallback', claimed.state === 'IN_PROGRESS' && !claimed.needsGeneration && !!claimed.brief);

  const cooling = keep(read(inspection({ lastFailure: { at: NOW, reason: 'TIMEOUT' }, state: { kind: 'NEEDS_GENERATION', row: null, fallback: fallbackFrom(yesterday, TODAY, NOW) } }, { retryAfterMs: 120_000 })));
  check('inside a failure cooldown → FAILED, no POST, retryAfterMs, the fallback kept',
    cooling.state === 'FAILED' && !cooling.needsGeneration && cooling.retryAfterMs === 120_000 && !!cooling.brief);
  const coolingEmpty = keep(read(inspection({ state: { kind: 'NEEDS_GENERATION', row: row({ content: null, generatedAt: null }), fallback: null } }, { retryAfterMs: 90_000 })));
  check('…and a first-ever failure in cooldown → FAILED with nothing to show', coolingEmpty.state === 'FAILED' && coolingEmpty.brief === null && !coolingEmpty.needsGeneration);

  const noData = keep(read(inspection({ state: { kind: 'NEEDS_GENERATION', row: null, fallback: null } }, { hasData: false })));
  check('no accounts → NO_DATA, never a generation', noData.state === 'NO_DATA' && !noData.needsGeneration && noData.brief === null);

  const staleBalances = keep(read(inspection({ state: { kind: 'FRESH', row: row({ balancesAsOf: new Date('2026-08-17T23:41:39.276Z') }) } })));
  check('balances that have aged into STALE are flagged', staleBalances.brief?.balancesMayBeStale === true
    && staleBalances.brief.balancesAsOf === '2026-08-17T23:41:39.276Z');
  check('…and fresh ones are not', fresh.brief?.balancesMayBeStale === false);
}

console.log('\n2. POST — every lifecycle outcome');
{
  const post = (result: EnsureResult) => keep(responseFromEnsure({ spaceId: 'space_A', result, today: TODAY, now: NOW }));
  const t = { total: 1 };
  const fb = fallbackFrom(row(), TODAY, NOW);
  check('FRESH (cached or refreshed) → FRESH', post({ status: 'FRESH', path: 'WATERMARK_REFRESHED', brief: content as never, row: row(), timings: t }).state === 'FRESH');
  const generated = post({ status: 'GENERATED', brief: { ...content, generatedAt: '2026-09-13T11:59:00.000Z' } as never, persisted: true,
    correlationId: 'brief_secret', balancesAsOf: new Date('2026-09-13T06:00:00.000Z'), historyThrough: '2026-09-12', timings: t });
  check('GENERATED → FRESH with the new Brief', generated.state === 'FRESH' && generated.brief?.generatedAt === '2026-09-13T11:59:00.000Z');
  check('IN_PROGRESS → IN_PROGRESS with the fallback', post({ status: 'IN_PROGRESS', fallback: fb, timings: t }).brief !== null);
  const cooled = post({ status: 'COOLING_DOWN', retryAfterMs: 60_000, fallback: fb, timings: t });
  check('COOLING_DOWN → FAILED with retryAfterMs', cooled.state === 'FAILED' && cooled.retryAfterMs === 60_000 && !!cooled.brief);
  const failed = post({ status: 'FAILED', reason: 'REASON_SECRET', retryAfterMs: 180_000, fallback: null, timings: t });
  check('FAILED → FAILED, no reason text', failed.state === 'FAILED' && failed.brief === null && failed.retryAfterMs === 180_000);
  check('NO_DATA → NO_DATA', post({ status: 'NO_DATA', timings: t }).state === 'NO_DATA');
  check('generation responses carry no metrics', !('metrics' in generated));
}

console.log('\n3. nothing internal crosses');
{
  const FORBIDDEN_KEYS = ['sourceWatermark', 'materialDigest', 'generationStartedAt', 'correlationId', 'model', 'promptVersion',
    'evidence', 'lastFailureReason', 'lastFailedAt', 'ownerUserId', 'id', 'secretExtra', 'timings', 'payload', 'statedAs',
    'reason', 'persisted', 'row', 'fallback', 'decision', 'historyThrough', 'evidenceAsOf'];
  const FORBIDDEN_VALUES = ['wm-secret', 'dg-secret', 'brief_secret', 'owner_secret', 'REASON_SECRET', 'should-not-leak',
    'brief-prompt-secret', 'gpt-5.1', 'row_secret', 'freshness.needsReauth'];
  const leaks: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (FORBIDDEN_KEYS.includes(k)) leaks.push(`${path}.${k}`);
        walk(x, `${path}.${k}`);
      }
      return;
    }
    if (typeof v === 'string' && FORBIDDEN_VALUES.some((f) => v.includes(f))) leaks.push(`${path}=${v}`);
  };
  all.forEach((r, i) => walk(r, `response${i}`));
  check(`${all.length} responses, no internal key or value in any`, leaks.length === 0, leaks.slice(0, 6).join(', '));
  check('only the contract\'s top-level keys', all.every((r) => Object.keys(r).every((k) =>
    ['spaceId', 'state', 'brief', 'needsGeneration', 'retryAfterMs', 'metrics', 'checkedAt'].includes(k))));
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
