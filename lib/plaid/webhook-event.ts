/**
 * lib/plaid/webhook-event.ts  (OPERATIONALIZATION P0 — Workstream B)
 *
 * THE APPEND-ONLY VERIFIED-WEBHOOK FACT WRITER — one row per signature-verified
 * Plaid webhook, written by the receiver with its handling verdict.
 *
 * ⚠️ TELEMETRY NEVER BREAKS THE ACK. Non-throwing, the same posture as
 * recordAiInvocation / recordProviderCall: a ledger failure must never turn a
 * verified delivery into a non-200, or Plaid would retry it.
 *
 * ⚠️ ALLOWLISTED FIELDS ONLY. The provider's opaque item_id, our Item id (a soft
 * reference), the webhook type/code, Plaid's error CODE, the status we held, the
 * owner state, the verdict and the environment. Never the payload, never a
 * token, never an account id, never a message string.
 *
 * ⚠️ fm_system. PlaidWebhookEvent is revoked from fm_app and has no tenant
 * column (migration 20261007100000); the system role is the only authority that
 * can write it, and the default says so.
 */

import { systemDb } from "@/lib/db";
import { redactedErrorForLog } from "@/lib/plaid/errors";

export interface PlaidWebhookEventInput {
  externalItemId: string | null;
  plaidItemId: string | null;
  webhookType: string;
  webhookCode: string;
  errorCode: string | null;
  itemStatusAtReceipt: string | null;
  ownerInactive: boolean | null;
  handling: string;
  environment: string;
}

/** Narrow write-client seam — the AiInvocationWriteClient idiom. */
export interface PlaidWebhookEventWriteClient {
  plaidWebhookEvent: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
}

/** Record one verified webhook. Never throws, never rejects. */
export async function recordPlaidWebhookEvent(
  input: PlaidWebhookEventInput,
  client: PlaidWebhookEventWriteClient = systemDb as unknown as PlaidWebhookEventWriteClient,
): Promise<void> {
  try {
    await client.plaidWebhookEvent.create({
      data: {
        externalItemId:      input.externalItemId,
        plaidItemId:         input.plaidItemId,
        webhookType:         input.webhookType,
        webhookCode:         input.webhookCode,
        errorCode:           input.errorCode,
        itemStatusAtReceipt: input.itemStatusAtReceipt,
        ownerInactive:       input.ownerInactive,
        handling:            input.handling,
        environment:         input.environment,
      },
    });
  } catch (e) {
    console.warn("[plaid webhook] recordPlaidWebhookEvent failed (non-fatal):", redactedErrorForLog(e));
  }
}
