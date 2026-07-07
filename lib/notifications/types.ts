/**
 * lib/notifications/types.ts  (OPS-3 S0)
 *
 * Pure types + the channel-adapter contract for the notification seam.
 * Zero runtime beyond type declarations; this module imports nothing and
 * instantiates nothing. Mirrors lib/email/types.ts (OPS-1 S0) deliberately —
 * same seam philosophy, one layer up.
 *
 * SEAM PHILOSOPHY (frozen — docs/initiatives/ops3/OPS3_IMPLEMENTATION_PLAN.md):
 *   - One chokepoint (lib/notifications/notify.ts, S1) will be the ONLY way
 *     any subsystem — including AI — reaches a user with a notification (F12).
 *   - Channel implementations live behind the ChannelAdapter contract, one
 *     adapter per file, so channels stay swappable and greppable. The email
 *     adapter (S4) DELEGATES to the existing lib/email/send.ts chokepoint —
 *     no second email path exists.
 *   - Delivery is best-effort and NON-THROWING end to end: adapters resolve a
 *     ChannelResult (the EmailResult contract, verbatim) instead of throwing
 *     into domain logic.
 *
 * ── DOCTRINE: the chokepoint invariant and its ONLY bypasses (F12) ──────────
 * Every user-facing notification flows Producer → createNotification() →
 * preference resolution → delivery adapters. The named bypasses are exhaustive:
 *   1. CEREMONY, not awareness — password-reset links, email-verification,
 *      email-change confirmations, invite-acceptance links. Test: if
 *      suppressing the message would BREAK a flow the user initiated, it is
 *      ceremony and goes straight to sendEmail(); if suppressing it merely
 *      leaves the user less informed, it is awareness and MUST use the
 *      chokepoint.
 *   2. The recipient no longer exists — the post-purge "account deleted"
 *      email (OPS-2 S7c) has no User row to notify.
 *   3. Operator alerting — PO-track alerts target the operator, are
 *      tenant-blind, and use the PO track's own delivery path. They must NOT
 *      ride the user-notification system (trust boundary below).
 *   4. Interactive request/response surfaces — AI chat replies and the
 *      on-demand Daily Brief are responses, not notifications. The
 *      notification is "your brief is ready", never the brief itself.
 *
 * ── DOCTRINE: the in-app delivery asymmetry (F8) ────────────────────────────
 * The Notification row (S1) IS the in-app delivery — no NotificationDelivery
 * row is written for the IN_APP channel. NotificationDelivery rows exist only
 * for EXTERNAL channels (EMAIL now; PUSH/SMS/WEBHOOK later). Consequence for
 * every future reader: in-app reach is measured on Notification, external
 * reach on NotificationDelivery. Stated here so no OPS-5 dashboard ever
 * double-counts or zero-counts in-app.
 *
 * ── DOCTRINE: Product Operations vs Platform Operations (F14) ───────────────
 * Notifications are PRODUCT OPERATIONS: tenant-scoped, finance-bearing,
 * rendered for the user. Platform Operations (OPS-5 / PO track) reads
 * delivery METADATA ONLY — counts, statuses, providers, timestamps — and is
 * never given Notification.title / Notification.body. The boundary doctrine:
 * platform-operations capability must remain structurally incapable of
 * reading product content.
 *
 * ── DOCTRINE: metadata pointer contracts (F6) ───────────────────────────────
 * A notification POINTS AT facts; it never duplicates them. Each registry
 * entry (lib/notifications/registry.ts) documents the exact key set its
 * `metadata Json` carries — domain pointers such as { inviteId },
 * { plaidItemId }, { adviceId }. Future stores' ids (job-run ids, canonical
 * event-instance ids if a later PO phase mints them) ride in as new metadata
 * keys with ZERO migration; a column is promoted only when an indexed query
 * exists. There is deliberately NO sourceEventId column (frozen ruling —
 * OPS3_SOURCEEVENTID_OWNERSHIP_REVIEW.md): the platform's only event-instance
 * store is AuditLog, already captured by the auditLogId soft ref.
 *
 * NOTE for PO1 Phase 1: createNotification() (S1) is a telemetry-chokepoint
 * candidate — when the telemetry seam lands, wrapping that one function
 * observes the entire notification system.
 */

/**
 * Delivery channels. IN_APP and EMAIL are implemented within OPS-3 (S1/S4);
 * PUSH / SMS / WEBHOOK are VOCABULARY ONLY — reserved channel names with no
 * adapter (an unimplemented channel simply has no adapter registered; the
 * ChannelAdapter contract is the seam, not stub files).
 */
export type NotificationChannel = "IN_APP" | "EMAIL" | "PUSH" | "SMS" | "WEBHOOK";

/**
 * Priority vocabulary. MUST stay value-identical to the Prisma
 * NotificationPriority enum when S1 lands (string literal ↔ enum, the
 * AuditAction idiom). CRITICAL is reserved for locked ACCOUNT_SECURITY types.
 */
export type NotificationPriorityValue = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";

/**
 * Preference-matrix categories (F11). Preferences are per category × channel;
 * `locked` categories (ACCOUNT_SECURITY) cannot be muted. DIGEST is a special
 * category: its single type is the digest itself (F13); its preference
 * surface is the digest-frequency setting (S6), not the matrix.
 */
export type NotificationCategory =
  | "ACCOUNT_SECURITY"
  | "SPACES"
  | "FINANCIAL"
  | "AI"
  | "PLATFORM"
  | "DIGEST";

