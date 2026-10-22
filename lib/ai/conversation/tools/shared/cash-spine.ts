/**
 * lib/ai/conversation/tools/shared/cash-spine.ts
 *
 * THE CASH SPINE — the one set of streams, accounts and spending that
 * `project_cash`, `reconcile_projection` and every scenario tool share.
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
  FinanceDomains, type AccountsSectionData, type TransactionsSummaryData, type SpaceContext_AI,
} from '@/lib/ai/types';
import { transactionCorpusSpan } from '@/lib/data/transaction-query';
import { readCanonicalSpending, type CanonicalSpendingBaseline } from '@/lib/transactions/canonical-spending';
import { loadForecastIncomeStreams, type ResolvedIncomeStream } from '@/lib/ai/forecast/streams';
import { assembleForecast, type SpendingChangeRule } from '@/lib/ai/forecast/assemble';
import type { IncomeChangeRule } from '@/lib/forecast/income-change';
// ⚠️ NOTHING HERE IMPORTS lib/forecast/** DIRECTLY, AND A GUARD ENFORCES IT.
// FORECAST-6/8/9 each carry a "consumed only through the sanctioned adapter"
// test, and this harness is production code to those tests. `assembleForecast`
// re-exports the vocabulary its own callers need, which is the seam working as
// designed — the first draft reached past it for `explainForecast` and three
// suites failed, correctly.
import {
  AssumptionOrigin, PeriodBasis, StatementMode, type AssembledForecast, type ForecastHorizon,
  type UserStatement,
} from '../../forecast-vocabulary';
/**
 * RLS-AI-S0 — THE ABSENCE CONTRACT. Value imports, and deliberately: the oracle is
 * a CAPABILITY derived from `ctx.readClient`, not a client, so this file still
 * holds no Prisma client and the source scans that assert it still pass.
 */
import type { AbsenceVerdict } from '@/lib/ai/absence';
import type { ToolContext } from '../types';
import { assemble } from './reads';
import { historicalSnapshot } from './historical-snapshot';

/**
 * THE CASH SPINE — everything `project_cash` needs to answer, factored out so a
 * second tool cannot grow a second copy of it.
 *
 * ⚠️ ONE SPINE, TWO TOOLS, ONE SET OF NUMBERS. `scenario_projection` layers
 * stated contributions and returns over exactly these checkpoints. If it loaded
 * its own streams, its own accounts or its own spending window, the two tools
 * would eventually disagree about the same month — and the user would be told
 * both figures in the same conversation. The invariant that the last checkpoint
 * equals a standalone run holds because there is only ever one `runTo`.
 *
 * ⚠️ A RETROSPECTIVE RUN MUST START FROM THE BALANCE THAT WAS TRUE THEN, and
 * must not see a transaction dated after the cutoff. Opening cash comes from the
 * snapshot authority for that date, income cadence from the streams authority AT
 * that date (which reconstructs the then-current employer), and the spending
 * window is bounded by it. Anything else quietly projects the past using the
 * future.
 */
interface CashSpine {
  asOf:          string;
  retrospective: boolean;
  openingBasis:  string;
  /** The accounts payload the projection opened from. Null for a refused build. */
  accounts:      AccountsSectionData | null;
  /**
   * One forecast to `end`. `extraSpendingChanges` are appended to the spine's own
   * spending rules for this run only — how a solver varies spending (S1-7): as a
   * RULE the scenario's other rules compose with, never a replacement level that
   * would silently drop them.
   */
  runTo:         (end: string,
                  extraSpendingChanges?: readonly SpendingChangeRule[]) => AssembledForecast;
  /** The canonical spending baseline the observed rate averages — its months, count and basis. */
  spendingBaseline: CanonicalSpendingBaseline;
  /** The income streams every run folds — so a result can say, per stream, what reached its income term. */
  streams:       readonly ResolvedIncomeStream[];
}

