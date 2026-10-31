/**
 * lib/notifications/connection-attention.ts
 *
 * The typed CONNECTION STATE a SYNC_FAILED ("institution needs attention")
 * notification carries, and the copy + CTA each state renders. Pure: no I/O.
 *
 * WHAT THE PRODUCER CAN ACTUALLY TELL APART. notifyItemSyncFailed
 * (lib/plaid/sync-notifications.ts) fires only AFTER a call site has written
 * the health-classified PlaidItem.status (classifyPlaidErrorForHealth →
 * setPlaidItemHealth, or the operator request-reauth route). It reads that
 * status back from the row, so the state is derived from data already there —
 * no call site passes anything new:
 *
 *   PlaidItem.status   connectionState      why
 *   NEEDS_REAUTH    →  "reauth-required"    ITEM_LOGIN_REQUIRED / INVALID_ACCESS_TOKEN,
 *                                           or an operator's request-reauth
 *   REVOKED         →  "disconnected"       the item was removed (itemRemove). Reached
 *                                           when a user removes a connection while a
 *                                           sync is in flight: the late failure's
 *                                           ERROR write is dropped for a REVOKED item
 *                                           (lib/connections/health-transitions.ts),
 *                                           the call site still notifies, and the
 *                                           status read back is REVOKED. OWNER
 *                                           DECISION 2026-10-31: a connection the
 *                                           user removed sends no sync-failure
 *                                           notification of any kind, in ANY state
 *                                           (sync-notifications.ts removedByUser);
 *                                           a provider revocation (webhook
 *                                           USER_PERMISSION_REVOKED) still notifies.
 *   ERROR / ACTIVE /
 *   missing/unknown →  "sync-failed"        the conservative default
 *
 * NOT PRODUCED, deliberately:
 *   - "temporary, will retry": transient Plaid errors (ITEM_LOCKED,
 *     INSTITUTION_DOWN, 429 …) classify to null and NEVER notify. An ERROR item
 *     is excluded from the scheduled sync (it selects status ACTIVE only), so
 *     the default copy must not promise an automatic retry.
 *   - "stale" (no successful sync for N): no producer observes it.
 *
 * Unknown or missing state always renders the "sync-failed" copy, never
 * "disconnected": a failure is never called a disconnection, and nothing here
 * ever says a reconnection succeeded.
 */

export const CONNECTION_STATES = ["sync-failed", "reauth-required", "disconnected"] as const;
export type ConnectionAttentionState = (typeof CONNECTION_STATES)[number];

/** PlaidItem.status (as read back by the producer) → the state the email may claim. */
export function connectionStateFromItemStatus(status: string | null | undefined): ConnectionAttentionState {
  if (status === "NEEDS_REAUTH") return "reauth-required";
  if (status === "REVOKED") return "disconnected";
  return "sync-failed";
}

/** Narrow untrusted render data; anything unrecognised is the conservative default. */
export function parseConnectionState(value: unknown): ConnectionAttentionState {
  return typeof value === "string" && (CONNECTION_STATES as readonly string[]).includes(value)
    ? (value as ConnectionAttentionState)
    : "sync-failed";
}

export interface ConnectionAttentionCopy {
  title: string;
  body: string;
  actionLabel: string;
}

/** The copy and CTA label per state. `institution` is already non-empty (registry fallback). */
export function connectionAttentionCopy(state: unknown, institution: string): ConnectionAttentionCopy {
  switch (parseConnectionState(state)) {
    case "reauth-required":
      return {
        title:       `${institution} needs you to sign in again`,
        body:        `To keep your accounts up to date, sign in to ${institution} again from Fourth Meridian. Until then, new data from ${institution} can't sync.`,
        actionLabel: `Reconnect ${institution}`,
      };
    case "disconnected":
      return {
        title:       `${institution} is disconnected`,
        body:        `Fourth Meridian can no longer sync ${institution}. Reconnect it to resume updates.`,
        actionLabel: "Reconnect",
      };
    case "sync-failed":
      return {
        title:       `We couldn't sync ${institution}`,
        body:        "Your existing data is still available. Review the connection in Fourth Meridian to see what's needed.",
        actionLabel: "Review connection",
      };
  }
}
