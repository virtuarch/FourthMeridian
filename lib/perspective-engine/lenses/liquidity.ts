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
import { buildSpaceConversionContext, buildSpaceConversionContextById } from "@/lib/money/server-context";
import { minusDaysISO, toISODateUTC } from "@/lib/fx/config";
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
    // MC1 P3 Slice 5 — native currency rides along (non-identifying; the
    // privacy contract of this boundary is about names/institutions).
    currency:        account.currency ?? null,
    creditLimit:     account.creditLimit ?? undefined,
    lastUpdated:     account.lastUpdated,
    visibilityLevel: visibilityLevel as string,
  }));

  // MC1 Phase 3 Slice 5 — THE LENS FLIP (F-3). Real space context, valued at
  // the latest close relative to the engine's injected clock (matching the
  // core's derivation exactly). All-USD Spaces are numerically identical to
  // the raw-addition behavior. The by-id helper keeps @/lib/db out of this
  // adapter (its test tripwires pin the KD-19-only read path) and degrades
  // to identity if the Space row vanished mid-request.
  // MC1 view-as override — when the caller supplies a display-currency target
  // (Personal preview), value the lens directly in THAT currency so headline,
  // verdict, and metric sums all recompute consistently. Otherwise fall back to
  // the Space's reporting currency via the by-id helper — byte-identical.
  const convOpts = {
    currencies: lensRows.map((r) => r.currency ?? null),
    dates:      [minusDaysISO(toISODateUTC(options.now()), 1)],
  };
  const ctx = options.targetCurrency
    ? await buildSpaceConversionContext({ reportingCurrency: options.targetCurrency }, convOpts)
    : await buildSpaceConversionContextById(scope.spaceId, convOpts);

  return computeLiquidity(scope, options, lensRows, ctx);
}

registerLens("liquidity", liquidityLens);
