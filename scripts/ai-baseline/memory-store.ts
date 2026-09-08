/**
 * scripts/ai-baseline/memory-store.ts
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
 * Memory may hold intentions, assumptions and dated statements. It may NEVER
 * hold current financial truth. Each kind declares a CLOSED set of payload keys;
 * an unknown key is refused with the allowed list. There is therefore no field
 * in which "current cash" could be stored — not because somebody remembered not
 * to, but because no such key exists in any kind.
 *
 * ── Ownership (product decision, 2026-09-08) ────────────────────────────────
 * Memory is USER-OWNED WITHIN A SPACE. The Space identifies the financial world;
 * the user identifies whose intention it is. `ownerUserId` is required, and both
 * `recall` and `remember` operate ONLY on the authenticated user's own rows. No
 * sharing, no visibility model, no ACLs, no household consensus, no nullable
 * ownership. A shared Space holds one financial picture and two people's goals.
 *
 * ⚠️ RESEARCH CODE UNDER scripts/, like `scenario-ledger.ts` beside it. There is
 * no production reader. If the experiment shows the product needs it, it moves
 * to lib/ with a real consumer — not before.
 */

import { db } from '@/lib/db';
import { MemoryKind, MemoryStatus } from '@prisma/client';

export { MemoryKind, MemoryStatus };

// ── Payload shapes ───────────────────────────────────────────────────────────

/**
 * A closed key set per kind. THIS IS THE INVARIANT, not a validation nicety.
 *
 * ⚠️ NOTHING HERE CAN NAME A CURRENT BALANCE. An INTENTION carries a TARGET and
 * a date; a CHECKPOINT carries a horizon, which is what makes its `value` a
 * statement about the future rather than a claim about now; an ASSUMPTION
 * carries a rate or a level the user asserted. A payload key called
 * `currentCash` is not forbidden by a denylist that somebody has to maintain —
 * it simply is not in any of these sets, so it cannot be written.
 */
const PAYLOAD_KEYS: Record<MemoryKind, { allowed: string[]; requireOneOf: string[][] }> = {
  [MemoryKind.INTENTION]: {
    allowed: ['targetMetric', 'targetAmount', 'byDate', 'intent', 'amount', 'label', 'earliest'],
    // Either a target ("$1M of net worth by 2030") or a planned outlay ("a car,
    // about $20K, not before March 2027"). Both are things the user DECIDED.
    requireOneOf: [['targetMetric', 'targetAmount', 'byDate'], ['intent', 'amount', 'label']],
  },
  [MemoryKind.ASSUMPTION]: {
    allowed: ['monthlySpending', 'annualReturnPct', 'appliesTo'],
    requireOneOf: [['monthlySpending'], ['annualReturnPct']],
  },
  [MemoryKind.CHECKPOINT]: {
    // ⚠️ `horizon` IS REQUIRED, AND THAT IS THE WHOLE SAFETY PROPERTY. A value
    // with a horizon and a `statedAt` is "what we said on the 8th about the end
    // of the year". The same value without one would be a balance.
    allowed: ['metric', 'horizon', 'value', 'basis', 'toolCallId'],
    requireOneOf: [['metric', 'horizon', 'value']],
  },
};

export interface MemoryPayload { [key: string]: unknown }

export interface ValidationFailure { rejected: string; allowedKeys: string[] }

export function validatePayload(
  kind: MemoryKind, payload: MemoryPayload,
): { ok: true } | { ok: false; reason: string; allowedKeys: string[] } {
  const spec = PAYLOAD_KEYS[kind];
  if (!spec) return { ok: false, reason: `unknown memory kind "${kind}"`, allowedKeys: [] };

  const keys = Object.keys(payload ?? {});
  if (keys.length === 0) {
    return { ok: false, reason: 'the payload is empty', allowedKeys: spec.allowed };
  }
  const unknown = keys.filter((k) => !spec.allowed.includes(k));
  if (unknown.length > 0) {
    return { ok: false, allowedKeys: spec.allowed,
      reason: `${kind} payloads cannot carry ${unknown.join(', ')}. Memory records what was `
        + 'decided, assumed or said — never a current balance, which is always re-read from '
        + 'the financial authorities.' };
  }
  const satisfied = spec.requireOneOf.some((set) => set.every((k) => keys.includes(k)));
  if (!satisfied) {
    return { ok: false, allowedKeys: spec.allowed,
      reason: `a ${kind} needs all of ${spec.requireOneOf.map((s) => s.join(' + ')).join(', or all of ')}` };
  }
  return { ok: true };
}

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

