/**
 * lib/data/accounts.ts
 *
 * Server-only. All functions query Prisma and return plain serialisable objects
 * (no Date instances) so they can be passed safely from Server → Client components.
 *
 * getAccounts() queries via SpaceAccountLink → FinancialAccount (D3 Step 4C
 * read cutover — see docs/initiatives/d3/D3_STEP4C_CORE_DASHBOARD_REVIEW.md). Visibility is
 * status: ACTIVE on the link, same as the WorkspaceAccountShare query this
 * replaced; `kind` (HOME vs SHARED) is not filtered on — both confer
 * visibility, only ownership semantics differ, and only after the D3 Step 3
 * HOME Semantics Correction (docs/initiatives/d3/D3_STEP3_HOME_SEMANTICS_CORRECTION.md) is
 * the link set here guaranteed to agree with WorkspaceAccountShare's.
 * getHoldings() reads Holding rows anchored to FinancialAccount (visibility via
 * SpaceAccountLink, the same join getAccounts() uses), exposing the anchor as a
 * single `accountId` field so existing UI call sites need no changes.
 */

import { db } from "@/lib/db";
import { getSpaceContext } from "@/lib/space";
import { Account, Holding } from "@/types";
import { ShareStatus, PlaidItemStatus, type VisibilityLevel } from "@prisma/client";
import { estimateMinimumPayment } from "@/lib/debt";
// KD-19 — visibility-tier enforcement on the UI account/holdings read paths.
// grantsAccountDetail + TRANSACTION_DETAIL_VISIBILITY share the FULL gate the
// AI assemblers use, so no read surface can disagree; sanitizeForBalanceOnly
// is the same single-account redactor the shared-Space accounts route uses.
import { grantsAccountDetail, TRANSACTION_DETAIL_VISIBILITY } from "@/lib/ai/visibility";
import { sanitizeForBalanceOnly } from "@/lib/account-privacy";

/**
 * One visible account plus the SpaceAccountLink.visibilityLevel that
 * produced it — the internal, server-side contract for deterministic
 * consumers (Perspective Engine, future Meridian Analyst / Daily Brief /
 * Health Reviews) that must distinguish FULL vs BALANCE_ONLY vs
 * SUMMARY_ONLY without inferring it from sanitized/missing fields.
 *
 * The tier rides BESIDE the Account object, never on it: getAccounts()
 * (below) strips it, so the Account shape that flows into pages/client
 * components is byte-identical to before and the tier cannot end up in a
 * client response unless a consumer explicitly plucks and serializes it.
 * Reuses the existing VisibilityLevel model — do not introduce a parallel
 * tier vocabulary on top of this.
 */
export interface AccountWithVisibility {
  account:         Account;
  visibilityLevel: VisibilityLevel;
}

/**
 * All accounts visible to the current space, via SpaceAccountLink, each
 * paired with the visibility tier that produced it (AccountWithVisibility
 * above). Most callers want getAccounts() below instead.
 *
 * Pass `ctx` when the caller has already resolved space context for this
 * request (e.g. the dashboard page resolves it once and fans it out to all
 * its data helpers) to avoid a redundant getSpaceContext() call. Falls
 * back to resolving it internally (now cached per-request via React's
 * cache()) when called standalone, so existing callers keep working.
 *
 * `ctx.userId` is an optional internal/test seam: `getSpaceContext()` reads
 * next-auth `headers()` and therefore cannot run outside a Next request scope
 * (e.g. a standalone tsx privacy-proof script). A caller that already knows the
 * viewing user — and only such a caller — may pass `userId` to skip that
 * resolution. Production callers pass at most `{ spaceId }`, so they resolve
 * `userId` from the request scope exactly as before; production behavior is
 * unchanged.
 */
