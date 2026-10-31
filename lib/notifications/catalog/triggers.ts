/**
 * lib/notifications/catalog/triggers.ts  (Comms Center Phase A-1)
 *
 * The controlled trigger catalog (contract §5.1), READ-ONLY. Typed events only:
 * every trigger is code, with a typed payload, the recipient resolvers valid for
 * it and an emitter site. `Record<TriggerKey, …>` makes it exhaustive at
 * compile time. It deliberately contains NO comms-originated event (delivery
 * accepted / failed / read / bounced), so an automation can never trigger on
 * its own output (§5.7).
 *
 * `status` is AVAILABLE only where an emitter exists today; BUILD triggers
 * (emitter owner-approved, not yet added) and PROPOSED ones are "PROPOSED".
 * Payload fields are names + types + a PII flag — never values. Pure config.
 */

import type { RecipientResolver, TriggerItem, TriggerKey } from "@/lib/notifications/catalog/types";
import { TRIGGER_KEYS } from "@/lib/notifications/catalog/types";

const SUBJECT: RecipientResolver = { kind: "EVENT_SUBJECT_USER" };
const ACTOR: RecipientResolver = { kind: "EVENT_ACTOR_USER" };
const SPACE_ADMINS: RecipientResolver = { kind: "SPACE_ROLE", roles: ["OWNER", "ADMIN"] };

type Spec = Omit<TriggerItem, "key">;
const f = (name: string, type: string, pii = false) => ({ name, type, pii });

