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

import { NextRequest, NextResponse, after } from "next/server";
import { getSpaceContext } from "@/lib/space";
import { requireUser } from "@/lib/session";
import { performPlaidTokenExchange, parsePlaidError } from "@/lib/plaid/exchangeToken";
import { runDeferredHistorySync } from "@/lib/plaid/backgroundHistorySync";
import { limitByUser } from "@/lib/rate-limit";

// D2.x Slice 1 (fast-path split). This request returns as soon as the fast
// slice is durable — token exchanged, accounts/balances persisted, holdings
// attempted, today's snapshot written — and defers the full 730-day history
// import out-of-band (see deferHistorySync below).
//
// D2.x Slice 2 (background continuation). That deferred history now runs via
// after() below, in the SAME server invocation, after the response is sent.
// after() work counts against maxDuration, so the budget is raised from the
// fast-slice 30 to 60 (parity with the sync-banks cron) to give the background
// syncTransactionsForItem room to complete. Anything exceeding this budget is
// finished by the standing daily cron — no manual Refresh required.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    // SEC-FIX-1 — this route authenticates via getSpaceContext(); add the
    // shared guard so a forced-TOTP-enrolment-pending session is denied at
    // the API layer (the page middleware never runs on /api/*).
    const [, authErr] = await requireUser();
    if (authErr) return authErr;

    const { public_token, institution_id, institution_name } = await req.json();

    if (!public_token || !institution_id || !institution_name) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // Resolve space context — session user's userId + active spaceId.
    // For the admin Expand History flow this would return the admin's context
    // rather than the institution owner's, which is why that flow calls
    // exchange-expanded-history-token instead of this endpoint.
    const { userId, spaceId } = await getSpaceContext();

    // OPS-1 S4 — token exchange triggers a full import (Plaid API + heavy DB
    // writes); a legitimate user links a handful of institutions, not dozens
    // in fifteen minutes.
    const limited = await limitByUser(userId, "plaid-exchange-token", { limit: 10, windowSec: 900 });
    if (limited) return limited;

    const result = await performPlaidTokenExchange({
      userId,
      spaceId,
      public_token,
      institution_id,
      institution_name,
      // D2.x Slice 1 — defer the full history import so this request returns
      // once balances/holdings/snapshot are durable. Only this normal
      // first-run flow defers; the admin Expand History flow does not.
      deferHistorySync: true,
    });

    // D2.x Slice 2 — schedule the deferred history import to run after this
    // response is sent (post-response, same invocation). Fire-and-forget and
    // best-effort: runDeferredHistorySync never throws, so a background
    // failure can never affect the Link success returned below. Only gated on
    // historyPending, so it never runs for a caller that synced inline.
    if (result.historyPending) {
      after(() => runDeferredHistorySync(result.plaidItemId));
    }

    return NextResponse.json({
      success:            true,
      imported:           result.imported,
      holdingsImported:   result.holdingsImported,
      transactionsSynced: result.transactionsSynced,
      // Additive/optional. True when history is still arriving out-of-band so
      // the client can message honestly ("balances ready, importing history")
      // instead of treating a fast return as incomplete. Existing clients that
      // ignore this field are unaffected.
      historyPending:     result.historyPending ?? false,
    });
  } catch (err: unknown) {
    const { message, status, code } = parsePlaidError(err, "Failed to connect account");
    console.error(`[plaid] exchange-token error (code: ${code ?? "unknown"}):`, message);
    return NextResponse.json({ error: message }, { status });
  }
}
