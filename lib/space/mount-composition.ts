/**
 * lib/space/mount-composition.ts  (PS-6B — financial mount hydration)
 *
 * THE single authoritative server composition of the FINANCIAL initial-Workspace
 * data. It owns the loaders that back the three EAGER structural fetches the
 * dashboard shell used to run on every mount — sections, accounts, member count —
 * so the /dashboard RSC boundary can hydrate the shell instead of the client
 * re-fetching (each of those client fetches independently re-ran the
 * session-revocation + spaceMember authority; that duplicate work is what
 * produced the mount fan-out / P2024).
 *
 * NO DUPLICATED LOADERS. The route handlers (/api/spaces/[id]/sections,
 * /api/spaces/[id]/accounts) now delegate to loadSpaceSections/loadSpaceAccounts
 * here, so there is exactly ONE query definition per resource, consumed by both
 * the API route (for refresh / warm Workspace switches / external callers) and
 * this server composition (for the initial mount). The routes keep their own
 * authorization guards — this module performs NO authorization and must only be
 * called for a Space the caller has ALREADY been authorized for (the /dashboard
 * page authorizes via getSpaceContext before composing).
 *
 * FINANCIAL-ONLY (PS-6P boundary). This is the finance domain's
 * InitialWorkspacePayload. It is NOT part of the domain-neutral SpaceMountContext
 * (PS-6A) and carries no platform assumptions. Platform keeps its self-fetch
 * widgets (untouched).
 *
 * SERIALIZATION-SAFE. Returns exactly the client view shapes (DashboardSection /
 * SpaceAccount / number) — all strings/numbers/booleans, byte-identical to the
 * fetch().json() the client used to receive — so hydrating from the RSC payload
 * cannot drift from the fetched shape.
 */

import "server-only";
import { accountDisplayName, ACCOUNT_NAME_SELECT } from "@/lib/accounts/display-identity";
import { sortAccountsForDisplay } from "@/lib/data/accounts";

import { db } from "@/lib/db";
import { ShareStatus } from "@prisma/client";
import { normalizeSharedAccounts } from "@/lib/account-privacy";
import { resolveEffectiveDebtTerms } from "@/lib/debt/effective-terms";
import type { DashboardSection, SpaceAccount } from "@/lib/space/dashboard-types";
import { resolveRowBalances, reconcileAccount } from "@/lib/balances/account-balances";
import { loadPendingEvidence, NO_PENDING } from "@/lib/balances/pending-evidence";

/** THE sections loader (was inline in /api/spaces/[id]/sections). */
export async function loadSpaceSections(spaceId: string): Promise<DashboardSection[]> {
  const rows = await db.spaceDashboardSection.findMany({
    where:   { spaceId },
    orderBy: [{ tab: "asc" }, { order: "asc" }],
  });
  // Map to the client view type (drops createdAt/updatedAt, which no consumer
  // reads) so the hydrated value is byte-identical to the route's JSON shape.
  return rows.map((r) => ({
    id:      r.id,
    key:     r.key,
    label:   r.label,
    tab:     r.tab,
    enabled: r.enabled,
    order:   r.order,
    config:  (r.config ?? null) as Record<string, unknown> | null,
  }));
}

/** THE accounts loader (was inline in /api/spaces/[id]/accounts) — identical
 *  links query + earliest-transaction floor + visibility normalization. */
