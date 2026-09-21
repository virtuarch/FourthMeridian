/**
 * scripts/ai-baseline/memory-store.check.ts
 *
 * MEMORY BEHAVIOUR, AGAINST A REAL DATABASE.
 *
 *     npm run ai:memory-check
 *
 * ⚠️ IT IS NOT A `.test.ts`, AND THE NAME IS THE HONEST PART. `run-tests.ts`
 * discovers `*.test.ts` and runs every one of them with no database — the whole
 * suite is pure by design, and this would have been the only file in it needing
 * a connection. Rather than make the pure tests depend on a local Postgres, or
 * leave a test in the suite that silently skips itself and reports green, this
 * is a named command. IT IS NOT RUN BY CI. Run it when the memory path changes.
 *
 * ⚠️ SEPARATE FROM THE PURE TESTS BECAUSE IT NEEDS A CONNECTION. What a payload
 * may mean is pure and pinned in lib/ai/conversation/memory-model.test.ts;
 * supersession, field-wise amendment, the drop guard, tombstones, ownership
 * isolation and a standalone planning figure are not properties of a payload,
 * they are properties of rows and a transaction, and can only be shown by
 * writing them.
 *
 * ⚠️ IT WRITES, AND IT CLEANS UP AFTER ITSELF. Two throwaway users and one
 * throwaway Space, deleted in a `finally` — the cascade from Space and User takes
 * the memories with it. NOTHING FINANCIAL IS TOUCHED: no account, no transaction,
 * no snapshot, no real user and no real Space is read or written.
 */

import { db } from '@/lib/db';
import { assertCloneForDurableWrites } from '@/lib/ai/conversation/memory-write-policy';
import {
  recallMemories, rememberStated, recordProjection, listOwnMemories, retireMemory, deleteMemoryChain,
  MemoryKind, MemoryStatus,
} from '@/lib/ai/conversation/memory-store';
import { readMemory, stateOf, composeMemoryLine, REMEMBERED, type TurnEvidence } from '@/lib/ai/conversation/memory-model';
import { selectMemoryPlans } from '@/lib/ai/conversation/starter-topics';
import { findTool } from '@/lib/ai/conversation/tools';

let failures = 0;
const check = (name: string, cond: boolean, detail?: string): void => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

