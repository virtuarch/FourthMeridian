/**
 * GET /api/plaid/link-token
 *
 * Generates a short-lived Plaid Link token for the current user.
 * The frontend passes this token to react-plaid-link to open the Link UI.
 * After the user completes Link, the public_token is sent to /api/plaid/exchange-token.
 *
 * Query params:
 *   plaidItemId   (optional) — D2-7E reconnect flow. When provided, the token
 *                  is created in Plaid Link **update mode** (existing item's
 *                  access_token passed back to Plaid) so the reconnect
 *                  preserves the same item_id, letting
 *                  /api/plaid/exchange-token heal the existing PlaidItem row
 *                  instead of creating a duplicate. Ownership-checked against
 *                  the caller. Takes precedence over institutionId.
 *
 *   institutionId (optional) — D2 Slice A auto-detection. When provided,
 *                  checks whether the user already has an ACTIVE credential
 *                  for this institution (Connection layer first, PlaidItem
 *                  layer as legacy fallback). If found, puts Link in update
 *                  mode to prevent a duplicate credential being created for
 *                  the same institution. If not found, falls through to a
 *                  normal fresh-link flow. Ignored when plaidItemId is set.
 */

import { NextRequest, NextResponse } from "next/server";
import { plaidClient, PLAID_ENV } from "@/lib/plaid/client";
import { CountryCode, Products } from "plaid";
import { requireUser } from "@/lib/session";
import { parsePlaidError } from "@/lib/plaid/errors";
import { db } from "@/lib/db";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { ConnectionStatus, PlaidItemStatus, ProviderType } from "@prisma/client";
import { limitByUser } from "@/lib/rate-limit";
import { env } from "@/lib/env";

/**
 * The public URL Plaid should POST webhooks to (TRANSACTIONS/SYNC_UPDATES_AVAILABLE).
 * Prefer an explicit PLAID_WEBHOOK_URL; otherwise derive it from the trusted app
 * base URL (same source as email links). Plaid can only reach a public HTTPS
 * host, so a localhost / http base yields `undefined` — the token is created
 * without a webhook and Plaid simply never calls back (local dev needs a tunnel;
 * see .env.example PLAID_WEBHOOK_URL).
 */
