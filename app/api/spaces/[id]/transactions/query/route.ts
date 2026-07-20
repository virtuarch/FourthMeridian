/**
 * GET /api/spaces/[id]/transactions/query   (TX-3.3)
 *
 * The Transaction EXPLORER's server contract: a bounded keyset page of the rows that
 * answer one question, plus the exact size of that answer.
 *
 * WHY THIS IS A SIBLING AND NOT A CHANGE TO /transactions:
 *   The existing `GET /api/spaces/[id]/transactions` returns the whole bounded array
 *   and still feeds the ANALYTICAL consumers — Cash Flow, Liquidity, the Calendar
 *   heatmap, workspace renderers. Those keep their projection semantics until their
 *   own migration; TX-3 does not redesign them. This route exists so the browser-held
 *   array stops being the BROWSING authority, which is the actual TX-3 goal.
 *
 * Semantics:
 *   - Rows: `queryTransactions` — the one population/visibility/DTO authority, keyset
 *     paged (never offset), page bounded to MAX_TRANSACTION_PAGE_SIZE.
 *   - Count: `countTransactions` — the exact size of the SAME filtered set, built from
 *     the SAME filter construction, so "N results" cannot drift from the list. It is a
 *     COUNT only: money analytics are Cash Flow's semantic authority, not this route's.
 *   - No `moneyCtx`: explorer rows render in their NATIVE currency (unchanged from
 *     today's row rendering), so no conversion context needs to ride the page.
 *
 * Security / privacy:
 *   - ACTIVE member of the Space (VIEWER+); 403 for non-members, no existence
 *     disclosure. Row filtering is done ENTIRELY by the shared authority's KD-15
 *     predicate (TRANSACTION_DETAIL_VISIBILITY — FULL shares only), so the result is
 *     structurally partial in a shared Space and the UI carries a scope note.
 *   - Every query param is validated before it can reach Prisma (M3): malformed
 *     input is a 400 with field-level detail, never a 500.
 */

import { NextRequest, NextResponse } from "next/server";
import { SpaceMemberRole } from "@prisma/client";
import { requireSpaceRole } from "@/lib/session";
import {
  queryTransactions,
  parseTransactionQueryParams,
  encodeCursor,
} from "@/lib/data/transaction-query";
import { countTransactions } from "@/lib/data/transaction-count";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: spaceId } = await params;

  const [, err] = await requireSpaceRole(spaceId, SpaceMemberRole.VIEWER);
  if (err) return err;

  const parsed = parseTransactionQueryParams(req.nextUrl.searchParams);
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid query", details: parsed.errors }, { status: 400 });
  }
  const query = parsed.query;

  // The count is only needed when a page is FIRST fetched for a given question —
  // subsequent cursor pages are the same set, so re-counting each scroll step would
  // be pure waste. `countTransactions` ignores the cursor by design, so skipping it
  // mid-scroll cannot change the answer.
  const isFirstPage = query.cursor == null;

  const [page, count] = await Promise.all([
    queryTransactions({ spaceId, query }),
    isFirstPage ? countTransactions({ spaceId, query }) : Promise.resolve(null),
  ]);

  return NextResponse.json({
    transactions: page.rows,
    // Opaque continuation token — no consumer should construct or mutate one.
    nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
    hasMore: page.hasMore,
    // Present only on a first page; the client keeps the count it already has.
    ...(count !== null ? { count } : {}),
    // True when the supplied cursor belonged to a different sort and was dropped:
    // this page is the FIRST page of the new ordering, so a client accumulating
    // pages must RESET rather than append. (M2.)
    ...(page.cursorReset || parsed.cursorReset ? { cursorReset: true } : {}),
  });
}
