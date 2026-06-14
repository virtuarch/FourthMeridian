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
    const { message, status } = parsePlaidError(err, "Failed to create link token");
    console.error("[plaid] link-token error:", message);
    return NextResponse.json({ error: message }, { status });
  }
}
