/**
 * lib/platform/intelligence/ai/memory/store.ts  (Platform AI operational memory — the ONE data module)
 *
 * Design v2 §1–§2, O1 ruled (b). Preview only; nothing here runs unless the
 * memory flag is effective (the routes / tools check it first).
 *
 * ── AUTHORITY ────────────────────────────────────────────────────────────────
 * Every statement runs inside `withTenantDb(operatorId, …)` as fm_app with
 * `app.user_id` bound transaction-locally. RLS admits a row only when it is the
 * operator's, not deleted, not expired AND the operator holds an ACTIVE grant
 * for its area (defence in depth beneath the routes' fresh guard). Every query
 * ALSO names the owner. There is NO fm_system path here: this module never
 * imports `systemDb` (source-pinned); retention runs through ./purge.ts.
 *
 * ── WRITERS NEVER CHOOSE TIME ────────────────────────────────────────────────
 * No statement here names createdAt, observedAt or expiresAt (outside fm_app's
 * INSERT grant) or deletedAt (O1 (b): fm_app holds no UPDATE on it — the SOFT
 * DELETE is `fm_platform_ai_memory_soft_delete`, the sole path). Invalidation
 * writes `invalidReason` (the trigger stamps invalidatedAt = now()).
 *
 * ── VISIBILITY (D8) ──────────────────────────────────────────────────────────
 * An invalidated row is kept one day for the purge but is hidden from the panel,
 * the injection and recall by ONE helper, `visibleFacts()` (adds
 * `invalidatedAt IS NULL`). It is in the store, not RLS: a SELECT-policy term
 * would fail the invalidating UPDATE's new-row check (design O1).
 *
 * ── CONTENT ──────────────────────────────────────────────────────────────────
 * The one encryptWithPurpose(…, PLATFORM_AI_MEMORY) writer of
 * PlatformAiMemoryFact.noteEncrypted is here (lib/plaid/encrypted-fields.test.ts
 * census). A renewal copies the stored ciphertext; it never re-encrypts. Audit
 * rows carry types, areas and counts — never a note, a payload or a ref id.
 */

import "server-only";

