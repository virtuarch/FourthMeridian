/**
 * lib/plaid/webhook-health.ts  (FIN-007)
 *
 * The production default for the webhook receiver's health transition: the
 * canonical chokepoint, run under the SYSTEM principal (a webhook has no
 * tenant identity), with the authority stated rather than defaulted.
 *
 * OWNER-APPROVED 2026-10-31 — "your bank needs you to sign in again". After the
 * webhook writes NEEDS_REAUTH (ITEM/ERROR ITEM_LOGIN_REQUIRED |
 * INVALID_ACCESS_TOKEN) or REVOKED (USER_PERMISSION_REVOKED |
 * USER_ACCOUNT_REVOKED), the owner is told through the EXISTING connection-
 * attention path — notifyItemSyncFailed (lib/plaid/sync-notifications.ts) —
 * not a new type:
 *   - the state ("reauth-required" / "disconnected") is read back from the
 *     status this transition just wrote, exactly as for every other call site;
 *   - the SAME suppress-while-open key "SYNC_FAILED:item:{id}:open" as the cron
 *     and the interactive syncs, so a webhook and a failing sync of the same
 *     outage produce ONE notice; it is retired by the next successful sync or
 *     relink, as before;
 *   - the removed-by-user rule applies (no notice for a connection the user
 *     removed); a REVOKED item is never re-notified here (the receiver skips the
 *     transition for an item that is already REVOKED, and the health chokepoint
 *     refuses to leave REVOKED).
 * PENDING_EXPIRATION / PENDING_DISCONNECT are deliberately NOT here: they move
 * no health state (the item keeps syncing until the date — webhook-receiver.ts
 * FIN-007), so there is no "needs sign-in" fact to report yet, and the open key
 * would be retired by the very next successful sync. Catalogued as BUILD
 * (PLAID_ITEM_PENDING_EXPIRATION).
 *
 * The notification is best-effort (notifyItemSyncFailed never throws): a
 * notification problem never turns a verified webhook into a non-200.
 */
import { systemDb } from "@/lib/db";
import { setPlaidItemHealth } from "@/lib/connections/health-transitions";
import { notifyItemSyncFailed, type PlaidItemReadClient } from "@/lib/plaid/sync-notifications";
import type { WebhookHealthTransition } from "@/lib/plaid/webhook-receiver";

export interface WebhookHealthDeps {
  setHealth?: (plaidItemId: string, t: WebhookHealthTransition) => Promise<void>;
  notify?: (plaidItemId: string) => Promise<void>;
}

export async function applyWebhookHealthTransition(plaidItemId: string, t: WebhookHealthTransition, deps: WebhookHealthDeps = {}): Promise<void> {
  const setHealth = deps.setHealth
    ?? ((id: string, tr: WebhookHealthTransition) => setPlaidItemHealth(id, { status: tr.status, errorCode: tr.errorCode }, undefined, systemDb));
  await setHealth(plaidItemId, t);
  // After the write, so the producer reads back the status it must describe.
  // SYSTEM authority for the read-back too: a webhook has no tenant identity,
  // so the tenant client would see no item and never notify.
  await (deps.notify ?? ((id: string) => notifyItemSyncFailed(id, { itemClient: systemDb as unknown as PlaidItemReadClient })))(plaidItemId);
}