export async function loadSpaceAccounts(spaceId: string): Promise<SpaceAccount[]> {
  const links = await db.spaceAccountLink.findMany({
    where: {
      spaceId,
      status:           ShareStatus.ACTIVE,
      financialAccount: { deletedAt: null },
    },
    select: {
      visibilityLevel: true,
      addedByUserId:   true,
      addedByUser: { select: { firstName: true, name: true } },
      financialAccount: {
        select: {
          id: true, type: true, institution: true, balance: true,
          // v2.6-TRUTH-10 — THE ROOT CAUSE. This selected `name` alone, so the
          // loader feeding every Space surface could not resolve an identity and
          // emitted the provider's raw label — "CREDIT CARD" on Cash Flow while
          // the Credit page, reading getAccounts, showed "Ultimate Rewards®" for
          // the same row. Selecting the columns is what makes resolution possible.
          ...ACCOUNT_NAME_SELECT,
          currency: true, lastUpdated: true, creditLimit: true, debtSubtype: true,
          interestRate: true, minimumPayment: true,
          // v2.6-L3 — forwarded RAW into lib/balances (the only interpreter);
          // never read as a value in this file.
          availableBalance: true, walletAddress: true,
          // v2.6-L1 — the institution's balance-computation clock, carried so the
          // freshness authority can distinguish provider attestation from our own
          // write time instead of every surface assuming they are the same fact.
          balanceLastUpdatedAt: true,
          // V26-PRE (B3) — DebtProfile joined so the EFFECTIVE terms authority
          // (lib/debt/effective-terms.ts) can resolve APR/minimum payment.
          // Before this join, Space debt widgets computed interest and payoff
          // timelines from the superseded flat column the moment a user
          // corrected the APR via the debt profile.
          debtProfile: { select: { apr: true, minimumPayment: true } },
        },
      },
    },
    orderBy: [
      { financialAccount: { type: "asc" } },
      { financialAccount: { name: "asc" } },
    ],
  });

  const accountIds = links.map((l) => l.financialAccount.id);
  const floors = accountIds.length
    ? await db.transaction.groupBy({
        by:    ["financialAccountId"],
        where: { financialAccountId: { in: accountIds }, deletedAt: null },
        _min:  { date: true },
      })
    : [];
  const floorByAccount = new Map<string, string>();
  for (const f of floors) {
    if (f.financialAccountId && f._min.date) {
      floorByAccount.set(f.financialAccountId, f._min.date.toISOString().slice(0, 10));
    }
  }

  // normalizeSharedAccounts returns NormalizedAccount (institution/creditLimit
  // etc. optional/nullable). The client SpaceAccount view type already assumed
  // the narrower shape when it consumed this route's JSON (the fetch cast the
  // response to SpaceAccount[]), so this assertion preserves the EXACT runtime
  // shape the client has always received — no data is coerced.
  // V26-PRE (B3) — resolve effective debt terms through the single authority
  // BEFORE normalization, so every downstream consumer (LiabilitiesLedger
  // interest math, SectionCard avgApr/payoff, avalanche ordering) reads the
  // same effective APR/minimum payment as the Personal Debt surface. The
  // normalized shape is unchanged: `interestRate`/`minimumPayment` now simply
  // carry the EFFECTIVE values (DebtProfile > flat column).
  const effectiveLinks = links.map((l) => {
    const terms = resolveEffectiveDebtTerms(l.financialAccount);
    const { debtProfile: _profile, ...account } = l.financialAccount;
    return {
      ...l,
      financialAccount: {
        ...account,
        // v2.6-TRUTH-10 — resolve the canonical identity HERE, once, so every
        // Space surface downstream receives the same name the Credit page shows.
        // ⚠️ `name` is overwritten with the resolved identity, NOT a new field:
        // every consumer already reads `name`, and adding a second name field
        // would recreate the divergence this slice removes.
        name:           accountDisplayName(account),
        interestRate:   terms.apr,
        minimumPayment: terms.minimumPayment,
      },
    };
  });

  // v2.6-L3 — the canonical CURRENT-STATE claim, resolved ONCE here so every
  // widget consumes the same answer and none of them re-derives it. Pending
  // evidence is provider-observed only (loadPendingEvidence); nothing is
  // inferred from recurrence, averages, or habits.
  const pending = await loadPendingEvidence(accountIds);
  const now = new Date();
  const currentStateByAccount = new Map<string, SpaceAccount["currentState"]>();
  for (const l of links) {
    const fa = l.financialAccount;
    const balances = resolveRowBalances(fa, now);
    const rec = reconcileAccount(balances, pending.get(fa.id) ?? NO_PENDING, fa.creditLimit);
    // Only cash accounts carry a reachable figure; for the rest the field is
    // omitted entirely rather than populated with a null-that-reads-as-zero.
    if (rec.basis !== "DEPOSITORY") continue;
    currentStateByAccount.set(fa.id, {
      reachable:    rec.reachable?.amount ?? null,
      unexplained:  rec.unexplained,
      state:        rec.state,
      pendingCount: rec.pending.count,
    });
  }

  // v2.6-TRUTH-10b — the query sorts on the STORED name and cannot do better;
  // re-order the RESOLVED list so it reads the way it renders. Type order is
  // unchanged, and this list is unpaginated so the sort is complete.
  return sortAccountsForDisplay(normalizeSharedAccounts(effectiveLinks).map((a) => ({
    ...a,
    earliestTxDate: floorByAccount.get(a.id) ?? null,
    // Aggregated BALANCE_ONLY rows have a synthetic id that maps to no single
    // account, so they carry no current-state claim — an aggregate of reachable
    // figures across members is a different quantity we have not defined.
    ...(currentStateByAccount.has(a.id) ? { currentState: currentStateByAccount.get(a.id) } : {}),
  }))) as unknown as SpaceAccount[];
}

/** ACTIVE member count — the ONLY field the shell header reads from the heavy
 *  /api/spaces/[id] route. Composed as a cheap count so the mount need not call
 *  that route at all (the route stays for its other consumers). */
export function getSpaceMemberCount(spaceId: string): Promise<number> {
  return db.spaceMember.count({ where: { spaceId, status: "ACTIVE" } });
}

/**
 * The finance domain's initial-Workspace payload — the data the shell needs for
 * its first render, hydrated once. Deliberately the STRUCTURAL set only
 * (sections + accounts + member count); snapshots / perspectives / transactions
 * stay lazy/client (they are conditional and heavier — deferred, PS-6B does not
 * increase server work to reduce client work).
 */
export interface FinancialInitialWorkspacePayload {
  sections:    DashboardSection[];
  accounts:    SpaceAccount[];
  memberCount: number;
}

/** Compose the finance initial payload for an ALREADY-AUTHORIZED space. */
export async function composeFinancialInitialWorkspace(
  spaceId: string,
): Promise<FinancialInitialWorkspacePayload> {
  const [sections, accounts, memberCount] = await Promise.all([
    loadSpaceSections(spaceId),
    loadSpaceAccounts(spaceId),
    getSpaceMemberCount(spaceId),
  ]);
  return { sections, accounts, memberCount };
}
