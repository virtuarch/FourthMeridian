/**
 * scripts/ai-baseline/daily-brief-lifecycle.check.ts
 *
 * THE DAILY BRIEF ARTIFACT LIFECYCLE, AGAINST THE REAL DATABASE.
 *
 *     npm run ai:brief-lifecycle-check            # all sections
 *     BRIEF_ONLY=store|watermark|live npm run ai:brief-lifecycle-check
 *
 * ⚠️ NOT A `.test.ts`, AND NOT RUN BY CI — the memory-store check's reasoning:
 * atomicity is a property of Postgres under concurrency, and scoping is a property
 * of rows, so both can only be shown by writing them.
 *
 * ⚠️ WHAT IT WRITES. §1–§3 create throwaway users, Spaces, accounts, a
 * transaction, an instrument and a position observation, and delete every one of
 * them in a `finally`; no real user, Space or financial row is touched. §4 runs
 * the real lifecycle on the named Space: it may write TODAY'S DailyBrief row and
 * one AiInvocation (only if no Brief exists yet today), and it bumps that Space's
 * `updatedAt` timestamp — nothing else — to cause a harmless watermark change.
 */

import '@/lib/ai/assemblers';
import { assertCloneForDurableWrites } from '@/lib/ai/conversation/memory-write-policy';
import { db } from '@/lib/db';
import type { SpaceContext } from '@/lib/space';
import { basePackage } from '@/lib/ai/brief/fixtures';
import type { BriefGenerationResult } from '@/lib/ai/brief/generate';
import { ensureDailyBrief, type EnsureResult } from '@/lib/ai/brief/lifecycle';
import { GENERATION_LEASE_MS } from '@/lib/ai/brief/policy';
import { prismaBriefStore, type BriefCompletion } from '@/lib/ai/brief/store';
import { sourceWatermark } from '@/lib/ai/brief/watermark';
import { priceInvocation } from '@/lib/platform/ai/invocation-economics';
import { todayUTCISO } from '@/lib/time/clock';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}
const ONLY = process.env.BRIEF_ONLY ?? 'all';
const TAG = `brief-lifecycle-check-${Date.now()}`;
const DAY = '2026-09-13';

async function throwaway() {
  const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((x) => db.user.create({ data: { email: `${TAG}-${x}@example.invalid` } })));
  const s1 = await db.space.create({ data: { name: `${TAG}-s1`, type: 'PERSONAL', category: 'PERSONAL',
    members: { create: [{ userId: a.id, role: 'OWNER' }, { userId: b.id, role: 'MEMBER' }] } } });
  const s2 = await db.space.create({ data: { name: `${TAG}-s2`, type: 'PERSONAL', category: 'PERSONAL',
    members: { create: [{ userId: c.id, role: 'OWNER' }] } } });
  return { a: a.id, b: b.id, c: c.id, s1: s1.id, s2: s2.id };
}

async function cleanup(ids: { a: string; b: string; c: string; s1: string; s2: string }, accounts: string[], instruments: string[]) {
  await db.positionObservation.deleteMany({ where: { financialAccountId: { in: accounts } } });
  await db.transaction.deleteMany({ where: { financialAccountId: { in: accounts } } });
  await db.spaceAccountLink.deleteMany({ where: { financialAccountId: { in: accounts } } });
  await db.financialAccount.deleteMany({ where: { id: { in: accounts } } });
  await db.instrument.deleteMany({ where: { id: { in: instruments } } });
  await db.space.deleteMany({ where: { id: { in: [ids.s1, ids.s2] } } });   // cascades DailyBrief, SpaceMemory, members
  await db.user.deleteMany({ where: { id: { in: [ids.a, ids.b, ids.c] } } });
}

const completion = (headline: string, digest = 'dg-1'): BriefCompletion => ({
  content: { headline, quiet: true, observations: [], briefDay: DAY, generatedAt: new Date().toISOString(), evidenceAsOf: DAY },
  generatedAt: new Date(), balancesAsOf: new Date(), historyThrough: '2026-09-12',
  sourceWatermark: 'wm-1', materialDigest: digest, model: 'gpt-5.1', promptVersion: 'brief-prompt-check', correlationId: null,
});

