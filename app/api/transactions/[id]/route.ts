/**
 * GET /api/transactions/[id]  (TI-1 — Transaction Intelligence Phase 1)
 *
 * The canonical single-transaction detail read — the first per-row
 * transaction endpoint in the product. Read-only; serves the
 * TransactionDetail DTO (types/index.ts) assembled by getTransactionDetail()
 * (lib/data/transactions.ts). No UI consumes this yet (the detail overlay is
 * TI-2); it exists so the DTO/endpoint seam is stable before any surface
 * renders it.
 *
 * Security / privacy:
 *   - 401 for unauthenticated callers (requireUser).
 *   - Space scoping via getSpaceContext() — the same active-Space resolution
 *     every dashboard read uses.
 *   - Row visibility is enforced ENTIRELY by transactionDetailWhere()
 *     (lib/transactions/detail-query.ts): the row-scoped KD-15 predicate
 *     (legacy own-account path OR ACTIVE SpaceAccountLink at
 *     TRANSACTION_DETAIL_VISIBILITY — FULL only), plus both soft-delete
 *     guards. No query logic is duplicated here.
 *   - 404 — fails closed and uniformly — for: nonexistent id, soft-deleted
 *     row (import rollback), row outside the current Space, non-FULL
 *     visibility (BALANCE_ONLY / SUMMARY_ONLY / PRIVATE / legacy SHARED),
 *     and soft-deleted FinancialAccount. "Not found" and "not visible" are
 *     deliberately indistinguishable (no existence disclosure). Note this
 *     differs from GET /api/accounts/[id]/transactions, which returns an
 *     empty 200 list for a non-FULL link — there the ACCOUNT is legitimately
 *     known to the caller; here the transaction row itself is the secret.
 *
 * RLS-T1 — `id` ARRIVES FROM THE CLIENT, SO THE REFUSAL IS NOW ALSO THE
 * DATABASE'S. `transactionDetailWhere` is unchanged and still the KD-15
 * authority; what changes is that the read executes as the AUTHENTICATED CALLER,
 * so `Transaction`'s policy (`fm_account_visible("financialAccountId")`) has to
 * admit the row as well. The identity comes from `requireUser` — server-side
 * session state — and the Space from `getSpaceContext`; the policy reads neither,
 * it derives tenancy from ACTIVE SpaceMember rows, so a tampered active-Space
 * cookie cannot widen the answer. See getTransactionDetail's header for why
 * neither gate subsumes the other.
 *
 * See docs/investigations/TRANSACTION_INTELLIGENCE_DETAIL_VIEW_INVESTIGATION_2026-07-06.md §2–§3
 * and NEXT_INITIATIVE_TI_VS_MI_INVESTIGATION_2026-07-06.md §7.1 (TI-1).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser }               from "@/lib/session";
import { getSpaceContext }           from "@/lib/space";
import { getTransactionDetail }      from "@/lib/data/transactions";
import { withTenantDb }              from "@/lib/db/tenant-context";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const [user, err] = await requireUser();
  if (err) return err;

  const { spaceId } = await getSpaceContext();

  const transaction = await withTenantDb(user.id, (tx) =>
    getTransactionDetail(tx, id, { spaceId }));
  if (!transaction) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ transaction });
}
