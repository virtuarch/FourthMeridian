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
 * Flow:
 *   1. Read the RAW body (needed for signature verification) and verify Plaid's
 *      JWT signature (lib/plaid/webhook-verify). An invalid signature is a 401.
 *   2. For a transactions sync signal, resolve the PlaidItem by Plaid item_id and
 *      run the FULL deferred pipeline for it (sync → snapshot backfill →
 *      reconstruction → price backfill → wealth regen) via the concurrency-guarded
 *      syncPlaidItemFromWebhook — reusing the exact machinery the connect flow
 *      uses, never a parallel implementation.
 *   3. Everything else is acknowledged (200) but not processed.
 *
 * The manual "Sync Now" / cooldown / daily-cron paths are unchanged — the
 * webhook is the primary correct trigger, not a replacement for those safety nets.
 */

import { NextRequest, NextResponse, after } from "next/server";
import { db } from "@/lib/db";
import { verifyPlaidWebhook } from "@/lib/plaid/webhook-verify";
import { syncPlaidItemFromWebhook } from "@/lib/plaid/webhook-sync";

// The deferred pipeline runs here (post-response, same invocation), so give it
// the same budget as the connect flow / daily cron.
export const maxDuration = 60;

// TRANSACTIONS webhook codes that mean "there is transaction data to pull".
// SYNC_UPDATES_AVAILABLE is the one that fires for /transactions/sync (which
// this app uses throughout); the legacy get-flow codes are handled defensively
// (they trigger the same idempotent sync) in case a dashboard config surfaces one.
const SYNC_TRIGGER_CODES = new Set([
  "SYNC_UPDATES_AVAILABLE",
  "HISTORICAL_UPDATE",
  "INITIAL_UPDATE",
  "DEFAULT_UPDATE",
]);

export async function POST(req: NextRequest) {
  // RAW body FIRST — the signature commits to sha256(body), so it must be read
  // before (and instead of) req.json().
  const rawBody = await req.text();

  const verified = await verifyPlaidWebhook(rawBody, req.headers.get("plaid-verification"));
  if (!verified.ok) {
    console.warn(`[plaid webhook] signature rejected: ${verified.reason}`);
    return NextResponse.json({ error: "invalid webhook signature" }, { status: 401 });
  }

  let body: { webhook_type?: string; webhook_code?: string; item_id?: string };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { webhook_type, webhook_code, item_id } = body;
  console.log(`[plaid webhook] ${webhook_type ?? "?"}/${webhook_code ?? "?"} item=${item_id ?? "—"}`);

  // TRANSACTIONS sync signals (above) OR a HOLDINGS update (Plaid fires
  // webhook_type "HOLDINGS" / webhook_code "DEFAULT_UPDATE" once investment
  // holdings are ready — e.g. after the user grants Investments consent via
  // EnableInvestmentsButton). Both re-invoke the FULL deferred pipeline via
  // syncPlaidItemFromWebhook (sync → snapshot backfill → reconstruction → prices
  // → wealth regen), NOT a narrow holdings-only sync, or the snapshot/A9 steps
  // go stale — same discipline as the transactions webhook fix.
  const isSyncTrigger =
    (webhook_type === "TRANSACTIONS" && typeof webhook_code === "string" && SYNC_TRIGGER_CODES.has(webhook_code)) ||
    (webhook_type === "HOLDINGS" && webhook_code === "DEFAULT_UPDATE");

  if (!isSyncTrigger || !item_id) {
    // Verified but not something we act on — ack so Plaid doesn't retry.
    return NextResponse.json({ received: true, handled: false });
  }

  const item = await db.plaidItem.findUnique({
    where:  { externalItemId: item_id },
    select: { id: true },
  });
  if (!item) {
    console.warn(`[plaid webhook] no PlaidItem for item_id ${item_id} — ack, nothing to do`);
    return NextResponse.json({ received: true, handled: false });
  }

  // Run the guarded full pipeline AFTER responding, so Plaid gets a fast 200 and
  // never retries on our latency. The guard (syncPlaidItemFromWebhook) makes a
  // duplicated/racing delivery safe.
  after(() => syncPlaidItemFromWebhook(item.id));

  return NextResponse.json({ received: true, handled: true });
}
