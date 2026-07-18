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
 * buildAuditData() is PURE (unit-tested). recordAuditEvent() is the thin adapter
 * that writes one row; it accepts an optional transaction client so a security
 * event can be persisted atomically alongside its state change.
 */

import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import type { AuditActionType } from "@/lib/audit-actions";

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

/** Either the shared client or a $transaction client — mirrors lib/events/emit.ts. */
type DbClient = Prisma.TransactionClient | typeof db;

/**
 * ADAPTER — write one audit row. Pass a transaction client to include the write
 * in a surrounding db.$transaction (preserves atomicity with the state change
 * being audited); otherwise it writes on the shared client.
 */
export async function recordAuditEvent(
  input: AuditEventInput,
  client: DbClient = db,
): Promise<void> {
  await client.auditLog.create({ data: buildAuditData(input) });
}
