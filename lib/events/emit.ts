/**
 * lib/events/emit.ts  (EV-1 Slice 1)
 *
 * The single typed producer surface for domain events.
 *
 * Responsibilities in this slice:
 *   1. Persist the canonical AuditLog row for the event (this IS the existing
 *      behavior, centralized once). No schema change — the envelope + payload
 *      map onto the current AuditLog columns.
 *   2. Dispatch to an in-process handler registry — INERT in Slice 1 (empty
 *      registry, no-op loop). Handlers (e.g. snapshot regeneration) are wired
 *      in Slice 2.
 *
 * Deliberately NOT here (out of scope by direction): event bus, queue, broker,
 * cross-process pub/sub, async fan-out, event sourcing/replay. Dispatch is a
 * synchronous, in-process function call through a typed map.
 *
 * See docs/investigations/EV-1_TYPED_DOMAIN_EVENT_SEAM_INVESTIGATION.md and
 * docs/initiatives/ev1/implementation/EV-1_SLICE0_SLICE1_IMPLEMENTATION_CHECKLIST.md.
 */

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { AuditAction, type AuditActionType } from "@/lib/audit-actions";
import type { DomainEvent, DomainEventType } from "@/lib/events/types";

/** Either the shared Prisma client or an active transaction client. */
type DbClient = Prisma.TransactionClient | typeof db;

/**
 * Maps each emitted DomainEvent type to its canonical AuditAction string.
 *
 * PARTIAL BY DESIGN: it grows exactly one entry per producer migration slice.
 * Slice 1 migrates only SpaceRestored. Adding a variant to lib/events/types.ts
 * does NOT require an entry here until that producer is actually migrated — and
 * some future entries depend on AuditAction constants that do not exist yet
 * (MEMBER_JOINED, GOAL_CHECKED_IN, SNAPSHOT_GENERATED), which are added to
 * lib/audit-actions.ts in the slice that emits them, not now.
 */
const DOMAIN_EVENT_ACTION: Partial<Record<DomainEventType, AuditActionType>> = {
  SpaceRestored: AuditAction.SPACE_RESTORED,
};

/**
 * In-process, synchronous handler registry.
 *
 * INERT in Slice 1: no handlers are registered, so the dispatch loop in
 * emitDomainEvent performs no work. The snapshot-regeneration handler and
 * others are registered in Slice 2. Handlers are best-effort and must never
 * fail the caller — that isolation is added alongside the first real handler.
 */
type DomainEventHandler = (event: DomainEvent) => void;
const HANDLERS: Partial<Record<DomainEventType, DomainEventHandler[]>> = {};

/**
 * Emit a typed domain event.
 *
 * Persists the canonical AuditLog row, then runs any registered handlers
 * (none in Slice 1). Pass `ctx.tx` to persist inside an existing transaction
 * (preserves atomicity for producers that emit within `db.$transaction`);
 * omit it to use the shared client. The restore producer passes no `tx`.
 */
export async function emitDomainEvent(
  event: DomainEvent,
  ctx?: { tx?: Prisma.TransactionClient },
): Promise<void> {
  const client: DbClient = ctx?.tx ?? db;

  const action = DOMAIN_EVENT_ACTION[event.type];
  if (!action) {
    // Guards against emitting a not-yet-migrated event type. Unreachable for
    // SpaceRestored (the only mapped/exercised event in Slice 1).
    throw new Error(`emitDomainEvent: no AuditAction mapped for event type "${event.type}"`);
  }

  await client.auditLog.create({
    data: {
      userId:             event.actorUserId ?? null,
      spaceId:            event.spaceId ?? null,
      action,
      metadata:           event.payload as Prisma.InputJsonValue,
      ipAddress:          event.ipAddress ?? null,
      performedByAdminId: event.performedByAdminId ?? null,
      ...(event.occurredAt ? { createdAt: event.occurredAt } : {}),
    },
  });

  // ── Handler dispatch (INERT in Slice 1) ──────────────────────────────────
  // Registry is empty; this loop does nothing. Synchronous + in-process by
  // design — no bus, no queue, no async. Handlers arrive in Slice 2.
  const handlers = HANDLERS[event.type] ?? [];
  for (const handler of handlers) {
    handler(event);
  }
}
