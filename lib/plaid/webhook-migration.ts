/**
 * lib/plaid/webhook-migration.ts  (Release 2 — domain split)
 *
 * I/O around the pure plan in webhook-migration.core.ts: read an Item's current
 * webhook from Plaid (/item/get), repoint it (/item/webhook/update), and read it
 * back to VERIFY the provider now holds the target. One Item per call — the
 * operator selects Items explicitly; there is no "migrate everything" loop.
 *
 * ⚠️ The access token is decrypted here, used for the provider call, and never
 * returned, logged or placed in an error message. Errors surface as Plaid's
 * error CODE only (redactedErrorForLog idiom).
 *
 * Dependencies are injected so the whole sequence is unit-tested against a fake
 * Plaid without a live Item (webhook-migration.test.ts).
 */
import "server-only";

import type { PlaidApi } from "plaid";
import { db } from "@/lib/db";
import { systemDb } from "@/lib/db";
import { plaidClient } from "@/lib/plaid/client";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { env } from "@/lib/env";
import {
  expectedWebhookUrl,
  planWebhookMigration,
  redactWebhookUrl,
  type WebhookMigrationPlan,
} from "@/lib/plaid/webhook-migration.core";

export const WEBHOOK_UPDATE_ACKNOWLEDGED = "WEBHOOK_UPDATE_ACKNOWLEDGED";

export interface WebhookMigrationItem {
  id: string;
  status: string;
  institutionName: string;
  encryptedToken: string;
}

export interface WebhookMigrationDeps {
  loadItem: (id: string) => Promise<WebhookMigrationItem | null>;
  plaid: Pick<PlaidApi, "itemGet" | "itemWebhookUpdate">;
  decrypt: (ciphertext: string) => string;
  appUrl: string | undefined;
  /** Newest WEBHOOK_UPDATE_ACKNOWLEDGED received for this Item, if any. */
  lastAcknowledgedAt: (itemId: string) => Promise<Date | null>;
}

export function defaultWebhookMigrationDeps(): WebhookMigrationDeps {
  return {
    loadItem: (id) => db.plaidItem.findUnique({
      where:  { id },
      select: { id: true, status: true, institutionName: true, encryptedToken: true },
    }),
    plaid: plaidClient,
    decrypt: (c) => decryptWithPurpose(c, EncryptionPurpose.PLAID_ACCESS_TOKEN),
    appUrl: env.NEXT_PUBLIC_APP_URL,
    lastAcknowledgedAt: async (itemId) => {
      const row = await systemDb.plaidWebhookEvent.findFirst({
        where:   { plaidItemId: itemId, webhookType: "ITEM", webhookCode: WEBHOOK_UPDATE_ACKNOWLEDGED },
        orderBy: { receivedAt: "desc" },
        select:  { receivedAt: true },
      });
      return row?.receivedAt ?? null;
    },
  };
}

/** Plaid's error code for an axios-shaped Plaid error; never the message. */
export function plaidErrorCode(e: unknown): string {
  const data = (e as { response?: { data?: { error_code?: unknown } } })?.response?.data;
  return typeof data?.error_code === "string" ? data.error_code : "UNKNOWN_ERROR";
}

export interface WebhookMigrationView {
  itemId: string;
  institution: string;
  status: string;
  plan: WebhookMigrationPlan;
  lastAcknowledgedAt: string | null;
}

export type WebhookMigrationReadResult =
  | { ok: true; view: WebhookMigrationView }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "PROVIDER_ERROR"; providerError: string };

/** Dry run: what would happen for this Item. Reads Plaid; writes nothing. */
export async function inspectItemWebhook(itemId: string, deps: WebhookMigrationDeps): Promise<WebhookMigrationReadResult> {
  const item = await deps.loadItem(itemId);
  if (!item) return { ok: false, code: "NOT_FOUND" };
  const target = expectedWebhookUrl(deps.appUrl);
  let current: string | null = null;
  if (item.status === "ACTIVE" || item.status === "NEEDS_REAUTH") {
    try {
      const res = await deps.plaid.itemGet({ access_token: deps.decrypt(item.encryptedToken) });
      current = res.data.item.webhook ?? null;
    } catch (e) {
      return { ok: false, code: "PROVIDER_ERROR", providerError: plaidErrorCode(e) };
    }
  }
  const ack = await deps.lastAcknowledgedAt(item.id);
  return {
    ok: true,
    view: {
      itemId: item.id,
      institution: item.institutionName,
      status: item.status,
      plan: planWebhookMigration({ status: item.status, currentWebhook: current, target }),
      lastAcknowledgedAt: ack ? ack.toISOString() : null,
    },
  };
}

export type WebhookMigrationApplyResult =
  | { ok: true; outcome: "UPDATED" | "ALREADY_CURRENT"; before: string | null; after: string | null; target: string }
  | { ok: false; code: "NOT_FOUND" | "NO_TARGET" | "SKIP_STATUS" | "TARGET_MISMATCH"; message: string; before?: string | null }
  | { ok: false; code: "PROVIDER_ERROR"; providerError: string; before: string | null }
  | { ok: false; code: "NOT_VERIFIED"; before: string | null; after: string | null; target: string };

/**
 * Repoint ONE Item. `expectedTarget` is what the operator saw in the dry run;
 * the server recomputes the target and refuses a mismatch, so an env change
 * between preview and apply can never send an Item somewhere unreviewed.
 * Sequence: get (before) → skip if already current → update → get (verify).
 */
export async function applyItemWebhook(
  itemId: string,
  expectedTarget: string,
  deps: WebhookMigrationDeps,
): Promise<WebhookMigrationApplyResult> {
  const item = await deps.loadItem(itemId);
  if (!item) return { ok: false, code: "NOT_FOUND", message: "Connection not found." };
  const target = expectedWebhookUrl(deps.appUrl);
  if (!target) return { ok: false, code: "NO_TARGET", message: "This deployment has no public HTTPS app URL." };
  if (expectedTarget !== target) {
    return { ok: false, code: "TARGET_MISMATCH", message: "The webhook target changed since the dry run. Review it again." };
  }
  if (item.status !== "ACTIVE" && item.status !== "NEEDS_REAUTH") {
    return { ok: false, code: "SKIP_STATUS", message: `Item status ${item.status} has no usable access token.` };
  }

  const accessToken = deps.decrypt(item.encryptedToken);
  let beforeRaw: string | null;
  try {
    beforeRaw = (await deps.plaid.itemGet({ access_token: accessToken })).data.item.webhook ?? null;
  } catch (e) {
    return { ok: false, code: "PROVIDER_ERROR", providerError: plaidErrorCode(e), before: null };
  }
  const before = redactWebhookUrl(beforeRaw);
  if (beforeRaw === target) return { ok: true, outcome: "ALREADY_CURRENT", before, after: before, target };

  try {
    await deps.plaid.itemWebhookUpdate({ access_token: accessToken, webhook: target });
  } catch (e) {
    return { ok: false, code: "PROVIDER_ERROR", providerError: plaidErrorCode(e), before };
  }

  let afterRaw: string | null;
  try {
    afterRaw = (await deps.plaid.itemGet({ access_token: accessToken })).data.item.webhook ?? null;
  } catch (e) {
    return { ok: false, code: "PROVIDER_ERROR", providerError: plaidErrorCode(e), before };
  }
  const after = redactWebhookUrl(afterRaw);
  if (afterRaw !== target) return { ok: false, code: "NOT_VERIFIED", before, after, target };
  return { ok: true, outcome: "UPDATED", before, after, target };
}
