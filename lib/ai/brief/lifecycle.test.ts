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
import { BRIEF_PROMPT_HASH, BRIEF_PROMPT_VERSION, ensureDailyBrief, inspectDailyBrief, type EnsureResult, type LifecycleDeps } from './lifecycle';
import { BRIEF_GENERATION_VERSION, GENERATION_FAILURE_COOLDOWN_MS, GENERATION_LEASE_MS } from './policy';
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
    fail: null as null | string, throwOnLoad: false, headline: 'Quiet day.',
    lastInput: null as BriefPackage | null, lastReason: undefined as string | undefined };
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
    generate: async (pkg, now, reason): Promise<BriefGenerationResult> => {
      state.generations++;
      state.lastInput = pkg;
      state.lastReason = reason;
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
  const inspect = (now: Date, over: Partial<LifecycleDeps> = {}) =>
    inspectDailyBrief({ spaceId: SPACE, ownerUserId: OWNER }, { now, deps: { ...deps, ...over } });
  return { store, state, ensure, inspect };
}

const headlineOf = (r: EnsureResult) => ('brief' in r ? r.brief.headline : null);
/** An IN_PROGRESS result that still carries a usable Brief to show. */
const loader = (r: EnsureResult) => r.status === 'IN_PROGRESS' && !!r.fallback?.usable && r.fallback.row.content !== null;
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
        && row.promptVersion === BRIEF_PROMPT_VERSION && /^brief-generation-\d+\+prompt-[0-9a-f]{12}$/.test(BRIEF_PROMPT_VERSION)
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
    const soon = await f.ensure(new Date(T0.getTime() + 61_000));
    check('…an immediate retry is held by the cooldown — no model call, the old Brief offered',
      soon.status === 'COOLING_DOWN' && f.state.generations === 2 && soon.retryAfterMs > 0
        && soon.fallback?.usable === true && (soon.fallback.row.content as { headline: string }).headline === 'Quiet day. #1');
    const later = await f.ensure(new Date(T0.getTime() + 60_000 + GENERATION_FAILURE_COOLDOWN_MS + 1_000));
    check('…and once the cooldown has passed the retry generates', later.status === 'GENERATED' && headlineOf(later) === 'Quiet day. #3');

    const e = harness();
    e.state.throwOnLoad = true;
    const origError = console.error; console.error = () => {};
    const exploded = await e.ensure(T0);
    console.error = origError;
    check('an assembly error after claiming fails cleanly and releases the claim',
      exploded.status === 'FAILED' && exploded.reason === 'INTERNAL_ERROR'
        && e.store.get(key('2026-09-13'))!.generationStartedAt === null);
    e.state.throwOnLoad = false;
    check('…the next caller within the cooldown is held', (await e.ensure(new Date(T0.getTime() + 1000))).status === 'COOLING_DOWN');
    check('…and after it can generate', (await e.ensure(new Date(T0.getTime() + GENERATION_FAILURE_COOLDOWN_MS + 5_000))).status === 'GENERATED');
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

  console.log('\n9. cooldown policy, no data, and inspection');
  {
    check('the failure cooldown is three minutes', GENERATION_FAILURE_COOLDOWN_MS === 180_000);

    const first = harness();
    first.state.fail = 'PROVIDER_ERROR';
    const failed = await first.ensure(T0);
    check('a first-ever failure → FAILED with the cooldown as retryAfterMs, nothing to show',
      failed.status === 'FAILED' && failed.retryAfterMs === GENERATION_FAILURE_COOLDOWN_MS && failed.fallback === null);
    for (let i = 1; i <= 5; i++) await first.ensure(new Date(T0.getTime() + i * 10_000));
    check('…five more visits inside the cooldown spend no further model call', first.state.generations === 1);
    const inspected = await first.inspect(new Date(T0.getTime() + 60_000));
    check('…and inspection reports how long until a retry', inspected.retryAfterMs > 0 && inspected.retryAfterMs <= GENERATION_FAILURE_COOLDOWN_MS - 59_000);

    const empty = harness();
    const none = await empty.ensure(T0, { hasFinancialData: async () => false });
    check('a Space with no accounts → NO_DATA: no claim, no package, no model call',
      none.status === 'NO_DATA' && empty.state.loads === 0 && empty.state.generations === 0 && empty.store.rows.size === 0);

    const i = harness();
    const before = await i.inspect(T0);
    check('inspecting an empty store claims, assembles and generates nothing',
      before.decision.state.kind === 'NEEDS_GENERATION' && i.state.loads === 0 && i.state.generations === 0 && i.store.rows.size === 0);
    await i.ensure(T0);
    const afterGen = await i.inspect(new Date(T0.getTime() + 60_000));
    check('after a generation, inspection sees FRESH', afterGen.decision.state.kind === 'FRESH' && i.state.loads === 1);
    i.state.watermark = 'wm-moved';
    const moved = await i.inspect(new Date(T0.getTime() + 90_000));
    check('a moved watermark is CHECK_MATERIAL — and inspection still assembled nothing',
      moved.decision.state.kind === 'CHECK_MATERIAL' && i.state.loads === 1 && i.state.generations === 1);
    await i.store.claim(key('2026-09-14'), new Date('2026-09-14T08:00:00.000Z'));
    const claimed = await i.inspect(new Date('2026-09-14T08:00:05.000Z'));
    check('a claim held by another request is visible to inspection', claimed.decision.claimActive && claimed.decision.state.kind === 'NEEDS_GENERATION');
  }

  console.log('\n10. relevance across days — standing facts are introduced once');
  {
    const r = harness();
    r.state.pkg.currentState.concentration = { classification: 'HIGHLY_CONCENTRATED', topSymbol: 'BTC', topWeightPct: 85,
      populationValue: 28440.27, populationIsComplete: false };
    const day1 = new Date('2026-09-13T08:00:00.000Z');
    await r.ensure(day1);
    check('day 1 (first Brief): the model sees the concentration, marked NEW; reason daily',
      r.state.lastInput?.currentState.concentration?.novelty === 'NEW' && r.state.lastReason === 'daily');
    const row1 = r.store.get(key('2026-09-13'))!;
    check('…the standing facts are persisted inside the artifact',
      (row1.content as { standingFacts?: { concentration?: { topSymbol?: string } } }).standingFacts?.concentration?.topSymbol === 'BTC');

    r.state.watermark = 'wm-same-day'; r.state.pkg.currentState.liquid = 9_000;
    await r.ensure(new Date('2026-09-13T15:00:00.000Z'));
    check('a same-day material regeneration keeps it NEW (judged against the previous DAY) — reason change',
      r.state.lastInput?.currentState.concentration?.novelty === 'NEW' && r.state.lastReason === 'change');

    await r.ensure(new Date('2026-09-14T08:00:00.000Z'));
    check('day 2, unchanged and a quiet market: the model does not see it at all',
      r.state.lastInput !== null && r.state.lastInput.currentState.concentration === undefined && r.state.lastReason === 'daily');
    check('…while the stored facts still carry it for tomorrow',
      (r.store.get(key('2026-09-14'))!.content as { standingFacts?: { concentration?: unknown } }).standingFacts?.concentration !== null);

    r.state.pkg.currentState.concentration = { ...r.state.pkg.currentState.concentration, topWeightPct: 97 };
    await r.ensure(new Date('2026-09-15T08:00:00.000Z'));
    check('day 3, weight 85% → 97%: eligible again, marked CHANGED', r.state.lastInput?.currentState.concentration?.novelty === 'CHANGED');
  }

  console.log('\n11. reconnect — re-evaluated through the watermark and digest, never forced');
  {
    const r = harness();
    r.state.pkg.freshness = { ...r.state.pkg.freshness!, band: 'VERY_STALE', oldestBalanceAgeDays: 26, needsReauth: true,
      staleSources: [{ label: 'Chase', state: 'NEEDS_RECONNECT', lastUpdated: '2026-08-18' }] };
    const t = (h: number) => new Date(T0.getTime() + h * 3_600_000);
    await r.ensure(t(0));
    check('the day\'s Brief is written over the connection that needs reconnecting', r.state.generations === 1
      && r.state.lastInput?.freshness?.staleSources?.[0]?.label === 'Chase');

    r.state.watermark = 'wm-reauth-attempt';   // a reconnect that failed: a row was touched, nothing material moved
    const failedAttempt = await r.ensure(t(1));
    check('A. a failed reconnect attempt → digest unchanged → no model call',
      failedAttempt.status === 'FRESH' && failedAttempt.path === 'WATERMARK_REFRESHED' && r.state.generations === 1);

    r.state.watermark = 'wm-reconnected';
    r.state.pkg.freshness = { ...r.state.pkg.freshness!, band: 'LIVE', oldestBalanceAgeDays: 0.1, needsReauth: false, staleSources: undefined };
    const reconnected = await r.ensure(t(2));
    check('B. a successful reconnect changes the evidence → exactly one regeneration, reason change',
      reconnected.status === 'GENERATED' && r.state.generations === 2 && r.state.lastReason === 'change');
    check('…and the model no longer sees a stale source', r.state.lastInput?.freshness?.staleSources === undefined);

    r.state.watermark = 'wm-post-sync';        // the history sync that follows touches rows again
    const settled = await r.ensure(t(3));
    check('C. the follow-up sync with nothing material → no second model call', settled.status === 'FRESH' && r.state.generations === 2);

    r.state.watermark = 'wm-same-state';
    r.state.pkg.freshness = { ...r.state.pkg.freshness!, oldestBalanceAgeDays: 0.4 };
    check('D. only the age moving inside its band is not material', (await r.ensure(t(4))).status === 'FRESH' && r.state.generations === 2);

    r.state.watermark = 'wm-two-tabs'; r.state.pkg.currentState.liquid = (r.state.pkg.currentState.liquid ?? 0) + 25_000; r.state.delayMs = 20;
    const [x, y] = await Promise.all([r.ensure(t(5)), r.ensure(t(5))]);
    check('E. two tabs return after the reconnect sync → one model call, the other IN_PROGRESS',
      r.state.generations === 3 && [x.status, y.status].sort().join(',') === 'GENERATED,IN_PROGRESS');
    r.state.delayMs = 0;

    r.state.watermark = 'wm-down'; r.state.pkg.currentState.liquid = (r.state.pkg.currentState.liquid ?? 0) + 25_000; r.state.fail = 'TIMEOUT';
    const down = await r.ensure(t(6));
    r.state.watermark = 'wm-down-again';
    const again = await r.ensure(new Date(t(6).getTime() + 30_000));
    check('F. a failed regeneration after a reconnect is cooled, not retried on every visit',
      down.status === 'FAILED' && again.status === 'COOLING_DOWN' && r.state.generations === 4);
  }

  console.log('\n12. the generation contract — valid evidence, outdated rules');
  {
    // If this fails, the prompt or output schema changed. Decide whether what a Brief
    // may say changed meaningfully: if so bump BRIEF_GENERATION_VERSION (policy.ts);
    // either way, update the pin. The version, not this hash, decides validity.
    check('the prompt/schema hash is pinned (review BRIEF_GENERATION_VERSION when it moves)',
      BRIEF_PROMPT_HASH === 'f649c8f6be8a', BRIEF_PROMPT_HASH);
    check('what a row stores is the intentional version plus the hash', BRIEF_PROMPT_VERSION === `${BRIEF_GENERATION_VERSION}+prompt-${BRIEF_PROMPT_HASH}`);

    const r = harness();
    const t = (m: number) => new Date(T0.getTime() + m * 60_000);
    const today = key('2026-09-13');
    const headline = () => (r.store.get(today)!.content as { headline: string }).headline;
    await r.ensure(t(0));
    const cached = await r.ensure(t(1));
    check('A. current version, same evidence → FRESH CACHED, no model call',
      cached.status === 'FRESH' && cached.path === 'CACHED' && r.state.generations === 1);

    r.store.get(today)!.promptVersion = 'brief-prompt-88fd92878b42';   // written before the contract was versioned
    const inspected = await r.inspect(t(2));
    check('B. older version, same watermark → not FRESH (CHECK_MATERIAL, generation not current), no model call',
      inspected.decision.state.kind === 'CHECK_MATERIAL' && !inspected.decision.state.generationCurrent && r.state.generations === 1);

    r.state.delayMs = 20;
    const [x, y] = await Promise.all([r.ensure(t(3)), r.ensure(t(3))]);
    r.state.delayMs = 0;
    const loser = [x, y].find((e) => e.status === 'IN_PROGRESS');
    check('D. two clients after the bump → exactly one model call, the other IN_PROGRESS',
      r.state.generations === 2 && [x.status, y.status].sort().join(',') === 'GENERATED,IN_PROGRESS');
    check('C. the loser keeps the older Brief to show meanwhile', !!loser && loader(loser));
    check('H + I. an equal watermark AND an equal digest did not suppress it; reason version', r.state.lastReason === 'version');
    check('F. the row now carries the current generation version', r.store.get(today)!.promptVersion === BRIEF_PROMPT_VERSION
      && headline() === 'Quiet day. #2');
    const after = await r.ensure(t(4));
    check('G. the next visit is FRESH CACHED, no model call', after.status === 'FRESH' && after.path === 'CACHED' && r.state.generations === 2);

    r.store.get(today)!.promptVersion = 'brief-generation-0+prompt-old';
    r.state.fail = 'TIMEOUT';
    const failed = await r.ensure(t(5));
    check('E. a failed version regeneration → FAILED, the older content kept', failed.status === 'FAILED'
      && headline() === 'Quiet day. #2' && r.state.generations === 3);
    const cooled = await r.ensure(t(6));
    check('…retried inside the cooldown → COOLING_DOWN, no model call (the digest check cannot save it)',
      cooled.status === 'COOLING_DOWN' && r.state.generations === 3);
    const coolInspect = await r.inspect(t(6));
    check('…and inspection reports the cooldown with the old Brief still in place',
      coolInspect.retryAfterMs > 0 && coolInspect.decision.state.kind === 'CHECK_MATERIAL');
    r.state.fail = null;
    const recovered = await r.ensure(new Date(t(5).getTime() + GENERATION_FAILURE_COOLDOWN_MS + 1_000));
    check('…after the cooldown it regenerates once and is current', recovered.status === 'GENERATED' && r.state.generations === 4
      && r.store.get(today)!.promptVersion === BRIEF_PROMPT_VERSION);
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
