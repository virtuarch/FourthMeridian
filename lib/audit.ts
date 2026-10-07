/**
 * lib/audit.ts
 *
 * PO-1 — Operator/security audit FOUNDATION.
 *
 * DECISION: the append-only `AuditLog` model IS the audit foundation. This slice
 * does NOT introduce a second table or a parallel event store — that would
 * duplicate the platform's strongest existing primitive (append-only,
 * SET NULL-on-delete so records survive user/space deletion, indexed on
 * (action, createdAt), and already carrying `performedByAdminId` for
 * on-behalf-of actions). Instead this module defines the DOMAIN-NEUTRAL SHAPE
 * every operator/security event should carry and normalises it onto the existing
 * columns + metadata:
 *
 *   required field   → AuditLog storage
 *   ─────────────────────────────────────────────────────────────────────────
 *   actor            → userId               (acting account; null for anon/pre-account)
 *   actor type       → metadata.actorType   (USER | SYSTEM_ADMIN | PLATFORM_OPERATOR | SYSTEM)
 *   action           → action               (typed AuditAction vocabulary)
 *   target           → metadata.target      ({ type, id }) — domain-neutral reference
 *   timestamp        → createdAt            (DB default now())
 *   result           → metadata.result      (SUCCESS | FAILURE)
 *   metadata         → metadata             (merged; counts/ids/kinds ONLY —
 *                                            never financial values or user content)
 *
 * `performedByAdminId` stays the dedicated column for on-behalf-of actions
 * (a SYSTEM_ADMIN acting on another account), unchanged.
 *
 * WHY A SHAPE HELPER AND NOT COLUMNS: adding actorType/target/result columns
 * would be a schema migration touching a table 30+ call sites already write —
 * out of scope for a security-foundation slice, and unnecessary: metadata is
 * the house idiom for extensible, non-indexed event detail (cf. LOGIN_FAILED's
 * `{ reason }`, the connection status-change `{ from, to }`). Future PO slices
 * (per-connection resync, membership actions) emit through this one shape so the
 * operator audit feed is uniform from birth.
 *
 * buildAuditData() is PURE (unit-tested) and IS the one audit-shape authority —
 * consumed by lib/auth.ts and pinned by lib/security-surface.test.ts.
 *
 * V25-CLOSE-3 Part 4 — audit-authority decision. A thin `recordAuditEvent()`
 * adapter used to sit here with ZERO production callers while ~80 sites wrote
 * `db.auditLog.create` directly. Per the project's own rule — never ship an
 * authority without a clear consumer (TX-3) — the unadopted adapter was REMOVED
 * rather than promoted: full promotion would mean migrating every direct writer,
 * an architecture migration out of scope for an honesty slice, and leaving it in
 * place presented a false "adopted authority." What remains is exactly one shape
 * helper with real consumers. New operator/admin audit writes follow the
 * established sibling pattern — `db.auditLog.create({ data: { performedByAdminId,
 * action, metadata } })` (see app/api/platform/platform-ops/.../request-reauth) —
 * or fold their shape through buildAuditData() as the auth/security family does.
 * The guard `lib/audit-authority.test.ts` pins this: no recordAuditEvent revival
 * without a consumer.
 */

import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { AuditAction, type AuditActionType } from "@/lib/audit-actions";

/** Who acted. Kept deliberately small; extend only when a real new actor class exists. */
export type AuditActorType = "USER" | "SYSTEM_ADMIN" | "PLATFORM_OPERATOR" | "SYSTEM";

/** Outcome of the audited action. */
export type AuditResult = "SUCCESS" | "FAILURE";

/** A domain-neutral reference to whatever was acted on. */
export interface AuditTarget {
  /** e.g. "user", "space", "connection", "grant". */
  type: string;
  id?: string | null;
}

export interface AuditEventInput {
  /** The acting account (User.id). Omit/null for pre-account or anonymous events. */
  actorId?: string | null;
  actorType: AuditActorType;
  action: AuditActionType;
  result: AuditResult;
  target?: AuditTarget | null;
  /** Extra event detail — counts/ids/kinds only, never financial values or user content. */
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** Set when a SYSTEM_ADMIN performs this on behalf of another account. */
  performedByAdminId?: string | null;
}

/**
 * PURE — normalise an operator/security event onto AuditLog's create shape.
 * actorType/result/target are folded into metadata alongside any caller detail.
 */
export function buildAuditData(input: AuditEventInput): Prisma.AuditLogUncheckedCreateInput {
  const {
    actorId, actorType, action, result, target,
    metadata, ipAddress, userAgent, performedByAdminId,
  } = input;

  // metadata is genuinely dynamic JSON (the AuditLog.metadata Json? column), so
  // the object literal is cast through `unknown` to InputJsonValue — the same
  // dynamic-payload boundary lib/events/emit.ts crosses for event.payload.
  const mergedMetadata: Record<string, unknown> = {
    actorType,
    result,
    ...(target ? { target } : {}),
    ...(metadata ?? {}),
  };

  return {
    ...(actorId ? { userId: actorId } : {}),
    action,
    ipAddress: ipAddress ?? null,
    userAgent: userAgent ?? null,
    ...(performedByAdminId ? { performedByAdminId } : {}),
    metadata: mergedMetadata as unknown as Prisma.InputJsonValue,
  };
}

