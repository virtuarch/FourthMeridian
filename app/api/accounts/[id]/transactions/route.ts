/**
 * GET /api/accounts/[id]/transactions
 *
 * Transactions for ONE account, as visible to the current Space.
 *
 * TX-3.2 — FIRST CONSUMER of the Transaction Explorer query authority.
 * This route previously hand-rolled its own read and was the only row-listing
 * transaction reader in the repo that did NOT go through `bankingTransactionWhere`.
 * It now delegates to `queryTransactions`, which collapses three divergences:
 *
 *   1. POPULATION (a real correction, not a refactor). The old query was
 *      `{ financialAccountId, deletedAt: null }` with NO FlowType gate, so it
 *      returned INVESTMENT-category rows that every other transaction surface
 *      excludes. `bankingTransactionWhere` applies the canonical banking
 *      population, so those rows are now correctly absent here too.
 *   2. ACCOUNT SOFT-DELETE. The old query guarded the transaction's `deletedAt`
 *      but not the ACCOUNT's, so a soft-deleted account whose link was still
 *      ACTIVE kept serving rows. The shared authority guards both.
 *   3. DTO. The old path called `serializeTransactionRow` directly and therefore
 *      omitted `source`, `merchantId`, the CF-1 context fields, and the read-time
 *      owned-counterparty resolution. It now returns the SAME `Transaction` DTO as
 *      every other list read (additive — no field was removed).
 *
 * Paging is keyset (cursor), not offset — see lib/data/transaction-query.ts.
 *
 * Security / privacy — UNCHANGED, and deliberately still checked here:
 *   - `requireUser()` (SEC-FIX-1) so a forced-TOTP-enrolment-pending session is
 *     denied at the API layer; page middleware never runs on /api/*.
 *   - The explicit SpaceAccountLink lookup below is NOT a second population
 *     authority — it exists to distinguish the two DIFFERENT public contracts that
 *     `bankingTransactionWhere` alone cannot tell apart:
 *         no ACTIVE link at all                  → 404 (no existence disclosure)
 *         link, but below transaction-detail tier → empty 200 (KD-15)
 *     Row filtering itself is done ENTIRELY by the shared authority, using the same
 *     TRANSACTION_DETAIL_VISIBILITY predicate, so the two can never disagree.
 */

import { NextRequest, NextResponse } from "next/server";
import { ShareStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { requireUser } from "@/lib/session";
import { grantsTransactionDetail } from "@/lib/ai/visibility";
import {
  queryTransactions,
  parseTransactionQueryParams,
  encodeCursor,
} from "@/lib/data/transaction-query";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const [, authErr] = await requireUser();
  if (authErr) return authErr;

  const { id } = await params;
  const { spaceId } = await getSpaceContext();

  // `id` is a FinancialAccount.id (the canonical model — see getAccounts() in
  // lib/data/accounts.ts), visible to this space via an active SpaceAccountLink.
  const link = await db.spaceAccountLink.findFirst({
    where:  { spaceId, financialAccountId: id, status: ShareStatus.ACTIVE },
    select: { visibilityLevel: true },
  });

  if (!link) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!grantsTransactionDetail(link.visibilityLevel)) {
    // KD-15: shared into this Space, but at a tier that does not grant transaction
    // detail (BALANCE_ONLY / SUMMARY_ONLY). Empty list (200) so the modal renders
    // cleanly rather than erroring. Preserved verbatim from the pre-TX-3.2 contract.
    return NextResponse.json({ transactions: [], nextCursor: null, hasMore: false });
  }

  // M3 — every filter/sort/cursor/limit param is validated before it can reach
  // Prisma. Malformed input is a 400 with field-level detail, never a 500.
  const parsed = parseTransactionQueryParams(req.nextUrl.searchParams);
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid query", details: parsed.errors }, { status: 400 });
  }

  const { rows, nextCursor, hasMore, cursorReset } = await queryTransactions({
    spaceId,
    // `accountIds` is FORCED to this route's account and is written LAST so a
    // caller-supplied `?accountIds=` can never widen the query to another account.
    // (queryTransactions would intersect it with the visible set anyway; this makes
    // the route's own scope non-negotiable rather than merely safe.)
    query: { ...parsed.query, accountIds: [id] },
  });

  return NextResponse.json({
    transactions: rows,
    // The cursor crosses the wire as an opaque token — no consumer should ever
    // construct or mutate one.
    nextCursor: nextCursor ? encodeCursor(nextCursor) : null,
    hasMore,
    // True when the supplied cursor belonged to a different sort and was dropped:
    // this page is the FIRST page of the new ordering, so a client accumulating
    // pages must reset rather than append. (M2.)
    ...(cursorReset || parsed.cursorReset ? { cursorReset: true } : {}),
  });
}
