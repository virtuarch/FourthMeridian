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
import type { CompletenessTier } from "@/lib/perspective-engine/types";
import { valuePortfolioAsOf, type InvestmentValuationView } from "./valuation-core";
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
   * Override the ownership ceiling. LEAVE UNSET in production: it is DERIVED
   * from the account set's own latest evidence so every caller resolves the same
   * windows (see resolveEvidenceCeiling). Supplying a different value per caller
   * is what made a drill-down disagree with the chart it explained.
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

  // V26-S3-DETAIL — THE CEILING IS A PROPERTY OF THE ACCOUNT SET, NOT OF THE
  // QUESTION.
  //
  // It used to default to the latest requested date, and callers could pass
  // their own. That looked harmless and was not: `resolveOwnershipWindow`
  // returns EVIDENCE_AFTER_CEILING — no window at all — when an instrument's
  // first direct evidence falls after the ceiling, and that discards the
  // POSSIBLE prefix along with it. So the same holding on the same date was
  // HELD when asked as part of a year-long rebuild and NOT HELD when asked on
  // its own.
  //
  // Measured: a drill-down on 2026-01-01 asked with a same-day ceiling lost
  // SPCE, AMZN, TSLA, SIRI and TTWO — $696.14 — against the stored point that
  // regeneration had written with a window-end ceiling. The reconciliation
  // caught it, which is exactly what it is for; but a breakdown that can only be
  // right when the caller guesses the same ceiling is a trap.
  //
  // The ceiling is now DERIVED from the account set's own latest evidence, so
  // every caller gets the same windows for the same accounts, whatever they
  // asked about. Still clock-free: it reads dated rows, never `new Date()`.
  const facts = await loadOwnershipLicence(client, scope.accountIds, dates[dates.length - 1], args.ownershipToISO);

  for (const dateISO of dates) {
    out.set(dateISO, licenseValuationView(dateISO, byDate.get(dateISO)?.components ?? [], facts));
  }
  return out;
}

/**
 * THE ownership licence for an account set: per-(account, instrument) facts,
 * resolved once and applicable to ANY view of those accounts.
 *
 * Extracted so a caller that ALREADY has a valuation view can license it without
 * computing a second one. That is the whole point — A10 used to call the
 * valuation engine directly and skip this step, which back-projected positions
 * onto dates before any evidence said they were owned. There is one licence and
 * one place that loads it.
 */
export async function loadOwnershipLicence(
  client: Client,
  accountIds: readonly string[],
  fallbackCeilingISO: string,
  ceilingOverride?: string,
): Promise<Map<string, HoldingOwnershipFacts>> {
  const ownershipToISO = ceilingOverride
    ?? await resolveEvidenceCeiling(client, accountIds, fallbackCeilingISO);
  const facts = new Map<string, HoldingOwnershipFacts>();
  if (accountIds.length === 0) return facts;
  const ownership = await loadHoldingOwnership([...accountIds], ownershipToISO, client);
  for (const [k, o] of ownership) {
    facts.set(k, { resolution: o.resolution, closedFromISO: o.closedFromISO });
  }
  return facts;
}

/**
 * Apply the licence to a whole valuation VIEW, returning a licensed view.
 *
 * This is where A10 converges. The valuation engine answers "what is this
 * position worth on date D"; it does not answer "did you own it on date D". A
 * caller holding a raw view hands it here and gets back the same view restricted
 * to what ownership licenses — subtotal, counts, unvalued remainder and
 * completeness tier all re-aggregated through `valuePortfolioAsOf`, the SAME
 * canonical function that produced the view in the first place.
 *
 * Re-aggregating rather than only filtering matters: those fields are
 * precomputed on the view, so filtering `components` alone would leave them
 * describing a larger set than the rows beside them.
 *
 * An excluded position is REMOVED, not zeroed — `buildHistoricalHoldings` already
 * decided it was not held, and a zero-valued row asserts ownership of something
 * the evidence says was not owned.
 */
export function licenseView(
  view: InvestmentValuationView,
  dateISO: string,
  facts: ReadonlyMap<string, HoldingOwnershipFacts>,
): InvestmentValuationView {
  const set = licenseValuationView(dateISO, view.components, facts);
  const held = new Set(set.held.map((h) => holdingKey(h.financialAccountId, h.instrumentId)));
  const components = view.components.filter((c) => held.has(holdingKey(c.accountId, c.instrumentId)));
  if (components.length === view.components.length) return view;
  return valuePortfolioAsOf(components, view.asOf, view.reportingCurrency);
}

/**
 * Apply the licence to one date's valuation components.
 *
 * Pure projection over `buildHistoricalHoldings` — the same core the snapshot
 * path uses, so a licensed view and a stored snapshot cannot disagree about what
 * was held.
 */
export function licenseValuationView(
  dateISO: string,
  components: readonly { accountId: string; instrumentId: string; quantity: number | null;
                         reportingValue: number | null; overallTier: CompletenessTier; reason: string }[],
  facts: ReadonlyMap<string, HoldingOwnershipFacts>,
): HistoricalHoldingsSet {
  const mapped: HoldingComponent[] = components.map((c) => ({
    financialAccountId: c.accountId,
    instrumentId:       c.instrumentId,
    quantity:           c.quantity,
    reportingValue:     c.reportingValue,
    tier:               c.overallTier,
    reason:             c.reason,
  }));
  return buildHistoricalHoldings(dateISO, mapped, facts, (c) =>
    holdingKey(c.financialAccountId, c.instrumentId));
}

/**
 * The latest date this account set has ANY position/event evidence for.
 *
 * Deterministic and clock-free. Falls back to the caller's latest requested date
 * when the set has no evidence at all — there is then nothing for a ceiling to
 * clip, so any value behaves identically.
 */
async function resolveEvidenceCeiling(
  client: Client,
  accountIds: readonly string[],
  fallbackISO: string,
): Promise<string> {
  if (accountIds.length === 0) return fallbackISO;
  const scope = { financialAccountId: { in: [...accountIds] } };
  const [obs, evt] = await Promise.all([
    client.positionObservation.aggregate({
      where: { ...scope, deletedAt: null, supersededById: null }, _max: { date: true },
    }),
    client.investmentEvent.aggregate({
      where: { ...scope, deletedAt: null, supersededById: null }, _max: { date: true },
    }),
  ]);
  const candidates = [obs._max.date, evt._max.date]
    .filter((d): d is Date => d != null)
    .map((d) => d.toISOString().slice(0, 10));
  candidates.push(fallbackISO);
  return candidates.reduce((max, d) => (d > max ? d : max));
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
