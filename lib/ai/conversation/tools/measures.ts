/**
 * lib/ai/conversation/tools/measures.ts
 *
 * M1 measures & comparison: `measure_flows` and `get_baselines`, with their
 * period/category argument helpers and coverage reads.
 *
 * Part of the tool surface split out of `tools.ts` (CQ-011). The facade
 * `lib/ai/conversation/tools.ts` owns the registry (`TOOLS`) and is the only
 * import path callers use; this module never imports the facade.
 *
 * Moved verbatim: every comment and invariant in `tools.ts`'s header applies
 * here — adapters, not authorities; read and calculate only; no Prisma client in
 * scope (the source scans in `lib/test-support/tools-source.ts` read this file).
 */

import {
  FinanceDomains, type AccountsSectionData, type TransactionsSummaryData, type MonthlyBreakdownEntry,
} from '@/lib/ai/types';
import { transactionCorpusSpan } from '@/lib/data/transaction-query';
import { readCanonicalSpending } from '@/lib/transactions/canonical-spending';
import { transactionAccountPopulation } from '@/lib/data/transaction-population';
import {
  MEASURABLE_SPEND_CATEGORIES, UNSUPPORTED_SPEND_CATEGORIES, resolveSpendCategory,
} from '@/lib/transactions/category-vocabulary';
import { loadForecastIncomeStreams } from '@/lib/ai/forecast/streams';
/**
 * RLS-AI-S0 — THE ABSENCE CONTRACT. Value imports, and deliberately: the oracle is
 * a CAPABILITY derived from `ctx.readClient`, not a client, so this file still
 * holds no Prisma client and the source scans that assert it still pass.
 */
import {
  adjudicateAbsence, indeterminateSentence as indeterminateFor, EvidenceState, type AbsenceVerdict,
} from '@/lib/ai/absence';
import { continuationOf } from '@/lib/ai/forecast/income-completeness';
// ── M1: measures & comparison ────────────────────────────────────────────────
// ⚠️ THE ARITHMETIC LIVES IN `lib/ai/measures`, NOT HERE. Period resolution, the
// measure, the comparison, the baselines and every derived figure are pure
// functions over the monthly rows the ONE economic fold already produced. The two
// heads below resolve arguments, perform the reads, and hand the rows over.
import {
  parsePeriodSpec, parseCompareToSpec, resolvePeriod, resolveCompareTo, completeMonthsPeriod,
  type ResolvedPeriod,
} from '@/lib/ai/measures/period';
import {
  measure, compare, FLOW_MEASURES, type FlowMeasure, type MonthRow, type DataCoverage, type Tier,
} from '@/lib/ai/measures/measure';
import {
  resolveExpenseBaselineFromEvidence, resolveIncomeBaseline, derive, economicSpendingOf,
} from '@/lib/ai/measures/baseline';
import { incomeStreamEvidence } from '@/lib/ai/forecast/income-evidence';
import { computeDebtAggregate } from '@/lib/debt/aggregates';
import type { ToolContext, ToolDefinition } from './types';
import { obj, str, num } from './shared/schema';
import { round2, clampToCeiling } from './shared/values';
import { assemble } from './shared/reads';
import { originOf } from './shared/origin';

// ── 4b. Measures & comparison, baselines & derived figures (M1) ──────────────

/**
 * The period argument, DESCRIBED ONCE. It appears three times on the surface
 * (`period`, `compareTo`, `spendingWindow`); the explanation rides on the first
 * and the other two carry the bare shape and point back, because a model reads
 * every schema byte on every turn.
 */
const PERIOD_SHAPE = obj({
  preset: { type: 'string' }, month: { type: 'string' }, quarter: { type: 'string' },
  year: { type: 'number' }, completeMonths: { type: 'number' },
  from: { type: 'string' }, to: { type: 'string' },
});
const PERIOD_SCHEMA = {
  ...PERIOD_SHAPE,
  description: 'WHICH DAYS. Exactly one of: `preset` (MTD | QTD | YTD | PAST_WEEK | PAST_MONTH | '
    + 'PAST_QUARTER | PAST_6_MONTHS | PAST_YEAR — rolling ones are calendar months back, not 30 days), '
    + '`month` "YYYY-MM", `quarter` "YYYY-Q3", `year`, `completeMonths` N (the last N WHOLE calendar '
    + 'months, never the current one — the one for "normally", "on average", "per month"), or `from` + '
    + '`to` (YYYY-MM-DD, inclusive). A period that runs past today is cut at today and says so.',
};

