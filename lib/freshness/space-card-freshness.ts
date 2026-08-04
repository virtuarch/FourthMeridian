/**
 * lib/freshness/space-card-freshness.ts   (V27-L4F)
 *
 * Per-Space ACCOUNT freshness for the Spaces launcher cards, through the V27-L1
 * authority. READ-ONLY: one query, no writes.
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 *
 * The card's "Updated today" came from `getSpaceNetWorthSummaries().asOf` — the
 * latest SNAPSHOT date. A snapshot date says when Fourth Meridian last COMPUTED
 * a net worth, never when the balances underneath were observed. On the live
 * corpus the seed Spaces carried snapshot dates of 2026-07-19 while every
 * account in them had last been checked **56 days** earlier, and Chris' Space
 * read "Updated today" from a 2026-08-04 snapshot over balances last checked the
 * day before.
 *
 * The Slice 1 rules apply unchanged: anchor on the OLDEST observation, disclose
 * the distribution, and never let one fresh account speak for a stale Space.
 */

import "server-only";

import { db } from "@/lib/db";
import { ShareStatus } from "@prisma/client";
import { resolveSpaceFreshness, type SpaceFreshness } from "./space-freshness";

/** The card-facing projection — the claim plus what it hides. */
export interface SpaceCardFreshness {
  /** "Last checked" | "Balances as of" | "Freshness unknown". */
  label: string;
  /** ISO instant of the OLDEST observation, or null when nothing was observed. */
  anchorObservedAt: string | null;
  /** What the anchor hides, or null when it hides nothing. */
  qualifier: string | null;
  /** UNIFORM | PARTIAL | STALE | UNKNOWN. */
  claim: SpaceFreshness["claim"];
  accountCount: number;
  staleAccountCount: number;
}

/**
 * Resolve freshness for every given Space in one pass. Spaces with no linked
 * accounts are ABSENT from the result — a Space with nothing in it has no
 * freshness to claim, and the card should render no line rather than "unknown".
 */
export async function getSpaceCardFreshness(
  spaceIds: string[],
): Promise<Record<string, SpaceCardFreshness>> {
  const out: Record<string, SpaceCardFreshness> = {};
  if (spaceIds.length === 0) return out;

  const links = await db.spaceAccountLink.findMany({
    where: {
      spaceId: { in: spaceIds },
      status: ShareStatus.ACTIVE,
      financialAccount: { deletedAt: null },
    },
    select: {
      spaceId: true,
      financialAccount: {
        select: { id: true, balance: true, lastUpdated: true, balanceLastUpdatedAt: true },
      },
    },
  });

  const bySpace = new Map<string, typeof links>();
  for (const l of links) {
    const list = bySpace.get(l.spaceId) ?? [];
    list.push(l);
    bySpace.set(l.spaceId, list);
  }

  // ONE clock for the whole page, so two cards can never be aged against two
  // different instants.
  const now = new Date();
  for (const [spaceId, rows] of bySpace) {
    const f = resolveSpaceFreshness(
      rows.map((r) => ({
        accountId:         r.financialAccount.id,
        ingestedAt:        r.financialAccount.lastUpdated,
        providerBalanceAt: r.financialAccount.balanceLastUpdatedAt,
        balance:           r.financialAccount.balance,
      })),
      now,
    );
    out[spaceId] = {
      label:             f.label,
      anchorObservedAt:  f.anchor.observedAt,
      qualifier:         f.qualifier,
      claim:             f.claim,
      accountCount:      f.accountCount,
      staleAccountCount: f.staleAccountCount,
    };
  }
  return out;
}
