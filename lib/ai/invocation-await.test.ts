/**
 * lib/ai/invocation-await.test.ts  (IDEMP-009 / OBS-005)
 *
 * THE LEDGER WRITE IS AWAITED, AND A FAILED WRITE IS NEVER SILENT. Against the
 * real chokepoint with a fake client and a fake ledger: the row is on the ledger
 * before `generateWithTools` resolves (so before any HTTP response can); a
 * failing ledger is captured + counted + written to the durable signal, and the
 * turn still returns its answer; a failing FAILURE write still rethrows the
 * provider's own error; a success resets the count and clears the signal; the
 * pure verdict trips at the documented thresholds.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/invocation-await.test.ts
 */

import { generateWithTools, type StructuredClient } from './provider';
import { recordAiInvocation, recordAiInvocationFailure } from './invocation';
import {
  LEDGER_FAILURE_KEY, LEDGER_FAILURE_TRIP, LEDGER_CONSECUTIVE_TRIP, LEDGER_FAILURE_BUCKET_MS,
  consecutiveLedgerWriteFailures, ledgerUntrusted, onLedgerWriteFailure, resetLedgerHealthForTests,
  readLedgerWriteFailures, ledgerFailureBucket, noteLedgerWriteFailure, noteLedgerWriteSuccess,
} from '@/lib/platform/ai/ledger-health';
import { INFLIGHT_BUCKET_MS } from '@/lib/platform/ai/allowance-reservation';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const USAGE = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
const answering: StructuredClient = { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: USAGE }) } } };
const throwing: StructuredClient = { chat: { completions: { create: async () => { throw Object.assign(new Error('boom'), { status: 500 }); } } } };
const admitted = async () => ({ paused: false as const, state: 'MISSING' as const, raw: null });

/** A fake fm_system client: the ledger (slow or dead) and the RateLimit table the durable signal rides. */
function fakeSystem(opts: { ledger: 'ok' | 'slow' | 'dead' }) {
  const rows: Record<string, unknown>[] = [];
  const buckets = new Map<string, number>();
  const k = (key: string, w: Date) => `${key}@${w.toISOString()}`;
  const client = {
    aiInvocation: { create: async ({ data }: { data: Record<string, unknown> }) => {
      if (opts.ledger === 'dead') throw Object.assign(new Error('column "outcome" does not exist'), { code: 'P2022' });
      if (opts.ledger === 'slow') await new Promise((r) => setTimeout(r, 20));
      rows.push(data);
    } },
    rateLimit: {
      upsert: async ({ where, create }: { where: { key_windowStart: { key: string; windowStart: Date } }; create: { count: number } }) => {
        const kk = k(where.key_windowStart.key, where.key_windowStart.windowStart); const n = (buckets.get(kk) ?? 0) + create.count; buckets.set(kk, n); return { count: n };
      },
      deleteMany: async ({ where }: { where: { key: string } }) => { let n = 0; for (const kk of [...buckets.keys()]) if (kk.startsWith(`${where.key}@`)) { buckets.delete(kk); n++; } return { count: n }; },
      findMany: async ({ where }: { where: { key: string; windowStart: { in: Date[] } } }) =>
        where.windowStart.in.map((w) => ({ count: buckets.get(k(where.key, w)) ?? 0 })).filter((b) => b.count > 0),
    },
  };
  const durable = () => [...buckets.entries()].filter(([kk]) => kk.startsWith(`${LEDGER_FAILURE_KEY}@`)).reduce((n, [, c]) => n + c, 0);
  return { client, rows, durable };
}