interface FlowRead { rows: MonthRow[]; truncated: boolean; readFrom: string | null;
  declaredMonthlyExpenses: number | null }

/** The monthly fold's entries as the measure layer reads them. */
function toMonthRows(entries: readonly MonthlyBreakdownEntry[]): MonthRow[] {
  return entries.map((m) => ({
    month: m.month, incomeTotal: m.incomeTotal, expenseTotal: m.expenseTotal,
    refundTotal: m.refundTotal, debtPaymentTotal: m.debtPaymentTotal, transferTotal: m.transferTotal,
    partial: m.partial, truncated: m.truncated,
    byCategory: m.byCategory.map((c) => ({ category: c.category, total: c.total, count: c.count,
      ...(c.refundTotal ? { refundTotal: c.refundTotal } : {}) })),
  }));
}

/** One window of monthly rows, exactly as the ONE fold produced them. */
async function readFlowMonths(
  ctx: ToolContext, window: { from: string; to: string; label: string } | null,
): Promise<FlowRead | null> {
  const t = await assemble<TransactionsSummaryData>(FinanceDomains.TRANSACTIONS_SUMMARY, ctx,
    window ? { transactionWindow: { startDate: window.from, endDate: window.to, label: window.label } } : {});
  if (!t) return null;
  return {
    rows: toMonthRows(t.monthlyBreakdown),
    truncated: t.truncated,
    // The assembler clamps a floor older than its maximum lookback; the clamp is
    // a completeness fact about THIS read, so it travels with the rows.
    readFrom: window && t.startDate > window.from ? t.startDate : null,
    declaredMonthlyExpenses: t.declaredMonthlyExpenses ?? null,
  };
}

/**
 * What the record covers, and which sources feed the banking population.
 *
 * ⚠️ POPULATION-AWARE. A source is a component of a flow measure only when its
 * accounts put rows into the banking population. A brokerage that needs
 * reconnecting but posts no banking rows is not a component of spending and
 * cannot make a spending figure incomplete; a card that stopped delivering rows
 * can — for windows that run past the day it last delivered.
 */
async function flowCoverage(
  ctx: ToolContext, ceiling: string, accounts?: AccountsSectionData | null,
): Promise<Pick<DataCoverage, 'corpusFrom' | 'corpusTo' | 'components'>> {
  const [span, population, acc] = await Promise.all([
    transactionCorpusSpan(ctx.readClient, { spaceId: ctx.spaceId, asOf: ceiling }),
    transactionAccountPopulation(ctx.readClient, { spaceId: ctx.spaceId, asOf: ceiling }),
    accounts !== undefined ? Promise.resolve(accounts)
      : assemble<AccountsSectionData>(FinanceDomains.ACCOUNTS, ctx),
  ]);
  const byKey = new Map<string, { key: string; tier: Tier; deliveredThrough: string | null }>();
  for (const a of acc?.accounts ?? []) {
    const pop = population.find((p) => p.accountId === a.id);
    if (!pop || pop.rows === 0) continue;
    const band = a.balanceFreshness?.band;
    const behind = !!a.needsReauth || band === 'STALE' || band === 'VERY_STALE';
    const key = `${a.type}:${a.institution ?? a.name}`;
    const deliveredThrough = behind ? (a.lastUpdated ? a.lastUpdated.slice(0, 10) : pop.lastDate) : null;
    const prior = byKey.get(key);
    if (!prior || (behind && prior.tier === 'observed')) {
      byKey.set(key, { key, tier: behind ? 'incomplete' : 'observed', deliveredThrough });
    } else if (behind && prior.deliveredThrough && deliveredThrough && deliveredThrough < prior.deliveredThrough) {
      prior.deliveredThrough = deliveredThrough;
    }
  }
  return { corpusFrom: span.from, corpusTo: span.to, components: [...byKey.values()] };
}

