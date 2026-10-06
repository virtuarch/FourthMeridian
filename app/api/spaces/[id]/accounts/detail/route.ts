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
 *
 * ── RLS-T2 — THE SPACE'S OWN ROWS CONVERT; TWO INCLUDES ABOUT OTHER PEOPLE DO NOT
 * Every Space- and account-keyed read here now runs as the authenticated caller in
 * ONE short transaction — the links, the import counts, the ledger-coverage
 * groupBy, the pending evidence and the wallet valuation. That is the same
 * justification the already-converted sibling GET /api/spaces/[id]/accounts uses:
 * it is one coherent answer about one Space's accounts, and nothing inside reaches
 * a provider, a model or the network.
 *
 * ⚠️ TWO RELATION INCLUDES HAD TO COME OUT, AND BOTH WOULD HAVE DEGRADED IN
 * SILENCE RATHER THAN FAILING. Both are OPTIONAL relations, so Prisma returns
 * `null` instead of raising — which is strictly worse than the 500 the REQUIRED
 * `User` includes in this family produced, because nothing announces it:
 *
 *   1. `SpaceAccountLink.addedByUser` (`addedByUserId String?`). fm_app's `User`
 *      SELECT policy is `id = current_fm_user_id()` (§10 — co-member display
 *      identity is served by the application, see lib/spaces/roster-visibility.ts).
 *      This is the field `normalizeSharedAccounts` builds a BALANCE_ONLY
 *      aggregate's NAME from ("Jane's Checking Accounts" ← `addedByUser.firstName`),
 *      and a BALANCE_ONLY share is BY DEFINITION somebody else's account — so the
 *      degradation would have been 100% of exactly the rows the label exists for,
 *      silently reducing every one of them to a bare "Checking Accounts".
 *
 *   2. `AccountConnection.plaidItem` (`plaidItemDbId String?`). `PlaidItem` is a
 *      USER-keyed table (§9: `"userId" = current_fm_user_id()`), but connection
 *      HEALTH on a FULL-shared account is a Space-level fact. As the tenant a
 *      co-member's item is invisible, `deriveConnectionState` is never called, and
 *      the row reports `connectionState: null` — which this route documents as
 *      "manual, wallet-only, or a revoked item". A broken connection would have
 *      rendered as a healthy manual account. (`isManual` is UNAFFECTED: it is
 *      derived from the `plaidItemDbId` SCALAR, which fm_app can read.)
 *
 * Both are now separate, explicitly-named reads of the narrowest possible column
 * sets, for ids this Space's OWN tenant-visible rows named — the construction
 * GET /api/spaces/[id]/invites and PATCH …/members/[userId] already use. Neither
 * is routed to systemDb: app/api/spaces/ is not in that client's confinement list
 * (scripts/audit-db-authority.ts) and an ordinary HTTP handler acquiring a
 * deployment-wide authority is the escape this programme exists to close. The
 * honest fix for (2) is a `PlaidItem` SELECT arm admitting items whose connections
 * reach a visible Space — a migration, and so an owner decision.
 */

import type { PriceProvenance } from "@/lib/prices/current-quote.core";
import { NextRequest, NextResponse }         from "next/server";
import { db }                                from "@/lib/db";
import { withTenantDb }                      from "@/lib/db/tenant-context";
import { ShareStatus, ImportBatchStatus }    from "@prisma/client";
import { SpaceMemberRole }                   from "@prisma/client";
import { requireSpaceRole }                  from "@/lib/session";
import { normalizeSharedAccounts, type ShareRow } from "@/lib/account-privacy";
import { accountDisplayName, ACCOUNT_NAME_SELECT } from "@/lib/accounts/display-identity";
import { deriveConnectionState, type SyncConnectionState } from "@/lib/sync/status";
import { resolveAccountFreshness, type AccountFreshness } from "@/lib/freshness/observation";
import { resolveAccountBalances, reconcileAccount, type AccountBalances, type Reconciliation } from "@/lib/balances/account-balances";
import { loadPendingEvidence, NO_PENDING } from "@/lib/balances/pending-evidence";
import { loadWalletCurrentValues, hasKnownValue } from "@/lib/crypto/wallet-current-value";

