/**
 * scripts/ai-baseline/memory-store.check.ts
 *
 * MEMORY BEHAVIOUR, AGAINST THE REAL DATABASE.
 *
 *     npm run ai:memory-check
 *
 * ⚠️ IT IS NOT A `.test.ts`, AND THE NAME IS THE HONEST PART. `run-tests.ts`
 * discovers `*.test.ts` and runs every one of them with no database — the whole
 * suite is pure by design, and this would have been the only file in it needing
 * a connection. Rather than make 495 pure tests depend on a local Postgres, or
 * leave a test in the suite that silently skips itself and reports green, this
 * is a named command. IT IS NOT RUN BY CI. Run it when the memory path changes.
 *
 * ⚠️ SEPARATE FROM baseline.test.ts BECAUSE IT NEEDS A CONNECTION. The shape
 * rules are pure and pinned there; supersession, ownership isolation and the
 * assumption-attachment rule are not properties of a payload, they are
 * properties of two rows and a transaction, and they can only be shown by
 * writing them.
 *
 * ⚠️ IT WRITES, AND IT CLEANS UP AFTER ITSELF. Two throwaway users and one
 * throwaway Space, created in a transaction and deleted in a `finally` — the
 * cascade from Space and User takes the memories with it. NOTHING FINANCIAL IS
 * TOUCHED: no account, no transaction, no snapshot, no real user, and no real
 * Space is read or written. `SpaceMemory` is the only table this file can reach.
 */

import { db } from '@/lib/db';
import {
  recallMemories, rememberMemory, MemoryKind, MemoryStatus,
} from '@/lib/ai/conversation/memory-store';

let failures = 0;
const check = (name: string, cond: boolean, detail?: string): void => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const TAG = `ai-baseline-memory-test-${Date.now()}`;