/**
 * Insert one AuditLog row with NO `RETURNING`, and hand back its id.
 *
 * WHY. Prisma's `auditLog.create()` is `INSERT … RETURNING`, and RETURNING needs
 * SELECT on the table plus a SELECT policy the new row passes. The pre-identity
 * role `fm_auth` holds INSERT ONLY on AuditLog (FORCE RLS, no fm_auth SELECT
 * policy) — deliberately: the role that reads credentials must not read the
 * audit trail. So every `create()` through `authDb` failed with 42501, and
 * because authorize() writes the LOGIN row in the same transaction as the
 * session row, no login could succeed on a strict deployment (Preview,
 * 2026-10-06; the UI reported it as an invalid password). `createMany` is a
 * plain INSERT, which the grant allows.
 *
 * `write` is the un-awaited PrismaPromise, so it can sit inside an array
 * `$transaction([...])` or be awaited inside an interactive one. The id is
 * generated here because nothing comes back from the INSERT; callers that link
 * a notification to the row use it.
 *
 * Use this for every AuditLog write made through `authDb`.
 */
export function auditInsert(
  client: { auditLog: Prisma.TransactionClient["auditLog"] },
  data: Prisma.AuditLogUncheckedCreateInput,
): { id: string; write: Prisma.PrismaPromise<Prisma.BatchPayload> } {
  const id = data.id ?? randomUUID();
  return { id, write: client.auditLog.createMany({ data: [{ ...data, id }] }) };
}

// ─────────────────────────────────────────────────────────────────────────────
// P1 HUMAN OPERABILITY — THE OPERATOR-ACTION CHOKEPOINT.
//
// Zero operator writes carried a reason before P1, `userId` meant "operator" in
// some routes and "customer" in others, connection actions had no subject at
// all, and no audit row referenced the JobRun or RefreshExecution it caused.
// `recordOperatorAction` extends AuditLog — no new table, no new column — with a
// DETERMINISTIC envelope:
//
//   performedByAdminId  → the operator, always
//   userId              → the CUSTOMER when the target is a USER (so the row is
//                         visible to that customer under the tenant SELECT policy
//                         as "who acted on my account", and indexed for the
//                         Customer Success per-customer panel)
//   spaceId             → the Space when the target is a SPACE
//   metadata            → { actorType, result, actor:{via,area}, target:{kind,id},
//                           reason?, change?, execution? } — fixed keys only
//
// REASON IS REQUIRED BY TYPE for consequential actions (REASON_REQUIRED_ACTIONS):
// policy / overlay / cohort assignment, cadence changes, customer deactivation. A Run Now, a resync or a beta-queue decision needs none — the
// action IS the reason. A reason is a CODE plus an optional ≤280-char note the
// scrubber refuses when it looks like an address, a long digit run or a secret.
//
// NO FINANCIAL PAYLOAD, NO PII: `change` carries ids, enum values and counts.
// Callers write INSIDE the transaction that changes state (the policies
// mutate.ts pattern) so the audit and the change commit together.
// ─────────────────────────────────────────────────────────────────────────────

export type OperatorTargetKind =
  | "USER" | "BETA_REQUEST" | "PLAID_ITEM" | "CONNECTION" | "SPACE" | "PLATFORM_SETTING" | "JOB" | "POLICY_GROUP";

export const OPERATOR_REASON_CODES = [
  "BETA_ONBOARDING", "SUPPORT_REQUEST", "DOGFOOD", "TESTING", "POLICY_ROLLOUT", "INCIDENT", "ABUSE", "OTHER",
] as const;
export type OperatorReasonCode = (typeof OPERATOR_REASON_CODES)[number];

export interface OperatorReason {
  code: OperatorReasonCode;
  /** Free text, ≤ 280 chars, scrubbed by assertOperatorNoteSafe. */
  note?: string;
}

export const OPERATOR_NOTE_MAX = 280;

/** Actions that MUST carry a structured reason. Everything else may. */
export const REASON_REQUIRED_ACTIONS: ReadonlySet<AuditActionType> = new Set<AuditActionType>([
  AuditAction.CUSTOMER_POLICY_ASSIGNED,
  AuditAction.CUSTOMER_POLICY_OVERLAY_CHANGED,
  AuditAction.CUSTOMER_COHORT_ASSIGNED,
  AuditAction.JOB_CADENCE_CHANGED,
  AuditAction.JOB_CADENCE_RESET,
  AuditAction.ACCOUNT_DEACTIVATED,
  AuditAction.ACCOUNT_REACTIVATED,
  // Break-glass /admin actions (grants, 2FA reset) stay on their existing audit
  // shape in P1; adding a reason there is P2 (the surface is SYSTEM_ADMIN-only).
]);

