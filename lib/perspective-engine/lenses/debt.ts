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
 *
 * A5-P3 (Debt Time Machine) — when options.asOf is set, the rows come from the
 * A5-S2 resolver (getAccountsAsOf) with each balance resolved to the historical
 * date and stamped { method, tier }: revolving cards walk back (derived),
 * installment loans hold flat (estimated), before the account's floor is
 * incomplete. The pure core is UNTOUCHED; this binding reduces those per-row
 * tiers to the result's `completeness` envelope. Principal-vs-interest
 * decomposition is REFUSED as-of exactly as it is today — no amortization
 * engine exists and none is built here. Absent asOf ⇒ byte-identical (kill
 * switch): no getAccountsAsOf call, no completeness field.
 */

import { getAccountsWithVisibility } from "@/lib/data/accounts";
import { getAccountsAsOf } from "@/lib/data/accounts-asof";
import { buildSpaceConversionContext, buildSpaceConversionContextById } from "@/lib/money/server-context";
import { minusDaysISO, toISODateUTC } from "@/lib/fx/config";
import { registerLens } from "../registry";
import type { CompletenessTier, ComputeOptions, LensResult, PerspectiveScope } from "../types";
import { computeDebt, type DebtAccountRow } from "./debt.core";
import { buildDebtCompleteness, debtComponent } from "./asof-completeness";

async function debtLens(
  scope:   PerspectiveScope,
  options: ComputeOptions,
): Promise<LensResult> {
  // A5-P3 — per-account trust stamps, populated only on the as-of path so the
  // asOf-absent branch stays byte-identical. accountId → { tier, method }.
  const stamps = new Map<string, { tier: CompletenessTier; method: string }>();

  const visRows = options.asOf
    ? (await getAccountsAsOf({
        spaceId: scope.spaceId,
        userId:  scope.userId,
        asOf:    options.asOf,
        now:     options.now,
      })).map((r) => {
        stamps.set(r.account.id, { tier: r.tier, method: r.method });
        return { account: r.account, visibilityLevel: r.visibilityLevel as string };
      })
    : (await getAccountsWithVisibility({
        spaceId: scope.spaceId,
        // Always the viewing member — never a stored/elevated identity (§5.9).
        userId:  scope.userId,
      })).map(({ account, visibilityLevel }) => ({
        account,
        visibilityLevel: visibilityLevel as string,
      }));

  const lensRows: DebtAccountRow[] = visRows.map(({ account, visibilityLevel }) => ({
    id:              account.id,
    type:            account.type,
    balance:         account.balance,
    // MC1 QA Q2 — conversion input (non-identifying).
    currency:        account.currency ?? null,
    lastUpdated:     account.lastUpdated,
    visibilityLevel,
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

  const result = computeDebt(scope, options, lensRows, ctx);

  // A5-P3 — stamp the result only on the as-of path, over the debt accounts the
  // core actually counted (provenance.accountIds is the FULL + BALANCE_ONLY debt
  // set; summary-only and non-debt rows are excluded, so their tiers never leak
  // in). A "no debt accounts" answer (empty provenance) needs no trust envelope
  // and is returned untouched, as is every asOf-absent call — byte-identical.
  if (options.asOf && result.provenance.accountIds.length > 0) {
    const contributingStamps = result.provenance.accountIds
      .map((id) => stamps.get(id))
      .filter((s): s is { tier: CompletenessTier; method: string } => s != null)
      .map((s) => ({ tier: s.tier, component: debtComponent(s.method) }));
    return { ...result, completeness: buildDebtCompleteness(options.asOf, contributingStamps) };
  }

  return result;
}

registerLens("debt", debtLens);
