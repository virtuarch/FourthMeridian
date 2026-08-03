/**
 * lib/snapshots/historical-work-window.ts
 *
 * V26-ORCH-1 — the DB binding for the historical-work planner.
 *
 * Resolves the four evidence floors the pure planner
 * (historical-work-window.core.ts) needs, and nothing more. Every decision lives
 * in the core; this file only reads.
 *
 * It is THE single authority for "how far back should this trigger rebuild?" on
 * the wallet-connect, crypto-cron and manual-sync paths. The Plaid item path
 * keeps `maxAvailableWealthWindow` for now (see PART 5 of the brief): its
 * evidence floor is already correct and it has no blocking price constraint, so
 * migrating it would change nothing except risk.
 */

import { db } from "@/lib/db";
import { AssetClass, InvestmentCoverageOutcome } from "@prisma/client";
import {
  planHistoricalWorkWindow,
  type ChangeDetection,
  type HistoricalWorkWindow,
} from "./historical-work-window.core";
import { recentWealthWindow } from "./regenerate-history";

export type { HistoricalWorkWindow, ChangeDetection };
export { planHistoricalWorkWindow };

export interface ResolveHistoricalWorkWindowArgs {
  financialAccountIds: string[];
  /**
   * When supplied, rows written at/after this instant are treated as THIS run's
   * changes and their earliest date becomes `impactedFrom`. Supplying it is what
   * makes a refresh incremental; omitting it declares the trigger cannot measure
   * change, and the planner conservatively rebuilds the supportable interval.
   *
   * Deliberately an explicit opt-in: a trigger that cannot honestly measure must
   * say so rather than report "nothing changed".
   */
  changedSince?: Date;
  /**
   * Force the initial-build mode. Omit to let the binding detect it (no
   * historical snapshot rows below the recent window for these accounts' Spaces).
   */
  initialBuild?: boolean;
  now?: Date;
  /**
   * V26-CAP-1 — a capability WIDENING supplies the floor and impacted-from
   * directly, because the widened reach is not yet reflected in stored prices:
   * the whole point is to plan the acquisition that will create them. Reading
   * the archive here would return the OLD floor and plan nothing.
   *
   * Additive and optional — every existing caller is unaffected, and the planner
   * itself is untouched. It never widens beyond what the caller states, and the
   * result is still intersected with evidence and the writable ceiling.
   */
  capabilityOverride?: {
    blockingPriceFloorISO: string;
    impactedFromISO:       string;
  };
}

/**
 * The earliest date at which every PRICE-BLOCKING holding of this account set
 * can be valued, or null when the set holds none.
 *
 * Blocking = an instrument whose missing price makes a whole snapshot day
 * unwritable rather than merely lower-coverage. Today that is exactly the crypto
 * asset class, because the crypto no-fabrication guard refuses to assert a
 * carried balance for an unpriced day, whereas an unpriced equity contributes a
 * partial subtotal and the day is still written.
 *
 * Resolved by ASSET CLASS, never by ticker or provider name: adding a second
 * crypto asset or swapping price vendors changes nothing here.
 *
 * MAX across held blocking instruments — a day is plannable only where EVERY one
 * of them can be priced. Null when a blocking instrument has NO price at all,
 * which correctly means "nothing is plannable yet" rather than "unconstrained";
 * that case is reported separately so the caller does not mistake it for the
 * unconstrained one.
 */
async function resolveBlockingPriceFloor(
  financialAccountIds: string[],
): Promise<{ floorISO: string | null; unpricedBlockingInstruments: number }> {
  if (financialAccountIds.length === 0) return { floorISO: null, unpricedBlockingInstruments: 0 };

  const held = await db.positionObservation.findMany({
    where:  { financialAccountId: { in: financialAccountIds }, instrument: { assetClass: AssetClass.CRYPTO } },
    select: { instrumentId: true },
    distinct: ["instrumentId"],
  });
  if (held.length === 0) return { floorISO: null, unpricedBlockingInstruments: 0 };

  let floorISO: string | null = null;
  let unpriced = 0;
  for (const h of held) {
    const earliest = await db.priceObservation.findFirst({
      where:   { instrumentId: h.instrumentId },
      orderBy: { date: "asc" },
      select:  { date: true },
    });
    if (!earliest) { unpriced++; continue; }
    const iso = earliest.date.toISOString().slice(0, 10);
    if (floorISO === null || iso > floorISO) floorISO = iso; // MAX — every one must reach it
  }
  return { floorISO, unpricedBlockingInstruments: unpriced };
}

/**
 * The earliest date this account set has ANY account-level evidence for.
 *
 * ── The bug this exists to prevent (V26-S1-PLANNER) ──────────────────────────
 * This was `MIN(Transaction.date)` alone, described in the planner's own field
 * doc as "earliest transaction / observation". Transactions are the ONLY
 * evidence a banking account has — and they are evidence an INVESTMENT account
 * does not have at all. Measured on this database: the three live Plaid
 * investment accounts hold ZERO Transaction rows. Their history lives in
 * InvestmentEvent and is attested by InvestmentEventCoverage, which proves
 * COMPLETE, pagination-reconciled coverage back to 2025-07-31.
 *
 * So for an investment-only account set the planner reported "no evidence floor
 * — nothing deeper than the recent window exists" and planned 30 days, while
 * the provider had already demonstrated twelve months.
 *
 * The repair is to ask every table that can carry account-level evidence, and
 * take the EARLIEST. Widening only: MIN can never raise the floor, so no
 * existing plan narrows, and a set with transactions alone resolves exactly as
 * before.
 *
 * Why each source counts as evidence:
 *   Transaction.date                       a movement we hold a record of
 *   InvestmentEvent.date                   the investment analogue; the sole
 *                                          history source for a brokerage
 *   InvestmentEventCoverage.earliest       what the provider DEMONSTRABLY
 *     ReturnedDate (COMPLETE + reconciled)  returned — stronger than our own
 *                                          rows, because it also proves an
 *                                          empty interval was empty
 *   PositionObservation.date               ownership observed on a date
 *
 * The floor is a plan bound, never a licence: a wider window still passes
 * through the blocking-price intersection and every regeneration guard, so a
 * date this reaches can still be refused for lack of prices or ownership.
 * Nothing here asserts a value.
 */