/**
 * Registry-owned dedupe strategies (F3). Dedupe identifies the ongoing
 * CONDITION (deliberately collapsing occurrences — the opposite of instance
 * identity):
 *   none     — every occurrence notifies (the default; most types are
 *              naturally unique per occurrence).
 *   suppress — insert is a no-op while an un-archived row with the same
 *              dedupeKey exists; keys carry an ":open"-style suffix retired
 *              when the condition resolves, so a NEW outage notifies again.
 *              The only strategy implemented in OPS-3 v1.
 *   refresh  — bump the existing row to unread/top and update its metadata
 *              (occurrence-count collapse). VOCABULARY in OPS-3; implemented
 *              when a Wave-3 producer needs it.
 */
export type DedupeStrategy = "none" | "suppress" | "refresh";

/**
 * Per-type retention (F1/F9 lifecycle): read rows auto-archive after
 * `autoArchiveDays`; archived rows are deleted after `deleteDays`. Enforced
 * by the S6 cleanup job; tunable per registry entry without migration.
 */
export interface RetentionPolicy {
  autoArchiveDays: number;
  deleteDays: number;
}

/** Loosely-typed render input; each type's real shape is documented by its registry entry's pointerContract. */
export type NotificationRenderData = Readonly<Record<string, unknown>>;

/** Output of a registry entry's pure render function (title + optional body/href). */
export interface RenderedNotification {
  /** Bell/panel headline. Never empty. */
  title: string;
  /** Optional longer copy. */
  body?: string;
  /** Optional in-app destination, e.g. "/dashboard/connections". */
  href?: string;
}

/**
 * One registry entry — the single definition site for a notification type
 * (F1). Adding a type = one entry in lib/notifications/registry.ts + one
 * producer call site, and nothing else.
 */
export interface NotificationTypeDefinition {
  /** Canonical id, PO1 P0 grammar: DOMAIN_OBJECT_EVENT, past-tense SCREAMING_SNAKE (F2). Equals its registry key. */
  id: string;
  category: NotificationCategory;
  priority: NotificationPriorityValue;
  /** Channels enabled when the user has no override row (default-by-absence, F11). */
  defaultChannels: readonly NotificationChannel[];
  /** True = the user cannot mute this type's category (ACCOUNT_SECURITY). Uniform per category. */
  locked: boolean;
  retention: RetentionPolicy;
  /** May fold into the S6 digest email (declared at birth — F13). */
  digestable: boolean;
  dedupe: DedupeStrategy;
  /**
   * Key template when dedupe !== "none", e.g. "SYNC_FAILED:item:{plaidItemId}:open".
   * `{placeholders}` name pointerContract keys. Null when dedupe === "none".
   */
  dedupeKeyTemplate: string | null;
  /** Iconography key (lucide icon name) — UI stays switch-free. */
  icon: string;
  /**
   * VOCABULARY — declared, no producer wired yet (the EV-1 PROVISIONAL idiom).
   * WIRED      — a producer emits it (flipped by the wiring slice, in this file only).
   * All entries are VOCABULARY at S0 by definition.
   */
  status: "VOCABULARY" | "WIRED";
  /**
   * The metadata pointer contract (F6): the exact key set this type's
   * `metadata Json` carries (domain pointers + display payload). May be empty
   * — but must always be DECLARED, so lineage is structured doctrine, not ad hoc.
   */
  pointerContract: readonly string[];
  /** Pure render: data → { title, body?, href? }. No I/O. Must return a non-empty title even for empty data. */
  render: (data: NotificationRenderData) => RenderedNotification;
}

/**
 * What a producer hands the chokepoint (S1). `type` is narrowed to the
 * registry-derived NotificationTypeId at the call site
 * (NotificationInput<NotificationTypeId> — the id union lives in registry.ts,
 * which imports this module; the generic avoids a cycle).
 */
export interface NotificationInput<TId extends string = string> {
  /** Registry id — validated at the chokepoint; unknown ids throw at the producer (the emitDomainEvent idiom). */
  type: TId;
  /** Recipient — always a single user. */
  userId: string;
  /** Optional Space context. */
  spaceId?: string | null;
  /** Metadata per the type's pointerContract; also the render input. */
  data?: NotificationRenderData;
  /** Soft ref to the AuditLog fact, when the producer has it (F5). */
  auditLogId?: string | null;
  /** Overrides the type's default expiry behavior (e.g. mirrors SpaceInvite.expiresAt). */
  expiresAt?: Date | null;
}

/**
 * The outcome of one external-channel delivery attempt. Field-for-field the
 * EmailResult contract (lib/email/types.ts) so the S4 email adapter maps
 * sendEmail()'s result verbatim into a NotificationDelivery row:
 *   sent | captured | skipped | error.
 */
export interface ChannelResult {
  status: "sent" | "captured" | "skipped" | "error";
  /** Provider message id when status === "sent". */
  id?: string;
  /** Which transport produced this, e.g. "resend" | "capture". */
  provider?: string;
  /** Human-readable failure reason when status === "error". */
  error?: string;
}

/** A rendered, recipient-resolved message handed to an external-channel adapter. */
export interface ChannelMessage {
  /** Recipient user id. */
  userId: string;
  /** Recipient email address (resolved by the chokepoint for the EMAIL channel). */
  email?: string;
  type: string;
  category: NotificationCategory;
  priority: NotificationPriorityValue;
  title: string;
  body?: string;
  href?: string;
}

/**
 * The channel contract. One adapter per implemented channel, each in its own
 * file under lib/notifications/channels/ (S1: in-app is the Notification
 * insert itself and needs no adapter here; S4: email). Must never throw —
 * resolve a ChannelResult instead.
 */
export interface ChannelAdapter {
  /** Which channel this adapter serves. */
  readonly channel: NotificationChannel;
  /** Stable transport name, surfaced in ChannelResult.provider / NotificationDelivery.provider. */
  readonly name: string;
  /** Deliver a rendered message. Best-effort; never throws. */
  deliver(message: ChannelMessage): Promise<ChannelResult>;
}
