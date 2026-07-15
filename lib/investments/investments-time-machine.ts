/**
 * lib/investments/investments-time-machine.ts
 *
 * A10 — the DB binding for the Investments Time Machine read model. It COMPOSES
 * the canonical services; it does not reimplement any of them:
 *   - valuation (quantity × price × FX)  → getInvestmentValueAsOf (A8/A4/money),
 *     called once at asOf and once at compareTo. This is the ONLY replay / price
 *     / FX / valuation path — there is no second engine here.
 *   - period flows                       → canonical InvestmentEvent rows read
 *     with the provenance filter (deletedAt: null, supersededById: null), each
 *     amount converted to the reporting currency at its own event date through
 *     the same money layer valuation uses, then summarised by the pure core.
 *   - assembly / reconciliation          → assembleInvestmentsTimeMachine (pure).
 *
 * No persistence — this is derived arithmetic over persisted facts, never a
 * second fact store (mirrors valuation.ts). Receives resolved dates {asOf,
 * compareTo}; it never owns preset/date state (the Perspective Shell does).
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { convertMoney, identityContext } from "@/lib/money/convert";
import { buildSpaceConversionContextById } from "@/lib/money/server-context";
import type { ConversionContext } from "@/lib/money/types";
import { getInvestmentValueAsOf } from "./valuation";
import { resolveSpaceInvestmentAccountIds, resolveSingleAccountScope } from "./account-scope";
import { summarizePeriodFlows, type FlowEvent, type PeriodFlows } from "./investment-flows-core";
import {
  assembleInvestmentsTimeMachine,
  type InstrumentDisplay,
  type InvestmentsTimeMachineResult,
} from "./investments-time-machine-core";

type Client = PrismaClient | Prisma.TransactionClient;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface GetInvestmentsTimeMachineArgs {
  /** Value the whole Space's investments. */
  spaceId?: string;
  /** Or a single account (its Space supplies the reporting currency + FX). */
  financialAccountId?: string;
  asOf: string;                 // YYYY-MM-DD (resolved by the shell)
  compareTo?: string | null;    // YYYY-MM-DD; omitted/null ⇒ current-only, no flows
  client?: Client;
}

/**
 * The Investments Time Machine as-of a date, optionally compared to an earlier
 * date. Holdings + valued portfolio at asOf; period flows and a change
 * reconciliation over (compareTo, asOf] when compareTo is supplied.
 */
export async function getInvestmentsTimeMachine(
  args: GetInvestmentsTimeMachineArgs,
): Promise<InvestmentsTimeMachineResult> {
  const client = args.client ?? db;
  const { asOf } = args;
  const compareTo = args.compareTo ?? null;

  const scope = args.spaceId
    ? { spaceId: args.spaceId }
    : args.financialAccountId
      ? { financialAccountId: args.financialAccountId }
      : null;
  if (!scope) {
    throw new Error("[investments-time-machine] requires spaceId or financialAccountId");
  }

  // ── Canonical valuation at each endpoint (the single valuation path) ───────
  // Member-facing read (KD-21a): positions/holdings are scoped to detail-eligible
  // (FULL) links only, so a BALANCE_ONLY / SUMMARY_ONLY account never exposes its
  // positions or their value here. The wealth-total path (A9 regeneration) keeps
  // the "all" default and is unaffected.
  const [view, compareView] = await Promise.all([
    getInvestmentValueAsOf({ ...scope, asOf, client, visibilityScope: "detailEligible" }),
    compareTo
      ? getInvestmentValueAsOf({ ...scope, asOf: compareTo, client, visibilityScope: "detailEligible" })
      : Promise.resolve(null),
  ]);

  // ── Period flows from canonical events (only when an interval is defined) ──
  const flows: PeriodFlows | null = compareTo
    ? await readPeriodFlows(client, args, compareTo, asOf, view.reportingCurrency)
    : null;

  // ── Instrument display identity for the as-of holdings ─────────────────────
  const instrumentIds = [...new Set(view.components.map((c) => c.instrumentId))];
  const display = await readDisplay(client, instrumentIds);

  return assembleInvestmentsTimeMachine({ asOf, compareTo, view, compareView, flows, display });
}

