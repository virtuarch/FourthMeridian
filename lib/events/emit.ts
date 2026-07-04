/**
 * lib/events/emit.ts  (EV-1 Slice 1 → Slice 2)
 *
 * The single typed producer surface for domain events, now split into two
 * phases so a producer can persist inside a transaction while its side-effect
 * handlers run only after that transaction commits.
 *
 *   emitDomainEvent(event, ctx?)  — PERSIST phase.
 *     Writes the canonical AuditLog row (tx-aware). No schema change — the
 *     envelope + payload map onto existing AuditLog columns.
 *       • ctx.tx provided  → persist ONLY (in the caller's transaction). The
 *         caller must call dispatchDomainEvent(event) after the tx commits.
 *       • ctx.tx absent    → persist, then dispatch inline (post-persist ==
 *         post-commit when there is no surrounding transaction).
 *
 *   dispatchDomainEvent(event)    — DISPATCH phase.
 *     Runs the registered in-process handlers for event.type. Each handler is
 *     wrapped in its own try/catch (best-effort, non-fatal) so a handler
 *     failure never fails the originating request.
 *
 * Deliberately NOT here (out of scope by direction): event bus, queue, broker,
 * cross-process pub/sub, async fan-out / background processing, event
 * sourcing/replay. Dispatch is a synchronous, in-process await through a typed
 * map.
 *
 * See docs/investigations/EV-1_TYPED_DOMAIN_EVENT_SEAM_INVESTIGATION.md and
 * docs/initiatives/ev1/implementation/EV-1_SLICE2_IMPLEMENTATION_CHECKLIST.md.
 */

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { AuditAction, type AuditActionType } from "@/lib/audit-actions";
import type { DomainEvent, DomainEventType } from "@/lib/events/types";
import { regenerateSnapshotOnShareChange } from "@/lib/events/handlers/snapshot";

/** Either the shared Prisma client or an active transaction client. */
type DbClient = Prisma.TransactionClient | typeof db;

/**
 * Maps each emitted DomainEvent type to its canonical AuditAction string.
 *
 * PARTIAL BY DESIGN: it grows one entry per producer migration slice. All
 * referenced constants already exist in lib/audit-actions.ts (no edit there).
 *   Slice 1: SpaceRestored.
 *   Slice 2: AccountShared, AccountShareRevoked.
 */
const DOMAIN_EVENT_ACTION: Partial<Record<DomainEventType, AuditActionType>> = {
  SpaceRestored:       AuditAction.SPACE_RESTORED,
  AccountShared:       AuditAction.ACCOUNT_SHARED,
  AccountShareRevoked: AuditAction.ACCOUNT_REVOKED,
};

/**
 * In-process, synchronous handler registry. Handlers are best-effort and must
 * never fail the caller — dispatchDomainEvent enforces that isolation.
 *
 *   Slice 2: snapshot regeneration for the two share-set-changing events.
 */
type DomainEventHandler = (event: DomainEvent) => void | Promise<void>;
const HANDLERS: Partial<Record<DomainEventType, DomainEventHandler[]>> = {
  AccountShared:       [regenerateSnapshotOnShareChange],
  AccountShareRevoked: [regenerateSnapshotOnShareChange],
};

/**
 * DISPATCH phase — run the registered handlers for this event.
 *
 * Each handler runs in its own try/catch: a throw is logged via console.warn
 * and swallowed so the originating request still succeeds (mirrors the
 * pre-seam best-effort snapshot try/catch). Synchronous + in-process — no bus,
 * no queue, no background fan-out.
 *
 * Call this AFTER the transaction commits when the matching emitDomainEvent was
 * given a ctx.tx. When emitDomainEvent is called without a tx, it invokes this
 * for you.
 */
export async function dispatchDomainEvent(event: DomainEvent): Promise<void> {
  const handlers = HANDLERS[event.type] ?? [];
  for (const handler of handlers) {
    try {
      await handler(event);
    } catch (handlerErr) {
      console.warn(`[emitDomainEvent] handler for "${event.type}" failed (non-fatal):`, handlerErr);
    }
  }
}

/**
 * PERSIST phase — write the canonical AuditLog row for a typed domain event.
 *
 * Pass ctx.tx to persist inside an existing transaction (preserves atomicity
 * for producers that emit within db.$transaction); in that case handlers are
 * NOT dispatched here — call dispatchDomainEvent(event) after the tx commits.
 * Without ctx.tx, the row is persisted on the shared client and handlers are
 * dispatched inline.
 */
export async function emitDomainEvent(
  event: DomainEvent,
  ctx?: { tx?: Prisma.TransactionClient },
): Promise<void> {
  const client: DbClient = ctx?.tx ?? db;

  const action = DOMAIN_EVENT_ACTION[event.type];
  if (!action) {
    // Guards against emitting a not-yet-migrated event type.
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

  // No surrounding transaction → persist is already committed, so it is safe to
  // dispatch handlers inline. With a tx, the caller dispatches post-commit.
  if (!ctx?.tx) {
    await dispatchDomainEvent(event);
  }
}