async function storeSection() {
  console.log('1. THE STORE — claims against Postgres');
  const ids = await throwaway();
  try {
    const store = prismaBriefStore(db);
    const k = { spaceId: ids.s1, ownerUserId: ids.a, briefDay: DAY };
    const t0 = new Date();

    const race = await Promise.all(Array.from({ length: 8 }, () => store.claim(k, t0)));
    check('8 concurrent first-ever claims → exactly one winner', race.filter((r) => r.won).length === 1,
      `${race.filter((r) => r.won).length} won`);
    check('…and exactly one row', await db.dailyBrief.count({ where: { spaceId: ids.s1, ownerUserId: ids.a } }) === 1);
    const first = race.find((r) => r.won) as { won: true; token: Date };

    check('an active lease cannot be claimed', !(await store.claim(k, new Date(t0.getTime() + 30_000))).won);
    check('the winner completes', await store.complete(k, first.token, completion('first')));
    let row = await db.dailyBrief.findFirstOrThrow({ where: { spaceId: ids.s1, ownerUserId: ids.a } });
    check('success clears the claim and stores content',
      row.generationStartedAt === null && (row.content as { headline: string }).headline === 'first' && !!row.generatedAt);

    const regen = await store.claim(k, new Date(t0.getTime() + 1_000));
    check('a regeneration can claim a completed row', regen.won);
    check('failure releases it', regen.won && await store.fail(k, regen.token, 'TIMEOUT', new Date()));
    row = await db.dailyBrief.findFirstOrThrow({ where: { spaceId: ids.s1, ownerUserId: ids.a } });
    check('…the previous content survives, the failure is stamped',
      (row.content as { headline: string }).headline === 'first' && row.lastFailureReason === 'TIMEOUT' && row.generationStartedAt === null);
    const retry = await store.claim(k, new Date(t0.getTime() + 2_000));
    check('failure permits an immediate retry', retry.won);

    const late = new Date(t0.getTime() + 2_000 + GENERATION_LEASE_MS);
    const takeover = await Promise.all(Array.from({ length: 8 }, () => store.claim(k, late)));
    check('8 concurrent claims on an expired lease → exactly one winner', takeover.filter((r) => r.won).length === 1);
    const newWinner = takeover.find((r) => r.won) as { won: true; token: Date };
    check('the expired holder cannot complete over the new claimant',
      retry.won && !(await store.complete(k, retry.token, completion('stale'))));
    check('…the new claimant can', await store.complete(k, newWinner.token, completion('second', 'dg-2')));

    check('the key isolates the owner', (await store.claim({ ...k, ownerUserId: ids.b }, t0)).won);
    check('the key isolates the Space', (await store.claim({ ...k, spaceId: ids.s2 }, t0)).won);
    check('the key isolates the day', (await store.claim({ ...k, briefDay: '2026-09-14' }, t0)).won);
    check('four artifacts, one per key', await db.dailyBrief.count({ where: { spaceId: { in: [ids.s1, ids.s2] } } }) === 4);

    const read = await store.read({ spaceId: ids.s1, ownerUserId: ids.a }, '2026-09-14');
    check('read returns today\'s claimed row and the newest earlier Brief',
      read.todayRow?.briefDay === '2026-09-14' && read.todayRow.content === null
        && read.latestPrior?.briefDay === DAY && (read.latestPrior.content as { headline: string }).headline === 'second');
    check('refreshing the watermark needs the compared digest',
      !(await store.refreshWatermark(k, 'dg-1', 'wm-2')) && await store.refreshWatermark(k, 'dg-2', 'wm-2'));

    console.log('\n2. THE ORCHESTRATOR ON THE REAL STORE — two callers, one model call');
    let generations = 0;
    const pkg = basePackage();
    const deps = {
      store,
      resolveSpace: async (u: string, s: string) => ({ userId: u, spaceId: s }) as unknown as SpaceContext,
      watermark: async () => 'wm-race',
      loadPackage: async () => ({ package: pkg, degraded: [], timings: {}, historyThrough: '2026-09-12' }),
      generate: async (p: typeof pkg, now: Date): Promise<BriefGenerationResult> => {
        generations++;
        await new Promise((r) => setTimeout(r, 150));
        return { ok: true, validation: { droppedObservations: [], strippedEvidence: [], quietCorrected: false },
          meta: { correlationId: `brief_check_${generations}`, surface: 'brief', model: 'gpt-5.1', packageBytes: 1, packageApproxTokens: 1 },
          brief: { headline: 'raced', quiet: true, observations: [], briefDay: p.identity.briefDay, generatedAt: now.toISOString(), evidenceAsOf: p.identity.asOf } };
      },
    };
    const now = new Date();
    const results: EnsureResult[] = await Promise.all(Array.from({ length: 4 }, () =>
      ensureDailyBrief({ spaceId: ids.s2, ownerUserId: ids.c }, { now, deps })));
    const statuses = results.map((r) => r.status).sort();
    check('4 concurrent visits → one GENERATED, three IN_PROGRESS',
      statuses.join() === 'GENERATED,IN_PROGRESS,IN_PROGRESS,IN_PROGRESS', statuses.join());
    check('…exactly one model call', generations === 1);
    const cached = await ensureDailyBrief({ spaceId: ids.s2, ownerUserId: ids.c }, { now, deps });
    check('…and the next visit is served from the persisted row', cached.status === 'FRESH' && cached.path === 'CACHED' && generations === 1);
  } finally {
    await cleanup(ids, [], []);
  }
}

