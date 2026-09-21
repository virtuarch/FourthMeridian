/**
 * lib/ai/conversation/memory-store.ts
 *
 * THE ONLY WRITE PATH IN THE HARNESS — and it can reach exactly one table.
 *
 * ⚠️ EVERY OTHER TOOL IS READ-ONLY AND A TEST ASSERTS IT. That test did not get
 * weakened to let this through; it gained a named, narrow exception. This file
 * is the whole exception: it may touch `db.spaceMemory` and nothing else, which
 * a source scan enforces. No financial row can be created, updated or deleted
 * from anywhere in the harness, including here.
 *
 * ── What memory is for, and what it is demonstrably not for ─────────────────
 * Clip 6 proved conversational continuity does NOT need memory: after eliding a
 * tool payload fifteen turns old, the model understood the reference from the
 * surviving prose and re-fetched. So this is not for understanding. It is for
 * the two things re-fetching cannot reconstruct — what the user DECIDED, and
 * what we SAID, when, on what basis.
 *
 * ── The invariant, enforced by shape rather than by rule ────────────────────
 * Memory may hold goals, plans, standing rules, planning figures and dated
 * statements. It may NEVER hold current financial truth. WHAT a row may mean is
 * decided by the pure model beside this file (`memory-model.ts`): semantic
 * classes with closed, typed field sets, so there is no field in which "current
 * cash" could be stored — not because somebody remembered not to, but because
 * no such field exists in any class. This file is the I/O: it finds the current
 * version, asks the model whether the write is valid and admissible, and writes
 * one new row.
 *
 * ── Every change of mind is a row ───────────────────────────────────────────
 * Nothing is edited in place. A re-statement, a field-wise amendment and a
 * retirement each create ONE row that points at the version it replaces, so
 * "six months, then nine, then stop" is three rows and a chain. Retirement is a
 * tombstone row — when it was withdrawn and in what words — with no column added.
 * Only the owner, through their own panel, can erase a chain.
 *
 * ── Ownership (product decision, 2026-09-08) ────────────────────────────────
 * Memory is USER-OWNED WITHIN A SPACE. The Space identifies the financial world;
 * the user identifies whose intention it is. `ownerUserId` is required, and every
 * function here takes `{spaceId, ownerUserId}` as ONE argument, so no query shape
 * exists that returns, retires or erases another member's rows.
 */

import { db } from '@/lib/db';
import { MemoryKind, MemoryStatus } from '@prisma/client';
import {
  MEMORY_VERSION, KIND_OF_CLASS, MAX_WORDS_CHARS, EXAMPLES, SHAPE_KEY,
  validateShape, validateFields, admitWrite, mergeAmend, droppedFields, readMemory, stateOf,
  describeMemory, toPayload, tombstonePayload, expectedFrom, validSubject,
  type StatedClass, type MemoryClass, type Fields, type FieldChange, type TurnEvidence, type MemoryState,
} from './memory-model';

export { MemoryKind, MemoryStatus };

// ── Reading ──────────────────────────────────────────────────────────────────

export interface MemoryScope { spaceId: string; ownerUserId: string }

export interface RecallArgs {
  kind?:              MemoryKind;
  subject?:           string;
  includeSuperseded?: boolean;
  limit?:             number;
}

const MAX_RECALL = 50;

export interface RecalledMemory {
  id: string; kind: MemoryKind; subject: string; status: MemoryStatus;
  payload: unknown; statedAs: string; statedAt: string;
  appliesFrom: string | null; appliesTo: string | null;
  supersedesId: string | null;
}

type Row = Awaited<ReturnType<typeof db.spaceMemory.findFirstOrThrow>>;

const present = (r: Row): RecalledMemory => ({
  id: r.id, kind: r.kind, subject: r.subject, status: r.status,
  payload: r.payload, statedAs: r.statedAs,
  statedAt: r.statedAt.toISOString(),
  appliesFrom: r.appliesFrom?.toISOString() ?? null,
  appliesTo:   r.appliesTo?.toISOString() ?? null,
  supersedesId: r.supersedesId,
});

