/**
 * lib/ai/conversation/memory-isolation.test.ts — FM-AUDIT-019
 *
 * Dogfood / evaluation tooling must not silently mutate durable user memory.
 *
 *   1. the policy — read-only by default; writes only on an explicit opt-in that
 *      also proves a clone; any other value, or the live database, refuses;
 *   2. the write paths — `remember` refuses and the projection checkpoint no-ops
 *      unless the context carries `memoryWrites: true`;
 *   3. who turns it on — ONLY the product chat route passes a literal `true`; every
 *      harness either passes its policy's verdict or nothing (read-only), and every
 *      check whose purpose is writing memory asserts a clone first;
 *   4. fail closed, for real — the actual `ai:chat` entry, opted in against a
 *      database named `fintracker`, exits non-zero BEFORE any read (its URL is
 *      unreachable, so nothing could have been touched); the memory-store check
 *      pointed at live throws before writing.
 *
 * Standalone tsx script. No DB.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

delete process.env.DATABASE_URL;

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
process.on('unhandledRejection', (err) => {
  if (/Prisma/.test((err as { constructor?: { name?: string } })?.constructor?.name ?? '')) return;
  console.error('  ✗ unexpected unhandled rejection:', String(err)); process.exit(1);
});

const LIVE = 'postgresql://u:p@127.0.0.1:1/fintracker';
const CLONE = 'postgresql://u:p@127.0.0.1:1/fintracker_dogfood_a';
const UNKNOWN = 'postgresql://u:p@db.example.com:5432/prod';

async function main(): Promise<void> {
  const {
    harnessMemoryPolicy, assertCloneForDurableWrites, durableMemoryWritesAllowed, HARNESS_MEMORY_ENV,
  } = await import('./memory-write-policy');

  // ── 1. policy ────────────────────────────────────────────────────────────
  console.log('1. the harness policy');
  const p = (env: Record<string, string | undefined>) => harnessMemoryPolicy(env as NodeJS.ProcessEnv);
  check('unset ⇒ READ-ONLY (the default — never a write by accident)', ((r) => 'writes' in r && r.writes === false)(p({ DATABASE_URL: LIVE })));
  check('clone-only against a clone ⇒ writes, naming the clone',
    ((r) => 'writes' in r && r.writes === true && r.basis === 'CLONE_OPT_IN' && r.database === 'fintracker_dogfood_a')(p({ [HARNESS_MEMORY_ENV]: 'clone-only', DATABASE_URL: CLONE })));
  check('clone-only against LIVE ⇒ REFUSED', ((r) => 'refusal' in r && /LIVE/.test(r.refusal))(p({ [HARNESS_MEMORY_ENV]: 'clone-only', DATABASE_URL: LIVE })));
  check('clone-only against an unidentifiable database ⇒ REFUSED', 'refusal' in p({ [HARNESS_MEMORY_ENV]: 'clone-only', DATABASE_URL: UNKNOWN }));
  check('clone-only with no database URL ⇒ REFUSED', 'refusal' in p({ [HARNESS_MEMORY_ENV]: 'clone-only' }));
  check('a typo ("yes", "true", "1") never silently means "write"', ['yes', 'true', '1'].every((v) => 'refusal' in p({ [HARNESS_MEMORY_ENV]: v, DATABASE_URL: CLONE })));
  check('a purpose-built writer asserts a clone: throws on live / unknown / unset, passes a clone',
    [LIVE, UNKNOWN, undefined].every((u) => { try { assertCloneForDurableWrites({ DATABASE_URL: u } as unknown as NodeJS.ProcessEnv); return false; } catch { return true; } })
      && assertCloneForDurableWrites({ DATABASE_URL: CLONE } as unknown as NodeJS.ProcessEnv) === 'fintracker_dogfood_a');
  check('only an explicit `true` permits a write', durableMemoryWritesAllowed({ memoryWrites: true })
    && !durableMemoryWritesAllowed({}) && !durableMemoryWritesAllowed({ memoryWrites: false }));

  // ── 2. write paths ───────────────────────────────────────────────────────
  console.log('2. the write paths honour it');
  const { findTool } = await import('./tools');
  const readOnly = { spaceId: 's', asOfISO: '2026-09-21', spaceCtx: { userId: 'u' } } as never;
  const r = await findTool('remember')!.run({ subject: 'nw-goal', statedAs: 'I want $1M by 2030',
    goal: { targetMetric: 'netWorth', targetAmount: 1_000_000, byDate: '2030-12-31' } }, readOnly) as { stored: boolean; reason: string };
  check('remember in a context without memoryWrites: stored:false, and it says nothing was saved',
    r.stored === false && /durable memory writes are disabled/.test(r.reason), JSON.stringify(r));
  const r2 = await findTool('remember')!.run({ subject: 'x', statedAs: 'x', rule: { liquidFloorMonthsOfExpenses: 6 } },
    { ...(readOnly as object), memoryWrites: false } as never) as { stored: boolean };
  check('…and with memoryWrites:false', r2.stored === false);
  const tools = readFileSync('lib/ai/conversation/memory-tools.ts', 'utf8');
  const rememberRun = tools.slice(tools.indexOf("name: 'remember'"));
  check('remember checks the policy FIRST — before any shape, gate or store call',
    rememberRun.indexOf('durableMemoryWritesAllowed(ctx)') > -1
      && rememberRun.indexOf('durableMemoryWritesAllowed(ctx)') < rememberRun.indexOf('rememberStated('));
  const cp = tools.slice(tools.indexOf('export async function checkpointProjection'));
  check('the projection checkpoint no-ops in a read-only context, before it builds a statement',
    cp.indexOf('if (!durableMemoryWritesAllowed(ctx)) return null;') > -1
      && cp.indexOf('if (!durableMemoryWritesAllowed(ctx)) return null;') < cp.indexOf('recordProjection('));
  const { checkpointProjection } = await import('./memory-tools');
  check('…and returns null for a checkpointable result', (await checkpointProjection(readOnly, 'project_cash', {
    projection: { endingCash: 1000 }, horizon: { to: '2026-12-31' } })) === null);

  // ── 3. who turns it on ───────────────────────────────────────────────────
  console.log('3. only the product route enables writes literally');
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (['node_modules', '.next', 'prototype'].includes(e.name) ? [] : walk(path.join(dir, e.name)))
      : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);
  const literal = /memoryWrites:\s*true/;
  const enablers = ['lib', 'app', 'components', 'jobs', 'scripts'].flatMap(walk).filter((f) => literal.test(readFileSync(f, 'utf8')));
  const WRITER_CHECKS = ['scripts/ai-baseline/memory-store.check.ts', 'scripts/ai-baseline/applied-facts.check.ts'];
  // The engine's conditional pass-through (`args.memoryWrites === true ? { memoryWrites: true } : {}`)
  // forwards a caller's verdict and is pinned on its own below; it enables nothing itself.
  const PASS_THROUGH = 'lib/ai/conversation/engine.ts';
  check('the literal `memoryWrites: true` appears ONLY in the chat route and the clone-asserting write checks',
    enablers.every((f) => f === 'app/api/ai/chat/route.ts' || f === PASS_THROUGH || WRITER_CHECKS.includes(f))
      && enablers.includes('app/api/ai/chat/route.ts'),
    enablers.join(', '));
  for (const f of [...WRITER_CHECKS, 'scripts/ai-baseline/daily-brief-lifecycle.check.ts']) {
    check(`${path.basename(f)} asserts a clone before it writes`, /assertCloneForDurableWrites\(\)/.test(readFileSync(f, 'utf8')));
  }
  const turnHarnesses = walk('scripts').filter((f) => /openTranscript\(|runStatelessTurn\(/.test(readFileSync(f, 'utf8')));
  check('every harness that runs turns passes its policy verdict or nothing (read-only) — never a literal true',
    turnHarnesses.length >= 4 && turnHarnesses.every((f) => {
      const src = readFileSync(f, 'utf8');
      return !literal.test(src) && (!/memoryWrites/.test(src) || /memoryWrites: (args\.memoryWrites === true|memory\.writes)/.test(src) || /harnessMemoryPolicy\(/.test(src));
    }), turnHarnesses.join(', '));
  const entry = readFileSync('scripts/ai-conversation-baseline.ts', 'utf8');
  check('ai:chat / ai:baseline decide the policy before any Space is read',
    entry.indexOf('harnessMemoryPolicy()') > -1 && entry.indexOf('harnessMemoryPolicy()') < entry.indexOf('await resolveSpace('));
  const engine = readFileSync('lib/ai/conversation/engine.ts', 'utf8');
  check('the engine enables writes only when told to (absent ⇒ read-only)',
    /\.\.\.\(args\.memoryWrites === true \? \{ memoryWrites: true \} : \{\}\)/.test(engine));

  // ── 4. fail closed, for real ─────────────────────────────────────────────
  console.log('4. the real entry points refuse before touching anything');
  const tsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const base = { ...process.env }; delete base.DATABASE_URL; delete base.DIRECT_URL; delete base.FM_DB_GUARD;
  const chat = spawnSync(tsx, ['--require', './scripts/lib/server-only-preload.cjs', 'scripts/ai-conversation-baseline.ts', '--interactive'],
    { cwd: process.cwd(), input: '', encoding: 'utf8', timeout: 60_000,
      env: { ...base, [HARNESS_MEMORY_ENV]: 'clone-only', DATABASE_URL: LIVE } as NodeJS.ProcessEnv });
  check('`ai:chat` opted in against a database named fintracker exits non-zero with the refusal, before any read',
    chat.status !== 0 && /asks to write durable memory/.test(chat.stderr) && !/Space:/.test(chat.stdout),
    `status=${chat.status} ${chat.stderr.slice(0, 200)}`);
  const store = spawnSync(tsx, ['--require', './scripts/lib/server-only-preload.cjs', 'scripts/ai-baseline/memory-store.check.ts'],
    { cwd: process.cwd(), input: '', encoding: 'utf8', timeout: 60_000, env: { ...base, DATABASE_URL: LIVE } as NodeJS.ProcessEnv });
  check('the memory-store check pointed at live refuses before writing a row',
    store.status !== 0 && /REFUSING TO RUN: this check writes durable memory rows/.test(store.stderr + store.stdout),
    `status=${store.status} ${(store.stderr + store.stdout).slice(0, 200)}`);

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall memory isolation checks passed');
  process.exit(0);
}

main().catch((e) => { console.error('  ✗ crashed:', e instanceof Error ? e.stack : String(e)); process.exit(1); });
