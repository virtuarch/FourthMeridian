/**
 * lib/perspective-engine/lenses/liquidity.ts
 *
 * Liquidity lens — data binding + registration. All math lives in
 * ./liquidity.core.ts (pure, fixture-testable); this file only:
 *
 *   1. reads accounts through the visibility-enforced data layer
 *      (lib/data/accounts.ts#getAccountsWithVisibility — the KD-19 read
 *      path plus the server-side tier contract, never raw Prisma), and
 *   2. maps each row down to LiquidityAccountRow — id, type, balance,
 *      creditLimit, lastUpdated, visibilityLevel and NOTHING else. Names
 *      and institutions are dropped here, at the boundary, so the core
 *      can never leak what it never receives.
 *
 * Registered at module top level (house pattern: lib/ai/assemblers/*).
 * Import this module for its side effect; consumers then call
 * computePerspective("liquidity", scope).
 */

import { getAccountsWithVisibility } from "@/lib/data/accounts";
import { registerLens } from "../registry";
import type { ComputeOptions, LensResult, PerspectiveScope } from "../types";
import { computeLiquidity, type LiquidityAccountRow } from "./liquidity.core";

async function liquidityLens(
  scope:   PerspectiveScope,
  options: ComputeOptions,
): Promise<LensResult> {
  const rows = await getAccountsWithVisibility({
    spaceId: scope.spaceId,
    // Always the viewing member — visibility is computed for the requester,
    // never a stored or elevated identity (investigation §5.9).
    userId:  scope.userId,
  });

  const lensRows: LiquidityAccountRow[] = rows.map(({ account, visibilityLevel }) => ({
    id:              account.id,
    type:            account.type,
    balance:         account.balance,
    creditLimit:     account.creditLimit ?? undefined,
    lastUpdated:     account.lastUpdated,
    visibilityLevel: visibilityLevel as string,
  }));

  return computeLiquidity(scope, options, lensRows);
}

registerLens("liquidity", liquidityLens);
