/**
 * lib/ai/conversation/tools/investments.ts
 *
 * Investment tools: `get_investments` and `investment_scenario`.
 *
 * Part of the tool surface split out of `tools.ts` (CQ-011). The facade
 * `lib/ai/conversation/tools.ts` owns the registry (`TOOLS`) and is the only
 * import path callers use; this module never imports the facade.
 *
 * Moved verbatim: every comment and invariant in `tools.ts`'s header applies
 * here — adapters, not authorities; read and calculate only; no Prisma client in
 * scope (the source scans in `lib/test-support/tools-source.ts` read this file).
 */

import { FinanceDomains, type AccountsSectionData, type HoldingsSummaryData } from '@/lib/ai/types';
import { composeInvestments } from '@/lib/ai/economic-concepts';
import { applyInvestmentScenario, type ScenarioComponent } from '../scenario';
import { refuseUnknownArguments, notAppliedEcho } from '../scenario-rules';
import type { ToolDefinition } from './types';
import { obj, str, num } from './shared/schema';
import { absentIn, assemble } from './shared/reads';
import { historicalSnapshot } from './shared/historical-snapshot';

// ── 5. Investments ───────────────────────────────────────────────────────────

export const getInvestments: ToolDefinition = {
  name: 'get_investments',
  description:
    'What the user is invested in. Returns the canonical composition (traditional ' +
    'investments vs digital assets, disjoint) AND the position-level detail, which ' +
    'is a SUBSET limited to positions that could be priced. Every concentration ' +
    'figure states the population it is a share of. Pass `asOf` for a past date. No cost ' +
    'basis or account tax treatment is known: a sale\'s tax effect is never in this data.',
  parameters: obj({
    asOf: str('YYYY-MM-DD. Omit for today. A past date returns the composition as it was.'),
  }),
  async run(a, ctx) {
    const asOf = (a.asOf as string) || ctx.asOfISO;
    if (asOf < ctx.asOfISO) {
      // ⚠️ A PAST DATE HAS NO ACCOUNT COMPOSITION TO COMPOSE. `composeInvestments`
      // reads today's account totals; the historical authority is the snapshot's
      // own investments / digitalAssets split, which carries its own coverage.
      // Returning the current composition under a past `asOf` would be the exact
      // leakage this parameter exists to prevent.
      const snap = await historicalSnapshot(ctx, asOf) as Record<string, unknown>;
      if (snap.unavailable) return snap;
      return {
        asOf, basis: 'HISTORICAL_SNAPSHOT',
        observedOn: snap.observedOn,
        composition: {
          traditionalInvestments: snap.investments,
          digitalAssets: snap.digitalAssets,
          note: 'Disjoint by construction, from the snapshot authority for that date.',
        },
        coverage: snap.coverage,
        buckets: (snap.buckets as unknown[] | undefined)?.filter(
          (b) => ['investments', 'crypto'].includes((b as { bucket: string }).bucket)),
        positionDetailUnavailable:
          'Position-level detail and concentration are current-only in this harness.',
      };
    }
    const [acc, hold] = await Promise.all([
      assemble<AccountsSectionData>(FinanceDomains.ACCOUNTS, ctx),
      assemble<HoldingsSummaryData>(FinanceDomains.HOLDINGS_SUMMARY, ctx),
    ]);
    const composition = acc ? composeInvestments(acc) : null;
    return {
      // ⚠️ EVERY RESULT NAMES ITS INSTANT. Two of these tools carried none, and
      // a current-position figure was composed with a future cash figure and
      // presented as one answer.
      asOf: ctx.asOfISO,
      // ⚠️ THE AUTHORITY ON WHAT THE INVESTMENTS ARE WORTH. Account-level,
      // components disjoint by construction. Do not add anything below to this.
      composition,
      investmentAccounts: (acc?.accounts ?? [])
        .filter((a) => a.type === 'investment' || a.type === 'crypto')
        .map((a) => ({ name: a.name, type: a.type, value: a.reportingBalance,
          currency: a.currency, needsReauth: a.needsReauth })),
      // ⚠️ A SUBSET, AND IT SAYS SO. Positions the valuation seam could price.
      positionDetail: hold ? {
        scopeWarning:
          'These figures cover only positions that could be priced. They are NOT ' +
          'the investment totals — use `composition` for those.',
        valuedPositionsTotal: hold.valuedPositionsTotal,
        valuedNonCashTotal:   hold.valuedNonCashTotal,
        uninvestedCashInBrokerage: hold.valuedCashTotal,
        valuationCompleteness: hold.valuationCompleteness,
        unpricedPositions: hold.unvaluedPositions,
        positions: hold.topPositions?.items,
        concentration: hold.concentration,
        limits: hold.dataLimits,
      } : await absentIn(ctx, 'no priced positions in scope', 'any priced positions in scope'),
    };
  },
};

// ── 10. Investment scenario ──────────────────────────────────────────────────

export const investmentScenario: ToolDefinition = {
  name: 'investment_scenario',
  description:
    'Apply a percentage the USER stated to a named investment component and report ' +
    'the arithmetic effect on net worth AS OF TODAY. This is arithmetic over a ' +
    'hypothesis, not a prediction — never call it to guess what a market will do, and ' +
    'never add its result to a future projection without saying they are different dates.',
  parameters: obj({
    moves: { type: 'array', description: 'One entry per component to move.',
      items: obj({
        component: { type: 'string',
          enum: ['DIGITAL_ASSETS', 'TRADITIONAL_INVESTMENTS'],
          description: 'Which canonical component the stated move applies to.' },
        changePercent: num('The user\'s stated move, in percent. -30 for "down 30%".'),
      }, ['component', 'changePercent']) },
  }, ['moves']),
  async run(a, ctx) {
    // ⚠️ CLOSED, LIKE EVERY TOOL THAT COMPUTES MONEY (review). This is a
    // current-instant move on investments; an income change stated to it was
    // silently dropped, and the answer came back as if it had been considered.
    const rejected = refuseUnknownArguments(a, investmentScenario.parameters);
    if (rejected.length > 0) {
      return { unavailable: 'this calculation cannot carry what was stated, so it was NOT run',
        notApplied: notAppliedEcho(rejected),
        instead: 'investment_scenario moves investment components as of TODAY. A change to '
          + 'future income is scenario_projection\'s `incomeChanges`.' };
    }
    const acc = await assemble<AccountsSectionData>(FinanceDomains.ACCOUNTS, ctx);
    if (!acc) return absentIn(ctx, 'no accounts in scope', 'any accounts in scope');
    const comp = composeInvestments(acc);
    const components: ScenarioComponent[] = (comp?.components ?? [])
      .filter((c) => c.state === 'ASSERTABLE' && c.amount !== null)
      .map((c) => ({ key: c.key, label: c.label, currentValue: c.amount as number }));
    const moves: Record<string, number> = {};
    for (const m of (a.moves as { component: string; changePercent: number }[]) ?? []) {
      moves[m.component] = m.changePercent / 100;
    }
    const result = applyInvestmentScenario({ components, moves, currentNetWorth: acc.netWorth });
    return {
      // ⚠️ A CURRENT-INSTANT SCENARIO, SAID OUT LOUD. Without this the result was a
      // bare net-worth number with no date on it, and it was glued to a February
      // cash projection and presented as one figure.
      effectiveAt: ctx.asOfISO,
      appliesTo: 'the position as it stands today — this does NOT move forward in time',
      doNotComposeWith:
        'a projected future cash balance, unless you state that the two refer to '
        + 'different instants',
      ...result,
    };
  },
};
