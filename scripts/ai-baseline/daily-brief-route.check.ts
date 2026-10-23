/**
 * scripts/ai-baseline/daily-brief-route.check.ts
 *
 * THE DAILY BRIEF'S SERVER ENTRIES, AGAINST THE REAL DATABASE — and the routes'
 * refusals over real HTTP when a dev server is running.
 *
 *     npm run ai:brief-route-check
 *     BRIEF_ONLY=http|fixtures|live npm run ai:brief-route-check
 *     BRIEF_LIVE_REGENERATE=1 npm run ai:brief-route-check    # also regenerates the live Brief (one model call)
 *
 * ⚠️ WHAT A SCRIPT CANNOT DO. The route handlers need a request store for the
 * session, so a signed-in HTTP call is a browser dogfood. What runs here is
 * everything the handlers delegate to — `readBriefResponse` (GET, the page) and
 * `generateBriefResponse` (POST) — with the real Space resolution, the real store,
 * the real watermark and, in §3, the real model; plus the anonymous refusals of
 * both handlers over HTTP.
 *
 * ⚠️ WHAT IT WRITES. §2 creates throwaway users, Spaces and one account and deletes
 * them in a `finally`; its generator is a stub, so it spends nothing. §3 reads the
 * named real Space, bumps that Space's `updatedAt` (a harmless watermark change)
 * and — only with BRIEF_LIVE_REGENERATE=1 — deletes today's cached DailyBrief row
 * for its owner so two concurrent generation requests can race for real. No
 * financial row is touched anywhere.
 */

import '@/lib/ai/assemblers';
import { db } from '@/lib/db';
import type { BriefResponse } from '@/lib/brief-types';
import { basePackage } from '@/lib/ai/brief/fixtures';
import type { BriefGenerationResult } from '@/lib/ai/brief/generate';
import { GENERATION_FAILURE_COOLDOWN_MS } from '@/lib/ai/brief/policy';
import { generateBriefResponse, readBriefResponse } from '@/lib/ai/brief/view';
import { priceInvocation } from '@/lib/platform/ai/invocation-economics';
import { todayUTCISO } from '@/lib/time/clock';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}
const ONLY = process.env.BRIEF_ONLY ?? 'all';
const BASE = process.env.BRIEF_HTTP_BASE ?? 'http://localhost:3000';
const TAG = `brief-route-check-${Date.now()}`;

const INTERNALS = /sourceWatermark|materialDigest|generationStartedAt|correlationId|promptVersion|lastFailure|"model"|"evidence"|ownerUserId/;
const body = (r: Awaited<ReturnType<typeof readBriefResponse>>): BriefResponse => {
  if (!r.ok) throw new Error(`expected a body, got ${r.status}`);
  return r.body;
};

