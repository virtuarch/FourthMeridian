/**
 * lib/ai/brief/package.ts
 *
 * THE DAILY BRIEF EVIDENCE PACKAGE — assembled authorities in, one compact
 * deterministic package out.
 *
 * ⚠️ PURE, AND AN ADAPTER RATHER THAN AN AUTHORITY. Every figure here was computed
 * upstream: totals by the accounts assembler, the investment split by
 * `composeInvestments`, windowed changes by `canonicalWindowChange` and
 * `observedChange` over the FULL snapshot series (never a downsampled display
 * series), freshness by `resolveSpaceFreshness`, verdicts by `computeAssessment`,
 * plans by the same memory rules the AI page's starters use. What this module
 * adds is selection and rounding for reading — plus the one arithmetic a plan
 * needs (how far a goal is from today's balance), named where it happens.
 *
 * ⚠️ ONE SPACE, ONE OWNER. The caller resolves both; this never falls back to a
 * PERSONAL Space and never reads memory it was not handed.
 *
 * ⚠️ THE CEILING IS THE CALLER'S TO APPLY TO READS, AND THIS MODULE'S TO RESPECT.
 * A RETROSPECTIVE package (asOf before today) takes its position from the
 * snapshot series the loader already cut at asOf, and omits everything that only
 * exists for today — live freshness, today's concentration, and the verdicts
 * graded against live balances.
 */

import { composeInvestments, ComponentState } from '@/lib/ai/economic-concepts';
import { canonicalWindowChange, observedChange, type SeriesPoint } from '@/lib/data/snapshot-window';
import { resolveSpaceFreshness } from '@/lib/freshness/space-freshness';
import { staleSourcesForBrief, type SpaceDataHealth } from '@/lib/connections/space-data-health.core';
import { selectMemoryPlans } from '@/lib/ai/conversation/starter-topics';
import { readKnowledgeGaps } from '@/lib/ai/conversation/knowledge-gaps';
import type { RecalledMemory } from '@/lib/ai/conversation/memory-store';
import type {
  AccountsSectionData, HoldingsSummaryData, SnapshotDataPoint,
  SnapshotSectionData, TransactionsSummaryData,
} from '@/lib/ai/types';
import type { ClassificationReason, FinancialAssessment } from '@/lib/ai/intelligence';
import { claimEvidence, claimsReachedBy } from './claim-evidence';
import type {
  BriefChangeWindow, BriefClassification, BriefDelta, BriefPackage, BriefRecentActivity,
} from './types';

export interface BriefInputs {
  asOf:     string;
  /** Today's UTC day at `now`. asOf < today ⇒ RETROSPECTIVE. */
  today:    string;
  now:      Date;
  currency: string;
  accounts:     AccountsSectionData | null;
  /** Per-source freshness for the owner viewing this Space; null when unavailable. Current packages only. */
  dataHealth?:  SpaceDataHealth | null;
  transactions: TransactionsSummaryData | null;
  /** Projected from the FULL series, already cut at asOf. */
  snapshot:     SnapshotSectionData | null;
  holdings:     HoldingsSummaryData | null;
  assessment:   FinancialAssessment | null;
  /** The owner's own memories in this Space. */
  memories:     readonly RecalledMemory[];
  recentActivity: BriefRecentActivity | null;
  /**
   * The banking population was read and matched into `dataHealth` (sources report
   * `bankingRows`). False/absent ⇒ the cash-flow claim's sources are not
   * established and it gets no evidence entry.
   */
  bankingPopulationKnown?: boolean;
}

const MAX_GOALS = 3;
const MAX_PLANNED = 3;

const money = (n: number) => Math.round(n * 100) / 100;
const pct1 = (n: number) => Math.round(n * 10) / 10;
const moneyOrNull = (n: number | null | undefined) =>
  typeof n === 'number' && Number.isFinite(n) ? money(n) : null;

