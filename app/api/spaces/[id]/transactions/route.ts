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
 *
 * RLS-T1 — THE ROWS NOW COME BACK AS THE CALLER, NOT AS THE TABLE OWNER.
 * `getTransactions` requires its authority, and this route earns one: the
 * identity is the authenticated session's (`requireSpaceRole`, which is
 * next-auth-backed), never the `[id]` path parameter, a header, or the
 * active-Space cookie. The path `id` still decides WHICH Space is asked about —
 * that is what the membership check above is for — but it can no longer decide
 * what the database is willing to show.
 */

import { NextRequest, NextResponse } from "next/server";
import { SpaceMemberRole }           from "@prisma/client";
import { requireSpaceRole }          from "@/lib/session";
import { getTransactions }           from "@/lib/data/transactions";
import { withTenantDb }              from "@/lib/db/tenant-context";
import { resolveEffectiveSpaceConversionSerialized } from "@/lib/money/server-context";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: spaceId } = await params;

  const [auth, err] = await requireSpaceRole(spaceId, SpaceMemberRole.VIEWER);
  if (err) return err;

  // TX-2 — bounded read (default cap + truncation sentinel). `truncated` rides the
  // payload so a consumer can honestly say "showing the most recent N" rather than
  // silently implying completeness.
  //
  // TX-3.3 — this route is NO LONGER the browsing authority. The Transactions
  // explorer moved to the keyset-paged sibling
  // (GET /api/spaces/[id]/transactions/query, lib/data/transaction-query.ts), which
  // is unbounded-safe and server-filtered. What still reads THIS route is the
  // ANALYTICAL set: Cash Flow, Liquidity, the Overview doorway preview, and the
  // workspace renderers, which fold the whole array and therefore keep the cap +
  // truncation sentinel until their own projection migration. Do not add browsing
  // features here.
  //
  // RLS-T1 — ONE short transaction holds the row read and the Space-currency
  // lookup that frames it, because the two must agree about who is asking: a
  // page read as the caller and a reporting currency read as the table owner
  // would be one payload assembled by two roles. Nothing else goes inside — the
  // FX resolution below can touch the rate archive and must not be held across.
  const { transactions, truncated, limit, space } = await withTenantDb(
    auth.user.id,
    async (tx) => {
      const page = await getTransactions(tx, { spaceId });
      const spaceRow = await tx.space.findUnique({
        where:  { id: spaceId },
        select: { reportingCurrency: true },
      });
      return {
        transactions: page.rows, truncated: page.truncated, limit: page.limit,
        space: spaceRow,
      };
    },
  );

  // MC1 Phase 4 Slice 6 (F-6, plan D-8) — a serialized conversion context
  // rides the payload so the client-fetched SpaceTransactionsPanel can
  // convert its flow totals into this Space's reporting currency (each row
  // at its own date), exactly like the server-page surfaces do. USD Spaces
  // (and any Space whose rows are all already in the target) serialize an
  // EMPTY entry table — a few bytes, identical client math. Degrades to
  // undefined (panel falls back to native sums) if the Space row vanished.
  //
  // V25-CLOSE-3A — resolve the EFFECTIVE currency (shared decision point): the
  // Spend/In summary converts through the reverted (USD) context when the stored
  // currency is unsatisfiable, so it never shows native amounts under a foreign
  // symbol. Rows stay native either way. Stored currency untouched.
  const resolved = space
    ? await resolveEffectiveSpaceConversionSerialized(space, {
        currencies: transactions.map((t) => t.currency ?? null),
        dates:      transactions.map((t) => t.date),
      })
    : undefined;

  // TX-2A — `limit` rides alongside `truncated` so the workspace honesty note can
  // say the real cap ("the most recent 5,000") rather than a client-side magic
  // number. Presentation metadata only; no calculation depends on it.
  return NextResponse.json({
    transactions,
    moneyCtx:  resolved?.moneyCtx,
    reverted:  resolved?.reverted ?? false,
    effective: resolved?.effective,
    truncated,
    limit,
  });
}
