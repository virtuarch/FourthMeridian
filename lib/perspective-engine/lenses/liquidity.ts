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
 * A5-P2 (Liquidity Time Machine) — when options.asOf is set, step 1 reads the
 * SAME visibility-redacted rows from the A5-S2 resolver (getAccountsAsOf), which
 * resolves each balance to the historical date and stamps it with { method,
 * tier }. The pure core is UNTOUCHED (it takes rows); this binding then reduces
 * those per-row tiers to the result's `completeness` envelope via the S1
 * propagation helpers. Absent asOf ⇒ the live read, byte-identical (kill switch):
 * no getAccountsAsOf call, no completeness field.
 *
 * Registered at module top level (house pattern: lib/ai/assemblers/*).
 * Import this module for its side effect; consumers then call
 * computePerspective("liquidity", scope).
 */

import { getAccountsWithVisibility } from "@/lib/data/accounts";
import { getAccountsAsOf } from "@/lib/data/accounts-asof";
import { buildSpaceConversionContext, buildSpaceConversionContextById } from "@/lib/money/server-context";
import { minusDaysISO, toISODateUTC } from "@/lib/fx/config";
import { registerLens } from "../registry";
import type { CompletenessTier, ComputeOptions, LensResult, PerspectiveScope } from "../types";
import { computeLiquidity, type LiquidityAccountRow } from "./liquidity.core";
import { buildLiquidityCompleteness, liquidityComponent } from "./asof-completeness";

async function liquidityLens(
  scope:   PerspectiveScope,
  options: ComputeOptions,
): Promise<LensResult> {
  // A5-P2 — per-account trust stamps, populated only on the as-of path so the
  // asOf-absent branch stays byte-identical. accountId → { tier, type }.
  const stamps = new Map<string, { tier: CompletenessTier; type: string }>();

  const visRows = options.asOf
    ? (await getAccountsAsOf({
        spaceId: scope.spaceId,
        userId:  scope.userId,
        asOf:    options.asOf,
        now:     options.now,
      })).map((r) => {
        stamps.set(r.account.id, { tier: r.tier, type: r.account.type });
        return { account: r.account, visibilityLevel: r.visibilityLevel as string };
      })
    : (await getAccountsWithVisibility({
        spaceId: scope.spaceId,
        // Always the viewing member — visibility is computed for the requester,
        // never a stored or elevated identity (investigation §5.9).
        userId:  scope.userId,
      })).map(({ account, visibilityLevel }) => ({
        account,
        visibilityLevel: visibilityLevel as string,
      }));

  const lensRows: LiquidityAccountRow[] = visRows.map(({ account, visibilityLevel }) => ({
    id:              account.id,
    type:            account.type,
    balance:         account.balance,
    // MC1 P3 Slice 5 — native currency rides along (non-identifying; the
    // privacy contract of this boundary is about names/institutions).
    currency:        account.currency ?? null,
    creditLimit:     account.creditLimit ?? undefined,
    lastUpdated:     account.lastUpdated,
    visibilityLevel,
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

  const result = computeLiquidity(scope, options, lensRows, ctx);

  // A5-P2 — stamp the result with a trust envelope only on the as-of path, and
  // only over the accounts the core actually counted (provenance.accountIds
  // excludes summary-only rows, so a withheld account's tier never leaks in).
  // Absent asOf, or a shaped empty/withheld-only result with no contributors,
  // returns the core result untouched — byte-identical to today.
  if (options.asOf && result.provenance.accountIds.length > 0) {
    const contributingStamps = result.provenance.accountIds
      .map((id) => stamps.get(id))
      .filter((s): s is { tier: CompletenessTier; type: string } => s != null)
      .map((s) => ({ tier: s.tier, component: liquidityComponent(s.type) }));
    return { ...result, completeness: buildLiquidityCompleteness(options.asOf, contributingStamps) };
  }

  return result;
}

registerLens("liquidity", liquidityLens);
