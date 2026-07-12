/**
 * GET /api/spaces/[id]/accounts/detail
 *
 * Accounts Tab redesign (Phase 1) — a dedicated, management-centric read for the
 * ACCOUNTS rail tab (`accounts_overview`). Deliberately SEPARATE from
 * GET /api/spaces/[id]/accounts (which feeds the shared `SpaceAccount` type every
 * Wealth/Cash Flow/Liquidity/Debt widget consumes): this route carries the extra
 * per-account management fields (mask, connection health, historical-imports
 * count) that would bloat that shared type if added to it. See
 * FOURTH_MERIDIAN_ACCOUNTS_TAB_REDESIGN_IMPLEMENTATION_PLAN_2026-07-12.md §2.1.
 *
 * No schema change, no new writes — a new read only, reusing existing machinery:
 *  - The SpaceAccountLink ACTIVE-visibility join is the SAME one
 *    app/api/spaces/[id]/accounts/route.ts uses (not reinvented here).
 *  - Connection health is `deriveConnectionState()` from lib/sync/status.ts,
 *    imported and called verbatim — never reimplemented, never fabricated. It is
 *    `null` for a manual account (nothing was ever connected) rather than a fake
 *    "healthy".
 *  - `importBatchCount` is a COUNT of COMPLETED ImportBatch rows scoped by the
 *    exact `spaceAccountLinks.some({ spaceId, status: ACTIVE })` join the Activity
 *    Tab plan established for its ImportBatch producer — a second consumer of the
 *    same query shape, not a second implementation.
 *
 * Privacy: BALANCE_ONLY shares are aggregated + sanitised by normalizeSharedAccounts
 * exactly as the shared route does — no real name, institution, mask, or connection
 * metadata ever leaks on those rows, and they carry no per-account management
 * actions (their id is synthetic). FULL shares expose the full management shape.
 *
 * Security: membership-gated (VIEWER+), same as every other Space read. The Plaid
 * `cursor` is selected solely to derive state and is NEVER returned to the client.
 */

import { NextRequest, NextResponse }         from "next/server";
import { db }                                from "@/lib/db";
import { ShareStatus, ImportBatchStatus }    from "@prisma/client";
import { SpaceMemberRole }                   from "@prisma/client";
import { requireSpaceRole }                  from "@/lib/session";
import { normalizeSharedAccounts, type ShareRow } from "@/lib/account-privacy";
import { deriveConnectionState, type SyncConnectionState } from "@/lib/sync/status";