async function watermarkSection() {
  // FM-AUDIT-019 — this section seeds SpaceMemory rows, so it runs on a clone or not at all.
  console.log(`clone: ${assertCloneForDurableWrites()}`);
  console.log('\n3. THE WATERMARK — scoped to this Space and this owner');
  const ids = await throwaway();
  const accounts: string[] = [];
  const instruments: string[] = [];
  try {
    const fa1 = await db.financialAccount.create({ data: { ownerType: 'USER', ownerUserId: ids.a, name: `${TAG} chk`, type: 'checking', institution: 'Check Bank', balance: 100 } });
    const fa2 = await db.financialAccount.create({ data: { ownerType: 'USER', ownerUserId: ids.c, name: `${TAG} other`, type: 'checking', institution: 'Check Bank', balance: 500 } });
    accounts.push(fa1.id, fa2.id);
    await db.spaceAccountLink.create({ data: { spaceId: ids.s1, financialAccountId: fa1.id, kind: 'HOME', addedByUserId: ids.a } });
    await db.spaceAccountLink.create({ data: { spaceId: ids.s2, financialAccountId: fa2.id, kind: 'HOME', addedByUserId: ids.c } });

    const NOW = new Date();
    const wm = async () => sourceWatermark(db, { spaceId: ids.s1, ownerUserId: ids.a }, NOW);
    const w0 = await wm();
    check('unchanged sources → identical watermark', (await wm()).watermark === w0.watermark, `${w0.readMs} ms`);

    await db.spaceMemory.create({ data: { spaceId: ids.s1, ownerUserId: ids.b, kind: 'INTENTION', subject: 'b-goal',
      payload: { targetMetric: 'netWorth', targetAmount: 1, byDate: '2030-01-01' }, statedAs: 'b' } });
    check('another member\'s memory does NOT move the owner\'s watermark', (await wm()).watermark === w0.watermark);

    await db.financialAccount.update({ where: { id: fa2.id }, data: { balance: 900, lastUpdated: new Date() } });
    await db.transaction.create({ data: { financialAccountId: fa2.id, date: new Date(`${DAY}T00:00:00Z`), merchant: 'Elsewhere', category: 'Other', amount: -5 } });
    check('an unrelated Space\'s account and transaction do NOT move it', (await wm()).watermark === w0.watermark);

    await db.spaceMemory.create({ data: { spaceId: ids.s1, ownerUserId: ids.a, kind: 'INTENTION', subject: 'a-goal',
      payload: { targetMetric: 'netWorth', targetAmount: 2, byDate: '2030-01-01' }, statedAs: 'a' } });
    const w1 = (await wm()).watermark;
    check('the owner\'s own memory moves it', w1 !== w0.watermark);

    await db.financialAccount.update({ where: { id: fa1.id }, data: { balance: 150, lastUpdated: new Date() } });
    const w2 = (await wm()).watermark;
    check('a linked account\'s balance/clock moves it', w2 !== w1);

    await db.transaction.create({ data: { financialAccountId: fa1.id, date: new Date(`${DAY}T00:00:00Z`), merchant: 'Here', category: 'Other', amount: -12 } });
    const w3 = (await wm()).watermark;
    check('a transaction on a linked account moves it', w3 !== w2);

    const inst = await db.instrument.create({ data: { tickerSymbol: `${TAG.slice(-8)}`, name: TAG, assetClass: 'EQUITY' } });
    instruments.push(inst.id);
    const po = await db.positionObservation.create({ data: { financialAccountId: fa1.id, instrumentId: inst.id,
      date: new Date(`${DAY}T00:00:00Z`), quantity: 3, origin: 'OBSERVED', source: 'check' } });
    const w4 = await wm();
    check('an investment position moves it', w4.watermark !== w3);
    // A same-day holdings capture UPSERTS in place: no count or createdAt moves.
    await db.positionObservation.update({ where: { id: po.id }, data: { quantity: 4, institutionValue: 400 } });
    const w5 = await wm();
    check('a same-day position rewrite (quantity/value in place) moves it', w5.watermark !== w4.watermark);
    check('no secret is readable in it', !w4.watermark.includes(fa1.id) && !/150|Check Bank|a-goal/.test(w4.watermark)
      && /^brief-source-v3:[0-9a-f]{40}$/.test(w4.watermark));

    // A refresh-policy change moves health without any financial row — so it must move the watermark.
    const key = 'refresh_cadence_wallet';
    const original = await db.platformSetting.findUnique({ where: { key } });
    try {
      const before = (await wm()).watermark;
      await db.platformSetting.upsert({ where: { key }, update: { value: original?.value === '12h' ? '24h' : '12h' },
        create: { key, value: '12h' } });
      check('a WALLET refresh-cadence change moves it (no financial row changed)', (await wm()).watermark !== before);
    } finally {
      if (original) await db.platformSetting.update({ where: { key }, data: { value: original.value } });
      else await db.platformSetting.deleteMany({ where: { key } });
    }
  } finally {
    await cleanup(ids, accounts, instruments);
  }
}

