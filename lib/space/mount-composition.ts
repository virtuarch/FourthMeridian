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

import { db } from "@/lib/db";
import { ShareStatus } from "@prisma/client";
import { normalizeSharedAccounts } from "@/lib/account-privacy";
import type { DashboardSection, SpaceAccount } from "@/lib/space/dashboard-types";

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
          id: true, name: true, type: true, institution: true, balance: true,
          currency: true, lastUpdated: true, creditLimit: true, debtSubtype: true,
          interestRate: true, minimumPayment: true,
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
  return normalizeSharedAccounts(links).map((a) => ({
    ...a,
    earliestTxDate: floorByAccount.get(a.id) ?? null,
  })) as unknown as SpaceAccount[];
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
