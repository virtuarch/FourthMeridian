/**
 * POST /api/plaid/exchange-token
 *
 * Called after the user completes the Plaid Link flow.
 * Receives the public_token from the frontend, exchanges it for a permanent
 * access_token, encrypts it, and imports all accounts + investment holdings
 * into the user's personal space.
 *
 * Data model:
 *   PlaidItem  — credential, belongs to User (not space)
 *   FinancialAccount  — canonical account row, ownerType=USER
 *   AccountConnection — links FinancialAccount ↔ PlaidItem ↔ User
 *   WorkspaceAccountShare — makes the account visible in the active space
 *
 * Relinking the same institution matches on plaidAccountId (FinancialAccount)
 * and restores deletedAt → null on both FinancialAccount and AccountConnection
 * if the account had previously been removed (see app/api/accounts/[id]/route.ts
 * DELETE) — reconnecting an account brings it back instead of leaving a
 * reactivated WorkspaceAccountShare pointing at a still-hidden account.
 *
 * Plaid does not guarantee plaidAccountId is stable forever — it can reissue
 * a new account_id for the same real-world account on reconnect. When no
 * exact plaidAccountId match is found, we fall back to a conservative
 * fingerprint match (institutionId + mask + type + officialName/plaidName)
 * against archived accounts before creating a new row — see
 * lib/accounts/reconcile.ts.
 *
 * Body: { public_token: string, institution_id: string, institution_name: string }
 *
 * Core import logic lives in lib/plaid/exchangeToken.ts so the admin
 * Expand History flow (exchange-expanded-history-token) can use the same
 * code path while supplying the target user's context instead of the
 * session user's context.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSpaceContext } from "@/lib/space";
import { performPlaidTokenExchange, parsePlaidError } from "@/lib/plaid/exchangeToken";

export async function POST(req: NextRequest) {
  try {
    const { public_token, institution_id, institution_name } = await req.json();

    if (!public_token || !institution_id || !institution_name) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // Resolve space context — session user's userId + active spaceId.
    // For the admin Expand History flow this would return the admin's context
    // rather than the institution owner's, which is why that flow calls
    // exchange-expanded-history-token instead of this endpoint.
    const { userId, spaceId } = await getSpaceContext();

    const result = await performPlaidTokenExchange({
      userId,
      spaceId,
      public_token,
      institution_id,
      institution_name,
    });

    return NextResponse.json({
      success:            true,
      imported:           result.imported,
      holdingsImported:   result.holdingsImported,
      transactionsSynced: result.transactionsSynced,
    });
  } catch (err: unknown) {
    const { message, status, code } = parsePlaidError(err, "Failed to connect account");
    console.error(`[plaid] exchange-token error (code: ${code ?? "unknown"}):`, message);
    return NextResponse.json({ error: message }, { status });
  }
}