async function main(): Promise<void> {
  console.log('\nmemory store — supersession, ownership, attachment\n');

  const alice = await db.user.create({ data: { email: `${TAG}-a@example.invalid` } });
  const bob   = await db.user.create({ data: { email: `${TAG}-b@example.invalid` } });
  const space = await db.space.create({
    data: { name: TAG, type: 'PERSONAL', category: 'PERSONAL',
      members: { create: [{ userId: alice.id, role: 'OWNER' },
                          { userId: bob.id,   role: 'MEMBER' }] } },
  });
  const A = { spaceId: space.id, ownerUserId: alice.id };
  const B = { spaceId: space.id, ownerUserId: bob.id };

  try {
    // ── An intention lands ─────────────────────────────────────────────────
    const first = await rememberMemory(A, {
      kind: MemoryKind.INTENTION, subject: 'net-worth-target',
      payload: { targetMetric: 'netWorth', targetAmount: 1_000_000, byDate: '2030-12-31' },
      statedAs: 'I want to reach $1M by 2030',
    });
    check('an intention is stored', first.stored);
    check('…as the first of its subject, superseding nothing',
      first.stored && first.superseded === null);

    // ── §12.18 — a second statement supersedes the first ───────────────────
    const second = await rememberMemory(A, {
      kind: MemoryKind.INTENTION, subject: 'net-worth-target',
      payload: { targetMetric: 'netWorth', targetAmount: 750_000, byDate: '2030-12-31' },
      statedAs: 'make it $750K, 1M was optimistic',
    });
    check('a later statement on the same subject supersedes the earlier one',
      second.stored && second.superseded?.statedAs === 'I want to reach $1M by 2030');

    const active = await recallMemories(A, { kind: MemoryKind.INTENTION });
    check('…and recall returns exactly one ACTIVE memory for the subject',
      active.length === 1 && (active[0].payload as { targetAmount: number }).targetAmount === 750_000,
      String(active.length));

    // ⚠️ SUPERSESSION ALWAYS CREATES A NEW RECORD (product decision). Nothing is
    // edited in place, so the chain remembers that $1M was ever said.
    const all = await recallMemories(A, { kind: MemoryKind.INTENTION, includeSuperseded: true });
    check('§12.19 — the superseded record is kept and retrievable', all.length === 2);
    check('…and the chain points backwards from new to old',
      all[0].supersedesId === all[1].id && all[1].status === MemoryStatus.SUPERSEDED);

    // ── Ownership isolation ────────────────────────────────────────────────
    //
    // ⚠️ THE WHOLE POINT OF USER-OWNED-WITHIN-A-SPACE. Alice and Bob share one
    // financial world and not one set of goals.
    check('another member of the same Space sees none of it',
      (await recallMemories(B)).length === 0);
    const bobsOwn = await rememberMemory(B, {
      kind: MemoryKind.INTENTION, subject: 'net-worth-target',
      payload: { targetMetric: 'netWorth', targetAmount: 250_000, byDate: '2029-12-31' },
      statedAs: 'mine is 250k by 2029',
    });
    check('…and their own intention on the SAME subject supersedes nothing of the other\'s',
      bobsOwn.stored && bobsOwn.superseded === null);
    check('…leaving each with exactly one active target',
      (await recallMemories(A, { kind: MemoryKind.INTENTION })).length === 1
        && (await recallMemories(B, { kind: MemoryKind.INTENTION })).length === 1);

    // ── A standalone assumption does not persist ───────────────────────────
    const orphan = await rememberMemory(A, {
      kind: MemoryKind.ASSUMPTION, subject: 'summer-2027-spending',
      payload: { monthlySpending: 6_000 }, statedAs: 'assume I spend 6k',
    });
    check('an assumption with nothing to attach to is refused', !orphan.stored);
    check('…and the refusal says to record the decision first',
      !orphan.stored && /no active intention or checkpoint/.test(orphan.reason));

    const attached = await rememberMemory(A, {
      kind: MemoryKind.ASSUMPTION, subject: 'net-worth-target',
      payload: { annualReturnPct: 8, appliesTo: 'investments' },
      statedAs: 'assume 8% a year',
    });
    check('…while one attached to an existing intention is stored', attached.stored);
    check('…without disturbing the intention it belongs to',
      (await recallMemories(A, { kind: MemoryKind.INTENTION })).length === 1);

    // ── A checkpoint is a dated statement, never a balance ─────────────────
    const cp = await rememberMemory(A, {
      kind: MemoryKind.CHECKPOINT, subject: 'cash-2026-12-31',
      payload: { metric: 'cash', horizon: '2026-12-31', value: 38_243.5,
        basis: { spendingSource: 'OBSERVED', dailyRate: 142.9 } },
      statedAs: 'you are tracking toward about $38.2K by year end',
    });
    check('a checkpoint with a horizon is stored', cp.stored);
    check('…and carries the date it was said on',
      cp.stored && typeof cp.memory.statedAt === 'string' && cp.memory.statedAt.length >= 10);
    const noHorizon = await rememberMemory(A, {
      kind: MemoryKind.CHECKPOINT, subject: 'cash-now',
      payload: { metric: 'cash', value: 12_382.81 }, statedAs: 'you have $12,382.81',
    });
    check('…and one without a horizon is refused, because that is a balance',
      !noHorizon.stored);

    // ── Refusals, at the edges ─────────────────────────────────────────────
    check('a memory with no subject is refused',
      !(await rememberMemory(A, { kind: MemoryKind.INTENTION, subject: '   ',
        payload: { intent: 'purchase', amount: 1, label: 'x' }, statedAs: 'x' })).stored);
    check('a memory with no words is refused',
      !(await rememberMemory(A, { kind: MemoryKind.INTENTION, subject: 's',
        payload: { intent: 'purchase', amount: 1, label: 'x' }, statedAs: '' })).stored);

    // ── Nothing financial was written ──────────────────────────────────────
    check('the Space still holds no accounts, transactions or snapshots',
      (await db.spaceAccountLink.count({ where: { spaceId: space.id } })) === 0
        && (await db.spaceSnapshot.count({ where: { spaceId: space.id } })) === 0);
  } finally {
    await db.space.delete({ where: { id: space.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    const leftover = await db.spaceMemory.count({ where: { spaceId: space.id } });
    check('teardown cascades the memories away', leftover === 0, String(leftover));
    await db.$disconnect();
  }

  console.log(failures === 0 ? '\nAll memory-store checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures ? 1 : 0);
}

void main();