import { Prisma, type PlatformArea } from "@prisma/client";
import { withTenantDb, type TenantClient } from "@/lib/db/tenant-context";
import { encryptWithPurpose, decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { AuditAction } from "@/lib/audit-actions";
import { auditInsert, type OperatorActionWriteClient, recordOperatorAction } from "@/lib/audit";
import type { MemoryConcern, MemoryFactType, MemoryInvalidReason, MemoryOrigin, MemoryTtl } from "./constants";
import { parseStoredRefs, payloadProblem, validateSourceRefs, type MemoryPayload, type MemoryRef } from "./schema";

export interface MemoryFactRecord {
  id: string;
  area: PlatformArea;
  factType: MemoryFactType;
  origin: MemoryOrigin;
  concern: MemoryConcern | null;
  /** The decrypted note, or null (none, or unreadable — see noteUnreadable). */
  note: string | null;
  noteUnreadable: boolean;
  payload: MemoryPayload;
  refs: MemoryRef[];
  ttl: MemoryTtl;
  observedAt: Date;
  createdAt: Date;
  expiresAt: Date;
  supersedesId: string | null;
}

const FACT_SELECT = {
  id: true, platformArea: true, factType: true, origin: true, concern: true, noteEncrypted: true, payload: true,
  sourceRefs: true, ttl: true, observedAt: true, createdAt: true, expiresAt: true, supersedesId: true,
} as const;
type FactRow = Prisma.PlatformAiMemoryFactGetPayload<{ select: typeof FACT_SELECT }>;

/** The one decrypt of a note (a seam so the loophole / export tests can see what is decrypted). */
export type NoteDecrypt = (ciphertext: string) => string;
const decryptNote: NoteDecrypt = (c) => decryptWithPurpose(c, EncryptionPurpose.PLATFORM_AI_MEMORY);

/** Decrypt one row. Never throws: an unreadable note is reported, never shown, never logged. */
export function toFactRecord(row: FactRow, decrypt: NoteDecrypt = decryptNote): MemoryFactRecord {
  let note: string | null = null;
  let noteUnreadable = false;
  if (row.noteEncrypted) {
    try { note = decrypt(row.noteEncrypted); } catch { noteUnreadable = true; }
  }
  const payload = (row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload : {}) as MemoryPayload;
  return {
    id: row.id, area: row.platformArea, factType: row.factType, origin: row.origin, concern: row.concern,
    note, noteUnreadable, payload, refs: parseStoredRefs(row.sourceRefs), ttl: row.ttl,
    observedAt: row.observedAt, createdAt: row.createdAt, expiresAt: row.expiresAt, supersedesId: row.supersedesId,
  };
}

/** The audit client: a plain INSERT (no RETURNING — fm_app's AuditLog SELECT policy cannot see an operator row). */
function auditClient(tx: TenantClient): OperatorActionWriteClient {
  return { auditLog: { create: async ({ data }) => { await auditInsert(tx, data).write; return null; } } };
}

const isUniqueViolation = (e: unknown): e is Prisma.PrismaClientKnownRequestError =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/** Newest first, then id (stable). */
const FACT_ORDER = [{ createdAt: "desc" as const }, { id: "asc" as const }];

/**
 * THE visibility predicate (D8): owner, not invalidated. RLS already excludes
 * deleted / expired / revoked-area rows; `deletedAt: null` is repeated as belt
 * and braces. Every read of facts for the panel, injection, recall or export
 * goes through `visibleFacts`.
 */
export const VISIBLE = (operatorId: string) => ({ operatorUserId: operatorId, deletedAt: null, invalidatedAt: null }) as const;

/** The operator's visible facts (optionally only these areas / ids), newest first. */
export async function visibleFacts(
  operatorId: string,
  opts: { areas?: readonly PlatformArea[]; ids?: readonly string[]; take?: number; decrypt?: NoteDecrypt } = {},
): Promise<MemoryFactRecord[]> {
  if (opts.areas && opts.areas.length === 0) return [];
  const rows = await withTenantDb(operatorId, (tx) => tx.platformAiMemoryFact.findMany({
    where: {
      ...VISIBLE(operatorId),
      ...(opts.areas ? { platformArea: { in: [...opts.areas] } } : {}),
      ...(opts.ids ? { id: { in: [...opts.ids] } } : {}),
    },
    orderBy: FACT_ORDER,
    ...(opts.take ? { take: opts.take } : {}),
    select: FACT_SELECT,
  }));
  return rows.map((r) => toFactRecord(r, opts.decrypt));
}

// ── Insert (confirm / remember) ─────────────────────────────────────────────

export interface InsertFactInput {
  operatorId: string;
  area: PlatformArea;
  factType: MemoryFactType;
  origin: MemoryOrigin;
  concern: MemoryConcern | null;
  /** Already GUARDED (./note-guard.ts) — null for no note. */
  note: string | null;
  payload: MemoryPayload;
  refs: readonly MemoryRef[];
  ttl: MemoryTtl;
  /** The proposal token's jti (confirm); null for the Remember button. */
  proposalJti: string | null;
}

export type InsertOutcome =
  | { kind: "CREATED"; fact: MemoryFactRecord }
  /** UNIQUE(operatorUserId, proposalJti): this proposal was already confirmed (the route answers 409). */
  | { kind: "REPLAY" }
  | { kind: "INVALID"; problem: string };

/**
 * Insert one fact and its CONFIRMED audit row in ONE transaction. The shapes are
 * re-checked here (the trigger checks them again). A replayed proposal hits the
 * unique index ⇒ REPLAY (nothing written).
 */
export async function insertFact(input: InsertFactInput): Promise<InsertOutcome> {
  const payloadErr = payloadProblem(input.factType, input.payload);
  if (payloadErr) return { kind: "INVALID", problem: payloadErr };
  const refs = validateSourceRefs(input.factType, input.refs);
  if (!refs) return { kind: "INVALID", problem: "sourceRefs" };
  try {
    return await withTenantDb(input.operatorId, async (tx) => {
      const row = await tx.platformAiMemoryFact.create({
        data: {
          operatorUserId: input.operatorId, platformArea: input.area, factType: input.factType, origin: input.origin,
          concern: input.concern,
          noteEncrypted: input.note === null ? null : encryptWithPurpose(input.note, EncryptionPurpose.PLATFORM_AI_MEMORY),
          payload: input.payload as Prisma.InputJsonObject,
          sourceRefs: refs as unknown as Prisma.InputJsonArray,
          ttl: input.ttl, proposalJti: input.proposalJti,
        },
        select: FACT_SELECT,
      });
      await recordOperatorAction(auditClient(tx), {
        actor: { userId: input.operatorId, via: "PLATFORM_GRANT", area: input.area },
        action: AuditAction.PLATFORM_AI_MEMORY_CONFIRMED,
        target: { kind: "PLATFORM_AI_MEMORY", id: row.id },
        result: "SUCCESS",
        detail: { area: input.area, factType: input.factType, origin: input.origin, refCount: refs.length, ttl: input.ttl },
      });
      return { kind: "CREATED" as const, fact: toFactRecord(row) };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { kind: "REPLAY" };
    throw e;
  }
}

// ── Renew (supersede) ───────────────────────────────────────────────────────

export type RenewOutcome =
  | { kind: "RENEWED"; fact: MemoryFactRecord }
  | { kind: "NOT_FOUND" }
  /** A concurrent renew of the same row won (UNIQUE supersedesId). */
  | { kind: "CONFLICT" };

/**
 * Renew = a NEW row (same type, area, concern, note ciphertext, payload, TTL)
 * carrying the CURRENT observed states the caller just revalidated, and the old
 * row invalidated SUPERSEDED — one transaction, with the RENEWED audit row.
 * The caller (./revalidate.ts + the route) has already refused GONE and an
 * OPERATIONAL_STATE that CHANGED (409). expiresAt is never moved on any row.
 */
export async function renewFact(operatorId: string, id: string, currentRefs: readonly MemoryRef[]): Promise<RenewOutcome> {
  try {
    return await withTenantDb(operatorId, async (tx) => {
      const old = await tx.platformAiMemoryFact.findFirst({ where: { id, ...VISIBLE(operatorId) }, select: FACT_SELECT });
      if (!old) return { kind: "NOT_FOUND" as const };
      const refs = validateSourceRefs(old.factType, currentRefs);
      if (!refs) return { kind: "NOT_FOUND" as const };
      const inv = await tx.platformAiMemoryFact.updateMany({
        where: { id, ...VISIBLE(operatorId) },
        data: { invalidReason: "SUPERSEDED" },
      });
      if (inv.count !== 1) return { kind: "NOT_FOUND" as const };
      const row = await tx.platformAiMemoryFact.create({
        data: {
          operatorUserId: operatorId, platformArea: old.platformArea, factType: old.factType, origin: old.origin,
          concern: old.concern, noteEncrypted: old.noteEncrypted, payload: old.payload as Prisma.InputJsonObject,
          sourceRefs: refs as unknown as Prisma.InputJsonArray, ttl: old.ttl, supersedesId: old.id, proposalJti: null,
        },
        select: FACT_SELECT,
      });
      await recordOperatorAction(auditClient(tx), {
        actor: { userId: operatorId, via: "PLATFORM_GRANT", area: old.platformArea },
        action: AuditAction.PLATFORM_AI_MEMORY_RENEWED,
        target: { kind: "PLATFORM_AI_MEMORY", id: row.id },
        result: "SUCCESS",
        detail: { area: old.platformArea, newId: row.id, supersedesId: old.id },
      });
      return { kind: "RENEWED" as const, fact: toFactRecord(row) };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { kind: "CONFLICT" };
    throw e;
  }
}

// ── Invalidate (revalidation outcome; system, aggregated per turn) ──────────

/**
 * Invalidate visible facts with a reason, ONE aggregated INVALIDATED audit row
 * per (area, reason) — `{area, reason, count}`, no id. Returns the count changed.
 * A row already invalidated (or no longer visible) is skipped, never an error.
 */
export async function invalidateFacts(
  operatorId: string,
  items: ReadonlyArray<{ id: string; area: PlatformArea; reason: Exclude<MemoryInvalidReason, "SUPERSEDED"> }>,
): Promise<number> {
  if (items.length === 0) return 0;
  return withTenantDb(operatorId, async (tx) => {
    let total = 0;
    const groups = new Map<string, { area: PlatformArea; reason: MemoryInvalidReason; ids: string[] }>();
    for (const it of items) {
      const k = `${it.area}|${it.reason}`;
      const g = groups.get(k) ?? { area: it.area, reason: it.reason, ids: [] };
      g.ids.push(it.id);
      groups.set(k, g);
    }
    for (const g of groups.values()) {
      const r = await tx.platformAiMemoryFact.updateMany({
        where: { id: { in: g.ids }, platformArea: g.area, ...VISIBLE(operatorId) },
        data: { invalidReason: g.reason },
      });
      total += r.count;
      if (r.count > 0) {
        await recordOperatorAction(auditClient(tx), {
          actor: { userId: operatorId, via: "PLATFORM_GRANT", area: g.area },
          action: AuditAction.PLATFORM_AI_MEMORY_INVALIDATED,
          target: { kind: "PLATFORM_AI_MEMORY", id: "aggregate" },
          result: "SUCCESS",
          detail: { area: g.area, reason: g.reason, count: r.count, actorType: "SYSTEM" },
        });
      }
    }
    return total;
  });
}

// ── Soft delete (O1 ruled (b): the definer function is the SOLE path) ───────

/** The ONE statement that soft-deletes: the SECURITY DEFINER function (count only). */
export const MEMORY_SOFT_DELETE_SQL = `SELECT public.fm_platform_ai_memory_soft_delete($1::text) AS n`;

async function callSoftDelete(tx: TenantClient, id: string | null): Promise<number> {
  const rows = await tx.$queryRawUnsafe<Array<{ n: number | bigint | null }>>(MEMORY_SOFT_DELETE_SQL, id);
  const n = Number(rows[0]?.n ?? 0);
  if (!Number.isInteger(n) || n < 0) throw new Error("soft delete returned a non-count");
  return n;
}

/**
 * Soft-delete ONE visible fact: hidden at once (the function sets deletedAt =
 * now()), removed at the next purge. The DELETED audit row `{area, count}` is
 * written in the same transaction with the function's returned count.
 */
export async function softDeleteFact(operatorId: string, id: string): Promise<{ deleted: number }> {
  return withTenantDb(operatorId, async (tx) => {
    const f = await tx.platformAiMemoryFact.findFirst({ where: { id, ...VISIBLE(operatorId) }, select: { platformArea: true } });
    if (!f) return { deleted: 0 };
    const n = await callSoftDelete(tx, id);
    if (n > 0) {
      await recordOperatorAction(auditClient(tx), {
        actor: { userId: operatorId, via: "PLATFORM_GRANT", area: f.platformArea },
        action: AuditAction.PLATFORM_AI_MEMORY_DELETED,
        target: { kind: "PLATFORM_AI_MEMORY", id },
        result: "SUCCESS",
        detail: { area: f.platformArea, count: n },
      });
    }
    return { deleted: n };
  });
}

/**
 * "Delete all my memory": every row of the operator the function admits (own,
 * not deleted, not expired, held area — including a row already hidden by
 * invalidation, which the purge would otherwise keep one more day) — one call
 * with p_id NULL, one DELETED audit row `{area: "ALL", count}` (the function
 * returns a count only, not a per-area split).
 */
export async function softDeleteAllFacts(operatorId: string): Promise<{ deleted: number }> {
  return withTenantDb(operatorId, async (tx) => {
    const n = await callSoftDelete(tx, null);
    if (n > 0) {
      await recordOperatorAction(auditClient(tx), {
        actor: { userId: operatorId, via: "PLATFORM_GRANT" },
        action: AuditAction.PLATFORM_AI_MEMORY_DELETED,
        target: { kind: "PLATFORM_AI_MEMORY", id: "all" },
        result: "SUCCESS",
        detail: { area: "ALL", count: n },
      });
    }
    return { deleted: n };
  });
}

// ── Export (D13) ────────────────────────────────────────────────────────────

/**
 * The operator's own memory for their data export: held areas only (RLS already
 * hides a revoked area; `heldAreas` repeats it), visible facts, note plaintext,
 * type, refs and dates. Read-only. The EXPORTED audit row (counts only) is the
 * export route's.
 */
export async function readFactsForExport(operatorId: string, heldAreas: ReadonlySet<PlatformArea>, opts: { decrypt?: NoteDecrypt } = {}): Promise<MemoryFactRecord[]> {
  return visibleFacts(operatorId, { areas: [...heldAreas], decrypt: opts.decrypt });
}

// ── Refusals (design §7: PROPOSAL_REFUSED {reasonCode}, no content) ─────────

/** One PROPOSAL_REFUSED audit row per code — `{area, reasonCode}` only. */
export async function recordProposalRefusals(operatorId: string, area: PlatformArea, codes: readonly string[]): Promise<void> {
  if (codes.length === 0) return;
  await withTenantDb(operatorId, async (tx) => {
    for (const reasonCode of codes.slice(0, 10)) {
      await recordOperatorAction(auditClient(tx), {
        actor: { userId: operatorId, via: "PLATFORM_GRANT", area },
        action: AuditAction.PLATFORM_AI_MEMORY_PROPOSAL_REFUSED,
        target: { kind: "PLATFORM_AI_MEMORY", id: "proposal" },
        result: "REFUSED",
        detail: { area, reasonCode },
      });
    }
  });
}

/** EXPORTED (D13): counts only, in the export's own transaction-free step. */
export async function recordMemoryExported(operatorId: string, count: number): Promise<void> {
  await withTenantDb(operatorId, async (tx) => {
    await recordOperatorAction(auditClient(tx), {
      actor: { userId: operatorId, via: "PLATFORM_GRANT" },
      action: AuditAction.PLATFORM_AI_MEMORY_EXPORTED,
      target: { kind: "PLATFORM_AI_MEMORY", id: "export" },
      result: "SUCCESS",
      detail: { count },
    });
  });
}

