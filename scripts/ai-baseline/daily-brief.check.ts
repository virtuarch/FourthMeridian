/**
 * scripts/ai-baseline/daily-brief.check.ts
 *
 * THE DAILY BRIEF GOLDENS ON THE REAL MODEL — and one Brief on real data.
 *
 * ⚠️ LIVE, BILLED AND DELIBERATELY NOT A UNIT TEST. Every golden is one gpt-5.1
 * call over a pure fixture package (lib/ai/brief/fixtures.ts), recorded under
 * surface "harness" so it never counts as product traffic. The live section
 * reads the named Space through the same authorities the product will, writes
 * nothing but the invocation telemetry row, and checks that row.
 *
 * ⚠️ A GOLDEN FAILS ON WHAT THE MODEL TRIED, NOT ONLY ON WHAT SURVIVED. An
 * observation the licence dropped never reaches a user, but a model that invents
 * a figure is a finding: it is counted here as a failure even though the
 * delivered Brief is safe.
 *
 *   npm run ai:brief-check                       # goldens (3 samples each) + live
 *   BRIEF_SAMPLES=5 npm run ai:brief-check
 *   BRIEF_ONLY=goldens | live npm run ai:brief-check
 *   CHECK_SPACE_ID=<id> npm run ai:brief-check
 */

import '@/lib/ai/assemblers';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from '@/lib/db';
import { CHAT_MODEL } from '@/lib/ai/conversation/engine';
import { generateBriefFromPackage, type BriefGenerationResult } from '@/lib/ai/brief/generate';
import { generateDailyBrief, BriefScopeError } from '@/lib/ai/brief/daily-brief';
import { BRIEF_SCENARIOS, GLOBAL_FORBIDDEN, type BriefScenario } from '@/lib/ai/brief/fixtures';
import { approxTokens, serializePackage, BRIEF_SYSTEM_PROMPT } from '@/lib/ai/brief/prompt';
import { priceInvocation } from '@/lib/platform/ai/invocation-economics';

const SAMPLES = Math.max(1, Number(process.env.BRIEF_SAMPLES ?? 3));
const CONCURRENCY = Math.max(1, Number(process.env.BRIEF_CONCURRENCY ?? 4));
const ONLY = process.env.BRIEF_ONLY ?? 'all';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); }
}

const textOf = (r: BriefGenerationResult) => r.ok
  ? [r.brief.headline, ...r.brief.observations.flatMap((o) => [o.title, o.body])].join('\n')
  : '';

function score(s: BriefScenario, r: BriefGenerationResult): string[] {
  const out: string[] = [];
  if (!r.ok) return [`refused: ${r.reason} ${r.detail.join('; ')}`];
  const text = textOf(r);
  if (s.expect.quiet !== undefined && r.brief.quiet !== s.expect.quiet) out.push(`quiet=${r.brief.quiet}, expected ${s.expect.quiet}`);
  if (s.expect.mentionsAny && !s.expect.mentionsAny.some((re) => re.test(text))) out.push(`missing: ${s.expect.mentionsAny.map(String).join(' | ')}`);
  for (const re of s.expect.forbids ?? []) if (re.test(text)) out.push(`forbidden: ${re} ⇒ "${text.match(re)?.[0]}"`);
  if (s.expect.quietCeiling !== undefined) {
    if (r.brief.observations.length > s.expect.quietCeiling) out.push(`quiet day wrote ${r.brief.observations.length} observations (ceiling ${s.expect.quietCeiling})`);
    if (r.brief.observations.some((o) => o.importance === 'NOTABLE')) out.push('quiet day marked an observation NOTABLE');
  }
  for (const g of GLOBAL_FORBIDDEN) if (g.pattern.test(text)) out.push(`${g.name}: "${text.match(g.pattern)?.[0]}"`);
  for (const d of r.validation.droppedObservations) {
    out.push(`model ${d.reason}${d.figures ? ` ${d.figures.join(',')}` : ''} (observation ${d.index}, dropped)`);
  }
  return out;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i]); }
  }));
  return results;
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return { n: s.length, mean, p50: s[Math.floor(s.length / 2)] ?? 0, max: s[s.length - 1] ?? 0, min: s[0] ?? 0 };
};

