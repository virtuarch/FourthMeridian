/**
 * POST /api/plaid/webhook
 *
 * Receiver for Plaid webhooks. The webhook this app actually needs is the
 * TRANSACTIONS / SYNC_UPDATES_AVAILABLE signal: Plaid returns an initial slice
 * of history quickly after an Item is created, then ingests the deeper window
 * (the 730-day request) asynchronously over the following minutes and fires this
 * webhook when more is ready. Without a receiver the app assumed "first sync =
 * full history", which is the real backfill gap.
 *
 * Flow (the decision itself lives in lib/plaid/webhook-receiver.ts, pure and
 * tested branch by branch; this file is the adapter that supplies real I/O):
 *   1. Read the RAW body (needed for signature verification) and verify Plaid's
 *      JWT signature (lib/plaid/webhook-verify). An invalid signature is a 401
 *      and records NOTHING.
 *   2. Resolve the PlaidItem by Plaid item_id WITH its status and owner state.
 *   3. For a sync trigger on an ELIGIBLE Item (status ACTIVE, owner not
 *      deactivated — the daily cron's predicate), run the FULL deferred pipeline
 *      via the concurrency-guarded syncPlaidItemFromWebhook. A trigger for a
 *      REVOKED / NEEDS_REAUTH / ERROR Item or an inactive owner is acknowledged
 *      and REFUSED (OPERATIONALIZATION P0, 2026-10-07): before this, a
 *      REVOKED Item — whose token we still hold — ran the whole pipeline against
 *      Plaid on every delivery.
 *   4. EVERY verified webhook, acted on or not, leaves one PlaidWebhookEvent
 *      row (lib/plaid/webhook-event.ts): the beta's first
 *      USER_PERMISSION_REVOKED is evidence, not a log line.
 *   5. Everything verified is acknowledged (200) so Plaid never retries.
 *
 * The manual "Sync Now" / cooldown / daily-cron paths are unchanged — the
 * webhook is the primary correct trigger, not a replacement for those safety nets.
 */

import { NextRequest, NextResponse, after } from "next/server";
import { db } from "@/lib/db";
import { deploymentEnvironment } from "@/lib/env";
import { verifyPlaidWebhook } from "@/lib/plaid/webhook-verify";
import { syncPlaidItemFromWebhook } from "@/lib/plaid/webhook-sync";
import { handlePlaidWebhook } from "@/lib/plaid/webhook-receiver";
import { recordPlaidWebhookEvent } from "@/lib/plaid/webhook-event";

// The deferred pipeline runs here (post-response, same invocation), so give it
// the same budget as the connect flow / daily cron. Raised 60→300 with them
// (see resume-sync/route.ts) — this route was timing out mid-import too.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  // RAW body FIRST — the signature commits to sha256(body), so it must be read
  // before (and instead of) req.json().
  const rawBody = await req.text();

  const result = await handlePlaidWebhook(rawBody, req.headers.get("plaid-verification"), {
    verify: verifyPlaidWebhook,
    lookupItem: async (externalItemId) => {
      const item = await db.plaidItem.findUnique({
        where:  { externalItemId },
        select: { id: true, status: true, user: { select: { deactivatedAt: true } } },
      });
      return item ? { id: item.id, status: item.status, ownerDeactivated: item.user.deactivatedAt !== null } : null;
    },
    recordEvent: (event) => recordPlaidWebhookEvent(event),
    // Run the guarded full pipeline AFTER responding, so Plaid gets a fast 200 and
    // never retries on our latency. The guard (syncPlaidItemFromWebhook) makes a
    // duplicated/racing delivery safe. DF-2C — trigger WEBHOOK: the execution
    // ledger records that this refresh was initiated by a provider webhook.
    scheduleSync: (plaidItemId) => after(() => syncPlaidItemFromWebhook(plaidItemId, "WEBHOOK")),
    environment: deploymentEnvironment,
  });

  return NextResponse.json(result.body, { status: result.status });
}
