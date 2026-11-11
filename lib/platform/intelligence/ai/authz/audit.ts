/**
 * lib/platform/intelligence/ai/authz/audit.ts  (Platform AI P5 — THE fail-closed audit writer, I-5 / D-5)
 *
 * Design v2 §6.5, §7, §8.2; S2 ruling 4. The Production writer behind the three Platform AI
 * audit seams — each one written BEFORE the data it records leaves the server, and each one
 * FAIL CLOSED (any write failure throws; the caller then withholds the data):
 *
 *   platformAiToolAudit     authz/boundary.ts step 8 — one row per linked customer per area for a
 *                           customer-linkable RECORD tool (PLATFORM_AI_RECORD_VIEWED, or the tool's
 *                           own action, e.g. CUSTOMER_PROFILE_VIEWED); failure ⇒ UNAVAILABLE.
 *   platformAiRenderAudit   authz/record-render.ts step 3 — PLATFORM_AI_RECORD_VIEWED before a T2
 *                           value is read; failure ⇒ masked.
 *   platformAiSubjectAudit  authz/subject.ts — PLATFORM_AI_SUBJECT_LOOKUP for EVERY outcome;
 *                           failure ⇒ the subject is not resolved.
 *   platformAiPeopleSearchAudit  authz/people.ts — PLATFORM_AI_PEOPLE_SEARCH per @ picker search, BEFORE any
 *                           label leaves; detail { surface, queryLength, resultCount, fingerprint? } (keyed);
 *                           failure ⇒ the uniform empty response.
 *   platformAiPeopleGuardAudit   authz/people.ts — PLATFORM_AI_PEOPLE_GUARD per refused question, code only.
 *
 * THE ACTOR is the operator of the FRESH guard of that call (the per-call recheck's result for
 * the row's area) — never a value from the request. A row whose area has no fresh guard, a
 * guard for another operator, another area, or break-glass (grant null, I-7) is REFUSED (throws)
 * before anything is written. Rows go through THE one chokepoint (lib/audit.ts
 * recordOperatorAction) on fm_system, one at a time; a failure part-way leaves the earlier rows
 * written (over-recording accepted, under-recording impossible — §6.5).
 *
 * DETAIL is codes only: { surface: "platform-ai", tool, recordKind } (records) or
 * { surface, idKind, outcome, keyHash } (subjects). Never a value, a record id, an identifier.
 *
 * No module state. Never logs.
 */

import "server-only";

import type { PlatformArea } from "@prisma/client";
import { systemDb } from "@/lib/db";
import { recordOperatorAction, type OperatorActionInput, type OperatorActionWriteClient } from "@/lib/audit";
import { AuditAction } from "@/lib/audit-actions";
import type { BoundaryAuditRow, BoundaryAuditWriter } from "./boundary";
import type { RecordRenderAudit, RecordViewedRow } from "./record-render";
import type { FreshGuard } from "./recheck";
import type { SubjectAuditRow, SubjectAuditWriter } from "./subject";
import type { PeopleSearchAuditRow, PickerGuardAuditRow } from "./people";

export const PLATFORM_AI_AUDIT_SURFACE = "platform-ai";

export class PlatformAiAuditRefused extends Error {
  constructor(readonly code: "NO_FRESH_GUARD" | "BREAK_GLASS" | "ROW_INVALID") { super(`platform-ai audit refused: ${code}`); this.name = "PlatformAiAuditRefused"; }
}

/** The actor of one row: the FRESH guard of the row's area, for the operator it was issued to (I-7: never break-glass). */
function actorOf(area: PlatformArea, guard: FreshGuard | undefined): OperatorActionInput["actor"] {
  if (!guard?.auth?.user?.id) throw new PlatformAiAuditRefused("NO_FRESH_GUARD");
  if (guard.auth.grant === null || guard.auth.grant === undefined || guard.auth.grant.area !== area) throw new PlatformAiAuditRefused("BREAK_GLASS");
  return { userId: guard.auth.user.id, via: "PLATFORM_GRANT", area };
}

const ID = /^[A-Za-z0-9_:-]{1,64}$/;
const CODE = /^[A-Za-z0-9_:-]{1,64}$/;

async function writeRecordRows(client: OperatorActionWriteClient, rows: readonly (BoundaryAuditRow | RecordViewedRow)[], guards: ReadonlyMap<PlatformArea, FreshGuard>): Promise<void> {
  // Validate EVERY row (and its actor) before the first write: a malformed batch writes nothing and fails closed.
  const inputs: OperatorActionInput[] = rows.map((r) => {
    if (!ID.test(r.targetUserId) || !CODE.test(r.detail.tool) || !CODE.test(r.detail.recordKind) || r.detail.surface !== PLATFORM_AI_AUDIT_SURFACE) throw new PlatformAiAuditRefused("ROW_INVALID");
    return {
      actor: actorOf(r.area, guards.get(r.area)),
      action: r.action,
      target: { kind: "USER", id: r.targetUserId },
      result: "SUCCESS",
      detail: { surface: PLATFORM_AI_AUDIT_SURFACE, tool: r.detail.tool, recordKind: r.detail.recordKind },
    };
  });
  for (const input of inputs) await recordOperatorAction(client, input);
}