async function resolveEvidenceFloor(financialAccountIds: string[]): Promise<string | null> {
  if (financialAccountIds.length === 0) return null;
  const scope = { financialAccountId: { in: financialAccountIds } };

  const [tx, event, coverage, position] = await Promise.all([
    db.transaction.aggregate({ where: { ...scope, deletedAt: null }, _min: { date: true } }),
    db.investmentEvent.aggregate({ where: { ...scope, deletedAt: null, supersededById: null }, _min: { date: true } }),
    db.investmentEventCoverage.aggregate({
      where: {
        ...scope,
        outcome:              InvestmentCoverageOutcome.COMPLETE,
        paginationReconciled: true,
        earliestReturnedDate: { not: null },
      },
      _min: { earliestReturnedDate: true },
    }),
    db.positionObservation.aggregate({
      where: { ...scope, deletedAt: null, supersededById: null },
      _min:  { date: true },
    }),
  ]);

  const candidates = [
    tx._min.date,
    event._min.date,
    coverage._min.earliestReturnedDate,
    position._min.date,
  ].filter((d): d is Date => d != null);

  if (candidates.length === 0) return null;
  return candidates
    .map((d) => d.toISOString().slice(0, 10))
    .reduce((min, d) => (d < min ? d : min));
}

/**
 * Resolve the historical work window for an account set.
 *
 * Reads only floors; writes nothing. Safe to call on a dry run.
 */
export async function resolveHistoricalWorkWindow(
  args: ResolveHistoricalWorkWindowArgs,
): Promise<HistoricalWorkWindow & { unpricedBlockingInstruments: number }> {
  const { financialAccountIds, changedSince, now = new Date() } = args;
  const recent = recentWealthWindow(now);

  const evidenceFloorISO = await resolveEvidenceFloor(financialAccountIds);

  const resolved = await resolveBlockingPriceFloor(financialAccountIds);
  const { unpricedBlockingInstruments } = resolved;
  // A widening states the floor it just unlocked; otherwise the floor is what the
  // archive can actually price today.
  const blockingPriceFloorISO =
    args.capabilityOverride?.blockingPriceFloorISO ?? resolved.floorISO;

  // Impacted-from — MEASURED only when the caller supplied a `changedSince`.
  // Two independent sources of newly-written historical evidence: transactions
  // (a movement we did not previously know about) and price observations (a date
  // we previously could not value). Both are append-only and carry createdAt, so
  // this is real measurement, not an estimate.
  let changeDetection: ChangeDetection = "unavailable";
  let impactedFromISO: string | null = null;
  if (args.capabilityOverride) {
    changeDetection = "measured";
    impactedFromISO = args.capabilityOverride.impactedFromISO;
  } else if (changedSince) {
    changeDetection = "measured";
    const [tx, price] = await Promise.all([
      financialAccountIds.length
        ? db.transaction.aggregate({
            where: { financialAccountId: { in: financialAccountIds }, deletedAt: null, createdAt: { gte: changedSince } },
            _min:  { date: true },
          })
        : Promise.resolve({ _min: { date: null as Date | null } }),
      db.priceObservation.aggregate({
        where: { createdAt: { gte: changedSince } },
        _min:  { date: true },
      }),
    ]);
    const candidates = [tx._min.date, price._min.date].filter((d): d is Date => d != null);
    if (candidates.length) {
      impactedFromISO = candidates
        .map((d) => d.toISOString().slice(0, 10))
        .reduce((min, d) => (d < min ? d : min));
    }
  }

  // Initial build — no snapshot row for these accounts' Spaces below the recent
  // window means no deep history has ever been built for them.
  let initialBuild = args.initialBuild;
  if (initialBuild === undefined) {
    const links = await db.spaceAccountLink.findMany({
      where:  { financialAccountId: { in: financialAccountIds } },
      select: { spaceId: true },
      distinct: ["spaceId"],
    });
    const spaceIds = links.map((l) => l.spaceId);
    if (spaceIds.length === 0) {
      initialBuild = true;
    } else {
      const deep = await db.spaceSnapshot.findFirst({
        where:  { spaceId: { in: spaceIds }, date: { lt: new Date(`${recent.fromDate}T00:00:00.000Z`) } },
        select: { id: true },
      });
      initialBuild = deep === null;
    }
  }

  const plan = planHistoricalWorkWindow({
    evidenceFloorISO,
    blockingPriceFloorISO,
    writableToISO: recent.toDate,
    recentFromISO: recent.fromDate,
    initialBuild,
    changeDetection,
    impactedFromISO,
  });

  return { ...plan, unpricedBlockingInstruments };
}