async function httpSection() {
  console.log('1. HTTP — the handlers refuse the anonymous');
  try {
    const get = await fetch(`${BASE}/api/brief?spaceId=any`, { signal: AbortSignal.timeout(60_000) });
    check('GET /api/brief without a session → 401', get.status === 401, String(get.status));
    const post = await fetch(`${BASE}/api/brief/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spaceId: 'any' }), signal: AbortSignal.timeout(60_000) });
    check('POST /api/brief/generate without a session → 401', post.status === 401, String(post.status));
  } catch (err) {
    console.log(`  (no dev server reachable at ${BASE} — HTTP refusals not exercised: ${(err as Error).message})`);
  }
}

async function fixtureSection() {
  console.log('\n2. FIXTURES — scope, no-data, cooldown and races on the real store (stub generator)');
  const [a, c] = await Promise.all(['a', 'c'].map((x) => db.user.create({ data: { email: `${TAG}-${x}@example.invalid` } })));
  const s1 = await db.space.create({ data: { name: `${TAG}-s1`, type: 'PERSONAL', category: 'PERSONAL', members: { create: [{ userId: a.id, role: 'OWNER' }] } } });
  const s2 = await db.space.create({ data: { name: `${TAG}-s2`, type: 'PERSONAL', category: 'PERSONAL', members: { create: [{ userId: c.id, role: 'OWNER' }] } } });
  const account = await db.financialAccount.create({ data: { ownerType: 'USER', ownerUserId: a.id, name: `${TAG} chk`, type: 'checking', institution: 'Check Bank', balance: 100 } });
  await db.spaceAccountLink.create({ data: { spaceId: s1.id, financialAccountId: account.id, kind: 'HOME', addedByUserId: a.id } });

  try {
    check('a Space the user is not in → 403 for GET and POST',
      !(await readBriefResponse(a.id, s2.id)).ok && !(await generateBriefResponse(a.id, s2.id)).ok);

    const empty = body(await readBriefResponse(c.id, s2.id));
    const emptyPost = body(await generateBriefResponse(c.id, s2.id));
    check('a Space with no accounts → NO_DATA on GET and POST, and no artifact row',
      empty.state === 'NO_DATA' && emptyPost.state === 'NO_DATA'
        && await db.dailyBrief.count({ where: { spaceId: s2.id } }) === 0);

    let generations = 0;
    let failing = true;
    let liquid = 18_920.4;
    const deps = {
      loadPackage: async () => {
        const pkg = basePackage();
        pkg.currentState.liquid = liquid;
        return { package: pkg, degraded: [], timings: {}, historyThrough: '2026-09-12' };
      },
      generate: async (pkg: ReturnType<typeof basePackage>, now: Date): Promise<BriefGenerationResult> => {
        generations++;
        await new Promise((r) => setTimeout(r, 200));
        const meta = { correlationId: `brief_route_check_${generations}`, surface: 'brief', model: 'stub', packageBytes: 1, packageApproxTokens: 1 };
        if (failing) return { ok: false, reason: 'PROVIDER_ERROR', detail: ['stub'], meta };
        return { ok: true, meta, validation: { droppedObservations: [], strippedEvidence: [], quietCorrected: false },
          brief: { headline: `Stub brief ${generations}`, quiet: true, observations: [], briefDay: todayUTCISO(now), generatedAt: now.toISOString(), evidenceAsOf: todayUTCISO(now) } };
      },
    };
    const t0 = Date.now();
    const at = (ms: number) => ({ now: new Date(t0 + ms), deps });

    const firstFail = body(await generateBriefResponse(a.id, s1.id, at(0)));
    check('a first-ever failure → FAILED, retryAfterMs = the cooldown, nothing to show',
      firstFail.state === 'FAILED' && firstFail.brief === null && firstFail.retryAfterMs === GENERATION_FAILURE_COOLDOWN_MS && generations === 1);
    const readDuring = body(await readBriefResponse(a.id, s1.id, at(5_000)));
    check('GET during the cooldown → FAILED, needsGeneration false', readDuring.state === 'FAILED' && !readDuring.needsGeneration
      && (readDuring.retryAfterMs ?? 0) > 0);
    for (const ms of [10_000, 30_000, 90_000]) await generateBriefResponse(a.id, s1.id, at(ms));
    check('three more POSTs inside the cooldown spend nothing', generations === 1);

    failing = false;
    const recovered = body(await generateBriefResponse(a.id, s1.id, at(GENERATION_FAILURE_COOLDOWN_MS + 5_000)));
    check('after the cooldown → FRESH with a generated Brief', recovered.state === 'FRESH' && recovered.brief?.headline === 'Stub brief 2' && generations === 2);
    const fresh = body(await readBriefResponse(a.id, s1.id, at(GENERATION_FAILURE_COOLDOWN_MS + 6_000)));
    check('GET then → FRESH, nothing to do', fresh.state === 'FRESH' && !fresh.needsGeneration);
    check('no internal leaves the server', !INTERNALS.test(JSON.stringify([firstFail, readDuring, recovered, fresh])));

    // A material change that fails keeps the old Brief on screen through the cooldown.
    liquid = 9_000;
    failing = true;
    await db.financialAccount.update({ where: { id: account.id }, data: { lastUpdated: new Date() } });
    const moved = body(await readBriefResponse(a.id, s1.id, at(GENERATION_FAILURE_COOLDOWN_MS + 10_000)));
    check('sources moved → CHECK_REQUIRED with the Brief still shown', moved.state === 'CHECK_REQUIRED' && moved.brief?.headline === 'Stub brief 2');
    const regenFail = body(await generateBriefResponse(a.id, s1.id, at(GENERATION_FAILURE_COOLDOWN_MS + 11_000)));
    check('a failed regeneration → FAILED with the old Brief kept', regenFail.state === 'FAILED' && regenFail.brief?.headline === 'Stub brief 2' && generations === 3);
    const heldAgain = body(await generateBriefResponse(a.id, s1.id, at(GENERATION_FAILURE_COOLDOWN_MS + 20_000)));
    check('…a retry inside the cooldown keeps it and spends nothing', heldAgain.state === 'FAILED' && heldAgain.brief?.headline === 'Stub brief 2' && generations === 3);

    // Tomorrow, two visitors at once: one generates, the other sees yesterday's Brief.
    failing = false;
    const tomorrow = { now: new Date(t0 + 86_400_000), deps };
    const race = await Promise.all([generateBriefResponse(a.id, s1.id, tomorrow), generateBriefResponse(a.id, s1.id, tomorrow)]);
    const states = race.map((r) => body(r).state).sort();
    check('two concurrent POSTs on a new day → one FRESH, one IN_PROGRESS', states.join() === 'FRESH,IN_PROGRESS', states.join());
    const loser = race.map(body).find((r) => r.state === 'IN_PROGRESS');
    check('…the loser shows yesterday\'s Brief, dated', loser?.brief?.fromPriorDay === true && loser.brief.headline === 'Stub brief 2');
    check('…one generation for the day', generations === 4);
  } finally {
    await db.spaceAccountLink.deleteMany({ where: { financialAccountId: account.id } });
    await db.financialAccount.deleteMany({ where: { id: account.id } });
    await db.space.deleteMany({ where: { id: { in: [s1.id, s2.id] } } });
    await db.user.deleteMany({ where: { id: { in: [a.id, c.id] } } });
  }
}

async function liveSection() {
  const spaceId = process.env.CHECK_SPACE_ID ?? 'cmrrm846r000j7znwsl67gt1g';
  console.log(`\n3. LIVE — the real Space ${spaceId}`);
  const owner = await db.spaceMember.findFirstOrThrow({ where: { spaceId, role: 'OWNER', status: 'ACTIVE' } });
  const invocations = () => db.aiInvocation.count({ where: { surface: 'brief' } });
  const before = await invocations();
  const timed = async <T>(fn: () => Promise<T>) => { const t = Date.now(); const r = await fn(); return { r, ms: Date.now() - t }; };

  const reads: number[] = [];
  let lastRead: BriefResponse | null = null;
  for (let i = 0; i < 3; i++) {
    const { r, ms } = await timed(() => readBriefResponse(owner.userId, spaceId));
    reads.push(ms);
    lastRead = body(r);
  }
  console.log(`  GET path: ${reads.join(' / ')} ms → ${lastRead?.state}${lastRead?.brief ? ` "${lastRead.brief.headline}"` : ''}`);
  check('the GET path spent no model call', await invocations() === before);
  check('the GET body carries metrics and no internals', !!lastRead && 'metrics' in lastRead && !INTERNALS.test(JSON.stringify(lastRead)));

  if (lastRead?.state === 'FRESH') {
    const cached = await timed(() => generateBriefResponse(owner.userId, spaceId));
    console.log(`  POST on a current Brief: ${cached.ms} ms → ${body(cached.r).state}`);
    check('POST on a current Brief → FRESH, no model call', body(cached.r).state === 'FRESH' && await invocations() === before);

    await db.$executeRaw`UPDATE "Space" SET "updatedAt" = now() WHERE id = ${spaceId}`;
    const moved = await timed(() => readBriefResponse(owner.userId, spaceId));
    const checked = await timed(() => generateBriefResponse(owner.userId, spaceId));
    console.log(`  after a harmless source change: GET ${moved.ms} ms → ${body(moved.r).state}; POST ${checked.ms} ms → ${body(checked.r).state}`);
    check('a harmless source change → CHECK_REQUIRED, then FRESH without a model call',
      body(moved.r).state === 'CHECK_REQUIRED' && body(checked.r).state === 'FRESH' && await invocations() === before);
  }

  if (process.env.BRIEF_LIVE_REGENERATE === '1') {
    const today = new Date(`${todayUTCISO()}T00:00:00.000Z`);
    const deleted = await db.dailyBrief.deleteMany({ where: { spaceId, ownerUserId: owner.userId, briefDay: today } });
    console.log(`  (deleted ${deleted.count} cached DailyBrief row for today to race a real generation)`);
    const absent = body(await readBriefResponse(owner.userId, spaceId));
    check('with no Brief today, GET asks for generation', absent.needsGeneration && ['ABSENT', 'STALE'].includes(absent.state), absent.state);
    const race = await timed(() => Promise.all([generateBriefResponse(owner.userId, spaceId), generateBriefResponse(owner.userId, spaceId)]));
    const states = race.r.map((x) => body(x).state).sort();
    console.log(`  two concurrent POSTs: ${race.ms} ms → ${states.join(', ')}`);
    await new Promise((res) => setTimeout(res, 1500));
    check('two concurrent POSTs → one FRESH, one IN_PROGRESS', states.join() === 'FRESH,IN_PROGRESS', states.join());
    check('…exactly one model call', await invocations() === before + 1);
    check('…exactly one row', await db.dailyBrief.count({ where: { spaceId, ownerUserId: owner.userId, briefDay: today } }) === 1);
    const inv = await db.aiInvocation.findFirst({ where: { surface: 'brief' }, orderBy: { occurredAt: 'desc' } });
    if (inv) console.log(`  generation: provider ${inv.latencyMs} ms, prompt ${inv.promptTokens} (cached ${inv.cachedPromptTokens}), completion ${inv.completionTokens}, cost ${JSON.stringify(priceInvocation(inv))}`);
    const after = body(await readBriefResponse(owner.userId, spaceId));
    console.log(`  headline: "${after.brief?.headline}"`);
    check('GET afterwards → FRESH', after.state === 'FRESH');
  }
}

async function main() {
  if (ONLY === 'all' || ONLY === 'http') await httpSection();
  if (ONLY === 'all' || ONLY === 'fixtures') await fixtureSection();
  if (ONLY === 'all' || ONLY === 'live') await liveSection();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
