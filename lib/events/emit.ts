/**
 * lib/events/emit.ts  (EV-1 Slice 1 → Slice 2)
 *
 * The single typed producer surface for domain events, now split into two
 * phases so a producer can persist inside a transaction while its side-effect
 * handlers run only after that transaction commits.
 *
 *   emitDomainEvent(client, event)  — PERSIST phase.
 *     Writes the canonical AuditLog row on the client it is handed. No schema
 *     change — the envelope + payload map onto existing AuditLog columns.
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
 * ── RLS SLICE B: THE CLIENT IS A PARAMETER, NOT AN IMPORT ────────────────────
 * This file imports no Prisma client. `emitDomainEvent` takes the client it
 * writes through as its FIRST, REQUIRED argument, so the authority an audit row
 * is written under is decided — visibly — by the caller that knows who the user
 * is, and TypeScript fails at any call site that forgets to say. It was
 * previously `ctx?.tx ?? db`: an optional parameter whose DEFAULT was the
 * migration principal, which is the exact shape this programme is removing —
 * every caller that said nothing silently got BYPASSRLS.
 *
 * ⚠️ AND WHETHER TO DISPATCH IS NOW A CAPABILITY TEST, NOT A FLAG. A
 * `Prisma.TransactionClient` has no `$transaction` method; a `PrismaClient`
 * does. So `'$transaction' in client` decides whether the persist is already
 * inside somebody's transaction — in which case the handlers must NOT run until
 * it commits, and the caller dispatches — or stands alone, in which case
 * post-persist IS post-commit and dispatching inline is safe. That is exactly
 * what the old `ctx?.tx` flag meant, read off the client instead of asserted
 * beside it, so the two can no longer disagree.
 *
 * ⚠️ WHY A HANDLER MUST NEVER RUN INSIDE withTenantDb. The registry below
 * regenerates snapshots and writes notifications — long, multi-table work, and
 * `regenerateSnapshotOnShareChange` reaches rows the acting user may not be able
 * to see. A boundary that wrapped persist AND dispatch would hold one Postgres
 * transaction open across all of it. So a tenant-scoped producer enters the
 * boundary for the persist alone and calls `dispatchDomainEvent` after it
 * returns, which is what the capability test above makes it do.
 *
 * See docs/investigations/EV-1_TYPED_DOMAIN_EVENT_SEAM_INVESTIGATION.md and
 * docs/initiatives/ev1/implementation/EV-1_SLICE2_IMPLEMENTATION_CHECKLIST.md.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { AuditAction, type AuditActionType } from "@/lib/audit-actions";
import type { DomainEvent, DomainEventType } from "@/lib/events/types";
import { regenerateSnapshotOnShareChange } from "@/lib/events/handlers/snapshot";
import { notifySpaceInviteReceived } from "@/lib/events/handlers/space-invite-notification";
import {
  notifyMemberRemoved,
  notifyMemberRoleChanged,
  notifySpaceInviteAccepted,
} from "@/lib/events/handlers/space-member-notifications";

/**
 * What this file may be handed: ONE Prisma model, plus the ABILITY to open a
 * transaction when — and only when — the caller is not already inside one.
 *
 * ⚠️ `auditLog` AND NOTHING ELSE. A `Pick` is the invariant in the type system:
 * no caller can pass something through which the event seam could reach
 * `financialAccount`, `spaceMember` or any other model. Persisting an event is
 * one INSERT; the type says so.
 *
 * ⚠️ `$transaction` IS OPTIONAL BY CONSTRUCTION. A transaction-scoped client does
 * not have it, and that absence is the signal that a transaction is already open.
 */
export type DomainEventClient =
  Pick<Prisma.TransactionClient, "auditLog"> & Partial<Pick<PrismaClient, "$transaction">>;

