/**
 * lib/investments/current-positions.ts
 *
 * P2-3 — the canonical `getCurrentPositions(scope)` read seam. The ONE cheap
 * current-position projection for non-historical consumers (AI holdings
 * assembler, data export, Connections health, the future Plan layer). It is
 * **A10-at-today** — it composes the exact same valuation path as the Investments
 * Time Machine (valuation.ts `valuePositionRows` → valuation-core) — but sources
 * its position rows through a CHEAP latest-observation-per-(account, instrument)
 * read instead of scanning the full observation window. It is NOT a second
 * investment authority: it computes no value, price, FX, cash, or completeness
 * math of its own.
 *
 * Historical / As-Of reads stay with the A10 Time Machine (getInvestmentsTimeMachine)
 * — this seam deliberately cannot do As Of, compare, or period flows. If a caller
 * needs any of those, it is an A10 caller, not a getCurrentPositions caller.
 *
 * Visibility is enforced INSIDE the seam (KD-21a): current-position DETAIL is a
 * member-facing per-item read, so it is ALWAYS scoped to detail-eligible (FULL)
 * links via the canonical TRANSACTION_DETAIL_VISIBILITY predicate. No caller can
 * opt out and none can forget to filter — a BALANCE_ONLY / SUMMARY_ONLY / REVOKED
 * / deleted account contributes no position here, and it fails closed to empty.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { valuePortfolioAsOf } from "./valuation-core";
import {
  POSITION_VALUATION_SELECT,
  resolveInvestmentScopeAndCurrency,
  valuePositionRows,
  type ObservationValuationRow,
} from "./valuation";
import { readDisplay } from "./investments-time-machine";
import { resolvePositionAsOf } from "./reconstruction-read";
import {
  assembleCurrentPositions,
  type CurrentPositions,
} from "./current-positions-core";

type Client = PrismaClient | Prisma.TransactionClient;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Today (UTC), YYYY-MM-DD. The seam's default clock. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The scope of a current-position read. userId/owner scope is intentionally NOT
 *  offered — Personal is itself a Space, and no named consumer reads position
 *  DETAIL by user across Spaces. Add it only when a real consumer needs it. */
export type CurrentPositionsScope =
  | { spaceId: string }
  | { financialAccountId: string };

export interface CurrentPositionsOptions {
  /**
   * The seam's injected "today" clock (YYYY-MM-DD) — for determinism / tests, and
   * so a caller can value CURRENT positions and an all-visibility aggregate at the
   * exact same instant (the AI holdings assembler's use; always todayIso() in
   * production). It is NOT a historical portal: this seam has no compare/flows/
   * reconciliation, and a genuine as-of / historical read is an A10 caller
   * (loadInvestmentsHistory / getInvestmentsTimeMachine), never this. PCS-1B pins
   * "asOf is only ever today here" in space-data-historical.test.ts. When set, the
   * seam still returns the current-shape projection valued at that date via the
   * latest observation ≤ it (A10-at-`asOf` without compare/flows).
   */
  asOf?:  string;
  client?: Client;
}

/** The reconstruction-conflict rows the valuation path consumes. */
async function readConflicts(client: Client, accountIds: string[]) {
  return client.positionReconstruction.findMany({
    where:  { financialAccountId: { in: accountIds } },
    select: { financialAccountId: true, instrumentId: true, conflicted: true },
  });
}

/**
 * The canonical current positions for a Space or a single account, valued at
 * "today" (or an injected `asOf`) through the A10 valuation path.
 */
