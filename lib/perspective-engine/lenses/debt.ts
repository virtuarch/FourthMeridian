/**
 * lib/perspective-engine/lenses/debt.ts
 *
 * Debt lens — data binding + registration. All math lives in ./debt.core.ts
 * (pure, fixture-testable). This file:
 *
 *   1. reads through lib/data/accounts.ts#getAccountsWithVisibility (the
 *      KD-19 visibility-enforced path + server-side tier contract — never
 *      raw Prisma), and
 *   2. maps rows down to DebtAccountRow: id, type, balance, lastUpdated,
 *      visibilityLevel, and — because the data layer only populates them on
 *      FULL rows in the first place — effective APR, minimum payment (with
 *      its estimated flag), and promo end date. Names and institutions are
 *      dropped at this boundary; the core re-gates the FULL-only fields as
 *      defense in depth.
 *
 * The data layer has already resolved effective values (DebtProfile
 * user-entered > provider flat fields > lib/debt.ts estimate) — this
 * adapter adds no math of its own.
 */

import { getAccountsWithVisibility } from "@/lib/data/accounts";
import { buildSpaceConversionContext, buildSpaceConversionContextById } from "@/lib/money/server-context";
import { minusDaysISO, toISODateUTC } from "@/lib/fx/config";
import { registerLens } from "../registry";
import type { ComputeOptions, LensResult, PerspectiveScope } from "../types";
import { computeDebt, type DebtAccountRow } from "./debt.core";

async function debtLens(
  scope:   PerspectiveScope,
  options: ComputeOptions,
): Promise<LensResult> {
  const rows = await getAccountsWithVisibility({
    spaceId: scope.spaceId,
    // Always the viewing member — never a stored/elevated identity (§5.9).
    userId:  scope.userId,
  });

  const lensRows: DebtAccountRow[] = rows.map(({ account, visibilityLevel }) => ({
    id:              account.id,
    type:            account.type,
    balance:         account.balance,
    // MC1 QA Q2 — conversion input (non-identifying).
    currency:        account.currency ?? null,
    lastUpdated:     account.lastUpdated,
    visibilityLevel: visibilityLevel as string,
    interestRate:              account.interestRate ?? undefined,
    minimumPayment:            account.minimumPayment ?? undefined,
    minimumPaymentIsEstimated: account.minimumPaymentIsEstimated ?? undefined,
    promoAprEndDate:           account.debtProfile?.promoAprEndDate ?? undefined,
  }));

  // MC1 QA Q2 — real space context (same seam as the liquidity lens flip);
  // by-id helper keeps @/lib/db out of this adapter, identity fallback inside.
  // MC1 view-as override — target the requested display currency directly when
  // supplied (Personal preview) so the whole lens recomputes consistently;
  // otherwise the Space's reporting currency via the by-id helper (byte-identical).
  const convOpts = {
    currencies: lensRows.map((r) => r.currency ?? null),
    dates:      [minusDaysISO(toISODateUTC(options.now()), 1)],
  };
  const ctx = options.targetCurrency
    ? await buildSpaceConversionContext({ reportingCurrency: options.targetCurrency }, convOpts)
    : await buildSpaceConversionContextById(scope.spaceId, convOpts);

  return computeDebt(scope, options, lensRows, ctx);
}

registerLens("debt", debtLens);