export interface AccountDetailRow {
  id:                 string;      // FinancialAccount.id (FULL) or synthetic (BALANCE_ONLY aggregate)
  spaceAccountLinkId: string | null; // null for aggregated BALANCE_ONLY rows (no single link)
  visibility:         "FULL" | "BALANCE_ONLY";
  name:               string;
  institution:        string;     // "" on BALANCE_ONLY rows (never leaked)
  type:               string;
  mask:               string | null; // last 4 digits; null when absent or BALANCE_ONLY
  balance:            number;
  currency:           string;
  isManual:           boolean;     // no provider connection at all (no PlaidItem, no wallet)
  connectionState:    SyncConnectionState | null; // deriveConnectionState() — null for manual/BALANCE_ONLY, never fabricated
  importBatchCount:   number;      // COMPLETED ImportBatch rows for this account (0 on BALANCE_ONLY)
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: spaceId } = await params;

  // requireSpaceRole enforces ACTIVE membership — REMOVED/LEFT members cannot read.
  const [, err] = await requireSpaceRole(spaceId, SpaceMemberRole.VIEWER);
  if (err) return err;

  const links = await db.spaceAccountLink.findMany({
    where: {
      spaceId,
      status:           ShareStatus.ACTIVE,
      financialAccount: { deletedAt: null },
    },
    select: {
      id:              true,
      visibilityLevel: true,
      addedByUserId:   true,
      addedByUser: {
        select: { firstName: true, name: true },
      },
      financialAccount: {
        select: {
          id:             true,
          name:           true,
          type:           true,
          institution:    true,
          mask:           true,
          balance:        true,
          currency:       true,
          lastUpdated:    true,
          creditLimit:    true,
          debtSubtype:    true,
          interestRate:   true,
          minimumPayment: true,
          walletAddress:  true,
          connections: {
            where:  { deletedAt: null },
            select: {
              isCanonical:   true,
              plaidItemDbId: true,
              // cursor is consumed only by deriveConnectionState — never returned.
              plaidItem: { select: { status: true, cursor: true } },
            },
          },
        },
      },
    },
    orderBy: [
      { financialAccount: { type: "asc" } },
      { financialAccount: { name: "asc" } },
    ],
  });

  // COMPLETED historical-imports count per account, scoped to this Space via the
  // SAME spaceAccountLinks.some({ spaceId, status: ACTIVE }) join the Activity Tab
  // producer uses. groupBy keeps it one round-trip; missing accounts ⇒ 0.
  const importCounts = await db.importBatch.groupBy({
    by:    ["financialAccountId"],
    where: {
      status:           ImportBatchStatus.COMPLETED,
      financialAccount: {
        deletedAt:        null,
        spaceAccountLinks: { some: { spaceId, status: ShareStatus.ACTIVE } },
      },
    },
    _count: { _all: true },
  });
  const importCountByAccount = new Map<string, number>(
    importCounts.map((c) => [c.financialAccountId, c._count._all]),
  );

  // FULL shares carry the full management shape; BALANCE_ONLY shares are routed
  // through the shared aggregator so no identifying field ever leaks.
  const fullRows: AccountDetailRow[] = [];
  const balanceOnlyShares: ShareRow[] = [];

  for (const link of links) {
    const a = link.financialAccount;

    if (link.visibilityLevel !== "FULL") {
      // Reuse the shared normalizer's exact ShareRow shape (FULL/BALANCE_ONLY).
      balanceOnlyShares.push({
        visibilityLevel: link.visibilityLevel,
        addedByUserId:   link.addedByUserId,
        addedByUser:     link.addedByUser,
        financialAccount: {
          id:             a.id,
          name:           a.name,
          type:           a.type,
          institution:    a.institution,
          balance:        a.balance,
          currency:       a.currency,
          lastUpdated:    a.lastUpdated,
          creditLimit:    a.creditLimit,
          debtSubtype:    a.debtSubtype,
          interestRate:   a.interestRate,
          minimumPayment: a.minimumPayment,
        },
      });
      continue;
    }

    // A provider connection = an AccountConnection carrying a PlaidItem (canonical
    // preferred) or a wallet address. A manual asset has neither.
    const plaidConn =
      a.connections.find((c) => c.isCanonical && c.plaidItem) ??
      a.connections.find((c) => c.plaidItem);
    const hasProvider = a.connections.some((c) => c.plaidItemDbId !== null) || !!a.walletAddress;

    // connectionState from deriveConnectionState() verbatim; null when there is no
    // Plaid item to derive from (manual, wallet-only, or a revoked item) — never
    // a fabricated "healthy".
    const connectionState = plaidConn?.plaidItem
      ? deriveConnectionState(plaidConn.plaidItem)
      : null;

    fullRows.push({
      id:                 a.id,
      spaceAccountLinkId: link.id,
      visibility:         "FULL",
      name:               a.name,
      institution:        a.institution,
      type:               a.type,
      mask:               a.mask,
      balance:            a.balance,
      currency:           a.currency,
      isManual:           !hasProvider,
      connectionState,
      importBatchCount:   importCountByAccount.get(a.id) ?? 0,
    });
  }

  // Aggregate + sanitise BALANCE_ONLY shares; map to the detail shape with every
  // management field neutralised (no mask, no health, no imports, no actions).
  const aggregated: AccountDetailRow[] = normalizeSharedAccounts(balanceOnlyShares).map((r) => ({
    id:                 r.id,
    spaceAccountLinkId: null,
    visibility:         "BALANCE_ONLY",
    name:               r.name,
    institution:        "",
    type:               r.type,
    mask:               null,
    balance:            r.balance,
    currency:           r.currency,
    isManual:           false,
    connectionState:    null,
    importBatchCount:   0,
  }));

  // FULL rows first (already type/name sorted by the query), then aggregated —
  // the same ordering normalizeSharedAccounts produces for the shared route.
  return NextResponse.json([...fullRows, ...aggregated]);
}