/**
 * The authenticated user's own memories, newest statement first — RAW rows.
 *
 * ⚠️ THE SCOPE IS NOT A FILTER THE CALLER MAY OMIT. `spaceId` and `ownerUserId`
 * are one argument, required together, so no query shape exists that returns
 * another member's intentions.
 *
 * ⚠️ RAW ON PURPOSE. What a row MEANS is `readMemory`'s answer, and every reader
 * asks it; this returns what is stored.
 */
export async function recallMemories(
  scope: MemoryScope, args: RecallArgs = {},
): Promise<RecalledMemory[]> {
  const rows = await db.spaceMemory.findMany({
    where: {
      spaceId: scope.spaceId,
      ownerUserId: scope.ownerUserId,
      ...(args.kind ? { kind: args.kind } : {}),
      ...(args.subject ? { subject: args.subject } : {}),
      ...(args.includeSuperseded ? {} : { status: MemoryStatus.ACTIVE }),
    },
    orderBy: [{ statedAt: 'desc' }, { createdAt: 'desc' }],
    take: Math.min(Math.max(args.limit ?? 20, 1), MAX_RECALL),
  });
  return rows.map(present);
}

// ── Writing what the user stated ─────────────────────────────────────────────

export type StatedOp = 'record' | 'amend' | 'retire';

export interface StatedWrite {
  op?:       StatedOp;
  /** Required for `record`. For `amend` / `retire` it is read off the current version. */
  cls?:      StatedClass;
  subject:   string;
  statedAs:  string;
  /** `record`: the item's fields, whole. */
  fields?:   Fields;
  /** `amend`: fields to set, and fields to remove. Everything else is kept. */
  set?:      Fields;
  unset?:    readonly string[];
  /** `record` over an existing item that would lose fields: true says the user replaced the whole thing. */
  replace?:  boolean;
  appliesFrom?: string;
  appliesTo?:   string;
  /**
   * When the statement was made. Defaults to the database clock.
   *
   * ⚠️ THE CONVERSATION'S CLOCK, NOT POSTGRES'S, IS WHAT A STATEMENT MEANS. A
   * projection made "standing at 2026-09-08" must carry that date, or a
   * reconciliation compares a statement against a basis from a different day.
   */
  statedAt?: string;
}

/**
 * The provenance gate's inputs. Supplied by the TOOL path, which is where a model
 * is. Absent (scripts, live checks), the gate is not applied; present with
 * `evidence: null`, a money value fails closed.
 */
export interface WriteGate { evidence: TurnEvidence | null; asOf: string }

export type StatedResult =
  | { stored: true; unchanged?: true; op: StatedOp; class: MemoryClass; inWords: string | null; memory: RecalledMemory;
      superseded: { id: string; statedAs: string } | null;
      changed?: FieldChange[]; kept?: Fields; dropped?: string[];
      otherRulesInForce?: { subject: string; inWords: string }[] }
  | { stored: false; reason: string; expected?: unknown; example?: unknown; conflict?: true };

const refuse = (reason: string, extra: { expected?: unknown; example?: unknown } = {}): StatedResult =>
  ({ stored: false, reason, ...extra });

/** The newest row of a (kind, subject) chain — the one no other row supersedes. */
async function chainHead(scope: MemoryScope, kind: MemoryKind, subject: string): Promise<Row | null> {
  const rows = await db.spaceMemory.findMany({
    where: { spaceId: scope.spaceId, ownerUserId: scope.ownerUserId, kind, subject },
    orderBy: [{ createdAt: 'desc' }], take: 200,
  });
  const replaced = new Set(rows.map((r) => r.supersedesId).filter(Boolean));
  return rows.find((r) => !replaced.has(r.id)) ?? null;
}