/**
 * A category named by the model, resolved through THE category vocabulary
 * (lib/transactions/category-vocabulary.ts) — FM-AUDIT-003. A structural label
 * (Payment, Transfer, Income…) is not a spending line, and a category bank sync
 * never produces (Groceries, Medical, Transport…) is NOT a measured $0 — both are
 * refused by name, with where the money actually is. A provider-bucket line
 * (Dining holds groceries) is measured and carries its `meaning`.
 */
function resolveCategoryArg(raw: unknown):
  { category?: string; categoryMeaning?: { observability: string; contains: string } } | { unavailable: string } {
  if (raw === undefined || raw === null || raw === '') return {};
  const r = resolveSpendCategory(String(raw));
  if (!r.ok) return { unavailable: r.unavailable };
  return { category: r.category, categoryMeaning: { observability: r.observability, contains: r.meaning } };
}

const CATEGORY_VOCABULARY_UNSUPPORTED_LIST = UNSUPPORTED_SPEND_CATEGORIES.join(', ');

/** The category-argument description, generated from the vocabulary so the two cannot diverge. */
const CATEGORY_ARG_DESCRIPTION =
  `Optional spending category — one of ${MEASURABLE_SPEND_CATEGORIES.join(', ')} — to measure one line of `
  + 'spending instead of all of it; the result also carries all spending over the same window and this line\'s '
  + 'share of it (`ofAllSpending`) and `categoryMeaning` (what the line contains — SAY it when it matters: '
  + 'Dining includes groceries, Utilities includes rent, Other is the residual of medical, transportation, '
  + `entertainment and other unsplit spending). ${CATEGORY_VOCABULARY_UNSUPPORTED_LIST} are NOT tracked by bank `
  + 'sync and are refused rather than measured. Only with `measure: "spending"`.';

