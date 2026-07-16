/**
 * lib/liquidity/space-data.ts  (LIQ-H1 — historical Liquidity engine, DB binding)
 *
 * THE canonical read contract for the Liquidity workspace and the ONE historical-
 * liquidity authority. It is a server COMPOSITION over existing canonical reads —
 * it introduces NO valuation, NO classifier, and NO liquidity math of its own:
 *
 *   current     → computePerspective("liquidity") = the LIVE liquidity lens,
 *                 verbatim (single authority for present-day liquidity).
 *   atAsOf /    → the SPLICE ENGINE (evaluateHistorical): getAccountsAsOf (cash
 *   atCompareTo   walked back, cards walked back, everything else held flat) +
 *                 getInvestmentValueAsOf(scope 'all') (A8 price×qty×FX, crypto on
 *                 the shared spine) → spliceLiquidityRows (REPLACE each covered
 *                 investment/crypto row's held-flat estimate with its A8 value) →
 *                 the UNCHANGED pure computeLiquidity → the UNCHANGED
 *                 buildLiquidityCompleteness. Every number is A8's or the lens
 *                 core's; this file only routes the reads.
 *
 * Why the splice lives HERE and not in the lens: the lens is under
 * lib/perspective-engine/, whose import-graph guard forbids Prisma / valuation
 * reads (engine.test.ts). The lens's asOf branch is therefore only the cash/card
 * reconstruction primitive; the honest marketable splice is this higher
 * composition — exactly as the SD-4 contract-priming wave designed it.
 *
 * FX posture (deferred, consistent with SD-4): endpoints are valued in the Space's
 * REPORTING currency (A8's reportingCurrency; the conversion context targets the
 * same). Spliced investment rows are stamped in that currency so they identity-
 * convert (no double-FX). Display-currency "view as" and per-asOf-date FX-rate
 * fidelity for foreign-currency cash are a future workspace concern (the
 * Investments workspace owns display FX via convertInvestmentsSpaceData; Liquidity
 * will follow the same seam). Single-currency Spaces are exact.
 *
 * The pure composition (delta, trust, shape) is ./space-data-core.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { getAccountsAsOf } from "@/lib/data/accounts-asof";
import { getInvestmentValueAsOf } from "@/lib/investments/valuation";
import { buildSpaceConversionContextById } from "@/lib/money/server-context";
import { minusDaysISO, toISODateUTC } from "@/lib/fx/config";
import { computePerspective } from "@/lib/perspective-engine";
// Side-effect import: registers the "liquidity" lens so computePerspective can
// resolve it (the /perspectives route does the same). Required for `current`.
import "@/lib/perspective-engine/lenses/liquidity";
import { computeLiquidity } from "@/lib/perspective-engine/lenses/liquidity.core";
import {
  buildLiquidityCompleteness,
  liquidityComponent,
} from "@/lib/perspective-engine/lenses/asof-completeness";
import type { CompletenessTier, LensResult, PerspectiveScope } from "@/lib/perspective-engine/types";
import {
  spliceLiquidityRows,
  type AsOfLiquidityRow,
  type MarketableComponent,
} from "./historical-splice";
import { assembleLiquiditySpaceData } from "./space-data-core";
import type { LiquiditySpaceData } from "./space-data-core";

export type { LiquiditySpaceData, LiquidityDelta } from "./space-data-core";
export { assembleLiquiditySpaceData, worstOfCompleteness } from "./space-data-core";

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * The canonical reads the historical engine composes, as an injectable seam so the
 * engine is unit-testable DB-free (production omits `deps` and gets the real
 * bindings). Mirrors the `client ?? db` DI pattern of loadInvestmentsSpaceData.
 */
export interface LiquidityEngineDeps {
  getAccountsAsOf: typeof getAccountsAsOf;
  getInvestmentValueAsOf: typeof getInvestmentValueAsOf;
  buildCtx: typeof buildSpaceConversionContextById;
  computeCurrent: (scope: PerspectiveScope, now: () => Date) => Promise<LensResult>;
}

function resolveDeps(overrides?: Partial<LiquidityEngineDeps>): LiquidityEngineDeps {
  return {
    getAccountsAsOf: overrides?.getAccountsAsOf ?? getAccountsAsOf,
    getInvestmentValueAsOf: overrides?.getInvestmentValueAsOf ?? getInvestmentValueAsOf,
    buildCtx: overrides?.buildCtx ?? buildSpaceConversionContextById,
    computeCurrent:
      overrides?.computeCurrent ??
      ((scope, now) => computePerspective("liquidity", scope, { now })),
  };
}