/**
 * The authenticated user's own memories, newest statement first.
 *
 * ⚠️ THE SCOPE IS NOT A FILTER THE CALLER MAY OMIT. `spaceId` and `ownerUserId`
 * are one argument, required together, so no query shape exists that returns
 * another member's intentions.
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
  return rows.map((r) => ({
    id: r.id, kind: r.kind, subject: r.subject, status: r.status,
    payload: r.payload, statedAs: r.statedAs,
    statedAt: r.statedAt.toISOString(),
    appliesFrom: r.appliesFrom?.toISOString() ?? null,
    appliesTo:   r.appliesTo?.toISOString() ?? null,
    supersedesId: r.supersedesId,
  }));
}

// ── Writing ──────────────────────────────────────────────────────────────────

export interface RememberArgs {
  kind:        MemoryKind;
  subject:     string;
  payload:     MemoryPayload;
  statedAs:    string;
  appliesFrom?: string;
  appliesTo?:   string;
  /**
   * When the statement was made. Defaults to the database clock.
   *
   * ⚠️ THE CONVERSATION'S CLOCK, NOT POSTGRES'S, IS WHAT A CHECKPOINT MEANS. A
   * projection made "standing at 2026-09-08" must carry that date, or a
   * reconciliation compares a statement against a basis from a different day and
   * attributes the difference to the wrong thing. The harness runs on a fixed
   * `asOfISO`; without this the row silently recorded the UTC wall clock, which
   * on the first live run was already the previous day.
   */
  statedAt?:   string;
}

export type RememberResult =
  | { stored: true; memory: RecalledMemory; superseded: { id: string; statedAs: string } | null }
  | { stored: false; reason: string; allowedKeys?: string[] };

/**
 * Record one memory, superseding the owner's previous ACTIVE one on the same
 * subject and kind.
 *
 * ⚠️ SUPERSESSION ALWAYS CREATES A NEW RECORD (product decision). Nothing is
 * edited in place, so "$15K, then $8K, then cancelled" is three rows and a
 * chain rather than one row that has forgotten it ever said $15K. The chain is
 * one nullable self-relation — there is no versioning system and no event log.
 *
 * ⚠️ A STANDALONE ASSUMPTION DOES NOT PERSIST (product decision). "Assume I
 * spend $6K" said in passing is a per-turn statement the forecast substrate
 * already handles; it earns a row only when it is attached to something the user
 * actually decided. The attachment is the SUBJECT: an ASSUMPTION is stored only
 * when an ACTIVE INTENTION or CHECKPOINT on the same subject already exists for
 * the same owner. That needs no extra column and no second relation.
 */
export async function rememberMemory(
  scope: MemoryScope, args: RememberArgs,
): Promise<RememberResult> {
  const subject = args.subject?.trim();
  if (!subject) return { stored: false, reason: 'a memory needs a subject to be about' };
  if (!args.statedAs?.trim()) {
    return { stored: false, reason: 'a memory needs the words it was stated in' };
  }

  const valid = validatePayload(args.kind, args.payload);
  if (!valid.ok) return { stored: false, reason: valid.reason, allowedKeys: valid.allowedKeys };

  if (args.kind === MemoryKind.ASSUMPTION) {
    const anchor = await db.spaceMemory.findFirst({
      where: { spaceId: scope.spaceId, ownerUserId: scope.ownerUserId, subject,
        status: MemoryStatus.ACTIVE,
        kind: { in: [MemoryKind.INTENTION, MemoryKind.CHECKPOINT] } },
      select: { id: true },
    });
    if (!anchor) {
      return { stored: false,
        reason: `an assumption only persists when it is attached to something decided. There `
          + `is no active intention or checkpoint about "${subject}" for this user, so this `
          + 'was not stored. Record the intention first, or let the assumption stay a '
          + 'statement in this conversation — the forecast already applies it there.' };
    }
  }

  const written = await db.$transaction(async (tx) => {
    const prior = await tx.spaceMemory.findFirst({
      where: { spaceId: scope.spaceId, ownerUserId: scope.ownerUserId,
        kind: args.kind, subject, status: MemoryStatus.ACTIVE },
      orderBy: { statedAt: 'desc' },
      select: { id: true, statedAs: true },
    });
    const created = await tx.spaceMemory.create({
      data: {
        spaceId: scope.spaceId, ownerUserId: scope.ownerUserId,
        kind: args.kind, subject,
        payload: args.payload as never,
        statedAs: args.statedAs.trim(),
        ...(args.statedAt ? { statedAt: new Date(args.statedAt) } : {}),
        ...(args.appliesFrom ? { appliesFrom: new Date(args.appliesFrom) } : {}),
        ...(args.appliesTo   ? { appliesTo:   new Date(args.appliesTo)   } : {}),
        ...(prior ? { supersedesId: prior.id } : {}),
      },
    });
    if (prior) {
      await tx.spaceMemory.update({
        where: { id: prior.id }, data: { status: MemoryStatus.SUPERSEDED } });
    }
    return { created, prior };
  });

  return {
    stored: true,
    superseded: written.prior,
    memory: {
      id: written.created.id, kind: written.created.kind, subject: written.created.subject,
      status: written.created.status, payload: written.created.payload,
      statedAs: written.created.statedAs,
      statedAt: written.created.statedAt.toISOString(),
      appliesFrom: written.created.appliesFrom?.toISOString() ?? null,
      appliesTo:   written.created.appliesTo?.toISOString() ?? null,
      supersedesId: written.created.supersedesId,
    },
  };
}