/**
 * Record, amend or retire ONE thing the user stated.
 *
 * ⚠️ SUPERSESSION ALWAYS CREATES A NEW RECORD (product decision). Nothing is
 * edited in place; the chain is one nullable self-relation — there is no
 * versioning system and no event log.
 *
 * ⚠️ AND IT NEVER SILENTLY LOSES A FIELD. The observed failure was a strategy
 * ("six months; cards first; then invest") replaced by a bare `{liquid: <dollars>}`: the
 * ordering left memory without anyone deciding it should. So an `amend` merges
 * field-wise onto the current version and re-validates the whole; a `record`
 * that would drop a field the current version holds is refused unless the caller
 * says `replace: true`, and then echoes what was dropped; and a `record` on a
 * subject that already names a DIFFERENT class is refused outright.
 *
 * ⚠️ A STANDALONE PLANNING FIGURE PERSISTS. V1 refused an assumption with no
 * decision to attach to, to keep passing remarks out. Measured, the model does
 * not store passing remarks ("use $5k instead": 0 writes in 39); the rule only
 * blocked the explicit "remember that" (refused 10/10, carried into a fresh chat
 * 2/21). What stands in for it is what the user can see and stop: the figure is
 * stamped REMEMBERED, rendered apart from anything measured, shown stale, and
 * theirs to retire or delete.
 */