/** authz/boundary.ts `audit` — a customer-linkable RECORD tool's rows (throws ⇒ UNAVAILABLE). */
export function platformAiToolAudit(client: OperatorActionWriteClient = systemDb): BoundaryAuditWriter {
  return (rows, fresh) => writeRecordRows(client, rows, fresh);
}

/** authz/record-render.ts `audit` — PLATFORM_AI_RECORD_VIEWED before a T2 value is read (throws ⇒ masked). */
export function platformAiRenderAudit(client: OperatorActionWriteClient = systemDb): RecordRenderAudit {
  return (rows, guards) => {
    if (rows.some((r) => r.action !== AuditAction.PLATFORM_AI_RECORD_VIEWED)) return Promise.reject(new PlatformAiAuditRefused("ROW_INVALID"));
    return writeRecordRows(client, rows, guards);
  };
}

/** authz/people.ts searchPeople `audit` — PLATFORM_AI_PEOPLE_SEARCH, counts + keyed fingerprint only (throws ⇒ the uniform empty response). */
export function platformAiPeopleSearchAudit(client: OperatorActionWriteClient = systemDb): (row: PeopleSearchAuditRow) => Promise<void> {
  return async (row) => {
    if (!row.operatorId || !Number.isInteger(row.queryLength) || !Number.isInteger(row.resultCount) || (row.fingerprint !== null && !/^[0-9a-f]{8}$/.test(row.fingerprint))) {
      throw new PlatformAiAuditRefused("ROW_INVALID");
    }
    await recordOperatorAction(client, {
      actor: { userId: row.operatorId, via: "PLATFORM_GRANT", area: "CUSTOMER_SUCCESS" },
      action: AuditAction.PLATFORM_AI_PEOPLE_SEARCH,
      target: { kind: "PLATFORM_AI_SUBJECT", id: "people-search" },
      result: "SUCCESS",
      detail: { surface: PLATFORM_AI_AUDIT_SURFACE, queryLength: row.queryLength, resultCount: row.resultCount, ...(row.fingerprint ? { fingerprint: row.fingerprint } : {}) },
    });
  };
}

/** authz/people.ts runPickerGuard `audit` — PLATFORM_AI_PEOPLE_GUARD, a code-only row (never a token). */
export function platformAiPeopleGuardAudit(primaryArea: PlatformArea, client: OperatorActionWriteClient = systemDb): (row: PickerGuardAuditRow) => Promise<void> {
  return async (row) => {
    if (!row.operatorId || !["USERNAME", "EMAIL", "LIMITED", "UNAVAILABLE"].includes(row.kind)) throw new PlatformAiAuditRefused("ROW_INVALID");
    await recordOperatorAction(client, {
      // A P5 caller's authority is its fresh CUSTOMER_SUCCESS grant; any other caller acts through the turn's area.
      actor: { userId: row.operatorId, via: "PLATFORM_GRANT", area: row.p5 ? "CUSTOMER_SUCCESS" : primaryArea },
      action: AuditAction.PLATFORM_AI_PEOPLE_GUARD,
      target: { kind: "PLATFORM_AI_SUBJECT", id: "people-guard" },
      result: "REFUSED",
      detail: { surface: PLATFORM_AI_AUDIT_SURFACE, code: "USE_PEOPLE_PICKER", kind: row.kind },
    });
  };
}

/** authz/subject.ts `audit` — PLATFORM_AI_SUBJECT_LOOKUP for every outcome (throws ⇒ not resolved). */
export function platformAiSubjectAudit(client: OperatorActionWriteClient = systemDb): SubjectAuditWriter {
  return async (row: SubjectAuditRow) => {
    if (!/^[0-9a-f]{8}$/.test(row.keyHash) || (row.matchedUserId !== null && !ID.test(row.matchedUserId))) throw new PlatformAiAuditRefused("ROW_INVALID");
    if (!row.actor || !row.actor.operatorId || !row.actor.area) throw new PlatformAiAuditRefused("NO_FRESH_GUARD");
    await recordOperatorAction(client, {
      actor: { userId: row.actor.operatorId, via: "PLATFORM_GRANT", area: row.actor.area },
      action: AuditAction.PLATFORM_AI_SUBJECT_LOOKUP,
      // Target USER only when matched; otherwise the keyed hash (never the identifier).
      target: row.matchedUserId !== null ? { kind: "USER", id: row.matchedUserId } : { kind: "PLATFORM_AI_SUBJECT", id: row.keyHash },
      result: row.outcome === "MATCHED" ? "SUCCESS" : "REFUSED",
      detail: { surface: PLATFORM_AI_AUDIT_SURFACE, idKind: row.idKind, outcome: row.outcome, keyHash: row.keyHash },
    });
  };
}
