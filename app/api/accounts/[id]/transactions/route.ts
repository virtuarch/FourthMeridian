import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { ShareStatus } from "@prisma/client";
import { grantsTransactionDetail } from "@/lib/ai/visibility";
import { serializeTransactionRow } from "@/lib/transactions/serialize";

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
    // MI M6 read cutover — resolved Merchant presentation (additive join).
    include: { resolvedMerchant: { select: { displayName: true, logoUrl: true } } },
  });

  // TI-1: canonical serialization via the shared serializer
  // (lib/transactions/serialize.ts). This route's previous inline copy had
  // DRIFTED — it omitted `currency` (the MC1 Phase 0 native-currency stamp
  // every dashboard list carries), so the payload now additionally includes
  // `currency`, aligning the account modal with every other transaction
  // read. Additive only; all previously-present fields are unchanged.
  const transactions = rows.map(serializeTransactionRow);

  return NextResponse.json({ transactions });
}