export async function rememberStated(
  scope: MemoryScope, w: StatedWrite, gate?: WriteGate,
): Promise<StatedResult> {
  const op: StatedOp = w.op ?? 'record';
  const subject = w.subject?.trim();
  const words = w.statedAs?.trim().slice(0, MAX_WORDS_CHARS);
  if (!subject) return refuse('a memory needs a subject to be about — a short stable key such as "cash-strategy"');
  if (!words) return refuse('a memory needs the words it was stated in (`statedAs`)');

  // ── Which item is this about? ──────────────────────────────────────────────
  let cls = w.cls;
  let head: Row | null = null;
  if (op === 'record') {
    if (!cls) {
      return refuse('say what is being recorded: exactly one of `goal`, `plannedExpense`, `rule` or `baseline`',
        { expected: expectedFrom(w), example: EXAMPLES.RULE });
    }
    if (!validSubject(subject)) return refuse(`"${subject}" is not a subject key: lowercase words joined by hyphens, e.g. "cash-strategy"`);
    head = await chainHead(scope, KIND_OF_CLASS[cls] as MemoryKind, subject);
  } else {
    const heads = (await Promise.all([MemoryKind.INTENTION, MemoryKind.ASSUMPTION].map((k) => chainHead(scope, k, subject))))
      .filter((r): r is Row => r !== null && r.status === MemoryStatus.ACTIVE)
      .filter((r) => { const x = readMemory(r); return !cls || (x.readable && x.cls === cls); });
    if (heads.length !== 1) {
      return refuse(heads.length === 0
        ? `nothing is remembered under "${subject}", so there is nothing to ${op}. The subjects on record are in the memory line; `
          + 'to remember something new, use `op: "record"`'
        : `"${subject}" names more than one item. Say which with the shape key of its class`);
    }
    [head] = heads;
  }
  const current = head && head.status === MemoryStatus.ACTIVE ? readMemory(head) : null;
  const currentFields = current?.readable && current.cls !== 'PROJECTION' ? current.fields : null;

  // ── What would be stored? ──────────────────────────────────────────────────
  let fields: Fields = {};
  let supplied: Fields = {};
  let echo: { changed?: FieldChange[]; kept?: Fields; dropped?: string[] } = {};

  if (op === 'retire') {
    if (!current?.readable || current.cls === 'PROJECTION') {
      return refuse(`what is stored under "${subject}" cannot be read reliably, so it cannot be retired from here. Its owner can delete it under Memory`);
    }
    cls = current.cls;
  } else if (op === 'amend') {
    if (!current?.readable || current.cls === 'PROJECTION' || !currentFields) {
      return refuse(`what is stored under "${subject}" cannot be read reliably, so it cannot be amended. Record it again, whole, with \`op: "record"\``);
    }
    cls = current.cls;
    supplied = w.set ?? {};
    if (Object.keys(supplied).length === 0 && (w.unset ?? []).length === 0) {
      return refuse('an amendment changes something: give `set` (fields and their new values) or `unset` (field names)',
        { example: { op: 'amend', subject, statedAs: 'Actually make it nine months', set: { liquidFloorMonthsOfExpenses: 9 } } });
    }
    const merged = mergeAmend(cls, currentFields, supplied, w.unset ?? []);
    if (!merged.ok) return refuse(merged.reason, { expected: { [SHAPE_KEY[cls]]: currentFields } });
    fields = merged.fields;
    echo = { changed: merged.changed, kept: merged.kept };
  } else {
    const chosen = cls as StatedClass;
    const verdict = validateFields(chosen, w.fields);
    if (!verdict.ok) {
      return refuse(verdict.reason, { expected: expectedFrom(w.fields) ?? undefined, example: EXAMPLES[chosen] });
    }
    fields = supplied = w.fields as Fields;
    if (current?.readable && current.cls !== chosen) {
      return refuse(`"${subject}" already names a ${current.cls} (${describeMemory(current.cls, current.fields)}). `
        + 'Use another subject for this, or retire that item first');
    }
    if (currentFields) {
      const dropped = droppedFields(currentFields, fields);
      if (dropped.length > 0 && w.replace !== true) {
        return refuse(`the current ${chosen} under "${subject}" also says ${dropped.map((k) => `\`${k}: ${JSON.stringify(currentFields[k])}\``).join(', ')}, `
          + 'and this would silently lose it. If the user changed one part, use `op: "amend"` with `set`. If they replaced '
          + 'the whole thing, repeat this call with `replace: true`',
          { expected: { op: 'amend', subject, set: Object.fromEntries(Object.entries(fields).filter(([k, v]) => JSON.stringify(currentFields[k]) !== JSON.stringify(v))) } });
      }
      if (dropped.length > 0) echo = { dropped };
      // ⚠️ SAYING IT AGAIN IS NOT A CHANGE OF MIND. "Remember that." after the item
      // is already on record, word for word in its fields, writes nothing.
      //
      // ⚠️ UNLESS SAYING IT AGAIN IS THE POINT. A planning figure goes STALE on its
      // age alone, and a lapsed item is over — for those, "yes, still $5k" is not a
      // repetition but the newest thing the user has said about it, and it must
      // move the date, or the figure they just confirmed still reads as months old.
      const today = (w.statedAt ?? gate?.asOf)?.slice(0, 10);
      const reaffirmable = head !== null && today !== undefined && current?.readable === true
        && ['STALE', 'LAPSED'].includes(stateOf(present(head), current, today));
      if (!reaffirmable && dropped.length === 0 && Object.keys(fields).length === Object.keys(currentFields).length
        && Object.entries(fields).every(([k, v]) => JSON.stringify(currentFields[k]) === JSON.stringify(v)) && head) {
        return { stored: true, unchanged: true, op, class: chosen, inWords: describeMemory(chosen, fields),
          memory: present(head), superseded: null };
      }
    }
  }

  if (op !== 'retire' && gate) {
    const admitted = admitWrite({ cls: cls as StatedClass, supplied, current: currentFields, evidence: gate.evidence, asOf: gate.asOf });
    if (!admitted.ok) return refuse(admitted.reason, { example: EXAMPLES[cls as StatedClass] });
  }
  for (const [name, value] of [['appliesFrom', w.appliesFrom], ['appliesTo', w.appliesTo]] as const) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) return refuse(`\`${name}\` is not a date (YYYY-MM-DD)`);
  }
  if (w.appliesFrom && w.appliesTo && w.appliesFrom > w.appliesTo) return refuse('`appliesTo` is before `appliesFrom`');

  const chosen = cls as StatedClass;
  const payload = op === 'retire' ? tombstonePayload(chosen) : toPayload(chosen, fields);
  const shape = validateShape(payload);
  if (!shape.ok) return refuse(shape.reason);

  // ── One new row; the version it replaces keeps its content and changes status ─
  let created: Row;
  try {
    created = await db.$transaction(async (tx) => {
      const row = await tx.spaceMemory.create({
        data: {
          spaceId: scope.spaceId, ownerUserId: scope.ownerUserId,
          kind: KIND_OF_CLASS[chosen] as MemoryKind, subject,
          payload: payload as never,
          statedAs: words,
          status: op === 'retire' ? MemoryStatus.RETIRED : MemoryStatus.ACTIVE,
          ...(w.statedAt ? { statedAt: new Date(w.statedAt) } : {}),
          ...(w.appliesFrom ? { appliesFrom: new Date(w.appliesFrom) } : {}),
          ...(w.appliesTo   ? { appliesTo:   new Date(w.appliesTo)   } : {}),
          ...(head ? { supersedesId: head.id } : {}),
        },
      });
      if (head && head.status === MemoryStatus.ACTIVE) {
        await tx.spaceMemory.updateMany({
          where: { id: head.id, spaceId: scope.spaceId, ownerUserId: scope.ownerUserId },
          data: { status: op === 'retire' ? MemoryStatus.RETIRED : MemoryStatus.SUPERSEDED } });
      }
      return row;
    });
  } catch (err) {
    // `supersedesId` is unique: two writers replacing the same version cannot both win.
    if ((err as { code?: string })?.code === 'P2002') {
      return { stored: false, conflict: true, reason: 'this item was changed at the same moment by another request. Read it again, then repeat' };
    }
    throw err;
  }

  return {
    stored: true, op, class: chosen,
    inWords: op === 'retire' ? null : describeMemory(chosen, fields),
    memory: present(created),
    superseded: head && head.status === MemoryStatus.ACTIVE ? { id: head.id, statedAs: head.statedAs } : null,
    ...echo,
    ...(chosen === 'RULE' ? { otherRulesInForce: await otherRules(scope, subject) } : {}),
  };
}

