/**
 * POST /api/plaid/create-link-token
 *
 * Creates a short-lived Plaid link_token for the frontend to open Plaid Link.
 * The token expires after 4 hours and is not stored — it is passed directly
 * to the react-plaid-link component.
 */

import { NextResponse } from "next/server";
import { plaidClient } from "@/lib/plaid/client";
import { CountryCode, Products } from "plaid";

export async function POST() {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: {
        // Replaced with session.user.id in M2
        client_user_id: "demo-user",
      },
      client_name:   "FinTracker",
      products:      [Products.Transactions, Products.Investments],
      country_codes: [CountryCode.Us],
      language:      "en",
    });

    return NextResponse.json({ link_token: response.data.link_token });
  } catch (err: unknown) {
    console.error("[plaid] create-link-token error:", err);
    return NextResponse.json(
      { error: "Failed to create Plaid link token" },
      { status: 500 }
    );
  }
}