function resolvePlaidWebhookUrl(): string | undefined {
  const explicit = process.env.PLAID_WEBHOOK_URL?.trim();
  const url = explicit && explicit.length > 0
    ? explicit
    : `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/api/plaid/webhook`;
  if (!/^https:\/\//i.test(url) || /localhost|127\.0\.0\.1/i.test(url)) return undefined;
  return url;
}

export async function GET(req: NextRequest) {
  const [user, err] = await requireUser();
  if (err) return err;

  // PO-5A — availability gate. When Plaid isn't configured, return a clean 503
  // (the client renders an honest "temporarily unavailable" state) instead of
  // the module-load crash a missing key used to cause. The client is lazy now
  // (lib/plaid/client.ts), so importing it above is side-effect free.
  if (!env.isPlaidEnabled) {
    return NextResponse.json(
      { error: "unavailable", message: "Bank connections are being set up. Please check back soon." },
      { status: 503 },
    );
  }

  // OPS-1 S4 — each call mints a Plaid Link token (external API cost).
  const limited = await limitByUser(user.id, "plaid-link-token", { limit: 10, windowSec: 900 });
  if (limited) return limited;

  try {
    // D2-7E — explicit reconnect by PlaidItem ID (reconnect badge).
    // Takes precedence over institutionId auto-detection below.
    const reconnectItemId = req.nextUrl.searchParams.get("plaidItemId");
    // D2 Slice A — institution-level auto-detection (Add Account flow).
    const institutionId   = req.nextUrl.searchParams.get("institutionId");
    // Connection-specific Investments consent (update mode only). When
    // "investments", the update-mode token additionally collects DTM consent
    // for Investments on THIS Item via `additional_consented_products` — the
    // ONLY correct mechanism (products is omitted in update mode except for
    // credit products; Investments is not one). Never affects a fresh-link
    // session, so the global Transactions-only path (AmEx-compatible) is
    // untouched. See docs/investigations/PLAID_INVESTMENTS_CONSENT_INVESTIGATION.md.
    const consentParam    = req.nextUrl.searchParams.get("consent");
    let accessToken: string | undefined;

    if (reconnectItemId) {
      // Existing path — unchanged from D2-7E.
      const existing = await db.plaidItem.findFirst({
        where:  { id: reconnectItemId, userId: user.id },
        select: { encryptedToken: true },
      });
      if (!existing) {
        return NextResponse.json({ error: "Plaid item not found" }, { status: 404 });
      }
      accessToken = decryptWithPurpose(existing.encryptedToken, EncryptionPurpose.PLAID_ACCESS_TOKEN);
    } else if (institutionId) {
      // D2 Slice A — auto-detect an existing credential for this institution.
      // Check Connection layer first (written by exchange-token since Slice A);
      // fall back to PlaidItem for credentials that predate Slice A and have
      // no Connection row yet.
      const existingConnection = await db.connection.findFirst({
        where:  {
          userId:               user.id,
          provider:             ProviderType.PLAID,
          externalConnectionId: institutionId,
          status:               ConnectionStatus.ACTIVE,
        },
        select: { credential: true },
      });

      if (existingConnection?.credential) {
        accessToken = decryptWithPurpose(
          existingConnection.credential,
          EncryptionPurpose.CONNECTION_CREDENTIAL,
        );
        console.log(
          `[plaid][D2-SliceA] institution ${institutionId} — existing Connection found, opening Link in update mode`,
        );
      } else {
        // Legacy fallback: PlaidItem has no Connection row yet (pre-Slice-A link).
        const existingItem = await db.plaidItem.findFirst({
          where:   { userId: user.id, institutionId, status: PlaidItemStatus.ACTIVE },
          select:  { encryptedToken: true },
          orderBy: { updatedAt: "desc" },
        });
        if (existingItem) {
          accessToken = decryptWithPurpose(
            existingItem.encryptedToken,
            EncryptionPurpose.PLAID_ACCESS_TOKEN,
          );
          console.log(
            `[plaid][D2-SliceA] institution ${institutionId} — existing PlaidItem found (no Connection row yet), opening Link in update mode`,
          );
        }
        // Neither found → accessToken stays undefined → normal fresh-link flow.
      }
    }

    // redirect_uri is required for OAuth institutions (Chase, BoA, Wells Fargo, etc.)
    // in Production. Must be HTTPS and registered in the Plaid Dashboard.
    // Set PLAID_REDIRECT_URI in .env.local. For local dev use an ngrok/tunnel HTTPS URL.
    const redirectUri = process.env.PLAID_REDIRECT_URI || undefined;

    // Investments intentionally omitted: AmEx and other credit-only institutions
    // reject link tokens that include the investments product. Transactions covers
    // the core data we need; investment holdings are synced separately if the
    // institution supports it.
    const products      = [Products.Transactions];
    const country_codes = [CountryCode.Us];

    // Investments consent is added ONLY in update mode (accessToken present)
    // and ONLY when explicitly requested for this specific Item. It is never
    // added to a fresh-link session, so `products` stays Transactions-only for
    // every normal Add Connection — AmEx and other credit-only institutions
    // are unaffected. Placed in `additional_consented_products` (not
    // `products`): this collects consent without gating the institution and is
    // not billed until investmentsHoldingsGet is called on the Item.
    // B2 — request Investments consent UP FRONT via additional_consented_products
    // (NOT `products`). This is the DTM-correct, NON-GATING mechanism: it collects
    // Investments consent where the institution offers it (Schwab/Fidelity/etc.),
    // avoiding the second manual "Enable Investments" re-link for the common case,
    // while a credit-only institution (AmEx) is UNAFFECTED — it simply doesn't
    // offer Investments (putting Investments in `products` would instead REJECT
    // those institutions' Link tokens, which is why `products` stays
    // Transactions-only). Update mode keeps its existing per-Item consent request.
    const wantsInvestmentsConsent = accessToken
      ? consentParam === "investments" // update mode: only when explicitly requested
      : true;                          // fresh link: offer Investments consent (non-gating)
    const additionalConsentedProducts = wantsInvestmentsConsent
      ? [Products.Investments]
      : undefined;

    // Register the webhook so Plaid can tell us when the deeper history window has
    // finished ingesting (TRANSACTIONS/SYNC_UPDATES_AVAILABLE → /api/plaid/webhook).
    // Undefined (localhost/http) → token created without a webhook.
    const webhookUrl = resolvePlaidWebhookUrl();

    // ── Server-side config log (safe fields only) ─────────────────────────────
    console.log("[plaid] link-token config:", {
      env:           PLAID_ENV,
      client_name:   "Fourth Meridian",
      mode:          accessToken ? "update" : "new",
      products:      products.map(String),
      additional_consented_products: additionalConsentedProducts?.map(String) ?? null,
      country_codes: country_codes.map(String),
      redirect_uri:  redirectUri ? "set" : "NOT SET (OAuth institutions will fail)",
      webhook:       webhookUrl ? "set" : "NOT SET (no public HTTPS URL — dev needs a tunnel)",
    });

    const response = await plaidClient.linkTokenCreate({
      user:          { client_user_id: user.id },
      client_name:   "Fourth Meridian",
      country_codes,
      language:      "en",
      // Webhook endpoint for asynchronous updates (SYNC_UPDATES_AVAILABLE etc.).
      // Omitted when there is no public HTTPS URL, so local dev is unaffected.
      ...(webhookUrl && { webhook: webhookUrl }),
      // Update mode: pass access_token, omit products (Plaid requires this —
      // see LinkTokenCreateRequest docs). Default mode: unchanged from before.
      ...(accessToken ? { access_token: accessToken } : { products }),
      // Only present in update mode when this Item's Investments consent was
      // explicitly requested (see wantsInvestmentsConsent). Undefined otherwise,
      // so it is a no-op for every normal/reconnect session.
      ...(additionalConsentedProducts && { additional_consented_products: additionalConsentedProducts }),
      ...(redirectUri && { redirect_uri: redirectUri }),
      // D4 — Request maximum available transaction history (up to 730 days /
      // ~2 years) for every new Item. Plaid's default is 90 days when this
      // field is omitted, which is what all Items linked before this change
      // were initialized with.
      //
      // IMPORTANT — this value is immutable after the Transactions product is
      // first initialized on an Item. Plaid permanently caps the history
      // available for that Item at whatever was requested here. Clearing the
      // PlaidItem.cursor and re-running syncTransactions only replays within
      // that cap — it does NOT expand it. The only way to get deeper history
      // on an already-linked Item is to call /item/remove (deletes the Item at
      // Plaid) and send the user through Link again to create a new Item.
      //
      // This field is silently ignored when accessToken is present (Plaid
      // update mode), so it is safe to include unconditionally.
      transactions: { days_requested: 730 },
    });

    const token = response.data.link_token;
    console.log(`[plaid] link token created for user ${user.id} (env: ${PLAID_ENV})`);

    return NextResponse.json({ link_token: token });
  } catch (err: unknown) {
    const { message, status, code } = parsePlaidError(err, "Failed to create link token");

    // ── Raw diagnostic log (safe fields only — no secrets) ───────────────────
    // The client-facing `message` is intentionally generic. Without this, a
    // misconfigured PLAID_CLIENT_ID/PLAID_SECRET/PLAID_ENV pairing in Vercel
    // just shows up as "Failed to create link token" with no way to tell why
    // from the Vercel function logs. Log the underlying Plaid error shape here.
    const raw = (err as { response?: { data?: unknown; status?: number } })?.response;
    console.error("[plaid] link-token error:", {
      client_message: message,
      error_code:      code ?? null,
      plaid_status:     raw?.status ?? null,
      plaid_error_data: raw?.data   ?? null,
      env:              PLAID_ENV,
    });

    return NextResponse.json({ error: message }, { status });
  }
}
