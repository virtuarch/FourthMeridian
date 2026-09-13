/**
 * lib/ai/brief/lifecycle.test.ts
 *
 * ensureDailyBrief — cached, refreshed, regenerated, claimed, failed, recovered.
 *
 * The store here is in memory but keeps the Prisma store's contract exactly: the
 * claim is check-and-set with no await between the two (so it is as atomic under
 * Promise.all as the conditional UPDATE is under concurrency), and completion and
 * failure are fenced by the claim token. The real store's atomicity against
 * Postgres is proven by scripts/ai-baseline/daily-brief-lifecycle.check.ts.
 *
 * "Model calls" are counted at the generate seam; that one call writes exactly one
 * AiInvocation row is Slice 1's proven property (generate.test.ts §6).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/brief/lifecycle.test.ts
 */

import type { SpaceContext } from '@/lib/space';
import { todayUTCISO } from '@/lib/time/clock';
import { basePackage } from './fixtures';
import { materialDigest } from './digest';
import { BriefScopeError } from './errors';
import type { BriefGenerationResult } from './generate';
import { BRIEF_PROMPT_VERSION, ensureDailyBrief, type EnsureResult, type LifecycleDeps } from './lifecycle';
import { GENERATION_LEASE_MS } from './policy';
import type { BriefRow } from './state';
import type { BriefCompletion, BriefKey, BriefScope, BriefStore, ClaimResult } from './store';
import type { BriefPackage } from './types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

class MemoryStore implements BriefStore {
  rows = new Map<string, BriefRow>();
  private k = (s: BriefScope, day: string) => `${s.spaceId}|${s.ownerUserId}|${day}`;
  private tick = () => new Promise((r) => setImmediate(r));
  get(key: BriefKey) { return this.rows.get(this.k(key, key.briefDay)) ?? null; }

  async read(scope: BriefScope, today: string) {
    await this.tick();
    const todayRow = this.rows.get(this.k(scope, today));
    const prior = [...this.rows.values()]
      .filter((r) => r.spaceId === scope.spaceId && r.ownerUserId === scope.ownerUserId && r.briefDay < today && r.generatedAt)
      .sort((a, b) => b.briefDay.localeCompare(a.briefDay))[0];
    return { todayRow: todayRow ? structuredClone(todayRow) : null, latestPrior: prior ? structuredClone(prior) : null };
  }
  async claim(key: BriefKey, now: Date): Promise<ClaimResult> {
    await this.tick();
    const existing = this.rows.get(this.k(key, key.briefDay));
    const token = new Date(now.getTime());
    if (!existing) {
      this.rows.set(this.k(key, key.briefDay), {
        id: `row_${this.rows.size}`, ...key, content: null, generatedAt: null, balancesAsOf: null, historyThrough: null,
        sourceWatermark: null, materialDigest: null, model: null, promptVersion: null, correlationId: null,
        generationStartedAt: token, lastFailedAt: null, lastFailureReason: null,
      });
      return { won: true, token };
    }
    const s = existing.generationStartedAt;
    if (!s || now.getTime() - s.getTime() >= GENERATION_LEASE_MS) { existing.generationStartedAt = token; return { won: true, token }; }
    return { won: false };
  }
  async complete(key: BriefKey, token: Date, d: BriefCompletion) {
    await this.tick();
    const r = this.get(key);
    if (!r || r.generationStartedAt?.getTime() !== token.getTime()) return false;
    Object.assign(r, { ...d, generationStartedAt: null });
    return true;
  }
  async fail(key: BriefKey, token: Date, reason: string, at: Date) {
    await this.tick();
    const r = this.get(key);
    if (!r || r.generationStartedAt?.getTime() !== token.getTime()) return false;
    Object.assign(r, { generationStartedAt: null, lastFailedAt: at, lastFailureReason: reason });
    return true;
  }
  async refreshWatermark(key: BriefKey, digest: string, watermark: string) {
    await this.tick();
    const r = this.get(key);
    if (!r || !r.generatedAt || r.materialDigest !== digest) return false;
    r.sourceWatermark = watermark;
    return true;
  }
}

const SPACE = 'space_shared';
const OWNER = 'owner_A';
const T0 = new Date('2026-09-13T09:00:00.000Z');