export const measureFlows: ToolDefinition = {
  name: 'measure_flows',
  description:
    'HOW MUCH over a period, and MORE OR LESS than another period — computed, not narrated. ' +
    'Spending, income, economic net, card/debt payments, transfers or refunds for any month, ' +
    'quarter, year, the last N complete months, a to-date or rolling window; with `compareTo` it ' +
    'returns both sides AND the difference, percentage and direction. Use it for "how much did I ' +
    'spend / earn in X", "am I spending more than I used to", "was August higher than July", ' +
    '"compare the last three complete months with the three before", "did I spend more on travel", ' +
    '"is my income up this quarter". Every figure names its window, which months are whole, and ' +
    'whether the record covers it; `perCompleteMonth` is the monthly figure. Spending `total` is ' +
    'what was CHARGED; when refunds arrived in the window `netOfRefunds` is what it actually cost ' +
    '(and `changeNetOfRefunds` the comparison on that basis) — say that figure, never subtract a ' +
    'refund yourself. NEVER divide a window ' +
    'total by its days or months yourself, never compute a difference or percentage between two ' +
    'figures yourself, and never compare figures from two different windows by hand — ask for the ' +
    'comparison here. "PREVIOUS" of a period to date is the same elapsed days of the period before.',
  parameters: obj({
    measure: { type: 'string', enum: [...FLOW_MEASURES],
      description: 'WHAT is measured, by the one economic fold. `spending` never contains card '
        + 'payments or transfers; `economicNet` = income − spending over the window (what actually '
        + 'happened — for the steady monthly surplus use get_baselines); debt payments are NOT '
        + 'subtracted from it.' },
    period: PERIOD_SCHEMA,
    compareTo: { description: 'Optional. "PREVIOUS" (the equivalent earlier period: last month for a '
        + 'month, the same elapsed days of last month for a month to date, the N months before for '
        + 'completeMonths, the same number of days before for a rolling window), '
        + '"SAME_PERIOD_LAST_YEAR", or an explicit period (inside `compareTo`, `completeMonths` N '
        + 'means the N whole months BEFORE `period` begins). The result carries both sides, the '
        + 'difference, the percentage and the direction.',
      anyOf: [{ type: 'string', enum: ['PREVIOUS', 'SAME_PERIOD_LAST_YEAR'] }, PERIOD_SHAPE] },
    category: str(CATEGORY_ARG_DESCRIPTION),
    asOf: str('Information ceiling: pretend today is this date. Nothing after it is read.'),
  }, ['measure', 'period']),
  async run(a, ctx) {
    const ceiling = clampToCeiling((a.asOf as string) || ctx.asOfISO, ctx.asOfISO);
    const kind = String(a.measure) as FlowMeasure;
    if (!FLOW_MEASURES.includes(kind)) {
      return { unavailable: `unknown measure "${a.measure}"; one of ${FLOW_MEASURES.join(', ')}` };
    }
    const spec = parsePeriodSpec(a.period);
    if ('unavailable' in spec) return spec;
    const cat = resolveCategoryArg(a.category);
    if ('unavailable' in cat) return cat;
    const meaning = cat.categoryMeaning ? { categoryMeaning: cat.categoryMeaning } : {};
    if (cat.category && kind !== 'spending') {
      return { unavailable: 'a category is a line of SPENDING; use `measure: "spending"` with it' };
    }
    const compareSpec = a.compareTo === undefined || a.compareTo === null
      ? null : parseCompareToSpec(a.compareTo);
    if (compareSpec && typeof compareSpec === 'object' && 'unavailable' in compareSpec) return compareSpec;

    const period = resolvePeriod(spec, ceiling);
    if (period.from > ceiling) {
      return { unavailable: `the period ${period.label} begins ${period.from}, after ${ceiling}; nothing in it can be read` };
    }
    const cov = await flowCoverage(ctx, ceiling);
    const one = async (p: ResolvedPeriod) => {
      const read = await readFlowMonths(ctx, { from: p.from, to: p.to, label: p.label });
      return measure(kind, read?.rows ?? [], p,
        { ...cov, fetchCapHit: read?.truncated ?? false, readFrom: read?.readFrom ?? null }, cat.category);
    };
    if (!compareSpec) return { asOf: ceiling, ...(await one(period)), ...meaning };

    const other = resolveCompareTo(period, spec, compareSpec as Parameters<typeof resolveCompareTo>[2], ceiling);
    if (other.from === period.from && other.to === period.to) {
      return { unavailable: `\`compareTo\` resolves to the same window as \`period\` (${period.from}..${period.to}); `
        + 'a window compared with itself says nothing — use "PREVIOUS" for the equivalent earlier period' };
    }
    // ⚠️ BOTH SIDES IN ONE CALL, SO THE MODEL NEVER HOLDS ONE AND COMPUTES THE OTHER.
    const [left, right] = await Promise.all([one(period), one(other)]);
    return { asOf: ceiling, ...compare(left, right), ...meaning };
  },
};