export async function buildCashSpine(
  ctx: ToolContext,
  opts: {
    asOf: string; assumedMonthlySpending?: number;
    /**
     * I1 — dated income rules, baked into the closure so EVERY spine point sees
     * them.
     *
     * ⚠️ THIS IS WHY I1 REACHES THE FLOOR, THE DEBT WATERFALL AND THE CROSSINGS
     * WITHOUT TOUCHING ANY OF THEM. `spineFor` calls `runTo` once per date; a
     * rule inside the closure changes the cash at every one of those dates, and
     * the ledger reads nothing but that cash. A rule applied anywhere else would
     * have had to be applied to each consumer separately, and the first one
     * forgotten would answer a different question in the same conversation.
     */
    incomeChanges?: readonly IncomeChangeRule[];
    /**
     * S1-N1 — which liabilities' interest the caller's ledger accrues, decided from
     * the SAME accounts payload this spine opens from. Only the scenario ledger
     * passes it; `project_cash` has no liability model and keeps every cost flow.
     */
    interestModelledOn?: (accounts: AccountsSectionData) => string[];
    /**
     * S1 — dated spending rules, categories already resolved, baked into the closure
     * for the same reason I1's are: every spine point — each checkpoint, share date,
     * crossing step and solve evaluation — spends at the rate they leave, so the
     * floor, the waterfall and the crossings inherit them without knowing they exist.
     */
    spendingChanges?: readonly SpendingChangeRule[];
  },
): Promise<CashSpine | { unavailable: string; asOf: string }> {
  const asOf = opts.asOf;
  const retrospective = asOf < ctx.asOfISO;

  const reads = ctx.cashSpineReads;
  const [streams, accounts, canonical] = await Promise.all([
    loadForecastIncomeStreams(ctx.readClient, ctx.spaceId, asOf, reads?.incomeTransactions, reads?.incomeAccountTypes),
    reads ? reads.accounts() : assemble<AccountsSectionData>(FinanceDomains.ACCOUNTS, ctx),
    // ⚠️ THE ONE LINE THAT MADE THIS TOOL WORK. PROJECTION-1 derives its spending
    // rate from `reliableMonths(transactionsDomain)`; with only the accounts
    // domain in scope it sees zero months, cannot assert a rate, and returns
    // `closing: null` — always, for every horizon. Measured before the fix:
    // null / null. After: $38,243.50 to end-2026 and $128,827.54 to end-2027.
    // Both models papered over the null by doing the arithmetic in prose, and
    // one of them was $745.86 out.
    //
    // ⚠️ AND THE MONTHS ARE THE CANONICAL ONES, NOT THE WINDOW'S. This read the
    // 90-day assessment window, whose reliable months were TWO on 356 days of
    // 2026 — so `WINDOW_MONTHS = 3` was a cap that could not bind, and every
    // scenario spent at Aug+Sep while the get_baselines 3-month measurement said
    // Jul–Sep. The spine now reads exactly the trailing three complete months
    // before `asOf` (lib/transactions/canonical-spending), a month with nothing
    // recorded counting as zero; retrospective or not, the as-of date decides.
    readCanonicalSpending({
      asOf,
      readWindow: async (w) => reads ? reads.transactionsSummary()
        : assemble<TransactionsSummaryData>(FinanceDomains.TRANSACTIONS_SUMMARY, ctx, { transactionWindow: w }),
      // The seam's fixture summary IS the history it was given.
      readHistory: async (at) => {
        if (reads) {
          const t = await reads.transactionsSummary();
          return { from: t?.startDate ?? null, to: t?.endDate ?? null };
        }
        const span = await transactionCorpusSpan(ctx.readClient, { spaceId: ctx.spaceId, asOf: at });
        return { from: span.from, to: span.to };
      },
    }),
  ]);
  // The forecast reads only the months; it is handed exactly the canonical ones.
  const transactions = { monthlyBreakdown: canonical.months } as unknown as TransactionsSummaryData;

  // ⚠️ A SOLVER VARIES SPENDING BY RULE, NOT BY STATEMENT (S1-7). `scenario_goal_seek`
  // re-runs the projection at dozens of spending cuts; the expensive part is the three
  // reads above, and `assembleForecast` itself is pure, so each run appends its rule
  // to the closure's own (`runTo`'s second argument) rather than replacing the level.
  // ⚠️ ONE DERIVATION OF THE WORDING, AND IT IS THE AMOUNT. See the note below.
  const spendingStatement = (monthly: number): UserStatement[] => ([{
    mode: StatementMode.ASSERTS_FACT,
    statedAs: `assumed monthly spending ${monthly}`,
    asOfISO: ctx.asOfISO,
    subject: { kind: 'SPENDING_LEVEL', amount: monthly,
      currency: 'USD', periodBasis: PeriodBasis.MONTHLY },
  }]);
  // ⚠️ THE WORDING IS DERIVED FROM THE NUMBER, NEVER SUPPLIED. This took a caller's
  // `statedAs` verbatim, and `assembleForecast` quotes it into `appliedFacts` as the
  // words for the SPENDING LEVEL it applied — so any sentence could ride into the
  // applied channel attached to a figure it did not describe. Measured (1d67786):
  // the model passed "user has a $15k net bonus on 2026-12-07 added on top of current
  // pattern", the projection moved $10.43, and the result reported
  // `spending baseline 4346.48 USD: "…$15k net bonus…"` — a $15,000 assumption
  // presented as applied when it was discarded, and carried on into the durable
  // checkpoint's `basis.userAssumptions`.
  //
  // Generating the sentence from the amount makes the fact self-describing: what it
  // says and what it applied are the same value, by construction. There is no longer
  // a channel through which uninterpreted prose can become an applied fact.
  const statements: UserStatement[] = typeof opts.assumedMonthlySpending === 'number'
    ? spendingStatement(opts.assumedMonthlySpending)
    : [];

  // For a retrospective run the accounts payload is rebuilt from the snapshot
  // authority for that date — the CURRENT accounts domain would supply today's
  // opening cash to a projection that starts nine months ago.
  let openingAccounts: AccountsSectionData | null = accounts;
  let openingBasis = 'CURRENT_ACCOUNTS';
  if (retrospective) {
    const snap = await historicalSnapshot(ctx, asOf) as Record<string, unknown>;
    // ⚠️ THE STATE TRAVELS WITH THE SENTENCE. Forwarding only `unavailable` would
    // strip the adjudication off exactly the refusal a projection is built on.
    if (snap.unavailable) {
      return { unavailable: snap.unavailable as string, asOf,
        ...(snap.evidenceState ? { evidenceState: snap.evidenceState as AbsenceVerdict } : {}) };
    }
    openingAccounts = {
      totalLiquid: snap.liquid as number,
      totalLiabilities: snap.debt as number,
      netWorth: (snap.netWorth as number | null) ?? 0,
      totalAssets: (snap.totalAssets as number | null) ?? 0,
      totalInvestments: (snap.investments as number | null) ?? 0,
      totalDigitalAssets: (snap.digitalAssets as number | null) ?? 0,
      counts: accounts?.counts ?? { liquid: 0, investments: 0, digitalAssets: 0,
        realAssets: 0, liabilities: 0 },
      redactedCount: 0, totalsUnconverted: false,
    } as unknown as AccountsSectionData;
    openingBasis = 'HISTORICAL_SNAPSHOT';
  }

  const interestModelledOn = opts.interestModelledOn && accounts && !retrospective
    ? opts.interestModelledOn(accounts) : [];

  const forecastCtx = {
    space: { name: '', reportingCurrency: 'USD' },
    domains: {
      [FinanceDomains.ACCOUNTS]: { data: openingAccounts },
      [FinanceDomains.TRANSACTIONS_SUMMARY]: { data: transactions },
    },
  } as unknown as SpaceContext_AI;

  return {
    asOf, retrospective, openingBasis, accounts: openingAccounts,
    spendingBaseline: canonical.baseline,
    streams,
    runTo: (end: string, extraSpendingChanges?: readonly SpendingChangeRule[]) => {
      const rules = [...(opts.spendingChanges ?? []), ...(extraSpendingChanges ?? [])];
      return assembleForecast({
        ctx: forecastCtx, streams, asOfISO: asOf,
        statements,
        ...(opts.incomeChanges && opts.incomeChanges.length > 0
          ? { incomeChanges: opts.incomeChanges } : {}),
        ...(interestModelledOn.length > 0 ? { interestModelledOn } : {}),
        ...(rules.length > 0 ? { spendingChanges: rules } : {}),
        horizon: { fromISO: asOf, toISO: end, origin: AssumptionOrigin.USER_REQUESTED,
          statedAs: `through ${end}` } as unknown as ForecastHorizon,
      });
    },
  };
}