export interface AccountDetailRow {
  id:                 string;      // FinancialAccount.id (FULL) or synthetic (BALANCE_ONLY aggregate)
  spaceAccountLinkId: string | null; // null for aggregated BALANCE_ONLY rows (no single link)
  visibility:         "FULL" | "BALANCE_ONLY";
  /**
   * REVIEW-3 B-1 — on an aggregated BALANCE_ONLY row: how many member links it
   * discloses, so count surfaces can state the LINK count rather than the
   * post-aggregation row count. Absent on FULL rows (each is one account).
   */
  memberCount?:       number;
  /**
   * REVIEW-3 B-1 — on an aggregated BALANCE_ONLY DEBT row: Σ per-member issuer
   * credit (a positive magnitude), disclosed beside the owed `balance` and
   * never netted into it. Absent on FULL rows (their signed balance already
   * carries the credit state per lib/debt/balance-semantics).
   */
  creditTotal?:       number;
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
   * 2026-09-21 — a crypto wallet's PRICE clock (CURRENT_QUOTE / LAST_CLOSE),
   * separate from `freshness` (the quantity's). FULL rows only; absent when the
   * position is unpriced or the account is not a wallet.
   */
  cryptoPrice?:       PriceProvenance;
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

/**
 * The PlaidItem whose state backs an account's connection health.
 *
 * RLS-T2 — this used to be two `find`s over a relation include
 * (`c.isCanonical && c.plaidItem` first, then any `c.plaidItem`). The include is
 * gone (see the file header), so the same two-tier preference is expressed over a
 * lookup of the ids the connections carry. The ORDER is the behaviour: a canonical
 * connection's item is authoritative, and a non-canonical one is the fallback —
 * never the other way round.
 *
 * A connection whose `plaidItemDbId` is set but whose item is NOT in the map is
 * skipped rather than treated as an item, which is what makes an unreadable item
 * fall through to the next candidate instead of ending the search.
 */
function pickPlaidItem<I>(
  connections: readonly { isCanonical: boolean; plaidItemDbId: string | null }[],
  itemById:    ReadonlyMap<string, I>,
): I | null {
  const first = (cs: readonly { plaidItemDbId: string | null }[]): I | null => {
    for (const c of cs) {
      const item = c.plaidItemDbId === null ? undefined : itemById.get(c.plaidItemDbId);
      if (item !== undefined) return item;
    }
    return null;
  };
  return first(connections.filter((c) => c.isCanonical)) ?? first(connections);
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: spaceId } = await params;

  // requireSpaceRole enforces ACTIVE membership — REMOVED/LEFT members cannot read.
  const [viewer, err] = await requireSpaceRole(spaceId, SpaceMemberRole.VIEWER);
  if (err) return err;

  // ── Every Space- and account-keyed read, as the caller, in ONE short phase ──
  // RLS-T2 — see the header. The five reads below are sequentially dependent (the
  // account-id set scopes three of them) and make no network call, so one
  // transaction is one coherent answer rather than a boundary held open.
  const {
    links, importCountByAccount, ledgerThroughByAccount, pending, walletValueByAccount,
  } = await withTenantDb(viewer.user.id, async (client) => {
  const links = await client.spaceAccountLink.findMany({
    where: {
      spaceId,
      status:           ShareStatus.ACTIVE,
      financialAccount: { deletedAt: null },
    },
    select: {
      id:              true,
      visibilityLevel: true,
      addedByUserId:   true,
      // ⚠️ `addedByUser` IS NOT INCLUDED HERE — see the header. It is read
      // separately, after this phase, on a named authority.
      financialAccount: {
        select: {
          id:             true,
          // TRUTH-10 / REVIEW-3 C-1 — the full name-evidence set, via the shared
          // select, so this surface (which HOSTS the rename control) resolves the
          // same display identity as every other surface. Selecting `name` alone
          // made the Accounts tab show the pre-rename provider name forever.
          ...ACCOUNT_NAME_SELECT,
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
          // 2026-10-07 — groups privacy aggregates by liquidity access, as the
          // Space mount loader does, so both surfaces agree on the rows.
          providerSubtype: true,
          interestRate:   true,
          minimumPayment: true,
          walletAddress:  true,
          // W-M3a — names the wallet's asset, so this surface can tell a chain
          // that writes the balance column from one whose value lives on the spine.
          walletChain:    true,
          connections: {
            where:  { deletedAt: null },
            select: {
              isCanonical:   true,
              plaidItemDbId: true,
              // ⚠️ `plaidItem` IS NOT INCLUDED HERE — see the header. `PlaidItem`
              // is USER-keyed, so as the tenant a co-member's item is invisible
              // and the include would have returned null. The SCALAR id stays
              // (it is what `isManual` is derived from) and the two state columns
              // are read separately, after this phase, on a named authority.
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
  const importCounts = await client.importBatch.groupBy({
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
    ? await client.transaction.groupBy({
        by:    ["financialAccountId"],
        where: { financialAccountId: { in: ledgerAccountIds }, deletedAt: null },
        _max:  { date: true },
      })
    : [];
  const ledgerThroughByAccount = new Map<string, Date>();
  for (const r of ledgerMax) {
    if (r.financialAccountId && r._max.date) ledgerThroughByAccount.set(r.financialAccountId, r._max.date);
  }

  // v2.6-L3 — provider-observed pending movements, scoped per account. Nothing is
  // inferred: this is a read of rows a provider (or an import) delivered.
  // RLS slice B — `loadPendingEvidence` now requires its client. RLS-T2 — and the
  // client it is handed is the caller's own.
  const pending = await loadPendingEvidence(client, ledgerAccountIds);

  // W-M3a — a wallet on a chain that writes no `balance` column arrives from the
  // DB as a structural 0. Every claim below (freshness, balances, reconciliation)
  // is composed FROM that number, so the substitution happens once, here, before
  // any of them see it — rather than in three places that could disagree.
  //
  // ⚠️ RLS-T2 — `client` IS PASSED EXPLICITLY. `loadWalletCurrentValues` still
  // carries an `options.client ?? db` default (fifteen call sites wide, named in
  // lib/space/mount-composition.ts), and an omitted authority there is an AMBIENT
  // one: this call would have read PositionObservation / PositionReconstruction as
  // the migration principal while everything around it read as the caller.
  const walletValueByAccount = await loadWalletCurrentValues(
    links.map((l) => ({
      id: l.financialAccount.id,
      walletChain: l.financialAccount.walletChain,
      lastUpdated: l.financialAccount.lastUpdated,
    })),
    { contextSpaceId: spaceId, client },
  );

    return { links, importCountByAccount, ledgerThroughByAccount, pending, walletValueByAccount };
  });

  // ── The two facts about OTHER PEOPLE, read separately and named ─────────────
  // ⚠️ DELIBERATELY NOT withTenantDb — see the header. Both are reads fm_app's
  // policies structurally cannot serve from within a Space context, over ids the
  // tenant-visible rows above named, and both would otherwise have returned null
  // and degraded a user-facing label without raising anything.
  const adderIds = [...new Set(links.map((l) => l.addedByUserId).filter((v): v is string => v !== null))];
  const adders = adderIds.length === 0 ? [] : await db.user.findMany({
    where:  { id: { in: adderIds } },
    select: { id: true, firstName: true, name: true },
  });
  const adderById = new Map(adders.map(({ id, ...display }) => [id, display]));

  const plaidItemIds = [...new Set(
    links.flatMap((l) => l.financialAccount.connections.map((c) => c.plaidItemDbId))
      .filter((v): v is string => v !== null),
  )];
  // Exactly the two columns the state machine consumes, and no more:
  // syncIncompleteAt is consumed only by deriveConnectionState — never returned.
  const plaidItems = plaidItemIds.length === 0 ? [] : await db.plaidItem.findMany({
    where:  { id: { in: plaidItemIds } },
    select: { id: true, status: true, syncIncompleteAt: true },
  });
  const plaidItemById = new Map(plaidItems.map(({ id, ...state }) => [id, state]));

  // ONE clock for the whole response, so two rows in the same payload can never
  // be aged against two different instants.
  const now = new Date();

  // FULL shares carry the full management shape; BALANCE_ONLY shares are routed
  // through the shared aggregator so no identifying field ever leaks.
  const fullRows: AccountDetailRow[] = [];
  const balanceOnlyShares: ShareRow[] = [];

  for (const link of links) {
    const raw = link.financialAccount;
    const walletValue = walletValueByAccount.get(raw.id);
    // A wallet with a real number (VALUED or STALE alike — W6b) displaces the
    // column; an UNKNOWN one falls through to it rather than having a number
    // invented. W6d put Bitcoin on this path too, through the same registry
    // predicate and with no chain named here.
    const a = hasKnownValue(walletValue) ? { ...raw, balance: walletValue!.value! } : raw;

    if (link.visibilityLevel !== "FULL") {
      // Reuse the shared normalizer's exact ShareRow shape (FULL/BALANCE_ONLY).
      balanceOnlyShares.push({
        visibilityLevel: link.visibilityLevel,
        addedByUserId:   link.addedByUserId,
        addedByUser:     link.addedByUserId === null
          ? null
          : adderById.get(link.addedByUserId) ?? null,
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
          providerSubtype: a.providerSubtype,
          interestRate:   a.interestRate,
          minimumPayment: a.minimumPayment,
        },
      });
      continue;
    }

    // A provider connection = an AccountConnection carrying a PlaidItem (canonical
    // preferred) or a wallet address. A manual asset has neither.
    //
    // RLS-T2 — the item is resolved through `plaidItemById` rather than a relation
    // include, and the PREFERENCE ORDER is unchanged: a canonical connection
    // carrying an item wins, else any connection carrying one.
    const plaidItem = pickPlaidItem(a.connections, plaidItemById);
    // ⚠️ `isManual` reads the SCALAR, not the resolved item, exactly as before —
    // which is why it is unaffected by whose PlaidItem rows are readable.
    const hasProvider = a.connections.some((c) => c.plaidItemDbId !== null) || !!a.walletAddress;

    // connectionState from deriveConnectionState() verbatim; null when there is no
    // Plaid item to derive from (manual, wallet-only, or a revoked item) — never
    // a fabricated "healthy".
    const connectionState = plaidItem ? deriveConnectionState(plaidItem) : null;

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
      name:               accountDisplayName(a),
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
      ...(walletValue?.price ? { cryptoPrice: walletValue.price } : {}),
    });
  }

  // Aggregate + sanitise BALANCE_ONLY shares; map to the detail shape with every
  // management field neutralised (no mask, no health, no imports, no actions).
  // REVIEW-3 B-1 — the authority now aggregates AFTER financial semantics (a
  // debt row's balance is Σ per-member amountOwed with issuer credit disclosed
  // separately) and FAILS CLOSED on non-disclosing tiers, which surface only
  // as `redactedCount` below.
  const { accounts: aggregatedAccounts, redactedCount } = normalizeSharedAccounts(balanceOnlyShares);
  const aggregated: AccountDetailRow[] = aggregatedAccounts.map((r) => ({
    id:                 r.id,
    spaceAccountLinkId: null,
    visibility:         "BALANCE_ONLY",
    ...(r.aggregate ? { memberCount: r.aggregate.memberCount } : {}),
    ...(r.aggregate && r.aggregate.creditTotal > 0 ? { creditTotal: r.aggregate.creditTotal } : {}),
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
  // REVIEW-3 B-1 — the response carries the fail-closed redaction count so the
  // Accounts surfaces can DISCLOSE withheld links instead of silently omitting
  // them (consumers accept both this shape and the former bare array).
  return NextResponse.json({ rows: [...fullRows, ...aggregated], redactedCount });
}

/** The detail route's response shape (REVIEW-3 B-1). */
export interface AccountDetailResponse {
  rows:          AccountDetailRow[];
  /** ACTIVE links whose tier grants no balance disclosure — in no row, no sum. */
  redactedCount: number;
}
