/**
 * POST /api/webhooks/resend  (Comms Center Phase C; contract v1.1 §10.1)
 *
 * The Resend delivery webhook — a MACHINE route: no session, authenticated by
 * its svix signature (`svix-id` / `svix-timestamp` / `svix-signature`),
 * listed in MACHINE_WRITE_PATHS (lib/security/write-origin.ts).
 *
 * INERT until the owner configures it: with no RESEND_WEBHOOK_SECRET every
 * request is 503 and nothing is processed. The decision lives in
 * lib/notifications/delivery/provider-events.ts (pure, tested branch by
 * branch); this file supplies the real I/O.
 *
 * BOUNDED: a per-IP rate limit, a Content-Length pre-check and a body cap
 * (MAX_WEBHOOK_BODY_BYTES) before anything is verified; one transaction of at
 * most two INSERTs after. The response is immediate; the only deferred work is
 * the per-reason rejection counter.
 *
 * Never stores or logs a body: opens/clicks are dropped (O-13), and a stored
 * event holds only its svix id, type, Resend message id and instant.
 */

import { NextRequest, NextResponse, after } from "next/server";
import { limitByIp } from "@/lib/rate-limit";
import { handleResendWebhook, MAX_WEBHOOK_BODY_BYTES, webhookConfigured } from "@/lib/notifications/delivery/provider-events";
import { providerEventStore, recordWebhookRejection } from "@/lib/notifications/delivery/provider-event-store";
import { readBodyCapped } from "@/lib/notifications/delivery/capped-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resend's bursts are small; a sender far above this is not Resend.
 * REVIEW F5 (noted, unchanged): Resend delivers through svix, whose egress IPs are SHARED by
 * every svix customer — this per-IP bucket is a coarse flood bound, not a per-sender identity,
 * and could in principle be filled by another svix tenant's traffic to us. The signature is
 * the authentication; this limit only bounds work.
 */
const RATE = { limit: 600, windowSec: 60 };
const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(req: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  // Inert first: nothing — not even the rate-limit bucket — is touched until configured.
  if (!webhookConfigured(secret)) {
    return NextResponse.json({ error: "webhook not configured", code: "UNAVAILABLE" }, { status: 503, headers: NO_STORE });
  }
  const limited = await limitByIp(req, "resend-webhook", RATE);
  if (limited) return limited;
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) {
    return NextResponse.json({ error: "payload too large", code: "VALIDATION" }, { status: 413, headers: NO_STORE });
  }

  // RAW body FIRST — the signature commits to the exact bytes. REVIEW F4: read with a running
  // byte count, so a chunked body (no Content-Length) cannot exceed the cap either.
  const body = await readBodyCapped(req.body, MAX_WEBHOOK_BODY_BYTES);
  if (!body.ok) {
    return NextResponse.json({ error: "payload too large", code: "VALIDATION" }, { status: 413, headers: NO_STORE });
  }
  const rawBody = body.text;
  const result = await handleResendWebhook(
    {
      rawBody,
      headers: {
        id: req.headers.get("svix-id"),
        timestamp: req.headers.get("svix-timestamp"),
        signature: req.headers.get("svix-signature"),
      },
    },
    {
      secret,
      now: () => new Date(),
      store: providerEventStore,
      recordRejection: (reason) => after(() => recordWebhookRejection(reason)),
    },
  );
  return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
}