/**
 * Reconstruct the liquidity LensResult at ONE historical date via the splice
 * engine. This is the binding the lens itself cannot do (Prisma valuation read);
 * it reuses every pure authority unchanged and attaches the as-of trust envelope
 * exactly as the lens's asOf branch does — over the CONTRIBUTING accounts only
 * (a withheld account's tier never leaks into the envelope).
 */
async function evaluateHistorical(
  scope: PerspectiveScope,
  date: string,
  now: () => Date,
  deps: LiquidityEngineDeps,
  client: Client,
): Promise<LensResult> {
  const [asOfAccounts, valuation] = await Promise.all([
    deps.getAccountsAsOf({ spaceId: scope.spaceId, userId: scope.userId, asOf: date, now }),
    deps.getInvestmentValueAsOf({ spaceId: scope.spaceId, asOf: date, visibilityScope: "all", client }),
  ]);

  const asOfRows: AsOfLiquidityRow[] = asOfAccounts.map((r) => ({
    id: r.account.id,
    type: r.account.type,
    balance: r.account.balance,
    currency: r.account.currency ?? null,
    creditLimit: r.account.creditLimit ?? undefined,
    lastUpdated: r.account.lastUpdated,
    visibilityLevel: r.visibilityLevel as string,
    tier: r.tier,
  }));

  const components: MarketableComponent[] = valuation.components.map((c) => ({
    accountId: c.accountId,
    reportingValue: c.reportingValue,
    overallTier: c.overallTier,
  }));

  const { rows, stamps } = spliceLiquidityRows(asOfRows, components, valuation.reportingCurrency);

  // Same conversion context the lens builds (target = Space reporting currency,
  // valued at yesterday relative to the injected clock). Spliced investment rows
  // carry reportingCurrency, so they identity-convert; only foreign-currency cash
  // is FX'd — at today's rate (the documented deferral).
  const ctx = await deps.buildCtx(scope.spaceId, {
    currencies: rows.map((r) => r.currency ?? null),
    dates: [minusDaysISO(toISODateUTC(now()), 1)],
  });

  const result = computeLiquidity(scope, { now, asOf: date }, rows, ctx);

  if (result.provenance.accountIds.length > 0) {
    const contributing = result.provenance.accountIds
      .map((id) => stamps.get(id))
      .filter((s): s is { tier: CompletenessTier; type: string } => s != null)
      .map((s) => ({ tier: s.tier, component: liquidityComponent(s.type) }));
    return { ...result, completeness: buildLiquidityCompleteness(date, contributing) };
  }
  return result;
}

/** Options for the Liquidity workspace read. `asOf`/`compareTo` are the SD-0B shell
 *  dates; omit both for a pure current-state read (just `current`). */
export interface LoadLiquiditySpaceDataOptions {
  asOf?: string;
  compareTo?: string | null;
  /** Injected clock (deterministic tests); production omits it. */
  now?: () => Date;
  client?: Client;
  /** Test seam — override the canonical reads. Production omits this. */
  deps?: Partial<LiquidityEngineDeps>;
}

/**
 * THE single public Liquidity workspace loader. ORCHESTRATION ONLY:
 *   1. `current` — the live liquidity lens (always).
 *   2. `atAsOf` / `atCompareTo` — the splice engine at each requested date.
 *   3. delegate to the pure `assembleLiquiditySpaceData` for delta + trust.
 * Every consumer that needs current, as-of, compare-to, or the comparison reads it
 * through this one contract instead of assembling the graph itself.
 */
export async function loadLiquiditySpaceData(
  scope: PerspectiveScope,
  options?: LoadLiquiditySpaceDataOptions,
): Promise<LiquiditySpaceData> {
  const now = options?.now ?? (() => new Date());
  const client = options?.client ?? db;
  const deps = resolveDeps(options?.deps);

  const [current, atAsOf, atCompareTo, baseCtx] = await Promise.all([
    deps.computeCurrent(scope, now),
    options?.asOf ? evaluateHistorical(scope, options.asOf, now, deps, client) : Promise.resolve(null),
    options?.compareTo
      ? evaluateHistorical(scope, options.compareTo, now, deps, client)
      : Promise.resolve(null),
    // Resolve the Space reporting currency (the target buildCtx uses, plan D-1) so
    // the contract can carry the `from` currency a display-conversion pass needs.
    // Empty prefetch — this call only needs ctx.target, not any rate entry.
    deps.buildCtx(scope.spaceId, { currencies: [], dates: [] }),
  ]);

  return assembleLiquiditySpaceData({
    asOf: options?.asOf ?? toISODateUTC(now()),
    compareTo: options?.compareTo ?? null,
    reportingCurrency: baseCtx.target,
    current,
    atAsOf,
    atCompareTo,
  });
}
