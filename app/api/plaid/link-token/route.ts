/**
 * GET /api/plaid/link-token
 *
 * Generates a short-lived Plaid Link token for the current user.
 * The frontend passes this token to react-plaid-link to open the Link UI.
 * After the user completes Link, the public_token is sent to /api/plaid/exchange-token.
 */

import { NextResponse } from "next/server";
import { plaidClient, PLAID_ENV } from "@/lib/plaid/client";
import { CountryCode, Products } from "plaid";
import { requireUser } from "@/lib/session";
import { parsePlaidError } from "@/lib/plaid/errors";

export async function GET() {
  const [user, err] = await requireUser();
  if (err) return err;

  try {
    // redirect_uri is required for OAuth institutions (Chase, BoA, Wells Fargo, etc.)
    // in Production. Must be HTTPS and registered in the Plaid Dashboard.
    // Set PLAID_REDIRECT_URI in .env.local. For local dev use an ngrok/tunnel HTTPS URL.
    const redirectUri = process.env.PLAID_REDIRECT_URI || undefined;

    const products      = [Products.Transactions, Products.Investments];
    const country_codes = [CountryCode.Us];

    // ── Server-side config log (safe fields only) ─────────────────────────────
    console.log("[plaid] link-token config:", {
      env:           PLAID_ENV,
      client_name:   "FinTracker",
      products:      products.map(String),
      country_codes: country_codes.map(String),
      redirect_uri:  redirectUri ? "set" : "NOT SET (OAuth institutions will fail)",
    });

    const response = await plaidClient.linkTokenCreate({
      user:          { client_user_id: user.id },
      client_name:   "FinTracker",
      products,
      country_codes,
      language:      "en",
      ...(redirectUri && { redirect_uri: redirectUri }),
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