const DAY_MS = 86_400_000;
const dayMs = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`);

// ── Recent change ────────────────────────────────────────────────────────────

type Metric = 'netWorth' | 'liquid' | 'investments' | 'digitalAssets' | 'debt';
const METRICS: Record<Metric, (p: SnapshotDataPoint) => number | null> = {
  netWorth:      (p) => p.netWorth,
  liquid:        (p) => p.liquid,
  investments:   (p) => p.investments,
  digitalAssets: (p) => p.digitalAssets,
  debt:          (p) => p.liabilities,
};

function seriesOf(history: readonly SnapshotDataPoint[], metric: Metric): SeriesPoint[] {
  const pick = METRICS[metric];
  return history
    .map((p) => ({ date: new Date(`${p.date}T00:00:00.000Z`), value: pick(p) }))
    .filter((p): p is SeriesPoint => typeof p.value === 'number' && Number.isFinite(p.value));
}

/**
 * ⚠️ THE PERCENTAGE RULE IS THE AUTHORITY'S (`pctOfOpening`). This module only
 * asks for the narrating-consumer option: a base smaller than the movement gives
 * no percentage (`debt.pct: 11937.8` over a $9.75 opening was arithmetic without
 * meaning). When it is withheld, the opening value rides along so the change can
 * be told as two amounts.
 */
const NARRATED = { baseMustCoverChange: true } as const;

const delta = (c: { abs: number; pct: number | null; fromValue: number }): BriefDelta =>
  c.pct === null
    ? { abs: money(c.abs), pct: null, from: money(c.fromValue) }
    : { abs: money(c.abs), pct: pct1(c.pct) };

/** A classification as the model receives it: the verdict WITH its reason (types.ts). */
const classified = (
  classification: string, confidence: string, reason: ClassificationReason,
): BriefClassification => ({
  classification, scope: reason.scope, reasonCode: reason.reasonCode,
  reasonMetrics: reason.reasonMetrics, confidence, evidencePopulation: reason.evidencePopulation,
});

/**
 * A product-defined window (1W / 1M), per metric, through `canonicalWindowChange`.
 *
 * The window's dates are the liquid series' — liquid is never nulled — and a
 * metric is included only when its own canonical window has exactly those dates.
 * A metric that could not be measured over the same window is omitted, never
 * stitched in from a different one. No window at all is a refusal.
 */
function presetWindow(
  history: readonly SnapshotDataPoint[], preset: 'PAST_WEEK' | 'PAST_MONTH',
): BriefChangeWindow | undefined {
  const anchor = canonicalWindowChange(seriesOf(history, 'liquid'), preset, NARRATED);
  if (!anchor) return undefined;
  const out: BriefChangeWindow = { from: anchor.fromDate, to: anchor.toDate };
  for (const m of Object.keys(METRICS) as Metric[]) {
    const c = canonicalWindowChange(seriesOf(history, m), preset, NARRATED);
    if (c && c.fromDate === anchor.fromDate && c.toDate === anchor.toDate) out[m] = delta(c);
  }
  return out;
}

/**
 * Since the previous day's observation, through `observedChange`.
 *
 * Only when the two newest observations are consecutive days: across a gap the
 * movement is real but it is not "yesterday", and calling it that would be the
 * accidental-window error in miniature.
 */
function sincePreviousDay(history: readonly SnapshotDataPoint[]): BriefChangeWindow | undefined {
  if (history.length < 2) return undefined;
  const last = history[history.length - 1];
  const prev = history[history.length - 2];
  if (dayMs(last.date) - dayMs(prev.date) !== DAY_MS) return undefined;

  const out: BriefChangeWindow = { from: prev.date, to: last.date };
  const at = (p: SnapshotDataPoint, m: Metric) => {
    const v = METRICS[m](p);
    return typeof v === 'number' ? { date: new Date(`${p.date}T00:00:00.000Z`), value: v } : null;
  };
  for (const m of Object.keys(METRICS) as Metric[]) {
    const c = observedChange(at(prev, m), at(last, m), NARRATED);
    if (c) out[m] = delta(c);
  }
  return out;
}

// ── Projection ───────────────────────────────────────────────────────────────

export function projectBriefPackage(i: BriefInputs): BriefPackage {
  const retrospective = i.asOf < i.today;
  const acc = i.accounts;
  const history = i.snapshot?.history ?? [];

  // ── Current state ──
  let currentState: BriefPackage['currentState'];
  if (!retrospective) {
    const composition = composeInvestments(acc);
    const component = (key: string) => composition?.components.find((c) => c.key === key);
    const trad = component('TRADITIONAL_INVESTMENTS');
    const digital = component('DIGITAL_ASSETS');
    const conc = i.holdings?.concentration;
    currentState = {
      basis: 'CURRENT_ACCOUNTS',
      netWorth: moneyOrNull(acc?.netWorth),
      liquid:   moneyOrNull(acc?.totalLiquid),
      debt:     moneyOrNull(acc?.totalLiabilities),
      ...(composition ? { investments: {
        traditional: moneyOrNull(trad?.amount),
        digital:     moneyOrNull(digital?.amount),
        combined:    moneyOrNull(composition.combined),
        ...(composition.components.some((c) => c.state === ComponentState.UNKNOWN)
          ? { withheld: true as const } : {}),
      } } : {}),
      ...(conc && conc.classification !== 'INSUFFICIENT_DATA' && conc.topWeight !== null
        && conc.population.value > 0 ? { concentration: {
        classification: conc.classification,
        topSymbol: conc.topSymbol,
        topWeightPct: pct1(conc.topWeight * 100),
        populationValue: money(conc.population.value),
        populationIsComplete: conc.population.isComplete,
      } } : {}),
      ...((acc?.redactedCount ?? 0) > 0 ? { hiddenAccounts: acc!.redactedCount! } : {}),
    };
  } else {
    const point = history[history.length - 1] ?? null;
    currentState = {
      basis: 'HISTORICAL_SNAPSHOT',
      ...(point ? { observedOn: point.date } : {}),
      netWorth: moneyOrNull(point?.netWorth),
      liquid:   moneyOrNull(point?.liquid),
      debt:     moneyOrNull(point?.liabilities),
      ...(point ? { investments: {
        traditional: moneyOrNull(point.investments),
        digital:     moneyOrNull(point.digitalAssets),
        combined: point.digitalAssets === null ? null : money(point.investments + point.digitalAssets),
        ...(point.digitalAssets === null ? { withheld: true as const } : {}),
      } } : {}),
    };
  }

  // ── Claim-scoped evidence (today only — source health is a claim about today) ──
  const evidence = !retrospective
    ? claimEvidence({ health: i.dataHealth ?? null, asOf: i.asOf,
        bankingPopulationKnown: i.bankingPopulationKnown === true })
    : undefined;

  // ── Freshness (today only) ──
  const rows = acc?.accounts ?? [];
  const freshness: BriefPackage['freshness'] = !retrospective && acc && rows.length > 0
    ? (() => {
        const f = resolveSpaceFreshness(rows.map((a) => ({
          accountId: a.id,
          ingestedAt: a.lastUpdated,
          providerBalanceAt: a.balanceLastUpdatedAt ?? null,
          balance: a.reportingBalance ?? a.balance,
        })), i.now);
        const stale = staleSourcesForBrief(i.dataHealth ?? null);
        // The same rows, in the same order, as the sources they were projected
        // from — so each row's reach is computed from ITS source, never by label.
        const staleSources = (i.dataHealth?.sources ?? []).filter((s) => s.needsAttention);
        return {
          band: f.anchor.band,
          basis: f.anchor.basis,
          oldestBalanceObservedAt: f.anchor.observedAt,
          oldestBalanceAgeDays: f.anchor.ageDays === null ? null : pct1(f.anchor.ageDays),
          staleAccounts: f.staleAccountCount,
          unknownFreshnessAccounts: f.unknownCount,
          // Not the assembler's errorCount: it counts syncStatus 'error', which nothing writes.
          ...(i.dataHealth ? { connectionsNeedingAttention: i.dataHealth.attention } : {}),
          needsReauth: acc.health.needsReauthCount > 0,
          // Each stale source says which claims it reaches — possibly none. The
          // global list is never a licence to qualify a figure it does not feed.
          ...(stale.length > 0 ? { staleSources: stale.map((s, k) => ({
            ...s, ...(evidence ? { affects: staleSources[k] ? claimsReachedBy(staleSources[k], {
              asOf: i.asOf, bankingPopulationKnown: i.bankingPopulationKnown === true }) : [] } : {}) })) } : {}),
        };
      })()
    : undefined;

  // ── Recent change ──
  const d1 = sincePreviousDay(history);
  const w1 = presetWindow(history, 'PAST_WEEK');
  const m1 = presetWindow(history, 'PAST_MONTH');
  const recentChanges: BriefPackage['recentChanges'] = {
    ...(d1 ? { d1 } : {}), ...(w1 ? { w1 } : {}), ...(m1 ? { m1 } : {}),
  };

  // ── Behavior ──
  const txn = i.transactions;
  const a = i.assessment;
  const behavior: BriefPackage['behavior'] = txn && a ? {
    window: { from: txn.startDate, to: txn.endDate, days: txn.windowDays },
    monthlyIncome:       moneyOrNull(a.cashFlow.impliedMonthlyIncome),
    // ⚠️ M1 — THE BASELINE THE COVERAGE FIGURE DIVIDED BY, NOT THE RAW MEASUREMENT.
    // This read `cashFlow.estimatedMonthlyExpenses` (always the measured mean)
    // while `liquidity.coverageMonths` beside it was computed over the canonical
    // expense baseline (DECLARED > MEASURED, lib/liquidity/expense-baseline) — so
    // a Space with a declared figure would have printed the measured one next to
    // a coverage it does not explain. One authority chose; this prints its choice
    // and names the rung.
    monthlyExpenses:     moneyOrNull(a.liquidity.estimatedMonthlyExpense),
    ...(a.liquidity.estimatedMonthlyExpenseBasis
      ? { monthlyExpensesBasis: a.liquidity.estimatedMonthlyExpenseBasis } : {}),
    monthlyDebtPayments: moneyOrNull(a.cashFlow.estimatedMonthlyDebtPayments),
    cashFlowReliability: a.cashFlow.reliability,
    incomeConfidence:    a.dataQuality.incomeConfidence,
    deficitCause:        a.cashFlow.deficitCause,
    // The reason travels with the verdict — but only when a deficit was graded. An
    // unremarkable NOT_APPLICABLE would become a standing fact narrated every day.
    ...(a.cashFlow.deficitCause !== 'NOT_APPLICABLE' && a.cashFlow.deficitReason
      ? { deficit: classified(a.cashFlow.deficitCause, a.cashFlow.confidence, a.cashFlow.deficitReason) } : {}),
    // ⚠️ NEVER A BARE LABEL. `debt: { classification: 'CRITICAL' }` told the model
    // a verdict and nothing about what had been graded or why; told to explain it,
    // the model invented "the most severe tier, driven by how you've been using
    // and repaying it" for a rule whose only input was an APR. Every
    // classification ships with its scope, the rung that fired, the operands and
    // thresholds, its confidence and its population — one shape (types.ts).
    ...(!retrospective ? {
      liquidity: {
        ...classified(a.liquidity.classification, a.liquidity.confidence, a.liquidity.reason),
        coverageMonths: a.liquidity.coverageMonths === null ? null : pct1(a.liquidity.coverageMonths),
      },
      debtRate: {
        ...classified(a.debt.classification, a.debt.confidence, a.debt.reason),
        aprCompleteness: a.debt.aprCompleteness,
      },
      // What the rate costs next to this user's own position — shipped only WITH a
      // flagged rate (WARNING / CRITICAL), because that is the question it answers:
      // "the rate is high; does it matter here?". Measured: shipped beside an
      // unremarkable rate it became a standing fact the model narrated on every
      // quiet day ("Debt is modest and interest cost is small", 5/5 samples). The
      // assessment still carries the burden for every Space that owes anything.
      ...(a.debt.totalLiabilities > 0 && (a.debt.classification === 'WARNING' || a.debt.classification === 'CRITICAL') ? { debtBurden: {
        ratedOwed: a.debt.burden.ratedOwed,
        monthlyInterestIfCarried: a.debt.burden.monthlyInterestIfCarried,
        interestOfMonthlyIncomePct: a.debt.burden.interestOfMonthlyIncomePct,
        interestOfMonthlyExpensesPct: a.debt.burden.interestOfMonthlyExpensesPct,
        owedOfLiquidPct: a.debt.burden.owedOfLiquidPct,
        comparedWith: { monthlyIncome: a.debt.burden.monthlyIncome,
          monthlyExpenses: a.debt.burden.monthlyExpenses, liquid: a.debt.burden.liquid },
      } } : {}),
    } : {}),
  } : undefined;

  // ── Plans ──
  const selected = selectMemoryPlans(i.memories, i.asOf);
  const valueFor = (metric: string | null): number | null =>
    metric === 'netWorth' ? currentState.netWorth
    : metric === 'liquid' ? currentState.liquid
    : metric === 'investments' ? currentState.investments?.combined ?? null
    : null;
  const goals = selected.intentions
    .filter((x) => x.kind === 'goal')
    .slice(0, MAX_GOALS)
    .map((g) => {
      const current = valueFor(g.metric);
      return {
        metric: g.metric, targetAmount: money(g.targetAmount), byDate: g.byDate,
        // The one arithmetic here: distance from today's authority figure to the
        // user's own target. Omitted when today's figure is not established.
        ...(current !== null ? {
          current,
          remaining: money(g.targetAmount - current),
          progressPct: pct1((current / g.targetAmount) * 100),
        } : {}),
      };
    });
  const planned = selected.intentions
    .filter((x) => x.kind === 'planned-expense')
    .slice(0, MAX_PLANNED)
    .map((e) => ({ label: e.label, amount: money(e.amount) }));
  const nextCheckpoint = selected.nearestLiquidCheckpoint
    ? { metric: 'liquid' as const, horizon: selected.nearestLiquidCheckpoint } : undefined;
  const plans: BriefPackage['plans'] = goals.length || planned.length || nextCheckpoint
    ? { goals, planned, ...(nextCheckpoint ? { nextCheckpoint } : {}) } : undefined;

  // ── Data quality ──
  const share = a?.dataQuality.unidentifiedInflowShare ?? null;
  const dataQuality: BriefPackage['dataQuality'] = {
    historyDays: i.snapshot ? i.snapshot.spanDays : null,
    transactionHistory: a?.dataQuality.transactionHistoryCompleteness ?? null,
    knowledgeGaps: readKnowledgeGaps(acc?.knowledgeGaps).map((g) => ({ account: g.accountName, missing: g.label })),
    ungraded: (a?.ungraded ?? []).map((u) => ({ section: u.section, reason: u.reason })),
    ...(share !== null && share > 0 ? { unidentifiedIncomeSharePct: pct1(share * 100) } : {}),
    unvaluedPositions: retrospective ? 0 : i.holdings?.valuationCompleteness.unvaluedCount ?? 0,
    totalsEstimated: acc?.totalsEstimated ?? false,
    totalsUnconverted: acc?.totalsUnconverted ?? false,
  };

  return {
    identity: { briefDay: i.asOf, asOf: i.asOf, currency: i.currency,
      basis: retrospective ? 'RETROSPECTIVE' : 'CURRENT' },
    ...(freshness ? { freshness } : {}),
    ...(evidence ? { claimEvidence: evidence } : {}),
    currentState,
    recentChanges,
    ...(i.recentActivity ? { recentActivity: i.recentActivity } : {}),
    ...(behavior ? { behavior } : {}),
    ...(plans ? { plans } : {}),
    dataQuality,
  };
}