export const TRIGGER_CATALOG: Record<TriggerKey, Spec> = {
  // ── AVAILABLE
  "space.member.invited": {
    displayName: "Space member invited", source: "DOMAIN_EVENT", status: "AVAILABLE",
    description: "A Space owner or admin invited an existing user (MemberInvited, lib/events/types.ts).",
    payload: [f("spaceId", "string"), f("invitedUserId", "string"), f("role", "string")],
    resolvers: [SUBJECT, ACTOR],
  },
  "space.member.joined": {
    displayName: "Space member joined", source: "DOMAIN_EVENT", status: "AVAILABLE",
    description: "An invitee accepted and joined a Space (MemberJoined).",
    payload: [f("spaceId", "string"), f("userId", "string"), f("role", "string")],
    resolvers: [SUBJECT, SPACE_ADMINS],
  },
  "space.member.removed": {
    displayName: "Space member removed", source: "DOMAIN_EVENT", status: "AVAILABLE",
    description: "An owner or admin removed a member from a Space (MemberRemoved).",
    payload: [f("spaceId", "string"), f("removedUserId", "string"), f("newStatus", "string")],
    resolvers: [SUBJECT],
  },
  "space.member.role_changed": {
    displayName: "Space member role changed", source: "DOMAIN_EVENT", status: "AVAILABLE",
    description: "A member's role in a Space changed (MemberRoleChanged).",
    payload: [f("spaceId", "string"), f("targetUserId", "string"), f("oldRole", "string"), f("newRole", "string")],
    resolvers: [SUBJECT],
  },
  "plaid.item.sync_failed": {
    displayName: "Bank sync failed", source: "HEALTH_TRANSITION", status: "AVAILABLE",
    description: "A Plaid sync failed with a health-classified error (lib/plaid/sync-notifications.ts notifyItemSyncFailed).",
    payload: [f("plaidItemId", "string"), f("connectionState", "string")],
    resolvers: [SUBJECT],
  },
  "plaid.item.history_ready": {
    displayName: "Connection history ready", source: "JOB_OUTCOME", status: "AVAILABLE",
    description: "The deferred history pipeline finished for a Plaid item (notifyItemSyncComplete).",
    payload: [f("plaidItemId", "string")],
    resolvers: [SUBJECT],
  },
  "import.batch.completed": {
    displayName: "Import batch completed", source: "JOB_OUTCOME", status: "AVAILABLE",
    description: "A CSV import batch completed, with or without row errors (app/api/accounts/[id]/import).",
    payload: [f("batchId", "string"), f("rowCount", "number"), f("errorCount", "number")],
    resolvers: [SUBJECT],
  },
  // ── Owner-approved BUILD triggers, emitted since 2026-10-31
  "plaid.item.webhook_needs_reauth": {
    displayName: "Plaid webhook: sign-in required", source: "HEALTH_TRANSITION", status: "AVAILABLE",
    description: "The Plaid webhook moved an item to NEEDS_REAUTH (ITEM/ERROR ITEM_LOGIN_REQUIRED | INVALID_ACCESS_TOKEN); lib/plaid/webhook-health.ts notifies through notifyItemSyncFailed (SYNC_FAILED).",
    payload: [f("plaidItemId", "string")],
    resolvers: [SUBJECT],
  },
  "plaid.item.webhook_revoked": {
    displayName: "Plaid webhook: access revoked", source: "HEALTH_TRANSITION", status: "AVAILABLE",
    description: "The Plaid webhook reported a provider-side revocation (USER_PERMISSION_REVOKED | USER_ACCOUNT_REVOKED); lib/plaid/webhook-health.ts notifies through notifyItemSyncFailed (SYNC_FAILED), honouring the removed-by-user rule.",
    payload: [f("plaidItemId", "string")],
    resolvers: [SUBJECT],
  },
  "wallet.sync.failed": {
    displayName: "Wallet sync failed (sustained)", source: "HEALTH_TRANSITION", status: "AVAILABLE",
    description: "A wallet sync attempt failed while its connection has been degraded for at least 24 hours (lib/crypto/wallet-sync-notifications.ts, from syncWalletByChain).",
    payload: [f("financialAccountId", "string"), f("network", "string"), f("walletState", "string")],
    resolvers: [SUBJECT],
  },
  "account.registered": {
    displayName: "Account ready", source: "LIFECYCLE", status: "AVAILABLE",
    description: "A new account became usable: an invited registration commits (pre-verified), or an uninvited account verifies its email for the first time (lib/notifications/welcome.ts).",
    payload: [f("userId", "string"), f("invited", "boolean")],
    resolvers: [SUBJECT],
  },
  "platform.grant.created": {
    displayName: "Platform grant created", source: "LIFECYCLE", status: "AVAILABLE",
    description: "A Platform access grant was created (app/api/admin/platform-grants POST, after commit).",
    payload: [f("granteeUserId", "string"), f("area", "string"), f("level", "string")],
    resolvers: [SUBJECT],
  },
  "platform.grant.reinstated": {
    displayName: "Platform grant reinstated", source: "LIFECYCLE", status: "AVAILABLE",
    description: "A revoked Platform access grant was reinstated (app/api/admin/platform-grants POST, after commit).",
    payload: [f("granteeUserId", "string"), f("area", "string"), f("level", "string")],
    resolvers: [SUBJECT],
  },
  "platform.grant.level_changed": {
    displayName: "Platform grant level changed", source: "LIFECYCLE", status: "AVAILABLE",
    description: "An active Platform access grant changed level (app/api/admin/platform-grants POST, after commit).",
    payload: [f("granteeUserId", "string"), f("area", "string"), f("level", "string")],
    resolvers: [SUBJECT],
  },
  "platform.grant.revoked": {
    displayName: "Platform grant revoked", source: "LIFECYCLE", status: "AVAILABLE",
    description: "An active Platform access grant was revoked (app/api/admin/platform-grants/[grantId] PATCH, after commit).",
    payload: [f("granteeUserId", "string"), f("area", "string"), f("level", "string")],
    resolvers: [SUBJECT],
  },
  // ── PROPOSED
  "plaid.item.webhook_pending_expiration": {
    displayName: "Plaid webhook: access expiring", source: "HEALTH_TRANSITION", status: "PROPOSED",
    description: "The Plaid webhook reported PENDING_EXPIRATION / PENDING_DISCONNECT. Recorded only (lib/plaid/webhook-receiver.ts FIN-007); no event is emitted.",
    payload: [f("plaidItemId", "string")],
    resolvers: [SUBJECT],
  },
  "beta.invitation.expiring": {
    displayName: "Beta invitation expiring", source: "SCHEDULE", status: "PROPOSED",
    description: "A beta invitation is nearing its expiry. No emitter.",
    payload: [f("invitationId", "string"), f("expiresAt", "iso-date")],
    resolvers: [SUBJECT],
  },
  "beta.program.status_changed": {
    displayName: "Beta program status changed", source: "LIFECYCLE", status: "PROPOSED",
    description: "The Beta group was paused or ended. No emitter.",
    payload: [f("status", "string")],
    resolvers: [SUBJECT],
  },
  "wallet.import.completed": {
    displayName: "Wallet import completed", source: "JOB_OUTCOME", status: "PROPOSED",
    description: "A crypto wallet import completed. No emitter.",
    payload: [f("financialAccountId", "string"), f("network", "string")],
    resolvers: [SUBJECT],
  },
  "platform.maintenance.scheduled": {
    displayName: "Maintenance scheduled", source: "LIFECYCLE", status: "PROPOSED",
    description: "A maintenance window was scheduled. No emitter; a broadcast would be CONTROL (O-2).",
    payload: [f("window", "string")],
    resolvers: [{ kind: "PLATFORM_AREA_STAFF", area: "PLATFORM_OPS", includeSystemAdmin: true }],
  },
  "provider.incident.opened": {
    displayName: "Provider incident opened", source: "HEALTH_TRANSITION", status: "PROPOSED",
    description: "A provider incident was opened. No emitter.",
    payload: [f("provider", "string")],
    resolvers: [{ kind: "PLATFORM_AREA_STAFF", area: "PLATFORM_OPS", includeSystemAdmin: true }],
  },
  "schedule.daily": {
    displayName: "Daily schedule", source: "SCHEDULE", status: "PROPOSED",
    description: "Once per UTC day. Digest only; the digest is BUILD_OFF (O-14).",
    payload: [],
    resolvers: [SUBJECT],
  },
};

/** The trigger list in TRIGGER_KEYS order (AVAILABLE first, then BUILD, then PROPOSED). */
export function listTriggers(): TriggerItem[] {
  return TRIGGER_KEYS.map((key) => ({ key, ...TRIGGER_CATALOG[key] }));
}
