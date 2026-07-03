import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { ShareStatus } from "@prisma/client";
import { grantsTransactionDetail } from "@/lib/ai/visibility";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const { spaceId } = await getSpaceContext();

  // `id` is most commonly a FinancialAccount.id (the canonical model — see
  // getAccounts() in lib/data/accounts.ts), visible to this space via an
  // active SpaceAccountLink. Fall back to the legacy Account model for
  // any pre-migration rows that might still be referenced directly.
  //
  // D3 Step 4B read cutover: this used to query WorkspaceAccountShare.
  // SpaceAccountLink is kept in sync with it by the D3 Step 3 dual-write
  // (lib/accounts/space-account-link.ts), so this read returns the same
  // visibility decision either way. See docs/initiatives/d3/D3_STEP4_READ_CUTOVER_REVIEW.md.
  const link = await db.spaceAccountLink.findFirst({
    where:  { spaceId, financialAccountId: id, status: ShareStatus.ACTIVE },
    select: { visibilityLevel: true },
  });

  if (!link) {
    const legacyAccount = await db.account.findFirst({
      where:  { id, spaceId },
      select: { id: true },
    });
    if (!legacyAccount) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // Legacy Account rows are the Space's own accounts — FULL by definition.
  } else if (!grantsTransactionDetail(link.visibilityLevel)) {
    // KD-15: the account IS shared into this Space (so it's not "not found"),
    // but at a visibility tier that does not grant transaction detail
    // (BALANCE_ONLY / SUMMARY_ONLY). The account's balance is exposed via the
    // accounts path; its transaction rows must never leak here. Return an empty
    // list (200) so the modal renders cleanly rather than erroring. Mirrors the
    // TRANSACTION_DETAIL_VISIBILITY predicate the dashboard lists and AI context
    // use, so no UI read path can disagree. See
    // docs/initiatives/kd15/KD-15_IMPLEMENTATION_CHECKLIST.md.
    return NextResponse.json({ transactions: [] });
  }

  // Match either FK — Plaid-synced transactions carry financialAccountId,
  // legacy/manual rows carry accountId.
  const rows = await db.transaction.findMany({
    where: {
      OR: [{ accountId: id }, { financialAccountId: id }],
      // deletedAt: null — D2 Step 4D-R: excludes rows soft-deleted by an
      // import rollback, the same Transaction-level guard the dashboard
      // reads in lib/data/transactions.ts apply. See
      // docs/initiatives/d2/investigations/D2_STEP4DR_TRANSACTION_READ_PATH_AUDIT_INVESTIGATION.md.
      deletedAt: null,
    },
    orderBy: { date: "desc" },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transactions = rows.map((r: any) => ({
    id:          r.id,
    accountId:   r.accountId ?? r.financialAccountId,
    date:        r.date.toISOString().split("T")[0],
    merchant:    r.merchant,
    description: r.description ?? undefined,
    category:    r.category,
    amount:      r.amount,
    pending:     r.pending,
    // FlowType metadata (P5 Slice 1 — additive; not consumed anywhere yet).
    flowType:                 r.flowType ?? null,
    flowDirection:            r.flowDirection ?? null,
    classificationConfidence: r.classificationConfidence ?? null,
    classificationReason:     r.classificationReason ?? null,
    classifierVersion:        r.classifierVersion ?? null,
  }));

  return NextResponse.json({ transactions });
}
