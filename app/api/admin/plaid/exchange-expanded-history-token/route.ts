/**
 * POST /api/admin/plaid/exchange-expanded-history-token
 *
 * Admin-only endpoint for the Expand History flow.
 * Exchanges a Plaid public_token for an access_token and imports accounts
 * into the INSTITUTION OWNER's context — not the admin's context.
 *
 * WHY THIS EXISTS:
 *   The normal /api/plaid/exchange-token uses getSpaceContext(), which reads
 *   the active NextAuth session to resolve userId + spaceId. In the Expand
 *   History flow, the admin is the session user — but accounts must be owned
 *   by the original institution owner (oldPlaidItem.userId). Using the admin's
 *   context would:
 *     1. Assign the new PlaidItem.userId to the admin, not the account owner.
 *     2. Run fingerprint matching against the admin's accounts, missing all
 *        existing FinancialAccounts belonging to the real owner.
 *     3. Link SpaceAccountLinks to the admin's Space instead of the owner's.
 *     4. Cause retire-superseded-item to fail (it queries for a new PlaidItem
 *        with the same userId as the old one — admin userId wouldn't match).
 *
 * AUTH: SYSTEM_ADMIN only (requireSystemAdmin).
 *
 * Body: { publicToken: string, oldPlaidItemId: string }
 *
 * CONTEXT RESOLUTION:
 *   1. Look up oldPlaidItem.userId — this is the institution owner.
 *   2. Call resolveSpaceContext(oldItem.userId) — finds the owner's Personal
 *      Space without touching the admin's session or active Space cookie.
 *   3. Pass userId + spaceId to performPlaidTokenExchange.
 *   4. After a successful sync, retire the old PlaidItem using the same
 *      sequence as retire-superseded-item/route.ts: soft-delete old
 *      AccountConnections, then call disconnectPlaidItemIfOrphaned.
 *
 * INSTITUTION ID / NAME:
 *   Derived from oldPlaidItem (not from client input) — more reliable than
 *   accepting them from the frontend, and avoids the client needing to
 *   re-send data it doesn't own.
 *
 * RETURN:
 *   { success, imported, holdingsImported, transactionsSynced, newPlaidItemId, retiredPlaidItemId }
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSystemAdmin } from "@/lib/session";
import { db } from "@/lib/db";
import { resolveSpaceContext } from "@/lib/space";
import { performPlaidTokenExchange, parsePlaidError } from "@/lib/plaid/exchangeToken";
import { disconnectPlaidItemIfOrphaned } from "@/lib/plaid/disconnect";
import { PlaidItemStatus } from "@prisma/client";

export async function POST(req: NextRequest) {
  const [, err] = await requireSystemAdmin();
  if (err) return err;

  // ── Parse body ────────────────────────────────────────────────────────────
  let publicToken:    string;
  let oldPlaidItemId: string;
  try {
    const body = await req.json();
    if (!body?.publicToken    || typeof body.publicToken    !== "string") {
      return NextResponse.json({ error: "publicToken is required" }, { status: 400 });
    }
    if (!body?.oldPlaidItemId || typeof body.oldPlaidItemId !== "string") {
      return NextResponse.json({ error: "oldPlaidItemId is required" }, { status: 400 });
    }
    publicToken    = body.publicToken;
    oldPlaidItemId = body.oldPlaidItemId;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── Look up old PlaidItem → derive target user ────────────────────────────
  const oldItem = await db.plaidItem.findUnique({
    where:  { id: oldPlaidItemId },
    select: {
      id:              true,
      userId:          true,
      institutionId:   true,
      institutionName: true,
      status:          true,
    },
  });

  if (!oldItem) {
    return NextResponse.json({ error: "PlaidItem not found" }, { status: 404 });
  }

  if (oldItem.status !== PlaidItemStatus.ACTIVE) {
    return NextResponse.json(
      { error: `Old PlaidItem is not ACTIVE (status: ${oldItem.status})` },
      { status: 422 },
    );
  }

  // ── Resolve target user's Personal Space ──────────────────────────────────
  // resolveSpaceContext(userId) looks up SpaceMember rows for the institution
  // owner, not the admin session. This is the critical fix: all downstream
  // writes (FinancialAccount, SpaceAccountLink, etc.) will use the correct
  // ownerUserId and spaceId instead of the admin's.
  let spaceId: string;
  try {
    const ctx = await resolveSpaceContext(oldItem.userId);
    spaceId   = ctx.spaceId;
    console.log(
      `[admin][expand-history] resolved target user ${oldItem.userId} → spaceId ${spaceId}`,
    );
  } catch (spaceErr) {
    console.error("[admin][expand-history] failed to resolve target user space:", spaceErr);
    return NextResponse.json(
      { error: "Could not resolve the institution owner's Space. The user may have no active Space membership." },
      { status: 422 },
    );
  }

  // ── Exchange token + import accounts ─────────────────────────────────────
  // performPlaidTokenExchange never calls getSpaceContext() — it accepts
  // explicit userId + spaceId, which is exactly what allows this endpoint to
  // supply the target user's context rather than the admin's.
  let result: Awaited<ReturnType<typeof performPlaidTokenExchange>>;
  try {
    result = await performPlaidTokenExchange({
      userId:           oldItem.userId,
      spaceId,
      public_token:     publicToken,
      institution_id:   oldItem.institutionId,
      institution_name: oldItem.institutionName,
    });
  } catch (exchangeErr: unknown) {
    const { message, status, code } = parsePlaidError(
      exchangeErr,
      "Failed to exchange token and import accounts",
    );
    console.error(`[admin][expand-history] exchange error (code: ${code ?? "unknown"}):`, message);
    return NextResponse.json({ error: message }, { status });
  }

  // ── Retire the superseded old PlaidItem ───────────────────────────────────
  // Same sequence as retire-superseded-item/route.ts but run inline here so
  // the client needs only one POST call. We already have oldPlaidItemId, and
  // performPlaidTokenExchange confirms the new item was created + synced
  // (cursor will be set by syncTransactionsForItem inside performPlaid...).
  //
  // Step 1: soft-delete old AccountConnections so disconnectPlaidItemIfOrphaned
  // sees 0 remaining connections and proceeds with itemRemove.
  try {
    const { count } = await db.accountConnection.updateMany({
      where: { plaidItemDbId: oldPlaidItemId, deletedAt: null },
      data:  { deletedAt: new Date() },
    });
    console.log(
      `[admin][expand-history] soft-deleted ${count} AccountConnection(s) for old item ${oldPlaidItemId}`,
    );

    // Step 2: orphan-check → Plaid itemRemove → set status=REVOKED.
    await disconnectPlaidItemIfOrphaned(oldPlaidItemId);
    console.log(`[admin][expand-history] retired old item ${oldPlaidItemId}`);
  } catch (retireErr) {
    // Non-fatal: the exchange succeeded and accounts are imported correctly.
    // The old item will remain ACTIVE and will need manual retirement, but
    // no data is lost. Log prominently so it's easy to detect and retry.
    console.error(
      `[admin][expand-history] WARNING: exchange succeeded but retire failed for ${oldPlaidItemId}. ` +
        "Old PlaidItem is still ACTIVE. Run retire-superseded-item manually to clean up.",
      retireErr,
    );
  }

  return NextResponse.json({
    success:             true,
    imported:            result.imported,
    holdingsImported:    result.holdingsImported,
    transactionsSynced:  result.transactionsSynced,
    newPlaidItemId:      result.plaidItemId,
    retiredPlaidItemId:  oldPlaidItemId,
  });
}
