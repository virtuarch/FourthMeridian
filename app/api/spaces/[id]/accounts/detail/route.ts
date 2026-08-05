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
import { resolveAccountFreshness, type AccountFreshness } from "@/lib/freshness/observation";
import { resolveAccountBalances, reconcileAccount, type AccountBalances, type Reconciliation } from "@/lib/balances/account-balances";
import { loadPendingEvidence, NO_PENDING } from "@/lib/balances/pending-evidence";

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
  /**
   * v2.6-L1 — the canonical per-account freshness answer, from
   * resolveAccountFreshness. THIS is what makes "every current balance claim can
   * expose its account-level freshness" true rather than aspirational: the
   * balance on this row and the evidence for how old it is travel together.
   *
   * Carried on BALANCE_ONLY rows too — it describes a balance the tier already
   * discloses. On an aggregated row it reflects the OLDEST member (see
   * normalizeSharedAccounts), and its `ledger` is UNKNOWN: an aggregate maps to
   * no single account whose transactions could be counted.
   */
  freshness:          AccountFreshness;
  /**
   * v2.6-L2 — the canonical current-balance answer: the observed ledger figure
   * and the account-type-aware reading of `availableBalance`, each NAMED. The
   * raw column never reaches the client; on the Chase card the difference is
   * $562.37 owed versus $33,022.48 of unused credit line, and those must never
   * be interchangeable.
   */
  balances:           AccountBalances;
  /**
   * v2.6-L3 — the current-state reconciliation: provider-observed pending, the
   * predicted figure where evidence licenses one, the unexplained residual, and
   * the state in the canonical EXACT / PARTIALLY_ATTRIBUTED / UNAVAILABLE /
   * CONTRADICTORY vocabulary. An unexplained hold is an OUTPUT — the Amex HYSA's
   * $4,000 is reported, never smoothed into a prediction.
   */
  reconciliation:     Reconciliation;
}

/** v2.6-L1/L2 — one freshness answer for an aggregated BALANCE_ONLY row, so the
 *  row's freshness and its balance claim are resolved from the same evidence. */
function aggregateFreshness(
  r: { id: string; balance: number; lastUpdated: string; balanceLastUpdatedAt?: string | null },
  now: Date,
): AccountFreshness {
  return resolveAccountFreshness({
    accountId:         r.id,
    ingestedAt:        r.lastUpdated,
    providerBalanceAt: r.balanceLastUpdatedAt ?? null,
    balance:           r.balance,
  }, now);
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
          // v2.6-L2 — forwarded RAW into the balance authority, which is the only
          // module permitted to interpret it. Never read as a value here.
          availableBalance: true,
          lastUpdated:    true,
          // v2.6-L1 — the institution's own balance clock, kept distinct from
          // `lastUpdated` (ours) all the way to the client.
          balanceLastUpdatedAt: true,
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
              // syncIncompleteAt is consumed only by deriveConnectionState — never returned.
              plaidItem: { select: { status: true, syncIncompleteAt: true } },
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

  // v2.6-L1 — ledger COVERAGE per account: the newest transaction date we hold.
  // Deliberately a separate query from the balance columns, because the two feeds
  // advance independently (a wallet whose balance is a live on-chain read can sit
  // on a ledger that stops years earlier). Because this groupBy covers EVERY
  // linked account, an account absent from the result is one we looked at and
  // hold nothing for — NONE_ON_FILE, not UNKNOWN.
  const ledgerAccountIds = links.map((l) => l.financialAccount.id);
  const ledgerMax = ledgerAccountIds.length
    ? await db.transaction.groupBy({
        by:    ["financialAccountId"],
        where: { financialAccountId: { in: ledgerAccountIds }, deletedAt: null },
        _max:  { date: true },
      })
    : [];
  const ledgerThroughByAccount = new Map<string, Date>();
  for (const r of ledgerMax) {
    if (r.financialAccountId && r._max.date) ledgerThroughByAccount.set(r.financialAccountId, r._max.date);
  }

  // ONE clock for the whole response, so two rows in the same payload can never
  // be aged against two different instants.
  const now = new Date();

  // v2.6-L3 — provider-observed pending movements, scoped per account. Nothing is
  // inferred: this is a read of rows a provider (or an import) delivered.
  const pending = await loadPendingEvidence(ledgerAccountIds);

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
          balanceLastUpdatedAt: a.balanceLastUpdatedAt,
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

    // ONE freshness answer per account, composed into the balance claim rather
    // than resolved twice — the two must never be able to disagree.
    const fullFreshness = resolveAccountFreshness({
      accountId:         a.id,
      ingestedAt:        a.lastUpdated,
      providerBalanceAt: a.balanceLastUpdatedAt,
      ledgerThroughDate: ledgerThroughByAccount.get(a.id) ?? null,
      ledgerQueried:     true,
      balance:           a.balance,
    }, now);

    // ONE balance answer and ONE reconciliation per account, resolved before the
    // push so the row's `balances` and `reconciliation` cannot disagree.
    const fullBalances = resolveAccountBalances({
      accountId:           a.id,
      accountType:         a.type,
      debtSubtype:         a.debtSubtype,
      currency:            a.currency,
      balance:             a.balance,
      availableBalance:    a.availableBalance,
      creditLimit:         a.creditLimit,
      isSelfCustodyWallet: !!a.walletAddress,
      freshness:           fullFreshness,
    });
    const fullReconciliation = reconcileAccount(
      fullBalances,
      pending.get(a.id) ?? NO_PENDING,
      a.creditLimit,
    );

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
      freshness:          fullFreshness,
      balances:           fullBalances,
      reconciliation:     fullReconciliation,
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
    // The aggregate's freshness is the OLDEST member's (normalizeSharedAccounts
    // resolves that); `ledgerQueried` is deliberately omitted so coverage stays
    // UNKNOWN — a synthetic row maps to no single account whose transactions we
    // could have counted, and NONE_ON_FILE would be a claim we cannot make.
    freshness:          aggregateFreshness(r, now),
    // An aggregated row has no single account identity, so no provider
    // `availableBalance` belongs to it — the authority is handed nothing and
    // returns PROVIDER_DID_NOT_REPORT rather than a summed available figure that
    // would mix reachable cash with settled cash across members.
    balances:           resolveAccountBalances({
      accountId:        r.id,
      accountType:      r.type,
      currency:         r.currency,
      balance:          r.balance,
      availableBalance: null,
      freshness:        aggregateFreshness(r, now),
    }),
    // An aggregate maps to no single account, so it has no pending evidence and
    // no reachable quantity of its own — reconciled as UNAVAILABLE rather than
    // summing members' residuals into a figure we have not defined.
    reconciliation:     reconcileAccount(
      resolveAccountBalances({
        accountId:        r.id,
        accountType:      r.type,
        currency:         r.currency,
        balance:          r.balance,
        availableBalance: null,
        freshness:        aggregateFreshness(r, now),
      }),
      NO_PENDING,
      null,
    ),
  }));

  // FULL rows first (already type/name sorted by the query), then aggregated —
  // the same ordering normalizeSharedAccounts produces for the shared route.
  return NextResponse.json([...fullRows, ...aggregated]);
}