async function goldens() {
  console.log(`GOLDENS — ${BRIEF_SCENARIOS.length} scenarios × ${SAMPLES} samples on ${CHAT_MODEL}`);
  console.log(`  system prompt ${BRIEF_SYSTEM_PROMPT.length} chars (~${approxTokens(BRIEF_SYSTEM_PROMPT)} tok)`);
  const jobs = BRIEF_SCENARIOS.flatMap((s) => Array.from({ length: SAMPLES }, (_, k) => ({ s, k })));
  const runs = await pool(jobs, CONCURRENCY, async ({ s, k }) => {
    const r = await generateBriefFromPackage(s.pkg, { model: CHAT_MODEL, surface: 'harness' });
    return { s, k, r, problems: score(s, r) };
  });

  const byScenario = new Map<string, typeof runs>();
  for (const run of runs) byScenario.set(run.s.id, [...(byScenario.get(run.s.id) ?? []), run]);

  for (const [id, rs] of byScenario) {
    const s = rs[0].s;
    const pkgJson = serializePackage(s.pkg);
    console.log(`\n── ${id} · ${s.title}  (package ${Buffer.byteLength(pkgJson)} B, ~${approxTokens(pkgJson)} tok)`);
    for (const { k, r, problems } of rs) {
      const tag = problems.length === 0 ? 'PASS' : 'FAIL';
      if (!r.ok) { console.log(`  [${k}] ${tag} ${r.reason}: ${r.detail.join('; ')}`); continue; }
      console.log(`  [${k}] ${tag} quiet=${r.brief.quiet}${r.validation.quietCorrected ? ' (reconciled)' : ''} obs=${r.brief.observations.length}  "${r.brief.headline}"`);
      for (const o of r.brief.observations) console.log(`        · ${o.kind}/${o.importance} ${o.title} — ${o.body}  [${o.evidence.join(', ')}]`);
      for (const p of problems) console.log(`        ✗ ${p}`);
    }
    const passed = rs.filter((x) => x.problems.length === 0).length;
    check(`${id}: ${passed}/${rs.length} samples pass`, passed === rs.length);
  }

  const ok = runs.filter((x) => x.r.ok).map((x) => x.r).filter((r): r is Extract<BriefGenerationResult, { ok: true }> => r.ok);
  const lat = stats(ok.map((r) => r.meta.latencyMs ?? 0));
  const inTok = stats(ok.map((r) => r.meta.usage?.promptTokens ?? 0));
  const cached = stats(ok.map((r) => r.meta.usage?.cachedPromptTokens ?? 0));
  const outTok = stats(ok.map((r) => r.meta.usage?.completionTokens ?? 0));
  const reason = stats(ok.map((r) => r.meta.usage?.reasoningTokens ?? 0));
  const cost = stats(ok.map((r) => r.meta.costUsd ?? 0));
  const pkgTok = stats(BRIEF_SCENARIOS.map((s) => approxTokens(serializePackage(s.pkg))));
  const pkgBytes = stats(BRIEF_SCENARIOS.map((s) => Buffer.byteLength(serializePackage(s.pkg))));
  console.log('\nGOLDEN TOTALS');
  console.log(`  runs ${runs.length}, accepted ${ok.length}, fully passing ${runs.filter((x) => x.problems.length === 0).length}`);
  console.log(`  licence drops ${runs.reduce((n, x) => n + (x.r.ok ? x.r.validation.droppedObservations.length : 0), 0)}`);
  console.log(`  quiet reconciled to importance on ${ok.filter((r) => r.validation.quietCorrected).length}/${ok.length}`);
  console.log(`  quiet=true on ${ok.filter((r) => r.brief.quiet).length}/${ok.length}; observations mean ${(ok.reduce((n, r) => n + r.brief.observations.length, 0) / (ok.length || 1)).toFixed(2)}`);
  console.log(`  package bytes min/mean/max ${pkgBytes.min}/${pkgBytes.mean.toFixed(0)}/${pkgBytes.max}; ~tokens ${pkgTok.min}/${pkgTok.mean.toFixed(0)}/${pkgTok.max}`);
  console.log(`  prompt tokens mean ${inTok.mean.toFixed(0)} (cached mean ${cached.mean.toFixed(0)}); completion mean ${outTok.mean.toFixed(0)} max ${outTok.max}; reasoning mean ${reason.mean.toFixed(0)} max ${reason.max}`);
  console.log(`  latency ms p50 ${lat.p50} mean ${lat.mean.toFixed(0)} max ${lat.max}`);
  console.log(`  cost/Brief USD mean ${cost.mean.toFixed(5)} min ${cost.min.toFixed(5)} max ${cost.max.toFixed(5)}; total ${ok.reduce((n, r) => n + (r.meta.costUsd ?? 0), 0).toFixed(4)}`);
  return runs.map(({ s, k, r, problems }) => ({ scenario: s.id, sample: k, problems, result: r }));
}

