/**
 * lib/plaid/webhook-receiver.ts  (OPERATIONALIZATION P0 — Workstream B)
 *
 * THE WEBHOOK RECEIVER'S DECISION, as a pure function with injected I/O, so the
 * route (app/api/plaid/webhook/route.ts) is a thin adapter and every branch is
 * unit-testable without Plaid, a database or a Next request.
 *
 * ── Why this exists (2026-10-07) ─────────────────────────────────────────────
 * The receiver resolved the Item by `item_id` with NO status filter and handed
 * it to the full deferred pipeline. Nothing downstream reads `status` or the
 * owner's `deactivatedAt` either: syncPlaidItemFromWebhook checks platform-wide
 * admission only, the lock claim matches on `id`, and runDeferredHistorySync /
 * syncTransactionsForItem go straight to the provider. The daily cron
 * (jobs/sync-banks.ts) and the resume backstop filter `status: ACTIVE, user:
 * { deactivatedAt: null }`; the webhook path was the one producer that did not.
 * So a delivery for a REVOKED Item (whose token we still hold) ran the whole
 * pipeline against Plaid. The health chokepoint refuses REVOKED→ACTIVE
 * (lib/connections/health-transitions.ts), so the harm was provider calls,
 * ledger rows and log noise rather than resurrection — but it was real, it was
 * billable, and it was invisible, because every non-trigger webhook (ITEM/ERROR,
 * USER_PERMISSION_REVOKED, PENDING_EXPIRATION …) was a console.log and nothing
 * else.
 *
 * ── What it does now ─────────────────────────────────────────────────────────
 *   1. VERIFY first (injected). An invalid signature is a 401 and leaves NO
 *      evidence — an attacker must not be able to fill the ledger.
 *   2. Parse. Unparseable JSON is a 400 (verified, but nothing to record about).
 *   3. Resolve the Item (injected lookup: id, status, owner deactivated).
 *   4. DECIDE — pure (`decidePlaidWebhook`): a sync trigger for an ACTIVE Item
 *      with a live owner schedules the pipeline; a non-ACTIVE Item or an
 *      inactive owner is REFUSED, mirroring the cron's eligibility exactly;
 *      everything else is acknowledged.
 *   5. RECORD one PlaidWebhookEvent for EVERY verified webhook (injected
 *      writer, non-throwing) — identity, type/code, Plaid error CODE, the
 *      status we held, the owner state, the verdict, the environment. Never
 *      the payload.
 *   6. Schedule (injected; the route wraps it in Next's `after()`).
 *
 * Plaid's retry semantics are preserved exactly: every verified, parseable
 * delivery is a 200 so Plaid never retries on our decision.
 */

import type { PlaidWebhookEventInput } from "@/lib/plaid/webhook-event";

/** TRANSACTIONS codes that mean "there is transaction data to pull". */
export const SYNC_TRIGGER_CODES: ReadonlySet<string> = new Set([
  "SYNC_UPDATES_AVAILABLE",
  "HISTORICAL_UPDATE",
  "INITIAL_UPDATE",
  "DEFAULT_UPDATE",
]);

/** The receiver's verdict vocabulary — persisted on PlaidWebhookEvent.handling. */
export type WebhookHandling =
  | "SYNC_SCHEDULED"          // a sync trigger for an eligible Item: the deferred pipeline was started
  | "ACKNOWLEDGED"            // verified, not a trigger we act on (ITEM/ERROR, PENDING_EXPIRATION, …)
  | "UNKNOWN_ITEM"            // a trigger for an item_id with no PlaidItem here
  | "REFUSED_ITEM_STATUS"     // a trigger for an Item that is not ACTIVE (REVOKED / NEEDS_REAUTH / ERROR)
  | "REFUSED_OWNER_INACTIVE"; // a trigger for an Item whose owner is deactivated / pending deletion

/** What the receiver knows about the Item named by a webhook. */
export interface WebhookItemRef {
  id: string;
  status: string;
  ownerDeactivated: boolean;
}

/** The fields of a Plaid webhook body the receiver reads. Everything else is ignored. */
export interface PlaidWebhookBody {
  webhook_type?: unknown;
  webhook_code?: unknown;
  item_id?: unknown;
  error?: unknown;
}

const STR_MAX = 64;
const ITEM_ID_MAX = 128;

/** A string field, clipped; null for anything that is not a non-empty string. */
function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
}

/** Plaid's `error.error_code` when the body carries one. A CODE, never the message. */
export function webhookErrorCode(body: PlaidWebhookBody): string | null {
  const err = body.error;
  if (typeof err !== "object" || err === null) return null;
  return str((err as { error_code?: unknown }).error_code, STR_MAX);
}

/** Is this a webhook that should (re)run the deferred sync pipeline? */
export function isSyncTrigger(webhookType: string | null, webhookCode: string | null): boolean {
  if (!webhookType || !webhookCode) return false;
  return (
    (webhookType === "TRANSACTIONS" && SYNC_TRIGGER_CODES.has(webhookCode)) ||
    // HOLDINGS/DEFAULT_UPDATE fires once investment holdings are ready (e.g. after
    // Investments consent). Same FULL pipeline, never a holdings-only sync.
    (webhookType === "HOLDINGS" && webhookCode === "DEFAULT_UPDATE")
  );
}

