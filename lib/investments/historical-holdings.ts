/**
 * lib/investments/historical-holdings.ts
 *
 * V26-S2-OWNERSHIP — THE canonical historical-holdings query.
 *
 * One function answers "what did this portfolio hold on these dates, what was
 * each holding worth, and why is each one included or excluded" — and every
 * consumer that needs historical composition calls it:
 *
 *   · snapshot regeneration (the chart's numbers)
 *   · a future chart drill-down, allocation-as-of, sector-as-of, holdings table,
 *     export, AI summary
 *
 * ── The rule this exists to make structural ──────────────────────────────────
 * A drill-down that recomputes composition its own way WILL disagree with the
 * point the user clicked. The only defence that survives contact with future
 * features is that there is nowhere else to get the answer. So this composes the
 * two existing authorities and adds nothing:
 *
 *   getInvestmentValueForWindow   the ONE valuation engine — quantities, prices,
 *                                 FX, refusals. Not re-implemented, not wrapped
 *                                 in a second policy.
 *   loadHoldingOwnership          the ONE ownership engine, per (account,
 *                                 instrument).
 *   buildHistoricalHoldings       the pure set-builder.
 *
 * Regeneration previously called the valuation engine and then applied ownership
 * itself with a different (instrument-scoped) window and a different denominator.
 * It now calls this. There is one composition path.
 *
 * READ-ONLY. Nothing here writes.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { getInvestmentValueForWindow, type GetInvestmentValueWindowArgs } from "./valuation";
import { loadHoldingOwnership, holdingKey } from "./holding-ownership";
import {
  buildHistoricalHoldings,
  type HistoricalHoldingsSet,
  type HoldingComponent,
  type HoldingOwnershipFacts,
} from "./historical-holdings.core";
import { resolveInvestmentScopeAndCurrency } from "./valuation";
import type { InvestmentVisibilityScope } from "./account-scope";

type Client = PrismaClient | Prisma.TransactionClient;

export type { HistoricalHoldingsSet };
export { holdingKey };

export interface HistoricalHoldingsArgs {
  spaceId?: string;
  financialAccountId?: string;
  /** The exact dates to answer for (YYYY-MM-DD). */
  dates: readonly string[];
  client?: Client;
  visibilityScope?: InvestmentVisibilityScope;
  /**
   * Passed through to the valuation engine unchanged. See the note in
   * `historicalHoldingsForWindow` on why this is still permitted here.
   */
  holdConstantBeforeEarliest?: boolean;
  excludeDigitalAssetAccounts?: boolean;
  /**
   * The ownership ceiling. Ownership segments never extend past it, so a caller
   * valuing a closed window gets windows bounded to that window. Defaults to the
   * latest requested date — never a clock read, so the same request always
   * produces the same answer.
   */
  ownershipToISO?: string;
}

/**
 * The historical holdings set for each requested date.
 *
 * ── On `holdConstantBeforeEarliest` ──────────────────────────────────────────
 * It projects a holding's EARLIEST observed quantity backwards, which for a
 * freshly connected account is effectively today's quantity. That is exactly the
 * kind of present-tense input historical ownership must not depend on — and it
 * is a QUANTITY assumption, not an OWNERSHIP one. Ownership here is resolved
 * entirely from dated evidence and is never informed by it: a projected quantity
 * on a date ownership does not license is EXCLUDED, and the projection cannot
 * put a holding into the held set. Its remaining effect is to supply a number
 * for a date ownership already licensed, and it is labelled by the valuation
 * engine's own tier when it does.
 *
 * Retiring the projection entirely is a change to financial VALUES on days that
 * are currently written, so it belongs with a regeneration, not here.
 */
export async function historicalHoldingsForWindow(
  args: HistoricalHoldingsArgs,
): Promise<Map<string, HistoricalHoldingsSet>> {
  const client = args.client ?? db;
  const dates = [...new Set(args.dates)].sort();
  const out = new Map<string, HistoricalHoldingsSet>();
  if (dates.length === 0) return out;

  const valuationArgs: GetInvestmentValueWindowArgs = {
    spaceId: args.spaceId,
    financialAccountId: args.financialAccountId,
    dates,
    client,
    visibilityScope: args.visibilityScope,
    holdConstantBeforeEarliest: args.holdConstantBeforeEarliest,
    excludeDigitalAssetAccounts: args.excludeDigitalAssetAccounts,
  };

  const [byDate, scope] = await Promise.all([
    getInvestmentValueForWindow(valuationArgs),
    resolveInvestmentScopeAndCurrency(client, args, args.visibilityScope ?? "all"),
  ]);

  // The ceiling is a caller decision, defaulting to the latest requested date —
  // never `new Date()`. A window asked for twice gets the same answer.
  const ownershipToISO = args.ownershipToISO ?? dates[dates.length - 1];
  const ownership = scope.accountIds.length > 0
    ? await loadHoldingOwnership(scope.accountIds, ownershipToISO, client)
    : new Map<string, Awaited<ReturnType<typeof loadHoldingOwnership>> extends Map<string, infer V> ? V : never>();

  const facts = new Map<string, HoldingOwnershipFacts>();
  for (const [k, o] of ownership) {
    facts.set(k, { resolution: o.resolution, closedFromISO: o.closedFromISO });
  }

  for (const dateISO of dates) {
    const view = byDate.get(dateISO);
    const components: HoldingComponent[] = (view?.components ?? []).map((c) => ({
      financialAccountId: c.accountId,
      instrumentId:       c.instrumentId,
      quantity:           c.quantity,
      reportingValue:     c.reportingValue,
      tier:               c.overallTier,
      reason:             c.reason,
    }));
    out.set(
      dateISO,
      buildHistoricalHoldings(dateISO, components, facts, (c) =>
        holdingKey(c.financialAccountId, c.instrumentId)),
    );
  }
  return out;
}

/** Single-date convenience over the window form. Same engine, same answer. */
export async function historicalHoldingsAsOf(
  args: Omit<HistoricalHoldingsArgs, "dates"> & { asOf: string },
): Promise<HistoricalHoldingsSet> {
  const { asOf, ...rest } = args;
  const byDate = await historicalHoldingsForWindow({ ...rest, dates: [asOf] });
  return byDate.get(asOf) ?? {
    dateISO: asOf, held: [], excluded: [], heldCount: 0, valuedCount: 0,
    valuedSubtotal: 0, ownershipConfidence: "UNKNOWN",
  };
}