/** The owner's OTHER active rules — echoed on every rule write, so a second subject for one strategy is visible. */
async function otherRules(scope: MemoryScope, subject: string): Promise<{ subject: string; inWords: string }[]> {
  const rows = await db.spaceMemory.findMany({
    where: { spaceId: scope.spaceId, ownerUserId: scope.ownerUserId,
      kind: MemoryKind.INTENTION, status: MemoryStatus.ACTIVE, subject: { not: subject } },
    orderBy: [{ statedAt: 'desc' }], take: MAX_RECALL,
  });
  return rows.flatMap((r) => {
    const read = readMemory(r);
    return read.readable && read.cls === 'RULE' ? [{ subject: r.subject, inWords: describeMemory('RULE', read.fields) }] : [];
  });
}

// ── Projections — written by code, never on a caller's say-so ────────────────

export const PROJECTIONS_ARE_AUTOMATIC =
  'Projections are recorded automatically when the deterministic cash projection states one from '
  + 'observed evidence. A hypothetical result is never remembered. To keep the plan behind it, record '
  + 'what the user stated: their rule, their planning figure or their goal.';

export interface ProjectionStatement {
  /** `<metric>-<horizon>`: one ACTIVE statement per horizon, the rest in its chain. */
  subject:  string;
  /** What was measured. `liquid` = checking plus savings. */
  metric:   'liquid';
  horizon:  string;
  value:    number;
  /** Copied from the projection's own basis block. The key set is closed by the model. */
  basis:    Record<string, unknown>;
  statedAs: string;
  statedAt: string;
}

/**
 * Record what a projection SAID. The ONLY writer of a PROJECTION, and only the
 * turn loop calls it.
 *
 * ⚠️ NOT REACHABLE FROM A TOOL ARGUMENT. `remember` has no projection shape: a
 * model that could mint "what we said" could record a scenario result — a
 * hypothetical — as a statement, which is exactly what the four model-written
 * checkpoints on record were. The payload is validated by the same pure function
 * every reader uses, so `basis` cannot carry a key the code writer does not write.
 */
export async function recordProjection(
  scope: MemoryScope, p: ProjectionStatement,
): Promise<{ stored: true; memory: RecalledMemory } | { stored: false; reason: string }> {
  const payload = { v: MEMORY_VERSION, class: 'PROJECTION',
    metric: p.metric, horizon: p.horizon, value: p.value, basis: p.basis };
  const shape = validateShape(payload);
  if (!shape.ok) return { stored: false, reason: shape.reason };
  if (p.subject !== `${p.metric}-${p.horizon}`) return { stored: false, reason: 'a projection is filed under its metric and horizon' };

  const head = await chainHead(scope, MemoryKind.CHECKPOINT, p.subject);
  const created = await db.$transaction(async (tx) => {
    const row = await tx.spaceMemory.create({
      data: {
        spaceId: scope.spaceId, ownerUserId: scope.ownerUserId,
        kind: MemoryKind.CHECKPOINT, subject: p.subject,
        payload: payload as never, statedAs: p.statedAs, statedAt: new Date(p.statedAt),
        ...(head ? { supersedesId: head.id } : {}),
      },
    });
    if (head && head.status === MemoryStatus.ACTIVE) {
      await tx.spaceMemory.updateMany({
        where: { id: head.id, spaceId: scope.spaceId, ownerUserId: scope.ownerUserId },
        data: { status: MemoryStatus.SUPERSEDED } });
    }
    return row;
  });
  return { stored: true, memory: present(created) };
}