function harness() {
  const store = new MemoryStore();
  const state = { watermark: 'wm-1', pkg: basePackage(), loads: 0, generations: 0, delayMs: 0,
    fail: null as null | string, throwOnLoad: false, headline: 'Quiet day.' };
  const withDay = (p: BriefPackage, day: string) => ({ ...structuredClone(p), identity: { ...p.identity, briefDay: day, asOf: day } });
  const deps: LifecycleDeps = {
    store,
    resolveSpace: async (ownerUserId, spaceId) => ({ userId: ownerUserId, spaceId, role: 'MEMBER', permissions: {},
      space: { id: spaceId, name: 'Household', type: 'SHARED', category: 'FAMILY', isPublic: false, reportingCurrency: 'USD' } }) as unknown as SpaceContext,
    watermark: async () => state.watermark,
    loadPackage: async (_ctx, now) => {
      state.loads++;
      if (state.throwOnLoad) throw new Error('assembly exploded');
      return { package: withDay(state.pkg, todayUTCISO(now)), degraded: [], timings: {}, historyThrough: '2026-09-12' };
    },
    generate: async (pkg, now): Promise<BriefGenerationResult> => {
      state.generations++;
      const n = state.generations;
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      const meta = { correlationId: `brief_${n}`, surface: 'brief', model: 'gpt-5.1', packageBytes: 1, packageApproxTokens: 1 };
      if (state.fail) return { ok: false, reason: state.fail as 'TIMEOUT', detail: ['boom'], meta };
      return { ok: true, meta, validation: { droppedObservations: [], strippedEvidence: [], quietCorrected: false },
        brief: { headline: `${state.headline} #${n}`, quiet: true, observations: [], briefDay: pkg.identity.briefDay,
          generatedAt: now.toISOString(), evidenceAsOf: pkg.identity.asOf } };
    },
  };
  const ensure = (now: Date, over: Partial<LifecycleDeps> = {}) =>
    ensureDailyBrief({ spaceId: SPACE, ownerUserId: OWNER }, { now, deps: { ...deps, ...over } });
  return { store, state, ensure };
}

const headlineOf = (r: EnsureResult) => ('brief' in r ? r.brief.headline : null);
const key = (day: string): BriefKey => ({ spaceId: SPACE, ownerUserId: OWNER, briefDay: day });