export async function getCurrentPositions(
  scope:    CurrentPositionsScope,
  options?: CurrentPositionsOptions,
): Promise<CurrentPositions> {
  const client = options?.client ?? db;
  const asOf = options?.asOf ?? todayIso();
  const asOfDate = new Date(`${asOf}T00:00:00.000Z`);
  const scopeArgs = "spaceId" in scope
    ? { spaceId: scope.spaceId }
    : { financialAccountId: scope.financialAccountId };

  // Visibility resolved once, inside the seam — always detail-eligible (FULL).
  const { accountIds, contextSpaceId, reportingCurrency } =
    await resolveInvestmentScopeAndCurrency(client, scopeArgs, "detailEligible");

  if (accountIds.length === 0) {
    const view = valuePortfolioAsOf([], asOf, reportingCurrency);
    return assembleCurrentPositions({ asOf, view, display: {}, costBasisByPair: {} });
  }

  // ── Cheap latest-per-pair read (NOT the full-history window scan A10 uses) ──
  // Step 1: one indexed aggregate — the max observation date per (account,
  // instrument) ≤ asOf, over @@index([financialAccountId, instrumentId, date]).
  const latestDates = await client.positionObservation.groupBy({
    by:    ["financialAccountId", "instrumentId"],
    where: {
      financialAccountId: { in: accountIds },
      supersededById: null,
      deletedAt:      null,
      date:           { lte: asOfDate },
    },
    _max: { date: true },
  });

  const pairFilters = latestDates
    .filter((g): g is typeof g & { _max: { date: Date } } => g._max.date != null)
    .map((g) => ({ financialAccountId: g.financialAccountId, instrumentId: g.instrumentId, date: g._max.date }));

  if (pairFilters.length === 0) {
    const view = valuePortfolioAsOf([], asOf, reportingCurrency);
    return assembleCurrentPositions({ asOf, view, display: {}, costBasisByPair: {} });
  }

  // Step 2: fetch ONLY the latest-date rows per pair (+ costBasis for the seam)
  // and the reconstruction conflict flags. No earlier history is transferred.
  const [latestRows, reconRows] = await Promise.all([
    client.positionObservation.findMany({
      where:  { OR: pairFilters, supersededById: null, deletedAt: null },
      select: { ...POSITION_VALUATION_SELECT, costBasis: true },
    }),
    readConflicts(client, accountIds),
  ]);

  // Value through THE canonical path — identical to A10-at-today; the resolved
  // row per pair is byte-identical because resolvePositionAsOf over the latest-
  // date rows picks the same row it would over the full window.
  const view = await valuePositionRows({
    client, asOf, contextSpaceId, reportingCurrency,
    holdConstant: false,
    posRows: latestRows,
    reconRows,
  });

  const instrumentIds = [...new Set(view.components.map((c) => c.instrumentId))];
  const display = await readDisplay(client, instrumentIds);
  const costBasisByPair = resolveLatestCostBasis(latestRows, asOf);

  return assembleCurrentPositions({ asOf, view, display, costBasisByPair });
}

/**
 * Non-cash current-position COUNT per account for a scope — the cheap
 * position-PRESENCE signal non-portfolio consumers (Connections) need: "does this
 * account have positions, and how many?". Derived from THE ONE canonical authority
 * (wraps getCurrentPositions), so it can never disagree with the portfolio — this
 * is deliberately NOT a second position read. Keyed by financialAccountId; an
 * account with no positions is simply absent (count 0). Unvalued positions still
 * count (a held-but-unpriced position IS present); cash rows are excluded, matching
 * the legacy positionCount semantics Connections replaced.
 */
export async function countCurrentPositionsByAccount(
  scope:    CurrentPositionsScope,
  options?: CurrentPositionsOptions,
): Promise<Record<string, number>> {
  const { rows } = await getCurrentPositions(scope, options);
  const counts: Record<string, number> = {};
  for (const r of rows) {
    if (r.isCash) continue;
    counts[r.accountId] = (counts[r.accountId] ?? 0) + 1;
  }
  return counts;
}

/** A latest-per-pair observation row carrying the additive cost-basis column. */
type LatestRow = ObservationValuationRow & { costBasis: number | null };

/**
 * The cost basis of the RESOLVED latest observation per (account, instrument),
 * keyed `${accountId}|${instrumentId}`. Reuses the canonical `resolvePositionAsOf`
 * (A4 origin precedence) so the picked row matches the one valuation valued, and
 * breaks a same-(date, origin) multi-source tie by the greatest institutionValue —
 * identical to valuation.ts's `pickResolvedRow`. Exported for the seam's unit test.
 */
export function resolveLatestCostBasis(
  rows: readonly LatestRow[],
  asOf: string,
): Record<string, number | null> {
  const byPair = new Map<string, LatestRow[]>();
  for (const r of rows) {
    const k = `${r.financialAccountId}|${r.instrumentId}`;
    (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(r);
  }
  const out: Record<string, number | null> = {};
  for (const [k, pairRows] of byPair) {
    const resolved = resolvePositionAsOf(
      pairRows.map((r) => ({ date: ymd(r.date), quantity: r.quantity, origin: r.origin, completeness: r.completeness })),
      asOf,
    );
    if (resolved.date == null || resolved.origin == null) {
      out[k] = null;
      continue;
    }
    const match = pairRows
      .filter((r) => ymd(r.date) === resolved.date && r.origin === resolved.origin)
      .sort((a, b) => (b.institutionValue ?? -Infinity) - (a.institutionValue ?? -Infinity))[0];
    out[k] = match?.costBasis ?? null;
  }
  return out;
}