/** Key-order-insensitive JSON: Postgres `jsonb` does not keep the order a payload was written in. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));

const TAG = `ai-baseline-memory-test-${Date.now()}`;
const TODAY = '2026-09-20';
const STRATEGY = { liquidFloorMonthsOfExpenses: 6, fractionOfExcess: 1, target: ['highest_apr', 'investments'] };

async function main(): Promise<void> {
  console.log('\nmemory store V2 — rules, amendment, the drop guard, retirement, ownership\n');
  // FM-AUDIT-019 — this check's PURPOSE is writing memory rows, so it runs on a clone or not at all.
  console.log(`clone: ${assertCloneForDurableWrites()}`);

  const alice = await db.user.create({ data: { email: `${TAG}-a@example.invalid` } });
  const bob   = await db.user.create({ data: { email: `${TAG}-b@example.invalid` } });
  const space = await db.space.create({
    data: { name: TAG, type: 'PERSONAL', category: 'PERSONAL',
      members: { create: [{ userId: alice.id, role: 'OWNER' },
                          { userId: bob.id,   role: 'MEMBER' }] } },
  });
  const A = { spaceId: space.id, ownerUserId: alice.id };
  const B = { spaceId: space.id, ownerUserId: bob.id };
  const active = async (kind: MemoryKind, subject: string) => (await recallMemories(A, { kind, subject }));

  try {
    // ── A rule lands as a rule ─────────────────────────────────────────────
    const rule = await rememberStated(A, { cls: 'RULE', subject: 'cash-strategy', fields: STRATEGY,
      statedAs: 'Keep six months of expenses, pay highest-APR debt first, then invest', statedAt: TODAY });
    check('a three-clause strategy is stored', rule.stored);
    const stored = (await active(MemoryKind.INTENTION, 'cash-strategy'))[0];
    check('…under INTENTION, class RULE, holding exactly the contract\'s clause',
      canon(stored?.payload) === canon({ v: 2, class: 'RULE', rule: STRATEGY }), JSON.stringify(stored?.payload));
    check('…with no dollar figure anywhere in the row', !/\d{3,}/.test(JSON.stringify(stored?.payload)));
    const sameAgain = await rememberStated(A, { cls: 'RULE', subject: 'cash-strategy', fields: STRATEGY, statedAs: 'Remember that.' });
    check('saying it again is not a change of mind: nothing is written', sameAgain.stored && sameAgain.unchanged === true
      && (await recallMemories(A, { kind: MemoryKind.INTENTION, subject: 'cash-strategy', includeSuperseded: true })).length === 1);

    // ── A standalone planning figure persists (the V1 anchor rule is replaced) ─
    const baseline = await rememberStated(A, { cls: 'BASELINE', subject: 'planning-spending',
      fields: { monthlySpending: 5000 }, statedAs: 'Use $5k monthly spending for planning', statedAt: TODAY });
    check('a planning figure with nothing to attach to IS stored', baseline.stored);
    const b = (await active(MemoryKind.ASSUMPTION, 'planning-spending'))[0];
    check('…stamped REMEMBERED / PLANNING by code — never one of the measured-baseline words',
      (b?.payload as { basis?: string; scope?: string })?.basis === REMEMBERED && (b?.payload as { scope?: string })?.scope === 'PLANNING');
    check('…and a caller cannot supply the stamp', !(await rememberStated(A, { cls: 'BASELINE', subject: 'other-figure',
      fields: { monthlySpending: 5000, basis: 'MEASURED' }, statedAs: 'x' })).stored);

    // ── Six → nine: the floor changes, the ordering survives ───────────────
    const nine = await rememberStated(A, { op: 'amend', subject: 'cash-strategy', set: { liquidFloorMonthsOfExpenses: 9 },
      statedAs: 'Actually make the cash buffer nine months', statedAt: TODAY });
    check('an amendment is stored and echoes what changed and what was kept', nine.stored
      && JSON.stringify(nine.changed) === '[{"field":"liquidFloorMonthsOfExpenses","from":6,"to":9}]'
      && canon(nine.kept) === canon({ fractionOfExcess: 1, target: ['highest_apr', 'investments'] }));
    const afterNine = await recallMemories(A, { kind: MemoryKind.INTENTION, subject: 'cash-strategy', includeSuperseded: true });
    const head = afterNine.find((r) => r.status === MemoryStatus.ACTIVE);
    check('exactly one ACTIVE rule, holding 9 AND the original ordering',
      afterNine.filter((r) => r.status === MemoryStatus.ACTIVE).length === 1
        && canon((head?.payload as { rule: unknown }).rule) === canon({ ...STRATEGY, liquidFloorMonthsOfExpenses: 9 }));
    check('…as a NEW row: the six-month version is kept, SUPERSEDED, and the chain points back to it',
      afterNine.length === 2 && afterNine.some((r) => r.status === MemoryStatus.SUPERSEDED && r.id === head?.supersedesId));
    check('an amendment that would leave an invalid rule is refused, naming what would remain', await (async () => {
      const r = await rememberStated(A, { op: 'amend', subject: 'cash-strategy', unset: ['liquidFloorMonthsOfExpenses'], statedAs: 'forget the six-month part' });
      return !r.stored && /would leave/.test(r.reason); })());
    check('amending a subject that holds nothing is refused, pointing at `record`', await (async () => {
      const r = await rememberStated(A, { op: 'amend', subject: 'no-such-thing', set: { liquidFloorMonthsOfExpenses: 9 }, statedAs: 'x' });
      return !r.stored && /nothing is remembered under/.test(r.reason); })());

    // ── Supersession never silently drops a field ──────────────────────────
    const lossy = await rememberStated(A, { cls: 'RULE', subject: 'cash-strategy', fields: { liquidFloorMonthsOfExpenses: 12 }, statedAs: 'twelve months' });
    check('a re-statement that would lose the ordering is REFUSED, and says to amend', !lossy.stored
      && /silently lose/.test(lossy.reason) && /op: "amend"/.test(lossy.reason) && /target/.test(lossy.reason));
    check('…and the version on record is untouched', (await active(MemoryKind.INTENTION, 'cash-strategy')).length === 1
      && ((await active(MemoryKind.INTENTION, 'cash-strategy'))[0].payload as { rule: { liquidFloorMonthsOfExpenses: number } }).rule.liquidFloorMonthsOfExpenses === 9);
    const replaced = await rememberStated(A, { cls: 'RULE', subject: 'cash-strategy', fields: { liquidFloorMonthsOfExpenses: 12 }, replace: true, statedAs: 'new plan: just keep twelve months' });
    check('with `replace: true` the loss is deliberate, and echoed', replaced.stored && JSON.stringify([...(replaced.dropped ?? [])].sort()) === '["fractionOfExcess","target"]');
    const clash = await rememberStated(A, { cls: 'GOAL', subject: 'cash-strategy', fields: { targetMetric: 'liquid', targetAmount: 28644.75 }, statedAs: 'nine months in cash' });
    check('a DIFFERENT class cannot replace a rule under its subject (the {liquid: 28644.75} defect)', !clash.stored && /already names a RULE/.test(clash.reason));
    const second = await rememberStated(A, { cls: 'RULE', subject: 'bonus-rule', fields: { surplusFraction: 0.5, target: 'investments' }, statedAs: 'half of what I save goes to investments' });
    check('a second rule is a second item, and the write echoes the other rule in force',
      second.stored && second.otherRulesInForce?.length === 1 && second.otherRulesInForce[0].subject === 'cash-strategy');

    // ── Retirement is a tombstone row ──────────────────────────────────────
    const retired = await rememberStated(A, { op: 'retire', subject: 'bonus-rule', statedAs: 'Stop doing that', statedAt: TODAY });
    const chain = await recallMemories(A, { kind: MemoryKind.INTENTION, subject: 'bonus-rule', includeSuperseded: true });
    check('"stop doing that" writes a tombstone: when, and in what words', retired.stored && chain.length === 2
      && chain.every((r) => r.status === MemoryStatus.RETIRED) && chain.some((r) => r.statedAs === 'Stop doing that'
        && canon(r.payload) === canon({ v: 2, class: 'RULE', retired: true })));
    check('…and no reader returns the item', (await active(MemoryKind.INTENTION, 'bonus-rule')).length === 0);
    const again = await rememberStated(A, { cls: 'RULE', subject: 'bonus-rule', fields: { surplusFraction: 0.25, target: 'investments' }, statedAs: 'ok, a quarter then' });
    const tombstone = chain.find((r) => readMemory(r).readable === false);
    check('a later re-statement supersedes the tombstone, so the chain is unbroken',
      again.stored && again.memory.supersedesId === tombstone?.id && again.superseded === null);

    // ── A coerced V1 row heals only by the user's own later statement ──────
    const legacy = await db.spaceMemory.create({ data: { ...A, kind: 'INTENTION', subject: 'cash-buffer',
      payload: { intent: 'keep-buffer', amount: 6, label: 'monthsOfExpenses' }, statedAs: 'Keep six months of expenses in cash' } });
    const rows = await recallMemories(A, { limit: 50 });
    check('a coerced V1 row is on record, unreadable, and reaches no reader', !readMemory(legacy).readable
      && !JSON.stringify(composeMemoryLine(rows, TODAY)).includes('monthsOfExpenses"')
      && selectMemoryPlans(rows, TODAY).intentions.every((i) => i.kind !== 'planned-expense'));
    const healed = await rememberStated(A, { cls: 'RULE', subject: 'cash-buffer', fields: { liquidFloorMonthsOfExpenses: 6 }, statedAs: 'Keep six months of expenses in cash' });
    check('…and a V2 statement on its subject supersedes it without destroying it', healed.stored && healed.superseded?.id === legacy.id
      && (await db.spaceMemory.findUnique({ where: { id: legacy.id } }))?.status === MemoryStatus.SUPERSEDED);

    // ── The provenance gate, through the store ─────────────────────────────
    const said = (userTexts: string[], ours: unknown[] = []): TurnEvidence => ({ userTexts, ours: () => ours });
    const derived = await rememberStated(A, { cls: 'GOAL', subject: 'net-worth-target', fields: { targetMetric: 'netWorth', targetAmount: 371875.2, byDate: '2029-09-30' },
      statedAs: 'Remember this.' }, { evidence: said(['Remember this.'], ['{"result":{"netWorth":371875.2}}']), asOf: TODAY });
    check('a figure we produced is not the user\'s goal', !derived.stored && /figure we produced/.test(derived.reason));
    check('nothing was written for it', (await active(MemoryKind.INTENTION, 'net-worth-target')).length === 0);
    const typed = await rememberStated(A, { cls: 'GOAL', subject: 'net-worth-target', fields: { targetMetric: 'netWorth', targetAmount: 1_000_000, byDate: '2030-12-31' },
      statedAs: 'I want to reach $1M by 2030' }, { evidence: said(['I want to reach $1M by 2030']), asOf: TODAY });
    check('a figure the user typed is', typed.stored);
    check('an amend never re-gates what it inherits', (await rememberStated(A, { op: 'amend', subject: 'net-worth-target', set: { byDate: '2031-12-31' },
      statedAs: 'make it 2031' }, { evidence: said(['make it 2031']), asOf: TODAY })).stored);
    check('with no conversation evidence a money value fails closed', !(await rememberStated(A, { cls: 'PLANNED_EXPENSE', subject: 'car',
      fields: { label: 'car', amount: 20000 }, statedAs: 'a car' }, { evidence: null, asOf: TODAY })).stored);

    // ── Ownership isolation ────────────────────────────────────────────────
    //
    // ⚠️ THE WHOLE POINT OF USER-OWNED-WITHIN-A-SPACE. Alice and Bob live in one
    // financial world and do not have one set of goals.
    check('another member of the same Space sees none of it', (await recallMemories(B)).length === 0);
    const bobsOwn = await rememberStated(B, { cls: 'RULE', subject: 'cash-strategy', fields: { liquidFloorMonthsOfExpenses: 3 }, statedAs: 'three months for me' });
    check('…and their own rule on the SAME subject supersedes nothing of the other\'s', bobsOwn.stored && bobsOwn.superseded === null
      && ((await active(MemoryKind.INTENTION, 'cash-strategy'))[0].payload as { rule: { liquidFloorMonthsOfExpenses: number } }).rule.liquidFloorMonthsOfExpenses === 12);
    check('…nor can they amend or retire it', !(await rememberStated(B, { op: 'retire', subject: 'net-worth-target', statedAs: 'x' })).stored);

    // ── A projection is a dated statement, written by code only ────────────
    const cp = await recordProjection(A, {
      subject: 'liquid-2026-12-31', metric: 'liquid', horizon: '2026-12-31', value: 38_243.5,
      basis: { spendingSource: 'OBSERVED', dailyRate: 142.9 },
      statedAs: 'Projected 38243.5 liquid (checking plus savings) for 2026-12-31.', statedAt: TODAY,
    });
    check('a projection with a horizon is stored by the code-only entry point', cp.stored);
    check('…and carries the date it was said on', cp.stored && cp.memory.statedAt.slice(0, 10) === TODAY);
    const cp2 = await recordProjection(A, { subject: 'liquid-2026-12-31', metric: 'liquid', horizon: '2026-12-31', value: 40_000,
      basis: { spendingSource: 'OBSERVED' }, statedAs: 'Projected 40000 liquid…', statedAt: TODAY });
    check('…one ACTIVE statement per horizon, the rest in its chain', cp2.stored
      && (await recallMemories(A, { kind: MemoryKind.CHECKPOINT })).length === 1);
    check('…and a basis key the code writer does not write is refused',
      !(await recordProjection(A, { subject: 'liquid-2027-06-30', metric: 'liquid', horizon: '2027-06-30', value: 1,
        basis: { surplusRule: 'all of it' }, statedAs: 'x', statedAt: TODAY })).stored);
    // memoryWrites: true — so the refusal below is the CHECKPOINT rule's, not the
    // read-only default's (a read-only context would pass this vacuously).
    const ctx = { spaceId: space.id, asOfISO: TODAY, spaceCtx: { userId: alice.id }, memoryWrites: true } as never;
    const minted = await findTool('remember')!.run({ subject: 'net-worth-2027-06-30', statedAs: 'a scenario result',
      kind: 'CHECKPOINT', payload: { metric: 'net-worth', horizon: '2027-06-30', value: 88617.84 } }, ctx) as { stored: boolean };
    check('…and the tool path cannot mint one', !minted.stored
      && (await recallMemories(A, { kind: MemoryKind.CHECKPOINT, includeSuperseded: true })).length === 2);

    // ── A stale planning figure can be re-affirmed ─────────────────────────
    //
    // ⚠️ "YES, STILL $5K" IS THE NEWEST THING THEY HAVE SAID ABOUT IT. A planning
    // figure goes stale on its age alone, so an identical re-statement is not a
    // repetition to be skipped — skipping it left the figure they had just
    // confirmed still reading as months old, and still shown to them as stale.
    const OLD = '2026-01-05';
    await rememberStated(A, { cls: 'BASELINE', subject: 'old-figure', fields: { monthlySpending: 5000 },
      statedAs: 'Use $5k monthly spending for planning', statedAt: OLD });
    const beforeRow = (await active(MemoryKind.ASSUMPTION, 'old-figure'))[0];
    const stateOfRow = (r: typeof beforeRow) => { const x = readMemory(r); return x.readable ? stateOf(r, x, TODAY) : 'UNREADABLE'; };
    check('a planning figure older than the staleness threshold reads as STALE', stateOfRow(beforeRow) === 'STALE');
    const reaffirmed = await rememberStated(A, { cls: 'BASELINE', subject: 'old-figure', fields: { monthlySpending: 5000 },
      statedAs: 'yes, still $5k', statedAt: TODAY });
    const afterRow = (await active(MemoryKind.ASSUMPTION, 'old-figure'))[0];
    check('re-affirming it writes a new version and moves its date',
      reaffirmed.stored && !('unchanged' in reaffirmed && reaffirmed.unchanged) && afterRow.statedAt.slice(0, 10) === TODAY
        && afterRow.id !== beforeRow.id, JSON.stringify(reaffirmed).slice(0, 140));
    check('…so it is no longer stale, and the earlier version is kept', stateOfRow(afterRow) === 'IN_FORCE'
      && (await recallMemories(A, { kind: MemoryKind.ASSUMPTION, subject: 'old-figure', includeSuperseded: true })).length === 2);
    const third = await rememberStated(A, { cls: 'BASELINE', subject: 'old-figure', fields: { monthlySpending: 5000 },
      statedAs: 'still five thousand', statedAt: TODAY });
    check('…while repeating a FRESH figure still writes nothing', third.stored && 'unchanged' in third && third.unchanged === true
      && (await recallMemories(A, { kind: MemoryKind.ASSUMPTION, subject: 'old-figure', includeSuperseded: true })).length === 2);

    // ── The owner's own surface: see, stop, erase ──────────────────────────
    const mine = await listOwnMemories(A, TODAY);
    check('the owner\'s listing is ACTIVE items only, each as a sentence — never a past version or a tombstone',
      mine.length > 0 && mine.every((m) => m.state !== 'SUPERSEDED' && m.state !== 'RETIRED')
        && mine.filter((m) => m.class === 'RULE').every((m) => (m.inWords ?? '').startsWith('Keep ') || (m.inWords ?? '').startsWith('Each month')));
    check('…and never another member\'s', (await listOwnMemories(B, TODAY)).every((m) => !mine.some((x) => x.id === m.id)));
    const strategyId = mine.find((m) => m.class === 'RULE' && /12 months/.test(m.inWords ?? ''))?.id ?? '';
    check('another member cannot retire or erase it by id — it is simply not found',
      (await retireMemory(B, strategyId)).ok === false && (await deleteMemoryChain(B, strategyId)).ok === false
        && (await listOwnMemories(A, TODAY)).some((m) => m.id === strategyId));
    const projectionId = mine.find((m) => m.class === 'PROJECTION')?.id ?? '';
    const stopProjection = await retireMemory(A, projectionId);
    check('a projection cannot be "stopped" — only erased', !stopProjection.ok && stopProjection.why === 'NOT_RETIRABLE');
    const stopped = await retireMemory(A, strategyId, TODAY);
    check('the owner retiring an item writes the same tombstone a conversation does', stopped.ok
      && (await recallMemories(A, { kind: MemoryKind.INTENTION, subject: 'cash-strategy', includeSuperseded: true }))
        .some((r) => r.status === MemoryStatus.RETIRED && r.statedAs === 'Retired by you in Memory.'));
    const before = await db.spaceMemory.count({ where: { ...A, kind: 'INTENTION', subject: 'cash-strategy' } });
    const anyVersion = (await recallMemories(A, { kind: MemoryKind.INTENTION, subject: 'cash-strategy', includeSuperseded: true }))[0];
    const erased = await deleteMemoryChain(A, anyVersion.id);
    check('erasing removes the item AND its whole history, in one statement', erased.ok && erased.erased === before && before >= 4
      && (await db.spaceMemory.count({ where: { ...A, kind: 'INTENTION', subject: 'cash-strategy' } })) === 0);
    check('…and nothing of the other member\'s same-named chain',
      (await db.spaceMemory.count({ where: { ...B, kind: 'INTENTION', subject: 'cash-strategy' } })) === 1);

    // ── Refusals, at the edges ─────────────────────────────────────────────
    check('a memory with no subject is refused',
      !(await rememberStated(A, { cls: 'RULE', subject: '   ', fields: STRATEGY, statedAs: 'x' })).stored);
    check('a memory with no words is refused',
      !(await rememberStated(A, { cls: 'RULE', subject: 's-one', fields: STRATEGY, statedAs: '' })).stored);

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