export const getBaselines: ToolDefinition = {
  name: 'get_baselines',
  description:
    'THE MONTHLY RATES TO REASON FORWARD FROM, AND EVERYTHING COMPUTED FROM THEM: monthly surplus, ' +
    'savings rate, runway in months of current cash, and "N months of expenses" in dollars with ' +
    'how far current cash is from it. Call it AGAIN whenever the user changes the monthly figure ' +
    'or the number of months — every derived figure changes with it, and none is to be recomputed ' +
    'in prose: never multiply a baseline by months, subtract cash from a threshold, or subtract ' +
    'spending from income yourself. The expense baseline is STATED in this conversation > DECLARED ' +
    'in the product > MEASURED over named complete months; income is STATED > CADENCE of settled ' +
    'paychecks > MEASURED. Use it for "how much do I normally spend", "what is my monthly ' +
    'surplus", "what is my savings rate", "how many months of expenses do I have", "how much cash ' +
    'should I keep". `measuredSpending.byWindow` shows how the measured figure differs by window — ' +
    'choose the window that fits the question (pass `spendingWindow`) and SAY which one. ' +
    '`thresholds` always carries 3, 6 and 12 months; pass `monthsOfExpenses` for any other ' +
    'multiple. Every derived figure ships with its numerator, denominator and basis — quote them. ' +
    'Never divide an orientation or window total to get a monthly figure. For WHEN cash reaches a ' +
    'threshold, give its amount to scenario_crossing — do not divide a shortfall by the surplus. ' +
    'For runway or reserves AFTER a one-off cash movement (paying a card, a purchase, a windfall), pass ' +
    '`liquidChange` and quote `afterLiquidChange` — never subtract from cash or divide in prose. ' +
    'It does not say what the user SHOULD spend or keep. The thresholds are reference points to set ' +
    'side by side, not a standard: say which the evidence favours and why, and leave the choice of ' +
    'reserve to the user.',
  parameters: obj({
    statedMonthlySpending: num('The monthly spending the user STATED in this conversation, if any '
      + '("use $5k"). Wins over the product setting and the measured figure, and is echoed as STATED.'),
    statedMonthlyIncome: num('The monthly income the user STATED in this conversation, if any.'),
    spendingWindow: { ...PERIOD_SHAPE, description: 'Optional: which PAST months the MEASURED spending '
      + 'baseline is AVERAGED over, e.g. {"completeMonths": 6} — the same shape as measure_flows '
      + '`period`. Default is the complete months the cash projection averages. This is NOT how many '
      + 'months of expenses to keep — "six months of expenses" is `monthsOfExpenses: [6]`.' },
    monthsOfExpenses: { type: 'array', items: { type: 'number' },
      description: 'How many months of expenses to price, e.g. [9] for "keep nine months of expenses" '
        + '— a MULTIPLIER of the baseline, not an averaging window. 3, 6 and 12 are always returned. '
        + 'Each comes back in dollars with the rule, the baseline it multiplied, and the gap to '
        + 'current cash.' },
    liquidChange: num('A one-off change to liquid cash in dollars, to price runway and reserves after it: '
      + 'paying $5,000 to a card is -5000. Nothing else moves.'),
    asOf: str('Information ceiling: pretend today is this date. Nothing after it is read.'),
  }),
  async run(a, ctx) {
    const ceiling = clampToCeiling((a.asOf as string) || ctx.asOfISO, ctx.asOfISO);
    const windowSpec = a.spendingWindow === undefined || a.spendingWindow === null
      ? null : parsePeriodSpec(a.spendingWindow);
    if (windowSpec && 'unavailable' in windowSpec) return windowSpec;
    // ⚠️ 3, 6 AND 12 ARE ALWAYS PRICED. Told "keep six months of that" one turn
    // after a baseline call, the model multiplied 5,000 × 6 and subtracted liquid in
    // prose because neither figure was in evidence. The common candidates cost a
    // few hundred bytes; any other multiple is asked for by name.
    const asked = (Array.isArray(a.monthsOfExpenses) ? a.monthsOfExpenses : [])
      .map(Number).filter((n) => Number.isFinite(n)).slice(0, 8);
    const wanted = [...new Set([3, 6, 12, ...asked])].sort((x, y) => x - y);

    const year = resolvePeriod({ completeMonths: 12 }, ceiling);
    const [acc, streams, canonical, yearRead] = await Promise.all([
      assemble<AccountsSectionData>(FinanceDomains.ACCOUNTS, ctx),
      loadForecastIncomeStreams(ctx.readClient, ctx.spaceId, ceiling),
      // ⚠️ THE DEFAULT IS THE CANONICAL BASELINE — the cash projection's own months,
      // now the trailing three COMPLETE months before the ceiling's month
      // (lib/transactions/canonical-spending). It was the reliable months of the
      // 90-day assessment window: two, on almost every day, while `byWindow[3]`
      // beside it said Jul–Sep. One result, two "three-month" answers.
      // A named `spendingWindow` below is a MEASUREMENT and never touches this.
      windowSpec ? Promise.resolve(null) : readCanonicalSpending({
        asOf: ceiling,
        readWindow: (w) => assemble<TransactionsSummaryData>(FinanceDomains.TRANSACTIONS_SUMMARY, ctx,
          { transactionWindow: w }),
        readHistory: async (at) => {
          const span = await transactionCorpusSpan(ctx.readClient, { spaceId: ctx.spaceId, asOf: at });
          return { from: span.from, to: span.to };
        },
      }),
      readFlowMonths(ctx, { from: year.from, to: year.to, label: year.label }),
    ]);
    const cov = await flowCoverage(ctx, ceiling, acc);
    const covOf = (r: FlowRead | null): DataCoverage =>
      ({ ...cov, fetchCapHit: r?.truncated ?? false, readFrom: r?.readFrom ?? null });

    // ── The measured rung, over a NAMED window ──
    let measuredSpending;
    if (windowSpec) {
      const p = resolvePeriod(windowSpec, ceiling);
      const read = await readFlowMonths(ctx, { from: p.from, to: p.to, label: p.label });
      measuredSpending = measure('spending', read?.rows ?? [], p, covOf(read));
    } else {
      const months = canonical?.months ?? [];
      const p = months.length ? completeMonthsPeriod(months[0].month, months[months.length - 1].month,
        `the canonical spending baseline: ${canonical!.baseline.label}, the months the cash projection averages`,
        ceiling) : null;
      measuredSpending = p ? measure('spending', toMonthRows(months), p, covOf(null)) : null;
    }

    const expense = resolveExpenseBaselineFromEvidence({
      stated: typeof a.statedMonthlySpending === 'number' ? a.statedMonthlySpending : null,
      declared: yearRead?.declaredMonthlyExpenses ?? null,
      measured: measuredSpending,
    });

    // The cadence → monthly conversion is the forecast authority's, through its adapter.
    const streamEvidence = streams.map((s) => incomeStreamEvidence({
      label: s.label, cadence: s.cadence,
      typicalAmount: s.amount?.assertable ? s.amount.value : null,
      stillPaying: s.projectionEligible,
      // FIN-001: a recently-silent / unobserved stream surfaces as `incomplete`, never a silent fall to MEASURED.
      continuation: continuationOf(s),
    }));
    const half = resolvePeriod({ completeMonths: 6 }, ceiling);
    const income = resolveIncomeBaseline({
      stated: typeof a.statedMonthlyIncome === 'number' ? a.statedMonthlyIncome : null,
      streams: streamEvidence,
      measured: yearRead ? measure('income', yearRead.rows, half, covOf(yearRead)) : null,
    });

    // ── The position the derived figures divide into ──
    const liquid = acc && typeof acc.totalLiquid === 'number' ? acc.totalLiquid : null;
    const debts = (acc?.accounts ?? []).filter((r) => r.type === 'debt' && r.visibilityLevel === 'FULL');
    const aggregate = computeDebtAggregate(debts.map((r) => ({
      balance: r.reportingBalance ?? r.balance, apr: typeof r.apr === 'number' ? r.apr : null,
      minimumPayment: typeof r.minimumPayment === 'number' ? r.minimumPayment : null })));

    const derived = derive({ expense, income, liquid,
      minimumDebtService: aggregate.minimumPayment > 0 ? aggregate.minimumPayment : null,
      monthsOfExpenses: wanted });
    // ⚠️ HARDENING — THE FIGURE THE MODEL USED TO WORK OUT IN PROSE. "If I paid $5,000
    // toward my cards, how much runway is left?" was answered 10,925.25 ÷ 5,438.35 in
    // the answer's own words, and its later explanation was a reconstruction. The same
    // `derive` over the moved cash makes it a tool figure with a derivation.
    const change = typeof a.liquidChange === 'number' && Number.isFinite(a.liquidChange) ? round2(a.liquidChange) : null;
    const moved = change !== null && liquid !== null ? derive({ expense, income, liquid: liquid + change,
      minimumDebtService: aggregate.minimumPayment > 0 ? aggregate.minimumPayment : null, monthsOfExpenses: wanted }) : null;
    // Only what the change MOVES: surplus and savings rate do not depend on cash.
    const afterLiquidChange = moved && change !== null && liquid !== null ? {
      liquidChange: change, liquidAfter: round2(liquid + change),
      basis: 'current liquid plus this one-off change; spending, income and every other balance unchanged',
      runway: moved.runway, thresholds: moved.thresholds,
    } : null;

    // ⚠️ THE SPREAD OF LEGITIMATE FIGURES, FROM ONE READ. "Monthly spending" has a
    // different honest answer over 3, 6 and 12 complete months; showing them side
    // by side is what lets the model choose a window on purpose and say so.
    const byWindow = yearRead ? [3, 6, 12].map((n) => {
      const m = measure('spending', yearRead.rows, resolvePeriod({ completeMonths: n }, ceiling), covOf(yearRead));
      // NET-BASELINE-1 — the same NET economic figure the baseline uses, so the
      // table and `expense.amount` are one definition; gross rides along only
      // when refunds moved the window materially.
      const eco = economicSpendingOf(m);
      return { completeMonths: n, from: m.period.from, to: m.period.to, perCompleteMonth: eco.perCompleteMonth,
        ...(eco.material ? { grossPerCompleteMonth: eco.grossPerCompleteMonth, refundEffect: eco.refundEffect } : {}),
        highest: eco.highest, lowest: eco.lowest, completeness: m.completeness.tier };
    }) : [];
    const liquidBehind = (acc?.accounts ?? []).filter((r) =>
      (r.type === 'checking' || r.type === 'savings') && r.needsReauth).length;

    // ── RLS-AI-S0 — ONE ADJUDICATION FOR THREE REFUSALS ──────────────────────
    //
    // ⚠️ THE THREE EMPTIES HAVE ONE CAUSE OR NONE. Every one of them is downstream
    // of the accounts domain and the monthly fold on THIS Space, and the policies
    // are Space-granular, so three separate verdicts could only ever disagree by
    // accident. Adjudicated once, here, and only when at least one of them is
    // actually empty — a Space with all three answerable issues no probe.
    const anyEmpty = !expense || !income || liquid === null;
    const verdict: AbsenceVerdict | null = anyEmpty
      ? await adjudicateAbsence(ctx.readClient, ctx.spaceId) : null;
    const refuse = (proven: string, subject: string) =>
      (verdict === EvidenceState.INDETERMINATE
        ? { unavailable: indeterminateFor(subject), evidenceState: verdict }
        : { unavailable: proven, evidenceState: EvidenceState.PROVEN_EMPTY });

    return {
      asOf: ceiling,
      // ⚠️ A STATED rung is the figure the CALL passed; `origin` says whether the user's words license it.
      expense: expense ? { ...expense, ...(expense.basis === 'STATED' ? { origin: originOf(a, 'statedMonthlySpending', ctx) } : {}) }
        : refuse('no expense baseline: nothing stated, nothing declared, and no '
        + 'complete calendar month of spending to average', 'anything to build an expense baseline from'),
      income: income ? { ...income, ...(income.basis === 'STATED' ? { origin: originOf(a, 'statedMonthlyIncome', ctx) } : {}) }
        : refuse('no income baseline: nothing stated, no settled recurring deposits, '
        + 'and no complete month of observed income', 'anything to build an income baseline from'),
      ...derived,
      ...(afterLiquidChange ? { afterLiquidChange } : {}),
      liquid: liquid === null ? refuse('no accounts in scope', 'any accounts in scope') : {
        amount: liquid, basis: 'unrestricted cash (checking + savings, excluding restricted accounts such as an HSA), from the current accounts — the same figure as '
          + 'get_financial_snapshot.liquid; investments and digital assets are not in it',
        ...(liquidBehind > 0 ? { completeness: { tier: 'incomplete' as Tier,
          reason: `${liquidBehind} liquid account(s) need reconnecting; the balance is the last one read` } } : {}) },
      ...(aggregate.missingMinimumCount > 0
        ? { minimumDebtServiceUnknownFor: aggregate.missingMinimumCount } : {}),
      measuredSpending: { byWindow,
        note: 'The measured monthly figure depends on the window. None of these is wrong; say which one '
          + 'an answer used. These are MEASUREMENTS: the canonical baseline (`expense`, the cash projection\'s '
          + 'own months) does not change because one of them was read. `spendingWindow` prices THIS answer\'s '
          + 'thresholds over another window and nothing else. Every figure is NET of '
          + 'refunds dated in the month; where refunds mattered, `grossPerCompleteMonth` and `refundEffect` '
          + 'are given — quote them, never subtract.' },
    };
  },
};
