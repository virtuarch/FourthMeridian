import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getWorkspaceContext } from "@/lib/workspace";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const { workspaceId } = await getWorkspaceContext();

  // Verify the account belongs to this workspace before returning its transactions
  const account = await db.account.findFirst({
    where: { id, workspaceId },
    select: { id: true },
  });

  if (!account) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rows = await db.transaction.findMany({
    where:   { accountId: id },
    orderBy: { date: "desc" },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transactions = rows.map((r: any) => ({
    id:          r.id,
    accountId:   r.accountId,
    date:        r.date.toISOString().split("T")[0],
    merchant:    r.merchant,
    description: r.description ?? undefined,
    category:    r.category,
    amount:      r.amount,
    pending:     r.pending,
  }));

  return NextResponse.json({ transactions });
}