export interface OperatorActionInput {
  actor: { userId: string; via: "PLATFORM_GRANT" | "SYSTEM_ADMIN"; area?: string };
  action: AuditActionType;
  target: { kind: OperatorTargetKind; id: string };
  reason?: OperatorReason;
  /** Facts/ids/enum values/counts only — never balances, amounts, prompts or credentials. */
  change?: { before: Record<string, unknown> | null; after: Record<string, unknown> | null };
  execution?: { jobRunId?: string | null; refreshExecutionId?: string | null; commandId?: string | null };
  result: "SUCCESS" | "FAILURE" | "REFUSED";
  /** Extra non-sensitive detail (counts, outcome words). Fixed envelope keys win on collision. */
  detail?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export class OperatorActionValidationError extends Error {
  constructor(message: string) { super(message); this.name = "OperatorActionValidationError"; }
}

const LOOKS_LIKE_EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const LONG_DIGIT_RUN   = /\d{4,}/;
const SECRET_WORDS     = /\b(password|passwd|secret|token|api[_-]?key|bearer|private key)\b/i;

/** Returns the note trimmed, or throws when it is too long or looks like PII / a secret. */
export function assertOperatorNoteSafe(note: string): string {
  const trimmed = note.trim();
  if (trimmed.length > OPERATOR_NOTE_MAX) throw new OperatorActionValidationError(`Reason note exceeds ${OPERATOR_NOTE_MAX} characters.`);
  if (LOOKS_LIKE_EMAIL.test(trimmed)) throw new OperatorActionValidationError("Reason note must not contain an email address.");
  if (LONG_DIGIT_RUN.test(trimmed))   throw new OperatorActionValidationError("Reason note must not contain long digit runs (account or card numbers).");
  if (SECRET_WORDS.test(trimmed))     throw new OperatorActionValidationError("Reason note must not contain credential material.");
  return trimmed;
}

export function isOperatorReasonCode(v: unknown): v is OperatorReasonCode {
  return typeof v === "string" && (OPERATOR_REASON_CODES as readonly string[]).includes(v);
}

/** Parse an untrusted reason object from a request body. Throws on an invalid shape. */
export function parseOperatorReason(raw: unknown): OperatorReason {
  if (typeof raw !== "object" || raw === null) throw new OperatorActionValidationError("A reason { code, note? } is required.");
  const { code, note } = raw as { code?: unknown; note?: unknown };
  if (!isOperatorReasonCode(code)) throw new OperatorActionValidationError(`Reason code must be one of ${OPERATOR_REASON_CODES.join(", ")}.`);
  if (note !== undefined && typeof note !== "string") throw new OperatorActionValidationError("Reason note must be a string.");
  const safe = typeof note === "string" && note.trim() !== "" ? assertOperatorNoteSafe(note) : undefined;
  return safe ? { code, note: safe } : { code };
}

/**
 * PURE — the AuditLog create shape for one operator action. Throws when a
 * reason-required action has none or the note is unsafe, so a consequential
 * action can never commit without its audit.
 */
export function buildOperatorActionData(input: OperatorActionInput): Prisma.AuditLogUncheckedCreateInput {
  if (REASON_REQUIRED_ACTIONS.has(input.action) && !input.reason) {
    throw new OperatorActionValidationError(`${input.action} requires a structured reason.`);
  }
  const reason = input.reason
    ? { code: input.reason.code, ...(input.reason.note ? { note: assertOperatorNoteSafe(input.reason.note) } : {}) }
    : undefined;
  const metadata: Record<string, unknown> = {
    ...(input.detail ?? {}),
    actorType: input.actor.via === "SYSTEM_ADMIN" ? "SYSTEM_ADMIN" : "PLATFORM_OPERATOR",
    result: input.result,
    actor: { via: input.actor.via, ...(input.actor.area ? { area: input.actor.area } : {}) },
    target: { kind: input.target.kind, id: input.target.id },
    ...(reason ? { reason } : {}),
    ...(input.change ? { change: input.change } : {}),
    ...(input.execution ? { execution: input.execution } : {}),
  };
  return {
    ...(input.target.kind === "USER" ? { userId: input.target.id } : {}),
    ...(input.target.kind === "SPACE" ? { spaceId: input.target.id } : {}),
    performedByAdminId: input.actor.userId,
    action: input.action,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    metadata: metadata as unknown as Prisma.InputJsonValue,
  };
}

/** The narrowest client the recorder needs — a transaction, systemDb, or a fake. */
export interface OperatorActionWriteClient {
  auditLog: { create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown> };
}

/**
 * Record one operator action. THROWS on validation (a consequential action must
 * not proceed un-audited) — write it inside the same transaction as the change.
 */
export async function recordOperatorAction(client: OperatorActionWriteClient, input: OperatorActionInput): Promise<void> {
  await client.auditLog.create({ data: buildOperatorActionData(input) });
}
