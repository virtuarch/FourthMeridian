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
 *
 * ── RLS-ACC-S1 — THE GATE JOINS THE PHASE IT WAS GUARDING ────────────────────
 * RLS-C-S3 converted the row read and left the `SpaceAccountLink` gate above it
 * on the migration principal. That half-conversion was the worse of the two
 * possible states, because the gate is the thing that decides 404 vs 200: it
 * asked a BYPASSRLS principal "is this account linked into this Space", got an
 * answer about every Space in the deployment, and then compared it to a
 * `spaceId` that arrives from the active-Space cookie. The membership check was
 * entirely application-side — `getSpaceContext()` resolves the cookie, and
 * nothing in this file re-proved that the caller belongs to the Space it names.
 * Nothing was exploitable, because `getSpaceContext` refuses a Space the caller
 * is not a member of, but "the context resolver remembered" is not a boundary,
 * and a POST-READ ownership check is a strictly weaker object than a PRE-READ
 * database guarantee.
 *
 * Both reads are now ONE short phase under the caller's own identity, in the
 * original order. `SpaceAccountLink.fm_app_sel` is
 * `spaceId IN (SELECT fm_visible_space_ids())`, so a cookie naming a Space this
 * identity does not belong to now yields NO LINK and a 404 from the database,
 * not from a comparison. The tier check stays exactly where it was: it answers a
 * question the policies deliberately do not (§OWNER DECISION — RLS enforces
 * tenancy only, `visibilityLevel` is a column-level redaction tier in
 * application code), and `fm_account_visible` admits every ACTIVE link
 * regardless of tier, so the application rule is strictly NARROWER here, never
 * redundant.
 *
 * `parseTransactionQueryParams` is pure — it takes a `URLSearchParams` and
 * touches no database — so it runs inside the callback purely to keep the
 * original statement ORDER. Hoisting it out would be cheaper and would also
 * change the contract: a malformed query against an account the caller cannot
 * see currently answers 404, and must keep answering 404 rather than revealing
 * that validation ran.
 */

import { NextRequest, NextResponse } from "next/server";
import { ShareStatus } from "@prisma/client";
import { getSpaceContext } from "@/lib/space";
import { requireUser } from "@/lib/session";
import { grantsTransactionDetail } from "@/lib/ai/visibility";
import {
  queryTransactions,
  parseTransactionQueryParams,
  encodeCursor,
} from "@/lib/data/transaction-query";
import { withTenantDb } from "@/lib/db/tenant-context";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const [user, authErr] = await requireUser();
  if (authErr) return authErr;

  const { id } = await params;
  const { spaceId } = await getSpaceContext();

  // RLS-ACC-S1 — ONE short transaction on the tenant role, holding the GATE and
  // the rows it gates. The identity is the authenticated session's user
  // (requireUser above), never the account id in the path and never the
  // active-Space cookie.
  const outcome = await withTenantDb(user.id, async (tx) => {
    // `id` is a FinancialAccount.id (the canonical model — see getAccounts() in
    // lib/data/accounts.ts), visible to this space via an active SpaceAccountLink.
    const link = await tx.spaceAccountLink.findFirst({
      where:  { spaceId, financialAccountId: id, status: ShareStatus.ACTIVE },
      select: { visibilityLevel: true },
    });

    if (!link) return { kind: "notFound" as const };
    if (!grantsTransactionDetail(link.visibilityLevel)) {
      // KD-15: shared into this Space, but at a tier that does not grant transaction
      // detail (BALANCE_ONLY / SUMMARY_ONLY). Empty list (200) so the modal renders
      // cleanly rather than erroring. Preserved verbatim from the pre-TX-3.2 contract.
      return { kind: "redacted" as const };
    }

    // M3 — every filter/sort/cursor/limit param is validated before it can reach
    // Prisma. Malformed input is a 400 with field-level detail, never a 500.
    // Pure, and inside the phase only to preserve the original ordering — see the
    // header on why a malformed query must not out-rank the 404.
    const parsed = parseTransactionQueryParams(req.nextUrl.searchParams);
    if (!parsed.ok) return { kind: "invalid" as const, errors: parsed.errors };

    const { rows, nextCursor, hasMore, cursorReset } = await queryTransactions(tx, {
      spaceId,
      // `accountIds` is FORCED to this route's account and is written LAST so a
      // caller-supplied `?accountIds=` can never widen the query to another account.
      // (queryTransactions would intersect it with the visible set anyway; this makes
      // the route's own scope non-negotiable rather than merely safe.)
      query: { ...parsed.query, accountIds: [id] },
    });
    return {
      kind: "rows" as const, rows, nextCursor, hasMore,
      // True when the supplied cursor belonged to a different sort and was
      // dropped, from EITHER source — resolved here, where `parsed` is in scope.
      cursorReset: cursorReset || parsed.cursorReset,
    };
  });

  if (outcome.kind === "notFound") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (outcome.kind === "redacted") {
    return NextResponse.json({ transactions: [], nextCursor: null, hasMore: false });
  }
  if (outcome.kind === "invalid") {
    return NextResponse.json({ error: "Invalid query", details: outcome.errors }, { status: 400 });
  }

  const { rows, nextCursor, hasMore, cursorReset } = outcome;

  return NextResponse.json({
    transactions: rows,
    // The cursor crosses the wire as an opaque token — no consumer should ever
    // construct or mutate one.
    nextCursor: nextCursor ? encodeCursor(nextCursor) : null,
    hasMore,
    // True when the supplied cursor belonged to a different sort and was dropped:
    // the result below is the FIRST slice of the new ordering, so a client
    // accumulating results must reset rather than append. (M2.)
    ...(cursorReset ? { cursorReset: true } : {}),
  });
}
