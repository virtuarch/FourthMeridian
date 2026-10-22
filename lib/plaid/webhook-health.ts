/**
 * lib/plaid/webhook-health.ts  (FIN-007)
 *
 * The production default for the webhook receiver's health transition: the
 * canonical chokepoint, run under the SYSTEM principal (a webhook has no
 * tenant identity), with the authority stated rather than defaulted.
 */
import { systemDb } from "@/lib/db";
import { setPlaidItemHealth } from "@/lib/connections/health-transitions";
import type { WebhookHealthTransition } from "@/lib/plaid/webhook-receiver";

export async function applyWebhookHealthTransition(plaidItemId: string, t: WebhookHealthTransition): Promise<void> {
  await setPlaidItemHealth(plaidItemId, { status: t.status, errorCode: t.errorCode }, undefined, systemDb);
}