async function live() {
  const spaceId = process.env.CHECK_SPACE_ID ?? 'cmrrm846r000j7znwsl67gt1g';
  console.log(`\nLIVE — one Brief on real data (Space ${spaceId})`);
  const owner = await db.spaceMember.findFirstOrThrow({ where: { spaceId, role: 'OWNER', status: 'ACTIVE' } });

  let scopeRefused = false;
  try { await generateDailyBrief({ spaceId: 'space-that-does-not-exist', ownerUserId: owner.userId }); }
  catch (e) { scopeRefused = e instanceof BriefScopeError; }
  check('a Space the owner is not in is refused, never swapped for PERSONAL', scopeRefused);

  const t0 = Date.now();
  const run = await generateDailyBrief({ spaceId, ownerUserId: owner.userId });
  const totalMs = Date.now() - t0;
  const pkgJson = serializePackage(run.evidence.package);
  console.log(`  package ${Buffer.byteLength(pkgJson)} B, ~${approxTokens(pkgJson)} tok; degraded: [${run.evidence.degraded.join(', ')}]`);
  console.log(`  read timings ms ${JSON.stringify(run.evidence.timings)}`);
  console.log(`  end-to-end ${totalMs} ms (evidence + model + validation)`);
  console.log(`  PACKAGE ${JSON.stringify(run.evidence.package, null, 1)}`);

  const r = run.result;
  console.log(`  RESULT ${JSON.stringify(r, null, 1)}`);
  check('the live Brief was accepted', r.ok, r.ok ? undefined : `${r.reason}: ${r.detail.join('; ')}`);
  check('the package is for the named Space\'s day', run.evidence.package.identity.basis === 'CURRENT');
  if (r.ok) check('no observation was dropped by the licence', r.validation.droppedObservations.length === 0,
    JSON.stringify(r.validation.droppedObservations));

  await new Promise((res) => setTimeout(res, 1500)); // the invocation write is fire-and-forget
  const rows = await db.aiInvocation.findMany({ where: { correlationId: r.meta.correlationId } });
  check('exactly one AiInvocation row for the Brief', rows.length === 1, String(rows.length));
  const row = rows[0];
  if (row) {
    check('surface is brief, model gpt-5.1, no tools', row.surface === 'brief' && row.model === CHAT_MODEL && row.toolCallCount === 0);
    const priced = priceInvocation(row);
    console.log(`  AiInvocation: prompt ${row.promptTokens} (cached ${row.cachedPromptTokens}), completion ${row.completionTokens}, reasoning ${row.reasoningTokens}, latency ${row.latencyMs} ms, finish ${row.finishReason}`);
    console.log(`  priced from the ledger row: ${JSON.stringify(priced)}`);
    console.log(`  generator meta cost: ${r.meta.costUsd}`);
  }
  return { package: run.evidence.package, degraded: run.evidence.degraded, timings: run.evidence.timings, totalMs, result: r, invocation: row ?? null };
}

async function main() {
  const artifact: Record<string, unknown> = { model: CHAT_MODEL, at: new Date().toISOString(), samples: SAMPLES };
  if (ONLY !== 'live') artifact.goldens = await goldens();
  if (ONLY !== 'goldens') artifact.live = await live();

  const dir = process.env.BRIEF_ARTIFACT_DIR ?? path.join(os.tmpdir(), 'fm-daily-brief');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `daily-brief-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(artifact, null, 1));
  console.log(`\nartifact: ${file}`);
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
