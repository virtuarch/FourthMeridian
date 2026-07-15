/**
 * lib/investments/account-scope.ts
 *
 * KD-21a — the single source of truth for WHICH accounts an investment read may
 * see, keyed off SpaceAccountLink visibility. The A-track valuation / time-machine
 * bindings compute value and holdings FROM per-position rows, so the account set
 * they scope to IS the visibility boundary for position + event detail.
 *
 * Two visibility scopes:
 *   - "all"            — every ACTIVE, non-deleted linked account. Used by
 *                        wealth-TOTAL callers (A9 snapshot regeneration), where a
 *                        BALANCE_ONLY-shared account's value legitimately counts
 *                        toward Space wealth (its balance IS shared; only per-item
 *                        detail is not). This is the default.
 *   - "detailEligible" — only links whose visibilityLevel grants per-item detail
 *                        (FULL — the canonical TRANSACTION_DETAIL_VISIBILITY
 *                        predicate, deliberately shared with getHoldings so the
 *                        investment spine and the data layer can never disagree
 *                        about who sees positions). BALANCE_ONLY / SUMMARY_ONLY /
 *                        PRIVATE / SHARED expose NO positions or events here — the
 *                        member-facing Investments Time Machine uses this scope.
 *
 * Fails closed: "detailEligible" with no qualifying link yields an empty account
 * set, never a leak.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { TRANSACTION_DETAIL_VISIBILITY } from "@/lib/ai/visibility";

type Client = PrismaClient | Prisma.TransactionClient;

export type InvestmentVisibilityScope = "all" | "detailEligible";

/** The ACTIVE, non-deleted account ids for a Space, filtered by visibility scope. */
export async function resolveSpaceInvestmentAccountIds(
  client: Client,
  spaceId: string,
  scope: InvestmentVisibilityScope,
): Promise<string[]> {
  const links = await client.spaceAccountLink.findMany({
    where: {
      spaceId,
      status: "ACTIVE",
      financialAccount: { deletedAt: null },
      ...(scope === "detailEligible"
        ? { visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY } }
        : {}),
    },
    select: { financialAccountId: true },
  });
  return [...new Set(links.map((l) => l.financialAccountId))];
}

/**
 * The (accountIds, spaceId) scope for a single-account investment read. `spaceId`
 * supplies the reporting currency / FX context.
 *   - "all": preserves the prior behavior — the account is always in scope; the
 *     link is consulted only to resolve the Space when no hint is given.
 *   - "detailEligible": the account's own ACTIVE link must grant detail (FULL);
 *     otherwise the account contributes NO positions/events (fails closed).
 */
export async function resolveSingleAccountScope(
  client: Client,
  financialAccountId: string,
  spaceIdHint: string | null,
  scope: InvestmentVisibilityScope,
): Promise<{ accountIds: string[]; spaceId: string | null }> {
  if (scope === "detailEligible") {
    const link = await client.spaceAccountLink.findFirst({
      where: {
        financialAccountId,
        status: "ACTIVE",
        visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY },
      },
      select: { spaceId: true },
    });
    if (!link) return { accountIds: [], spaceId: spaceIdHint };
    return { accountIds: [financialAccountId], spaceId: spaceIdHint ?? link.spaceId };
  }

  // "all" — unchanged: only look up the Space when no hint was supplied.
  let spaceId = spaceIdHint;
  if (!spaceId) {
    const link = await client.spaceAccountLink.findFirst({
      where: { financialAccountId, status: "ACTIVE" },
      select: { spaceId: true },
    });
    spaceId = link?.spaceId ?? null;
  }
  return { accountIds: [financialAccountId], spaceId };
}
