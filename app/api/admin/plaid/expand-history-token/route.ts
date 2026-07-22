/**
 * POST /api/admin/plaid/expand-history-token
 *
 * Generates a FRESH Plaid Link token for the Expand History flow.
 *
 * Auth: SYSTEM_ADMIN only.
 *
 * Body: { plaidItemId: string }
 *
 * Validations (all must pass before calling Plaid):
 *   1. PlaidItem exists and belongs to a user (we look it up by id)
 *   2. PlaidItem.status === ACTIVE
 *   3. PlaidItem.cursor !== null (first sync completed — confirms real data exists
 *      that is worth extending; new items with no cursor have no history at all)
 *   4. Institution is not in EXPAND_HISTORY_BLOCKED_INSTITUTIONS (Robinhood)
 *   5. All live AccountConnections have a non-null mask on their FinancialAccount —
 *      data-driven eligibility check that ensures resolveAccountByFingerprint can
 *      match accounts after the new Item is created. Mask is required by the
 *      fingerprint match (Layer 3 — see lib/accounts/reconcile.ts).
 *
 * Link token is created in FRESH mode — no access_token, no update mode.
 * A fresh link produces a brand-new Plaid item_id. exchange-token then creates a
 * new PlaidItem row for that item. The old PlaidItem stays ACTIVE until the admin
 * UI posts to retire-superseded-item after exchange-token completes.
 *
 * WHY FRESH LINK (not update mode):
 * transactions.days_requested is only applied when the Transactions product is
 * first initialized on a new Item. Passing access_token puts Link in update mode,
 * which reuses the existing Item — the history depth cap is immutable for that
 * Item and cannot be extended. A fresh link (new item_id, new access_token) is
 * the only mechanism Plaid provides for requesting deeper history.
 *
 * INSTITUTION PRESELECTION — investigated and not implemented:
 * Plaid's /link/token/create has an `institution_id` request field described as
 * "Used for certain legacy use cases." This was the public-key era mechanism for
 * skipping the institution search screen. Plaid explicitly removed this
 * functionality for US/Canada fresh links. From the official Plaid support
 * response on react-plaid-link/issues/158:
 *   "Plaid Link used to allow for this functionality but we no longer allow
 *    for this type of integration."
 * And on react-plaid-link/issues/306:
 *   "For US/Canada, there is not [a way to skip the institution page]."
 *
 * The `institution_data.routing_number` field only "highlights" an institution
 * in search results (pins it at top); it does not skip the search screen, is
 * documented as unreliable, and we do not store routing numbers in PlaidItem.
 *
 * Conclusion: DO NOT pass institution_id or institution_data here. The admin
 * will search for the institution in Plaid's generic institution search. This is
 * acceptable for an admin-only flow where the admin already knows the institution.
 *
 * SECURITY: userId scope.
 * getSpaceContext() in exchange-token resolves the session user's ID.
 * In the current single-admin system, admin === account owner, so the new
 * PlaidItem.userId will match the existing PlaidItem.userId and fingerprint
 * matching will find the right FinancialAccount rows. This assumption must be
 * revisited if multi-user (non-admin) access is added.
 *
 * Returns: { link_token, oldPlaidItemId, institutionName }
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSystemAdmin } from "@/lib/session";
import { db } from "@/lib/db";
import { plaidClient, PLAID_ENV } from "@/lib/plaid/client";
import { CountryCode, Products } from "plaid";
import { parsePlaidError } from "@/lib/plaid/errors";
import { AuditAction } from "@/lib/audit-actions";
import { PlaidItemStatus } from "@prisma/client";
import { EXPAND_HISTORY_BLOCKED_INSTITUTIONS } from "@/lib/admin/provider-lifecycle";

export async function POST(req: NextRequest) {
  // Capture the acting admin for attribution. The guard returns before the Plaid
  // call, so a rejected caller never reaches the success-path audit write.
  const [admin, err] = await requireSystemAdmin();
  if (err) return err;

  // ── Parse body ────────────────────────────────────────────────────────────
  let plaidItemId: string;
  try {
    const body = await req.json();
    if (!body?.plaidItemId || typeof body.plaidItemId !== "string") {
      return NextResponse.json({ error: "plaidItemId is required" }, { status: 400 });
    }
    plaidItemId = body.plaidItemId;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── Fetch PlaidItem with live account masks ────────────────────────────────
  const item = await db.plaidItem.findUnique({
    where:  { id: plaidItemId },
    select: {
      id:              true,
      userId:          true,
      institutionId:   true,
      institutionName: true,
      status:          true,
      cursor:          true,   // non-null = at least one page synced
      // D2.x resume — the cursor is now persisted per page, so cursor≠null no
      // longer implies the first sync FINISHED. syncIncompleteAt===null is the
      // authoritative "fully synced" signal (Validation 2 below).
      syncIncompleteAt: true,
      connections: {
        where:  { deletedAt: null },
        select: {
          financialAccount: {
            select: { mask: true },
          },
        },
      },
    },
  });

  if (!item) {
    return NextResponse.json({ error: "PlaidItem not found" }, { status: 404 });
  }

  // ── Validation 1: must be ACTIVE ──────────────────────────────────────────
  if (item.status !== PlaidItemStatus.ACTIVE) {
    return NextResponse.json(
      { error: `PlaidItem is not ACTIVE (status: ${item.status}). Reconnect the provider before expanding history.` },
      { status: 422 },
    );
  }

  // ── Validation 2: first sync must have fully completed ────────────────────
  // cursor≠null AND syncIncompleteAt===null: real data exists AND the initial
  // history import finished (not merely paged partway before an interruption).
  if (item.cursor === null || item.syncIncompleteAt !== null) {
    return NextResponse.json(
      { error: "PlaidItem has not completed its first sync yet. Wait for the initial sync to finish before expanding history." },
      { status: 422 },
    );
  }

  // ── Validation 3: institution not blocked ─────────────────────────────────
  if (EXPAND_HISTORY_BLOCKED_INSTITUTIONS.has(item.institutionId)) {
    return NextResponse.json(
      { error: `Institution ${item.institutionName} is not yet supported for Expand History. Account matching requires a non-null mask which this institution does not consistently provide.` },
      { status: 422 },
    );
  }

  // ── Validation 4: all accounts must have masks ────────────────────────────
  // Data-driven eligibility: resolveAccountByFingerprint requires mask for
  // Layer 3 matching. If any account lacks a mask, the new Item's accounts
  // would fail to match and create orphan duplicates instead of updating
  // the existing FinancialAccount rows.
  const missingMask = item.connections.some((c) => c.financialAccount.mask === null);
  if (missingMask) {
    return NextResponse.json(
      { error: "One or more accounts linked to this provider are missing an account mask. Expand History requires all accounts to have a mask for safe reconciliation." },
      { status: 422 },
    );
  }

  // ── Create fresh Plaid Link token ─────────────────────────────────────────
  // IMPORTANT: no access_token — this is a completely fresh link, not update
  // mode. Passing an access_token would put Link in update mode, which cannot
  // extend transaction history depth (days_requested is immutable after init).
  //
  // The redirect_uri is required for OAuth institutions (Chase, BoA, etc.)
  // in Production. Must match the URI registered in Plaid Dashboard.
  const redirectUri = process.env.PLAID_REDIRECT_URI || undefined;

  try {
    console.log("[plaid][admin][expand-history-token] config:", {
      env:             PLAID_ENV,
      oldPlaidItemId:  plaidItemId,
      institutionName: item.institutionName,
      institutionId:   item.institutionId,
      mode:            "fresh (no access_token)",
      days_requested:  730,
      redirect_uri:    redirectUri ? "set" : "NOT SET (OAuth institutions will fail)",
    });

    const response = await plaidClient.linkTokenCreate({
      user:          { client_user_id: item.userId },
      client_name:   "Fourth Meridian",
      country_codes: [CountryCode.Us],
      language:      "en",
      products:      [Products.Transactions],
      // Fresh link — DO NOT pass access_token. No update mode.
      // days_requested: 730 ensures the new Item initializes with max
      // transaction history. This value is immutable after Transactions
      // product first initializes on the new Item.
      transactions:  { days_requested: 730 },
      ...(redirectUri && { redirect_uri: redirectUri }),
    });

    const linkToken = response.data.link_token;
    console.log(`[plaid][admin][expand-history-token] link token created for item ${plaidItemId}`);

    // Forensic record (V25-CLOSE-3 Part 3). Metadata is ids + institution only;
    // the returned link_token is NEVER logged.
    await db.auditLog.create({
      data: {
        performedByAdminId: admin.id,
        action:             AuditAction.ADMIN_PLAID_HISTORY_TOKEN_CREATED,
        metadata: {
          plaidItemId,
          ownerUserId:   item.userId,
          institutionId: item.institutionId,
          result:        "SUCCESS",
        },
      },
    });

    return NextResponse.json({
      link_token:      linkToken,
      oldPlaidItemId:  plaidItemId,
      institutionName: item.institutionName,
    });
  } catch (plaidErr: unknown) {
    const { message, status, code } = parsePlaidError(plaidErr, "Failed to create expand-history link token");
    const raw = (plaidErr as { response?: { data?: unknown; status?: number } })?.response;
    console.error("[plaid][admin][expand-history-token] error:", {
      error_code:       code ?? null,
      plaid_status:     raw?.status ?? null,
      plaid_error_data: raw?.data   ?? null,
      env:              PLAID_ENV,
    });
    return NextResponse.json({ error: message }, { status });
  }
}