// ── The owner's own surface: see, stop, erase ────────────────────────────────

export interface OwnMemoryItem {
  id: string;
  /** Null when the row cannot be read reliably. */
  class: MemoryClass | null;
  state: MemoryState | 'UNREADABLE';
  /** The item as one plain sentence, from its fields. Null when unreadable. */
  inWords: string | null;
  /** The words it was noted in — the assistant's paraphrase, shown as "noted as". */
  notedAs: string;
  notedOn: string;
}

/** Everything this user has on record in this Space that is not a past version. Newest first. */
export async function listOwnMemories(scope: MemoryScope, todayISO: string): Promise<OwnMemoryItem[]> {
  const rows = await db.spaceMemory.findMany({
    where: { spaceId: scope.spaceId, ownerUserId: scope.ownerUserId, status: MemoryStatus.ACTIVE },
    orderBy: [{ statedAt: 'desc' }, { createdAt: 'desc' }], take: MAX_RECALL,
  });
  return rows.map((r) => {
    const row = present(r);
    const read = readMemory(row);
    return read.readable
      ? { id: r.id, class: read.cls, state: stateOf(row, read, todayISO.slice(0, 10)),
          inWords: describeMemory(read.cls, read.fields), notedAs: r.statedAs, notedOn: row.statedAt.slice(0, 10) }
      : { id: r.id, class: null, state: 'UNREADABLE' as const, inWords: null, notedAs: r.statedAs, notedOn: row.statedAt.slice(0, 10) };
  });
}

export type OwnMutation = { ok: true } | { ok: false; why: 'NOT_FOUND' | 'NOT_RETIRABLE' | 'CONFLICT' };

/** The owner's row by id — or null, which is also what another member's id returns. */
async function ownRow(scope: MemoryScope, id: string): Promise<Row | null> {
  return db.spaceMemory.findFirst({ where: { id, spaceId: scope.spaceId, ownerUserId: scope.ownerUserId } });
}

/** Stop using an item: the same tombstone row a conversation writes, in the panel's words. */
export async function retireMemory(scope: MemoryScope, id: string, statedAt?: string): Promise<OwnMutation> {
  const row = await ownRow(scope, id);
  if (!row || row.status !== MemoryStatus.ACTIVE) return { ok: false, why: 'NOT_FOUND' };
  const read = readMemory(row);
  if (!read.readable || read.cls === 'PROJECTION') return { ok: false, why: 'NOT_RETIRABLE' };
  const result = await rememberStated(scope, { op: 'retire', cls: read.cls, subject: row.subject,
    statedAs: 'Retired by you in Memory.', ...(statedAt ? { statedAt } : {}) });
  if (result.stored) return { ok: true };
  return { ok: false, why: result.conflict ? 'CONFLICT' : 'NOT_RETIRABLE' };
}

/**
 * Erase an item AND its whole history. Someone erasing what the assistant
 * remembers does not expect the previous version to survive. The chain is every
 * row of that `(owner, kind, subject)`; one statement removes it.
 */
export async function deleteMemoryChain(
  scope: MemoryScope, id: string,
): Promise<{ ok: true; erased: number; kind: MemoryKind } | { ok: false; why: 'NOT_FOUND' }> {
  const row = await ownRow(scope, id);
  if (!row) return { ok: false, why: 'NOT_FOUND' };
  const { count } = await db.spaceMemory.deleteMany({
    where: { spaceId: scope.spaceId, ownerUserId: scope.ownerUserId, kind: row.kind, subject: row.subject } });
  return { ok: true, erased: count, kind: row.kind };
}
