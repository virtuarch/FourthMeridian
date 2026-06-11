/**
 * GET /api/plaid/link-token
 *
 * Generates a short-lived Plaid Link token for the current user.
 * The frontend passes this token to react-plaid-link to open the Link UI.
 * After the user completes Link, the public_token is sent to /api/plaid/exchange-token.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { plaidClient } from "@/lib/plaid/client";
import { CountryCode, Products } from "plaid";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const response = await plaidClient.linkTokenCreate({
    user:          { client_user_id: session.user.id },
    client_name:   "FinTracker",
    products:      [Products.Transactions, Products.Investments],
    country_codes: [CountryCode.Us],
    language:      "en",
  });

  return NextResponse.json({ link_token: response.data.link_token });
}