/**
 * Maps each emitted DomainEvent type to its canonical AuditAction string.
 *
 * PARTIAL BY DESIGN: it grows one entry per producer migration slice. All
 * referenced constants already exist in lib/audit-actions.ts (no edit there).
 *   Slice 1: SpaceRestored.
 *   Slice 2: AccountShared, AccountShareRevoked.
 *   Slice 3: MemberRemoved (canonical MEMBER_REMOVED), MemberLeft (SPACE_LEAVE).
 *   Slice 4: ConnectionSynced (PLAID_REFRESH) — audit-only, no handler.
 *   Slice 5B: MemberRoleChanged (MEMBER_ROLE_CHANGED), GoalCreated
 *             (GOAL_CREATED) — audit-only, no handlers.
 *   Timeline T-1: MemberInvited (MEMBER_INVITED), MemberJoined (MEMBER_JOINED)
 *             — audit-only, no handlers; net-new Timeline-visible rows.
 *   Timeline T-2: GoalCheckedIn (GOAL_CHECKED_IN) — audit-only, no handler;
 *             net-new Timeline-visible row.
 */
const DOMAIN_EVENT_ACTION: Partial<Record<DomainEventType, AuditActionType>> = {
  SpaceRestored:       AuditAction.SPACE_RESTORED,
  AccountShared:       AuditAction.ACCOUNT_SHARED,
  AccountShareRevoked: AuditAction.ACCOUNT_REVOKED,
  MemberRemoved:       AuditAction.MEMBER_REMOVED,
  MemberLeft:          AuditAction.SPACE_LEAVE,
  ConnectionSynced:    AuditAction.PLAID_REFRESH,
  MemberRoleChanged:   AuditAction.MEMBER_ROLE_CHANGED,
  GoalCreated:         AuditAction.GOAL_CREATED,
  MemberInvited:       AuditAction.MEMBER_INVITED,
  MemberJoined:        AuditAction.MEMBER_JOINED,
  GoalCheckedIn:       AuditAction.GOAL_CHECKED_IN,
};

/**
 * In-process, synchronous handler registry. Handlers are best-effort and must
 * never fail the caller — dispatchDomainEvent enforces that isolation.
 *
 *   Slice 2: snapshot regeneration for the two share-set-changing events.
 *   Slice 3: same handler for member removal/leave (their share links are
 *            revoked in the same request, changing the space's active shares).
 *   OPS-3 S1: SPACE_INVITE_RECEIVED notification on MemberInvited (the first
 *            notification producer; see lib/notifications/create.ts).
 *   OPS-3 S5 Wave 2: Spaces membership notifications on MemberJoined /
 *            MemberRemoved / MemberRoleChanged (MemberLeft deliberately has
 *            no notification handler — wave-entry ruling; snapshot only).
 */
type DomainEventHandler = (event: DomainEvent) => void | Promise<void>;
const HANDLERS: Partial<Record<DomainEventType, DomainEventHandler[]>> = {
  AccountShared:       [regenerateSnapshotOnShareChange],
  AccountShareRevoked: [regenerateSnapshotOnShareChange],
  MemberRemoved:       [regenerateSnapshotOnShareChange, notifyMemberRemoved],
  MemberLeft:          [regenerateSnapshotOnShareChange],
  MemberInvited:       [notifySpaceInviteReceived],
  MemberJoined:        [notifySpaceInviteAccepted],
  MemberRoleChanged:   [notifyMemberRoleChanged],
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
 * PERSIST phase — write the canonical AuditLog row for a typed domain event,
 * under the authority the caller supplies.
 *
 * A transaction-scoped client (the tenant boundary's `tx`, or a producer's own
 * `db.$transaction` callback) persists inside that transaction and does NOT
 * dispatch — the caller must call dispatchDomainEvent(event) after it commits.
 * A full client stands alone, so post-persist is post-commit and the handlers
 * run inline, exactly as the no-ctx form always did.
 */
export async function emitDomainEvent(
  client: DomainEventClient,
  event: DomainEvent,
): Promise<void> {
  // See the header: the client's SHAPE says whether a transaction is already
  // open, so nothing has to be asserted beside it and then kept in step.
  const standalone = "$transaction" in client && typeof client.$transaction === "function";

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
  // dispatch handlers inline. Inside one, the caller dispatches post-commit.
  if (standalone) {
    await dispatchDomainEvent(event);
  }
}
