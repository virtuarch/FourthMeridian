/**
 * GET /api/spaces/[id]/transactions
 *
 * Transactions visible to this Space — feeds the shared-Space Transactions
 * tab and the Overview "Recent transactions" preview on flow-identified
 * templates (Space Template Redesign narrowing: Household / Family /
 * Business / Debt).
 *
 * Security / privacy:
 *   - Caller must be an ACTIVE member of the space (any role, VIEWER+).
 *   - 403 for non-members (no space existence disclosure).
 *   - Row filtering is done ENTIRELY by lib/data/transactions.ts's
 *     getTransactions, which applies the shared KD-15 predicate
 *     (TRANSACTION_DETAIL_VISIBILITY — FULL shares only; BALANCE_ONLY /
 *     SUMMARY_ONLY can never contribute rows). No query logic is
 *     duplicated here, so the KD-15 tripwire tests keep guarding the only
 *     path. Because the result is therefore structurally partial in a
 *     shared Space, every consumer renders a scope note ("fully shared
 *     accounts only").
 */

import { NextRequest, NextResponse } from "next/server";
import { SpaceMemberRole }           from "@prisma/client";
import { requireSpaceRole }          from "@/lib/session";
import { getTransactions }           from "@/lib/data/transactions";
import { db }                        from "@/lib/db";
import { serializeSpaceConversionContext } from "@/lib/money/server-context";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: spaceId } = await params;

  const [, err] = await requireSpaceRole(spaceId, SpaceMemberRole.VIEWER);
  if (err) return err;

  const transactions = await getTransactions({ spaceId });

  // MC1 Phase 4 Slice 6 (F-6, plan D-8) — a serialized conversion context
  // rides the payload so the client-fetched SpaceTransactionsPanel can
  // convert its flow totals into this Space's reporting currency (each row
  // at its own date), exactly like the server-page surfaces do. USD Spaces
  // (and any Space whose rows are all already in the target) serialize an
  // EMPTY entry table — a few bytes, identical client math. Degrades to
  // undefined (panel falls back to native sums) if the Space row vanished.
  const space = await db.space.findUnique({
    where:  { id: spaceId },
    select: { reportingCurrency: true },
  });
  const moneyCtx = space
    ? await serializeSpaceConversionContext(space, {
        currencies: transactions.map((t) => t.currency ?? null),
        dates:      transactions.map((t) => t.date),
      })
    : undefined;

  return NextResponse.json({ transactions, moneyCtx });
}