export interface WebhookDecision {
  handling: WebhookHandling;
  /** True only for SYNC_SCHEDULED. */
  schedule: boolean;
  /** The `handled` flag in the ack body — true only when the pipeline was started. */
  handled: boolean;
}

/**
 * THE eligibility rule. Pure. A sync trigger starts the pipeline only for an
 * ACTIVE Item whose owner is not deactivated — the same predicate the daily
 * cron applies (`status: ACTIVE, user: { deactivatedAt: null }`), stated once
 * here for the webhook producer. A REVOKED Item keeps its token until the row
 * is deleted, which is exactly why the status must be consulted before any
 * provider call.
 */
export function decidePlaidWebhook(
  webhookType: string | null,
  webhookCode: string | null,
  item: WebhookItemRef | null,
): WebhookDecision {
  if (!isSyncTrigger(webhookType, webhookCode)) {
    return { handling: "ACKNOWLEDGED", schedule: false, handled: false };
  }
  if (!item) return { handling: "UNKNOWN_ITEM", schedule: false, handled: false };
  if (item.status !== "ACTIVE") return { handling: "REFUSED_ITEM_STATUS", schedule: false, handled: false };
  if (item.ownerDeactivated) return { handling: "REFUSED_OWNER_INACTIVE", schedule: false, handled: false };
  return { handling: "SYNC_SCHEDULED", schedule: true, handled: true };
}

// ── The orchestrator (injected I/O) ──────────────────────────────────────────

export interface WebhookReceiverDeps {
  /** Signature verification over the RAW body. */
  verify: (rawBody: string, signatureHeader: string | null) => Promise<{ ok: boolean; reason?: string }>;
  /** Resolve the Item by Plaid item_id, with its status and owner state. */
  lookupItem: (externalItemId: string) => Promise<WebhookItemRef | null>;
  /** Append the verified-webhook fact. Must never throw (the real writer does not). */
  recordEvent: (event: PlaidWebhookEventInput) => void | Promise<void>;
  /** Start the deferred pipeline for an eligible Item (the route defers via `after()`). */
  scheduleSync: (plaidItemId: string) => void;
  /** V26-ENV-1 deployment environment stamp. */
  environment: () => string;
  log?: Pick<Console, "log" | "warn">;
}

export interface WebhookReceiverResult {
  status: 200 | 400 | 401;
  body: Record<string, unknown>;
  /** The fact that was recorded, when one was (null on 401 / 400). */
  event: PlaidWebhookEventInput | null;
}

export async function handlePlaidWebhook(
  rawBody: string,
  signatureHeader: string | null,
  deps: WebhookReceiverDeps,
): Promise<WebhookReceiverResult> {
  const log = deps.log ?? console;

  // 1. Verify FIRST. An unverified request leaves no evidence.
  const verified = await deps.verify(rawBody, signatureHeader);
  if (!verified.ok) {
    log.warn(`[plaid webhook] signature rejected: ${verified.reason ?? "unknown"}`);
    return { status: 401, body: { error: "invalid webhook signature" }, event: null };
  }

  // 2. Parse.
  let parsed: PlaidWebhookBody;
  try {
    const json: unknown = JSON.parse(rawBody);
    parsed = typeof json === "object" && json !== null ? (json as PlaidWebhookBody) : {};
  } catch {
    return { status: 400, body: { error: "invalid JSON body" }, event: null };
  }

  const webhookType = str(parsed.webhook_type, STR_MAX);
  const webhookCode = str(parsed.webhook_code, STR_MAX);
  const externalItemId = str(parsed.item_id, ITEM_ID_MAX);
  const errorCode = webhookErrorCode(parsed);
  log.log(`[plaid webhook] ${webhookType ?? "?"}/${webhookCode ?? "?"} item=${externalItemId ?? "—"}`);

  // 3. Resolve the Item (for every webhook that names one, so even an
  //    acknowledged ITEM/ERROR records which Item and which status it hit).
  const item = externalItemId ? await deps.lookupItem(externalItemId) : null;

  // 4. Decide.
  const decision = decidePlaidWebhook(webhookType, webhookCode, item);
  if (decision.handling === "UNKNOWN_ITEM") {
    log.warn(`[plaid webhook] no PlaidItem for item_id ${externalItemId} — ack, nothing to do`);
  } else if (decision.handling === "REFUSED_ITEM_STATUS" || decision.handling === "REFUSED_OWNER_INACTIVE") {
    log.log(`[plaid webhook] item ${item?.id} not eligible (${decision.handling}, status=${item?.status}) — ack, no sync`);
  }

  // 5. Record — the fact of the verified delivery and what we did with it.
  const event: PlaidWebhookEventInput = {
    externalItemId,
    plaidItemId: item?.id ?? null,
    webhookType: webhookType ?? "UNKNOWN",
    webhookCode: webhookCode ?? "UNKNOWN",
    errorCode,
    itemStatusAtReceipt: item?.status ?? null,
    ownerInactive: item ? item.ownerDeactivated : null,
    handling: decision.handling,
    environment: deps.environment(),
  };
  await deps.recordEvent(event);

  // 6. Schedule — only an eligible trigger reaches the provider.
  if (decision.schedule && item) deps.scheduleSync(item.id);

  return { status: 200, body: { received: true, handled: decision.handled }, event };
}
