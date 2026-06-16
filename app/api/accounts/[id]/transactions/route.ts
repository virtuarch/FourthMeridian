import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkspaceContext } from "@/lib/workspace";
import { ShareStatus } from "@prisma/client";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const { workspaceId } = await getWorkspaceContext();

  // `id` is most commonly a FinancialAccount.id (the canonical model — see
  // getAccounts() in lib/data/accounts.ts), visible to this workspace via an
  // active WorkspaceAccountShare. Fall back to the legacy Account model for
  // any pre-migration rows that might still be referenced directly.
  const share = await db.workspaceAccountShare.findFirst({
    where:  { workspaceId, financialAccountId: id, status: ShareStatus.ACTIVE },
    select: { id: true },
  });

  if (!share) {
    const legacyAccount = await db.account.findFirst({
      where:  { id, workspaceId },
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