/**
 * The (account, Space) scope for the event read + FX context. Mirrors valuation.ts
 * and shares its visibility filter: period flows are per-account transaction-level
 * detail, so they are scoped to detail-eligible (FULL) links only (KD-21a) — a
 * BALANCE_ONLY / SUMMARY_ONLY account never exposes its investment events here.
 */
async function resolveScope(
  client: Client,
  args: GetInvestmentsTimeMachineArgs,
): Promise<{ accountIds: string[]; spaceId: string | null }> {
  if (args.financialAccountId) {
    return resolveSingleAccountScope(client, args.financialAccountId, args.spaceId ?? null, "detailEligible");
  }
  const accountIds = await resolveSpaceInvestmentAccountIds(client, args.spaceId!, "detailEligible");
  return { accountIds, spaceId: args.spaceId! };
}

/**
 * Read the canonical InvestmentEvents in (from, to], convert each cash amount to
 * the reporting currency at its own date, and summarise. Rolled-back / superseded
 * rows are excluded (the A7-1 provenance filter).
 */
async function readPeriodFlows(
  client: Client,
  args: GetInvestmentsTimeMachineArgs,
  from: string,
  to: string,
  reportingCurrency: string,
): Promise<PeriodFlows> {
  const { accountIds, spaceId } = await resolveScope(client, args);
  if (accountIds.length === 0) {
    return summarizePeriodFlows([], from, to, reportingCurrency);
  }

  const rows = await client.investmentEvent.findMany({
    where: {
      financialAccountId: { in: accountIds },
      deletedAt: null,
      supersededById: null,
      date: { gt: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) },
    },
    select: { type: true, date: true, amount: true, quantity: true, currency: true },
  });

  // One FX context spanning the flow currencies + dates (same money layer as valuation).
  const currencies = [...new Set(rows.map((r) => r.currency).filter((c): c is string => !!c))];
  const dates = [...new Set(rows.map((r) => ymd(r.date)))];
  const ctx: ConversionContext = spaceId
    ? await buildSpaceConversionContextById(spaceId, { currencies, dates })
    : identityContext(reportingCurrency);

  const events: FlowEvent[] = rows.map((r) => {
    const date = ymd(r.date);
    if (r.amount == null) {
      return { type: r.type, date, amount: null, fxEstimated: false, hasQuantity: r.quantity != null && r.quantity !== 0 };
    }
    const c = convertMoney({ amount: r.amount, currency: r.currency }, date, ctx);
    return { type: r.type, date, amount: c.amount, fxEstimated: c.estimated, hasQuantity: r.quantity != null && r.quantity !== 0 };
  });

  return summarizePeriodFlows(events, from, to, ctx.target);
}

/**
 * Display + allocation identity for a set of instruments. Read-only.
 *
 * Carries symbol/name (row identity) plus the three fields the Allocation panel
 * groups by: `assetClass`, `sector`, and `isCash` (the canonical cash-equivalent
 * flag, same source valuation.ts uses). Additive — existing consumers read only
 * symbol/name; the allocation fields are ignored by everything else.
 */
async function readDisplay(
  client: Client,
  instrumentIds: string[],
): Promise<Record<string, InstrumentDisplay>> {
  if (instrumentIds.length === 0) return {};
  const rows = await client.instrument.findMany({
    where: { id: { in: instrumentIds } },
    select: { id: true, tickerSymbol: true, name: true, assetClass: true, sector: true, isCashEquivalent: true },
  });
  const map: Record<string, InstrumentDisplay> = {};
  for (const r of rows) {
    map[r.id] = {
      symbol:     r.tickerSymbol,
      name:       r.name,
      assetClass: r.assetClass,
      sector:     r.sector,
      isCash:     r.isCashEquivalent === true,
    };
  }
  return map;
}