export async function getAccountsWithVisibility(
  ctx?: { spaceId: string; userId?: string },
): Promise<AccountWithVisibility[]> {
  // Resolve spaceId + the current userId (used only for the reconnect badge
  // below). Call getSpaceContext() only when the caller hasn't supplied both —
  // it is cache()-memoized per request, so this is at most one call. When both
  // are provided (internal/test), no request scope is touched.
  const needsResolve = !ctx?.spaceId || !ctx?.userId;
  const resolved = needsResolve ? await getSpaceContext() : null;
  const spaceId = ctx?.spaceId ?? resolved!.spaceId;
  // D2-7E — current user, for the reconnect-badge ownership check below.
  const userId = ctx?.userId ?? resolved!.userId;

  const links = await db.spaceAccountLink.findMany({
    where: {
      spaceId,
      status:           ShareStatus.ACTIVE,
      financialAccount: { deletedAt: null },
    },
    include: {
      // KD-19 — owner first name for the generic label on sanitized
      // (BALANCE_ONLY / SUMMARY_ONLY) rows, matching normalizeSharedAccounts.
      addedByUser: { select: { firstName: true, name: true } },
      financialAccount: {
        include: {
          debtProfile: true,
          // D2-7E — only enough to compute needsReauth/plaidItemId below.
          // No other change to this query.
          connections: {
            where:  { deletedAt: null, plaidItemDbId: { not: null } },
            select: {
              connectedByUserId: true,
              plaidItemDbId:     true,
              plaidItem:         { select: { status: true } },
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return links.map((link: any) => {
    const r = link.financialAccount;

    // KD-19 — only FULL links may expose account metadata (institution, real
    // name, credit limit, debt fields). BALANCE_ONLY exposes the balance total
    // alone; SUMMARY_ONLY / PRIVATE / SHARED fail closed. Mirrors the AI
    // accounts assembler and lib/account-privacy.ts so no read surface can
    // disagree. Returns the same minimal safe shape the shared-Space accounts
    // route already serves to the UI.
    if (!grantsAccountDetail(link.visibilityLevel)) {
      const ownerFirstName =
        link.addedByUser?.firstName?.trim() ||
        link.addedByUser?.name?.trim().split(" ")[0] ||
        null;
      const safe = sanitizeForBalanceOnly(
        {
          id:          r.id,
          type:        r.type,
          debtSubtype: r.debtSubtype ?? null,
          balance:     r.balance,
          currency:    r.currency,
          lastUpdated: r.lastUpdated,
        },
        ownerFirstName,
      );
      return {
        visibilityLevel: link.visibilityLevel as VisibilityLevel,
        account: {
          id:          safe.id,
          name:        safe.name,
          type:        safe.type as Account["type"],
          institution: "",              // redacted — institution is identifying
          balance:     safe.balance,
          currency:    safe.currency,
          lastUpdated: safe.lastUpdated,
          // All other fields intentionally omitted (undefined) under the
          // BALANCE_ONLY / SUMMARY_ONLY tier: no institution, no debt metadata,
          // no Plaid/connection state, no wallet fields.
        } as Account,
      };
    }

    const profile = r.debtProfile ?? null;

    // D2-7E — reconnect badge. Only true for the connection *this* user made
    // themselves (AccountConnection.connectedByUserId), never for a Space
    // member viewing an account shared by someone else — a joint account can
    // have one healthy connection and one broken one.
    const reauthConnection = (r.connections ?? []).find(
      (c: { connectedByUserId: string; plaidItem: { status: PlaidItemStatus } | null }) =>
        c.connectedByUserId === userId && c.plaidItem?.status === PlaidItemStatus.NEEDS_REAUTH
    );

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
      visibilityLevel: link.visibilityLevel as VisibilityLevel,
      account: {
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
      needsReauth:   !!reauthConnection,
      plaidItemId:   reauthConnection?.plaidItemDbId ?? undefined,
      },
    };
  });
}

/**
 * All accounts visible to the current space — the client-safe shape every
 * existing caller uses. Delegates to getAccountsWithVisibility() and strips
 * the server-side visibility tier, so this function's output is unchanged
 * by the AccountWithVisibility addition.
 */
export async function getAccounts(ctx?: { spaceId: string; userId?: string }): Promise<Account[]> {
  return (await getAccountsWithVisibility(ctx)).map((r) => r.account);
}

/**
 * All holdings across all investment accounts.
 *
 * Holdings are anchored to a FinancialAccount (financialAccountId); visibility
 * goes through an active SpaceAccountLink, mirroring getAccounts() above.
 */
export async function getHoldings(ctx?: { spaceId: string }): Promise<Holding[]> {
  const { spaceId } = ctx ?? (await getSpaceContext());

  const rows = (await db.holding.findMany({
    where: {
      financialAccountId: { not: null },
      financialAccount: {
        deletedAt: null,
        // KD-19 — individual positions are per-item DETAIL and require a
        // FULL link. BALANCE_ONLY / SUMMARY_ONLY accounts contribute their
        // balance (via getAccounts) but never expose symbols/quantities.
        // Same FULL-only gate the transaction read paths use, so positions
        // and rows can never disagree.
        spaceAccountLinks: {
          some: {
            spaceId,
            status:          ShareStatus.ACTIVE,
            visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY },
          },
        },
      },
    },
  })).sort((a, b) => b.value - a.value);

  return rows.map((r) => ({
    id:        r.id,
    // Holdings match to accounts by this single id (the FinancialAccount FK).
    accountId: r.financialAccountId as string,
    symbol:    r.symbol,
    name:      r.name,
    quantity:  r.quantity,
    price:     r.price,
    value:     r.value,
    change24h: r.change24h,
    isCash:    r.isCash,
    currency:  r.currency ?? null, // MC1 P4 Slice 5 — conversion input
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
