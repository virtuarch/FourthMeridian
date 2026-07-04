/**
 * lib/events/types.ts  (EV-1 Slice 0)
 *
 * Typed domain-event vocabulary for Fourth Meridian.
 *
 * PURE TYPES — zero runtime. This module declares no values and imports
 * nothing; it exists solely to give every important domain action one
 * canonical, compile-time-checked shape. Persistence and the type→AuditAction
 * binding live in lib/events/emit.ts (Slice 1), not here.
 *
 * Seam philosophy (see docs/investigations/EV-1_TYPED_DOMAIN_EVENT_SEAM_INVESTIGATION.md):
 *   - No event bus, no queue, no async fan-out, no event sourcing.
 *   - The existing AuditLog table is the store; TimelineEvent is the consumer
 *     contract. This union is the missing typed producer surface.
 *
 * Migration status of each variant:
 *   - EXERCISED  → a producer emits it today (Slice 1: SpaceRestored only).
 *   - PROVISIONAL → declared to lock canonical naming; its payload is pinned
 *     to the real call site when that producer is migrated in a later slice.
 */

/**
 * Fields common to every domain event. These map 1:1 onto existing AuditLog
 * columns (see lib/events/emit.ts) — no schema change is implied.
 */
export interface DomainEventEnvelope {
  /** → AuditLog.spaceId (persisted to the legacy "workspaceId" column). */
  spaceId?: string | null;
  /** → AuditLog.userId — the user who caused the action. */
  actorUserId?: string | null;
  /** → AuditLog.ipAddress. */
  ipAddress?: string | null;
  /** → AuditLog.performedByAdminId (set only for admin-on-behalf actions). */
  performedByAdminId?: string | null;
  /** → AuditLog.createdAt. Omit to accept the DB default now(). */
  occurredAt?: Date;
}

/**
 * The domain-event discriminated union, keyed on `type`.
 * Each `payload` becomes the canonical AuditLog.metadata shape for that event.
 */
export type DomainEvent =
  // ── Space lifecycle ─────────────────────────────────────────────────────
  | (DomainEventEnvelope & { type: "SpaceRestored"; payload: { name: string } }) // EXERCISED (Slice 1)
  | (DomainEventEnvelope & { type: "SpaceCreated"; payload: { name: string; isPublic: boolean; category: string } }) // PROVISIONAL
  | (DomainEventEnvelope & { type: "SpaceUpdated"; payload: { name: string; isPublic: boolean; category?: string } }) // PROVISIONAL
  // ── Members ─────────────────────────────────────────────────────────────
  | (DomainEventEnvelope & { type: "MemberInvited"; payload: { invitedEmail: string; role: string } }) // PROVISIONAL
  | (DomainEventEnvelope & { type: "MemberJoined"; payload: { userId: string } }) // PROVISIONAL
  | (DomainEventEnvelope & { type: "MemberRemoved"; payload: { removedUserId: string; removedName: string; newStatus: string } }) // EXERCISED (Slice 3) — removed by an admin/owner
  | (DomainEventEnvelope & { type: "MemberLeft"; payload: { removedUserId: string; removedName: string; newStatus: string } }) // EXERCISED (Slice 3) — self-leave
  | (DomainEventEnvelope & { type: "MemberRoleChanged"; payload: { targetUserId: string; targetName: string; oldRole: string; newRole: string } }) // PROVISIONAL
  // ── Account sharing ─────────────────────────────────────────────────────
  | (DomainEventEnvelope & { type: "AccountShared"; payload: { financialAccountId: string; accountName: string; visibilityLevel: string } }) // PROVISIONAL
  | (DomainEventEnvelope & { type: "AccountShareRevoked"; payload: { financialAccountId: string; accountName: string | null } }) // PROVISIONAL
  // ── Goals ───────────────────────────────────────────────────────────────
  | (DomainEventEnvelope & { type: "GoalCreated"; payload: { goalId: string; name: string; goalType: string; targetAmount: number | null } }) // PROVISIONAL
  | (DomainEventEnvelope & { type: "GoalCheckedIn"; payload: { goalId: string; goalName: string } }) // PROVISIONAL
  // ── Sync / snapshots ────────────────────────────────────────────────────
  | (DomainEventEnvelope & { type: "ConnectionSynced"; payload: { provider: string; plaidItemId: string; accountsUpdated: number; spacesSnapshotted: number } }) // EXERCISED (Slice 4) — audit-only, no handler
  | (DomainEventEnvelope & { type: "SnapshotGenerated"; payload: { date: string; netWorth: number } }); // PROVISIONAL

/** Convenience alias for a single event's discriminant string. */
export type DomainEventType = DomainEvent["type"];