async function liveSection() {
  const spaceId = process.env.CHECK_SPACE_ID ?? 'cmrrm846r000j7znwsl67gt1g';
  console.log(`\n4. LIVE — the real lifecycle on Space ${spaceId}`);
  const owner = await db.spaceMember.findFirstOrThrow({ where: { spaceId, role: 'OWNER', status: 'ACTIVE' } });
  const today = todayUTCISO();
  const dayDate = new Date(`${today}T00:00:00.000Z`);
  const where = { spaceId, ownerUserId: owner.userId, briefDay: dayDate };
  const rowsBefore = await db.dailyBrief.count({ where });
  const invocationsBefore = await db.aiInvocation.count({ where: { surface: 'brief' } });
  const now = new Date();   // one clock bucket for every call

  const call = async (label: string) => {
    const t0 = Date.now();
    const r = await ensureDailyBrief({ spaceId, ownerUserId: owner.userId }, { now });
    const ms = Date.now() - t0;
    console.log(`  ${label}: ${r.status}${'path' in r ? `/${r.path}` : ''} in ${ms} ms  timings ${JSON.stringify(r.timings)}`);
    return { r, ms };
  };

  const first = await call('visit 1');
  check(rowsBefore === 0 ? 'no Brief today → GENERATED' : 'a Brief already existed today → FRESH',
    rowsBefore === 0 ? first.r.status === 'GENERATED' : first.r.status === 'FRESH');
  if (first.r.status === 'GENERATED') console.log(`  headline: "${first.r.brief.headline}"`);
  await new Promise((res) => setTimeout(res, 1500));   // the invocation write is fire-and-forget

  const second = await call('visit 2');
  check('same day, nothing moved → FRESH from cache, no assembly',
    second.r.status === 'FRESH' && second.r.path === 'CACHED' && !('package' in second.r.timings));

  await db.$executeRaw`UPDATE "Space" SET "updatedAt" = now() WHERE id = ${spaceId}`;
  const third = await call('visit 3 (Space.updatedAt bumped)');
  check('a harmless source change → package assembled, digest equal, FRESH without a model call',
    third.r.status === 'FRESH' && third.r.path === 'WATERMARK_REFRESHED' && 'package' in third.r.timings && !('generate' in third.r.timings));

  const fourth = await call('visit 4');
  check('…and the refreshed watermark is a cache hit again', fourth.r.status === 'FRESH' && fourth.r.path === 'CACHED');

  await new Promise((res) => setTimeout(res, 1500));
  check('exactly one DailyBrief row for today, this owner and this Space', await db.dailyBrief.count({ where }) === 1);
  const generated = first.r.status === 'GENERATED' ? 1 : 0;
  const invocationsAfter = await db.aiInvocation.count({ where: { surface: 'brief' } });
  check('AiInvocation rows added = generations performed', invocationsAfter - invocationsBefore === generated,
    `${invocationsAfter - invocationsBefore} added, ${generated} generated`);

  if (first.r.status === 'GENERATED') {
    const inv = await db.aiInvocation.findFirst({ where: { correlationId: first.r.correlationId } });
    const row = await db.dailyBrief.findFirstOrThrow({ where });
    check('the row joins its invocation by correlation id', row.correlationId === first.r.correlationId && !!inv);
    if (inv) {
      console.log(`  generation: prompt ${inv.promptTokens} (cached ${inv.cachedPromptTokens}), completion ${inv.completionTokens}, reasoning ${inv.reasoningTokens}, provider ${inv.latencyMs} ms`);
      console.log(`  cost: ${JSON.stringify(priceInvocation(inv))}`);
    }
    console.log(`  row: generatedAt ${row.generatedAt?.toISOString()} balancesAsOf ${row.balancesAsOf?.toISOString()} historyThrough ${row.historyThrough?.toISOString().slice(0, 10)} model ${row.model} promptVersion ${row.promptVersion}`);
  }
}

async function main() {
  if (ONLY === 'all' || ONLY === 'store') await storeSection();
  if (ONLY === 'all' || ONLY === 'watermark') await watermarkSection();
  if (ONLY === 'all' || ONLY === 'live') await liveSection();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
