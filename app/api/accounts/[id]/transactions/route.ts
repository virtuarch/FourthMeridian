import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { ShareStatus } from "@prisma/client";

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
  // visibility decision either way. See docs/D3_STEP4_READ_CUTOVER_REVIEW.md.
  const link = await db.spaceAccountLink.findFirst({
    where:  { spaceId, financialAccountId: id, status: ShareStatus.ACTIVE },
    select: { id: true },
  });

  if (!link) {
    const legacyAccount = await db.account.findFirst({
      where:  { id, spaceId },
      select: { id: true },
    });
    if (!legacyAccount) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }

  // Match either FK — Plaid-synced transactions carry financialAccountId,
  // legacy/manual rows carry accountId.
  const rows = await db.transaction.findMany({
    where:   { OR: [{ accountId: id }, { financialAccountId: id }] },
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
  }));

  return NextResponse.json({ transactions });
}