async function main() {
  console.log('1. first visit, then the same day');
  const h = harness();
  {
    const first = await h.ensure(T0);
    check('no Brief yet → GENERATED, one model call', first.status === 'GENERATED' && h.state.generations === 1 && h.state.loads === 1);
    const row = h.store.get(key('2026-09-13'))!;
    check('persisted with its provenance',
      !!row.generatedAt && row.content !== null && row.sourceWatermark === 'wm-1'
        && row.materialDigest === materialDigest({ ...basePackage(), identity: { ...basePackage().identity } })
        && row.promptVersion === BRIEF_PROMPT_VERSION && /^brief-prompt-[0-9a-f]{12}$/.test(BRIEF_PROMPT_VERSION)
        && row.model === 'gpt-5.1' && row.correlationId === 'brief_1' && row.historyThrough === '2026-09-12'
        && row.balancesAsOf?.toISOString() === basePackage().freshness!.oldestBalanceObservedAt
        && row.generationStartedAt === null);

    const again = await h.ensure(new Date(T0.getTime() + 60_000));
    check('same day, nothing moved → FRESH from cache', again.status === 'FRESH' && again.path === 'CACHED');
    check('…no package assembled, no model call', h.state.loads === 1 && h.state.generations === 1);
    check('…the stored Brief, unchanged', headlineOf(again) === 'Quiet day. #1');
  }

  console.log('\n2. sources moved, nothing material');
  {
    h.state.watermark = 'wm-2';
    h.state.pkg.currentState.netWorth = 128_470.10;         // cents of noise
    h.state.pkg.freshness!.oldestBalanceAgeDays = 0.7;       // a clock
    const r = await h.ensure(new Date(T0.getTime() + 120_000));
    check('→ FRESH via a refreshed watermark', r.status === 'FRESH' && r.path === 'WATERMARK_REFRESHED');
    check('…the package was assembled once, the model not called', h.state.loads === 2 && h.state.generations === 1);
    check('…the watermark was recorded, the content kept',
      h.store.get(key('2026-09-13'))!.sourceWatermark === 'wm-2' && headlineOf(r) === 'Quiet day. #1');
    const cached = await h.ensure(new Date(T0.getTime() + 180_000));
    check('…and the next visit is a plain cache hit again', cached.status === 'FRESH' && cached.path === 'CACHED' && h.state.loads === 2);
  }

  console.log('\n3. material change the same day');
  {
    h.state.watermark = 'wm-3';
    h.state.pkg.currentState.liquid = 12_000;
    const r = await h.ensure(new Date(T0.getTime() + 240_000));
    check('→ GENERATED, exactly one more model call', r.status === 'GENERATED' && h.state.generations === 2);
    check('…the package assembled once for both the digest and the generation', h.state.loads === 3);
    const row = h.store.get(key('2026-09-13'))!;
    check('…the content replaced in the same row', headlineOf(r) === 'Quiet day. #2'
      && (row.content as { headline: string }).headline === 'Quiet day. #2' && h.store.rows.size === 1);
  }

  console.log('\n4. the next UTC day');
  {
    const tomorrow = new Date('2026-09-14T08:00:00.000Z');
    const r = await h.ensure(tomorrow);
    check('a new day generates even though watermark and digest match yesterday',
      r.status === 'GENERATED' && h.state.generations === 3);
    check('…as a new row, yesterday\'s kept', h.store.rows.size === 2
      && (h.store.get(key('2026-09-13'))!.content as { headline: string }).headline === 'Quiet day. #2');
  }

  console.log('\n5. two callers at once');
  {
    const two = harness();
    two.state.delayMs = 25;
    const [a, b] = await Promise.all([two.ensure(T0), two.ensure(T0)]);
    const statuses = [a.status, b.status].sort();
    check('one generates, one is told it is in progress', statuses.join() === 'GENERATED,IN_PROGRESS', statuses.join());
    check('…one model call in total, and the loser assembled nothing', two.state.generations === 1 && two.state.loads === 1);
    check('…with no fallback on a first-ever Brief', [a, b].some((r) => r.status === 'IN_PROGRESS' && r.fallback === null));

    const withYesterday = harness();
    await withYesterday.ensure(new Date('2026-09-12T08:00:00.000Z'));
    withYesterday.state.delayMs = 25;
    const pair = await Promise.all([withYesterday.ensure(T0), withYesterday.ensure(T0)]);
    const loser = pair.find((r) => r.status === 'IN_PROGRESS');
    check('…and yesterday\'s Brief as the loser\'s dated fallback when there is one',
      loser?.status === 'IN_PROGRESS' && loser.fallback?.usable === true && loser.fallback.briefDay === '2026-09-12'
        && withYesterday.state.generations === 2);
  }

  console.log('\n6. the model fails');
  {
    const f = harness();
    await f.ensure(T0);
    f.state.watermark = 'wm-x';
    f.state.pkg.currentState.liquid = 9_000;
    f.state.fail = 'TIMEOUT';
    const failed = await f.ensure(new Date(T0.getTime() + 60_000));
    check('→ FAILED with the typed reason', failed.status === 'FAILED' && failed.reason === 'TIMEOUT');
    check('…today\'s older Brief offered as the fallback', failed.status === 'FAILED'
      && failed.fallback?.ageDays === 0 && failed.fallback.usable && (failed.fallback.row.content as { headline: string }).headline === 'Quiet day. #1');
    const row = f.store.get(key('2026-09-13'))!;
    check('…the old content preserved, the claim released, the failure stamped',
      (row.content as { headline: string }).headline === 'Quiet day. #1' && row.generationStartedAt === null
        && row.lastFailureReason === 'TIMEOUT' && !!row.lastFailedAt && row.sourceWatermark === 'wm-1');
    f.state.fail = null;
    const retry = await f.ensure(new Date(T0.getTime() + 61_000));
    check('…and an immediate retry succeeds', retry.status === 'GENERATED' && headlineOf(retry) === 'Quiet day. #3');

    const e = harness();
    e.state.throwOnLoad = true;
    const origError = console.error; console.error = () => {};
    const exploded = await e.ensure(T0);
    console.error = origError;
    check('an assembly error after claiming fails cleanly and releases the claim',
      exploded.status === 'FAILED' && exploded.reason === 'INTERNAL_ERROR'
        && e.store.get(key('2026-09-13'))!.generationStartedAt === null);
    e.state.throwOnLoad = false;
    check('…so the next caller can generate at once', (await e.ensure(new Date(T0.getTime() + 1000))).status === 'GENERATED');
  }

  console.log('\n7. a process that died holding the claim');
  {
    const d = harness();
    await d.store.claim(key('2026-09-13'), T0);            // the winner, then nothing
    const during = await d.ensure(new Date(T0.getTime() + 10_000));
    check('within the lease → IN_PROGRESS, no model call', during.status === 'IN_PROGRESS' && d.state.generations === 0);
    const after = await d.ensure(new Date(T0.getTime() + GENERATION_LEASE_MS));
    check('once the lease expires → the next caller generates', after.status === 'GENERATED' && d.state.generations === 1);

    const fence = new MemoryStore();
    const k = key('2026-09-13');
    const first = await fence.claim(k, T0);
    const second = await fence.claim(k, new Date(T0.getTime() + GENERATION_LEASE_MS + 1));
    const done = { content: {}, generatedAt: T0, balancesAsOf: null, historyThrough: null, sourceWatermark: 'w',
      materialDigest: 'd', model: 'm', promptVersion: 'p', correlationId: null };
    check('the expired winner cannot complete over the new claimant',
      first.won && second.won && !(await fence.complete(k, first.token, done)) && (await fence.complete(k, second.token, done)));
  }

  console.log('\n8. scope');
  {
    const s = harness();
    let refused = false;
    try {
      await s.ensure(T0, { resolveSpace: async (u) => ({ userId: u, spaceId: 'personal_fallback' }) as unknown as SpaceContext });
    } catch (err) { refused = err instanceof BriefScopeError; }
    check('a Space the owner is not in is refused, never swapped for PERSONAL', refused && s.state.generations === 0);
    await s.ensure(T0);
    await s.ensure(T0, { resolveSpace: async (_u, sp) => ({ userId: 'owner_B', spaceId: sp }) as unknown as SpaceContext });
    check('the same Space for another member is a separate artifact',
      s.store.rows.size === 2 && !!s.store.get({ spaceId: SPACE, ownerUserId: 'owner_B', briefDay: '2026-09-13' })
        && s.state.generations === 2);
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
