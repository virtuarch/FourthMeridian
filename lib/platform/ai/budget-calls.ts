/**
 * lib/platform/ai/budget-calls.ts  (AI & Costs — the 24 h budget KPI's records)
 *
 * The per-call drilldown behind "Budget used" / Budget utilisation. ONE page
 * of the customer AI calls in the KPI's exact window, with the KPI's own
 * status over that window as the summary:
 *
 *   summary   readUserSpendGroups(since, until) → buildFleetWindow → fleetSpendStatus
 *             — the grouped query and fold loadAiBudgetUtilization uses, so the
 *             drilldown's total cannot differ from the KPI for the same window.
 *   rows      AiInvocation on the same customer surfaces in [since, until],
 *             newest first, each priced by the fold's own pricer (priceCall).
 *   counts    returned (what the fold counts — equals summary.invocations) and
 *             not counted (failure facts, zero tokens).
 *
 * The window end is the KPI's `checkedAt`, carried in the deep link, so a
 * refresh reopens the SAME 24 h — not a window that slid while the drawer sat.
 *
 * fm_system (AiInvocation is revoked from fm_app). Identity-free: the opaque
 * customer reference only; no prompt, conversation, request id or email.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { buildFleetWindow, BUDGET_WINDOW_HOURS } from "@/lib/platform/ai/ai-budget";
import { loadResolvedControls, type CostControlsReadClient } from "@/lib/platform/ai/cost-controls";
import { ESTIMATE_NOT_BILLING } from "@/lib/platform/ai/cost-controls.types";
import { fleetSpendStatus } from "@/lib/platform/ai/fleet-spend-status";
import { opaqueUserRef, readUserSpendGroups, type UserSpendGroup } from "@/lib/platform/ai/spend-health";
import {
  BUDGET_CALL_SURFACES, BUDGET_CALLS_PAGE_SIZE, projectCall,
  type BudgetCallSource, type BudgetCallsQuery, type BudgetCallsResponse,
} from "@/lib/platform/ai/budget-calls-core";

export interface BudgetCallsDeps {
  windowHours?: number;
  /** The KPI's grouped read (default: readUserSpendGroups — the SAME function). */
  groups?: (since: Date, until: Date) => Promise<UserSpendGroup[]>;
  controls?: CostControlsReadClient;
  /** One page of calls, newest first. */
  list?: (since: Date, until: Date, skip: number, take: number) => Promise<BudgetCallSource[]>;
  /** Calls in the window by outcome. */
  countByOutcome?: (since: Date, until: Date) => Promise<{ outcome: string; count: number }[]>;
}

const windowWhere = (since: Date, until: Date) => ({
  occurredAt: { gte: since, lte: until },
  surface: { in: [...BUDGET_CALL_SURFACES] },
});

async function listCalls(since: Date, until: Date, skip: number, take: number): Promise<BudgetCallSource[]> {
  return systemDb.aiInvocation.findMany({
    where: windowWhere(since, until),
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    skip, take,
    select: {
      id: true, occurredAt: true, provider: true, model: true, surface: true, outcome: true, errorCode: true,
      promptTokens: true, cachedPromptTokens: true, completionTokens: true, userId: true,
    },
  });
}

async function countCalls(since: Date, until: Date): Promise<{ outcome: string; count: number }[]> {
  const rows = await systemDb.aiInvocation.groupBy({ by: ["outcome"], where: windowWhere(since, until), _count: { _all: true } });
  return rows.map((r) => ({ outcome: r.outcome, count: r._count._all }));
}

export async function loadBudgetCalls(q: BudgetCallsQuery, deps: BudgetCallsDeps = {}): Promise<BudgetCallsResponse> {
  const windowHours = deps.windowHours ?? BUDGET_WINDOW_HOURS;
  const until = new Date(q.untilMs);
  const since = new Date(q.untilMs - windowHours * 60 * 60 * 1000);
  const pageSize = BUDGET_CALLS_PAGE_SIZE;

  const [controls, groups, counts, rows] = await Promise.all([
    loadResolvedControls(deps.controls ?? (systemDb as unknown as CostControlsReadClient)),
    (deps.groups ?? readUserSpendGroups)(since, until),
    (deps.countByOutcome ?? countCalls)(since, until),
    (deps.list ?? listCalls)(since, until, (q.page - 1) * pageSize, pageSize),
  ]);

  const thresholds = { fleetUsd: controls["fleetAlert.thresholdUsd"].value, userUsd: controls["userAlert.thresholdUsd"].value };
  const fw = buildFleetWindow(groups, thresholds, windowHours, until, controls["fleetAlert.enabled"].value);
  const status = fleetSpendStatus({ fleet: fw.fleet, windowHours, bySurface: fw.bySurface, unpriced: fw.unpriced });

  const returned = counts.filter((c) => c.outcome === "RETURNED").reduce((a, c) => a + c.count, 0);
  const all = counts.reduce((a, c) => a + c.count, 0);

  return {
    window: { since: since.toISOString(), until: until.toISOString(), hours: windowHours },
    summary: { ...status, customers: fw.fleet.customers },
    page: { rows: rows.map((r) => projectCall(r, opaqueUserRef)), total: all, page: q.page, pageSize },
    counts: { returned, notCounted: all - returned },
    estimateNote: ESTIMATE_NOT_BILLING,
  };
}