async function main() {
  resetLedgerHealthForTests();
  console.log('1. the row is on the ledger BEFORE the chokepoint returns');
  {
    const sys = fakeSystem({ ledger: 'slow' });
    const out = await generateWithTools({ model: 'gpt-5.1', messages: [] }, { client: answering, sinks: { invocationClient: sys.client, paidRequestsAdmission: admitted } });
    check('a 20 ms write has landed when generateWithTools resolves (no settle, no tick)', out.content === 'ok' && sys.rows.length === 1 && sys.rows[0].outcome === 'RETURNED');
    check('a success leaves the process count at 0', consecutiveLedgerWriteFailures() === 0);
  }

  console.log('\n2. a dead ledger: captured, counted, durable signal written — and the turn still answers');
  {
    const sys = fakeSystem({ ledger: 'dead' });
    const seen: { consecutive: number; durableWritten: boolean }[] = [];
    const off = onLedgerWriteFailure((i) => seen.push(i));
    const out = await generateWithTools({ model: 'gpt-5.1', messages: [] }, { client: answering, sinks: { invocationClient: sys.client, paidRequestsAdmission: admitted } });
    check('the answer is returned (the cost is already incurred; the next turn is what the refusal protects)', out.content === 'ok');
    check('the failure was observed once, with consecutive=1 and the durable row written', seen.length === 1 && seen[0].consecutive === 1 && seen[0].durableWritten);
    check('the durable signal holds 1 in the hour bucket, nothing on the ledger', sys.durable() === 1 && sys.rows.length === 0);
    check('not yet untrusted: one failure is a blip', !ledgerUntrusted(sys.durable(), consecutiveLedgerWriteFailures()));

    let threw: unknown;
    await generateWithTools({ model: 'gpt-5.1', messages: [] }, { client: throwing, sinks: { invocationClient: sys.client, paidRequestsAdmission: admitted } }).catch((e) => { threw = e; });
    check('a failing FAILURE write still rethrows the provider\'s own error, unchanged', (threw as { status?: number })?.status === 500 && /boom/.test(String((threw as Error).message)));
    check(`after ${LEDGER_CONSECUTIVE_TRIP} consecutive failures this process reports the ledger UNTRUSTED`,
      consecutiveLedgerWriteFailures() === 2 && seen.length === 2 && ledgerUntrusted(sys.durable(), consecutiveLedgerWriteFailures()));
    off();
  }

  console.log('\n3. recovery');
  {
    const sys = fakeSystem({ ledger: 'ok' });
    // Seed the durable signal as the failing run above would have on the real table.
    await noteLedgerWriteFailure(new Error('x'), sys.client);
    check('precondition: process count 3, durable 1', consecutiveLedgerWriteFailures() === 3 && sys.durable() === 1);
    const ok = await recordAiInvocation({ provider: 'OPENAI', model: 'gpt-5.1', usage: USAGE, latencyMs: 1 }, sys.client);
    check('a successful write resolves true, resets the count and clears the durable signal', ok && consecutiveLedgerWriteFailures() === 0 && sys.durable() === 0 && sys.rows.length === 1);
    const ok2 = await recordAiInvocationFailure({ provider: 'OPENAI', model: 'gpt-5.1', outcome: 'FAILED', errorCode: '500', latencyMs: 1 }, sys.client);
    check('the failure writer resolves true too, and touches the signal only when recovering (no delete on a plain success)', ok2 && sys.rows.length === 2);
    await noteLedgerWriteSuccess(sys.client);
    check('noteLedgerWriteSuccess at 0 is a no-op', consecutiveLedgerWriteFailures() === 0);
  }

  console.log('\n4. the durable read, and the pure verdict');
  {
    resetLedgerHealthForTests();
    const sys = fakeSystem({ ledger: 'ok' });
    const now = new Date('2026-10-22T10:59:30.000Z');
    const dead = { ...sys.client, aiInvocation: { create: async () => { throw new Error('dead'); } } };
    for (let i = 0; i < LEDGER_FAILURE_TRIP; i++) await recordAiInvocation({ provider: 'OPENAI', model: 'gpt-5.1', usage: USAGE, latencyMs: 1 }, dead);
    check(`${LEDGER_FAILURE_TRIP} failed writes ⇒ the durable count reads ${LEDGER_FAILURE_TRIP} inside the window`, await readLedgerWriteFailures(sys.client, new Date()) === LEDGER_FAILURE_TRIP);
    check('…and trips the verdict on the durable signal alone (a fresh process, count 0)', ledgerUntrusted(LEDGER_FAILURE_TRIP, 0) && !ledgerUntrusted(LEDGER_FAILURE_TRIP - 1, 0));
    check('…or on the process count alone', ledgerUntrusted(0, LEDGER_CONSECUTIVE_TRIP) && !ledgerUntrusted(0, LEDGER_CONSECUTIVE_TRIP - 1));
    check('the bucket is the hour, the same bucket the in-flight counter uses', LEDGER_FAILURE_BUCKET_MS === INFLIGHT_BUCKET_MS && ledgerFailureBucket(now).toISOString() === '2026-10-22T10:00:00.000Z');
    check('two hours later the window has aged the signal out', await readLedgerWriteFailures(sys.client, new Date(Date.now() + 2 * LEDGER_FAILURE_BUCKET_MS)) === 0);
    check('a fake ledger with no rateLimit surface gets the process count only (no stray call)', await (async () => {
      resetLedgerHealthForTests();
      await noteLedgerWriteFailure(new Error('x'), { aiInvocation: { create: async () => {} } } as never);
      return consecutiveLedgerWriteFailures() === 1;
    })());
    resetLedgerHealthForTests();
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
