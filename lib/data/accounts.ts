/**
 * lib/data/accounts.ts
 *
 * Server-only. All functions query Prisma and return plain serialisable objects
 * (no Date instances) so they can be passed safely from Server → Client components.
 *
 * getAccounts() queries via SpaceAccountLink → FinancialAccount (D3 Step 4C
 * read cutover — see docs/D3_STEP4C_CORE_DASHBOARD_REVIEW.md). Visibility is
 * status: ACTIVE on the link, same as the WorkspaceAccountShare query this
 * replaced; `kind` (HOME vs SHARED) is not filtered on — both confer
 * visibility, only ownership semantics differ, and only after the D3 Step 3
 * HOME Semantics Correction (docs/D3_STEP3_HOME_SEMANTICS_CORRECTION.md) is
 * the link set here guaranteed to agree with WorkspaceAccountShare's.
 * getHoldings() reads both Holding anchors during the D11 migration: legacy
 * rows still pointing at Account (spaceId direct), and current/new rows
 * pointing at FinancialAccount (visibility via SpaceAccountLink, same join
 * getAccounts() uses). Output is normalized back to a single `accountId`
 * field so existing UI call sites need no changes.
 */

import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { Account, Holding } from "@/types";
import { ShareStatus } from "@prisma/client";
import { estimateMinimumPayment } from "@/lib/debt";

/**
 * All accounts visible to the current space, via SpaceAccountLink.
 *
 * Pass `ctx` when the caller has already resolved space context for this
 * request (e.g. the dashboard page resolves it once and fans it out to all
 * its data helpers) to avoid a redundant getSpaceContext() call. Falls
 * back to resolving it internally (now cached per-request via React's
 * cache()) when called standalone, so existing callers keep working.
 */
export async function getAccounts(ctx?: { spaceId: string }): Promise<Account[]> {
  const { spaceId } = ctx ?? (await getSpaceContext());

  const links = await db.spaceAccountLink.findMany({
    where: {
      spaceId,
      status:           ShareStatus.ACTIVE,
      financialAccount: { deletedAt: null },
    },
    include: { financialAccount: { include: { debtProfile: true } } },
    orderBy: [
      { financialAccount: { type: "asc" } },
      { financialAccount: { name: "asc" } },
    ],
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return links.map(({ financialAccount: r }: any) => {
    const profile = r.debtProfile ?? null;

    // Effective APR/minimum payment: DebtProfile (new, richer source) takes
    // precedence over the legacy flat columns when present.
    const effectiveApr = profile?.apr ?? r.interestRate ?? undefined;
    const manualMinimumPayment = profile?.minimumPayment ?? r.minimumPayment ?? undefined;

    let minimumPayment = manualMinimumPayment;
    let minimumPaymentIsEstimated = false;

    // Only estimate when the user gave us an APR but no real minimum payment —
    // never overrides a manually-entered or issuer-provided value.
    if (minimumPayment === undefined && effectiveApr !== undefined && r.balance) {
      minimumPayment = estimateMinimumPayment(Math.abs(r.balance), effectiveApr);
      minimumPaymentIsEstimated = true;
    }

    return {
      id:            r.id,
      // Resolution order: user override > Plaid's official name > Plaid's raw
      // name > whatever was already in `name` (covers manual/legacy accounts).
      name:          r.displayName ?? r.officialName ?? r.plaidName ?? r.name,
      type:          r.type as Account["type"],
      institution:   r.institution,
      balance:       r.balance,
      currency:      r.currency,
      lastUpdated:   r.lastUpdated.toISOString(),
      plaidName:     r.plaidName    ?? undefined,
      officialName:  r.officialName ?? undefined,
      displayName:   r.displayName  ?? undefined,
      creditLimit:    r.creditLimit ?? undefined,
      debtSubtype:    r.debtSubtype ?? undefined,
      interestRate:   effectiveApr,
      minimumPayment,
      minimumPaymentIsEstimated: minimumPaymentIsEstimated || undefined,
      debtProfile: profile ? {
        apr:               profile.apr               ?? undefined,
        minimumPayment:    profile.minimumPayment     ?? undefined,
        dueDay:            profile.dueDay             ?? undefined,
        statementCloseDay: profile.statementCloseDay  ?? undefined,
        promoAprEndDate:   profile.promoAprEndDate ? profile.promoAprEndDate.toISOString().split("T")[0] : undefined,
        notes:             profile.notes              ?? undefined,
      } : undefined,
      walletAddress:  r.walletAddress  ?? undefined,
      walletChain:   r.walletChain   as Account["walletChain"] ?? undefined,
      nativeBalance: r.nativeBalance ?? undefined,
      syncStatus:    r.syncStatus    as Account["syncStatus"]  ?? undefined,
    };
  });
}

/**
 * All holdings across all investment accounts.
 *
 * D11: Holding now has two possible anchors — legacy Account (accountId) and
 * FinancialAccount (financialAccountId) — while the migration is in
 * progress. Queried separately because each anchor resolves space visibility
 * differently (Account.spaceId is direct; FinancialAccount visibility goes
 * through an active SpaceAccountLink, mirroring getAccounts() above), then
 * merged. A given row only ever has one of the two FKs set, so there's no
 * double-counting. Once every Holding is confirmed migrated off Account,
 * the legacy branch can be deleted — not done here (additive-only for D11).
 */
export async function getHoldings(ctx?: { spaceId: string }): Promise<Holding[]> {
  const { spaceId } = ctx ?? (await getSpaceContext());

  const [legacyRows, financialAccountRows] = await Promise.all([
    db.holding.findMany({
      where: { accountId: { not: null }, account: { spaceId } },
    }),
    db.holding.findMany({
      where: {
        financialAccountId: { not: null },
        financialAccount: {
          deletedAt: null,
          spaceAccountLinks: { some: { spaceId, status: ShareStatus.ACTIVE } },
        },
      },
    }),
  ]);

  const rows = [...legacyRows, ...financialAccountRows].sort((a, b) => b.value - a.value);

  return rows.map((r) => ({
    id:        r.id,
    // Exactly one of accountId/financialAccountId is set per row — normalize
    // to a single field so downstream UI (which matches holdings to accounts
    // by this id) needs no changes.
    accountId: (r.accountId ?? r.financialAccountId) as string,
    symbol:    r.symbol,
    name:      r.name,
    quantity:  r.quantity,
    price:     r.price,
    value:     r.value,
    change24h: r.change24h,
    isCash:    r.isCash,
  }));
}

/**
 * Latest credit score for the current user.
 * CreditScore is user-owned (not space-owned) since it is personal identity data.
 */
export async function getFicoData(ctx?: { userId: string }): Promise<{ score: number | null; updatedAt: string | null }> {
  const { userId } = ctx ?? (await getSpaceContext());

  const row = await db.creditScore.findFirst({
    where:   { userId },
    orderBy: { recordedAt: "desc" },
    select:  { score: true, recordedAt: true },
  });

  return {
    score:     row?.score      ?? null,
    updatedAt: row?.recordedAt?.toISOString() ?? null,
  };
}

/** @deprecated use getFicoData instead */
export async function getFicoScore(): Promise<number | null> {
  return (await getFicoData()).score;
}
