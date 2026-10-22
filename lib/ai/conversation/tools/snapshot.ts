/**
 * lib/ai/conversation/tools/snapshot.ts
 *
 * Position tools: `get_financial_snapshot` and `explain_net_worth_composition`.
 *
 * Part of the tool surface split out of `tools.ts` (CQ-011). The facade
 * `lib/ai/conversation/tools.ts` owns the registry (`TOOLS`) and is the only
 * import path callers use; this module never imports the facade.
 *
 * Moved verbatim: every comment and invariant in `tools.ts`'s header applies
 * here — adapters, not authorities; read and calculate only; no Prisma client in
 * scope (the source scans in `lib/test-support/tools-source.ts` read this file).
 */

import { FinanceDomains, type AccountsSectionData } from '@/lib/ai/types';
import { composeInvestments } from '@/lib/ai/economic-concepts';
import { resolveExplorationNode } from '@/lib/history/exploration';
import { liquidityAccess, LIQUIDITY_ACCESS_MEANING, type LiquidityAccess } from '@/lib/account-classifier';
import type { ToolDefinition } from './types';
import { obj, str } from './shared/schema';
import { clampToCeiling } from './shared/values';
import { absentIn, assemble } from './shared/reads';
import { historicalSnapshot } from './shared/historical-snapshot';

/**
 * The liquidity authority's per-account verdict, projected beside each account so
 * the model reads it instead of guessing from a name. PROJECTION, NOT A RULE: the
 * verdict is `liquidityAccess()`'s and its wording is `LIQUIDITY_ACCESS_MEANING`'s,
 * both owned by lib/account-classifier.ts. It exists because an HSA (type checking,
 * subtype hsa) arrived with an `available` balance and no verdict, and the model
 * called the HSA-inclusive total "the stricter can-I-spend-it-today view" and
 * supplied HSA tax rules of its own.
 */
function accessOf(a: { type: string; providerSubtype?: string | null }): { access?: LiquidityAccess } {
  const v = liquidityAccess(a);
  return v ? { access: v } : {};
}

// ── 1. Snapshot ──────────────────────────────────────────────────────────────

export const getFinancialSnapshot: ToolDefinition = {
  name: 'get_financial_snapshot',
  description:
    'The position on a date. Omit `asOf` for today (adds per-account freshness, APRs and ' +
    'available balances); pass `asOf` for a past date (adds the account-level breakdown of ' +
    'each bucket and the coverage of that date). Today, `liquid` is unrestricted cash (checking + savings, excluding restricted accounts such as an HSA); on a past date it is ' +
    'the recorded checking + savings balance; historical snapshots do not separate restricted accounts such as an HSA, so it is not comparable to today\'s unrestricted `liquid` when such accounts exist. `checking` ' +
    'is checking alone. Start here for anything broad, and for any "how was I doing on X". ' +
    'Investment values carry no cost basis or account tax treatment: a sale\'s tax effect is ' +
    'unknown here, so name it when selling is on the table.',
  parameters: obj({
    asOf: str('YYYY-MM-DD. Omit for today. A past date returns the position AS IT WAS then.'),
  }),
  async run(a, ctx) {
    const asOf = (a.asOf as string) || ctx.asOfISO;
    // ⚠️ TWO BASES, AND THE RESULT SAYS WHICH. Today's position comes from the
    // accounts authority, which carries freshness, APRs and pending reconciliation
    // that simply do not exist for a past date. A historical snapshot that
    // pretended to those fields would be inventing them.
    if (asOf < ctx.asOfISO) return historicalSnapshot(ctx, asOf);

    const acc = await assemble<AccountsSectionData>(FinanceDomains.ACCOUNTS, ctx);
    if (!acc) return absentIn(ctx, 'no accounts in scope', 'any accounts in scope');
    return {
      asOf: ctx.asOfISO, basis: 'CURRENT_ACCOUNTS',
      netWorth: acc.netWorth, totalAssets: acc.totalAssets,
      totalLiabilities: acc.totalLiabilities,
      /** Unrestricted cash. Deliberately not named `cash` — see get_net_worth_history. */
      liquid: acc.totalLiquid,
      // The authority's own restricted total: owned (in netWorth/totalAssets), not in `liquid`.
      // ⚠️ THE RELATION IS STATED, NOT LEFT TO INFERENCE. Shown beside `liquid` with no
      // relation, the model read restricted as a PART of liquid and subtracted it again
      // ("$56,580 − $6,009 = $50,571", Preview 3ae6fbe). It is already out of `liquid`.
      ...(typeof acc.totalRestrictedCash === 'number' && acc.totalRestrictedCash !== 0
        ? { restrictedCash: { amount: acc.totalRestrictedCash,
          relation: 'already EXCLUDED from `liquid` — `liquid` is the unrestricted amount, so do not subtract '
            + 'this from it; included in totalAssets and netWorth',
          meaning: LIQUIDITY_ACCESS_MEANING.restricted } } : {}),
      counts: acc.counts,
      // CF-7's composer is the authority on what "investments" means; the two
      // components are disjoint by construction and must not be re-derived.
      investmentComposition: composeInvestments(acc),
      accounts: (acc.accounts ?? []).map((a2) => ({
        name: a2.name, type: a2.type, institution: a2.institution,
        balance: a2.reportingBalance, currency: a2.currency,
        amountOwed: a2.amountOwed, creditBalance: a2.creditBalance,
        liabilityState: a2.liabilityState,
        apr: a2.apr, minimumPayment: a2.minimumPayment,
        freshness: a2.balanceFreshness?.band, needsReauth: a2.needsReauth,
        // RWA-1C — a manual asset's balance is the USER'S ESTIMATE, not a market
        // price; the assembler marks it and this row must not drop the mark.
        ...(a2.valuationSource ? { valuationSource: a2.valuationSource } : {}),
        // RWA-2A — the user's recorded valuations, the DESCRIPTOR of the modeled
        // curve between them (never modeled points) and the user-reported change.
        ...(a2.valuations ? { valuations: a2.valuations } : {}),
        ...(a2.modeledHistory ? { modeledHistory: a2.modeledHistory } : {}),
        ...(a2.valueChangeSinceFirstRecorded ? { valueChangeSinceFirstRecorded: a2.valueChangeSinceFirstRecorded } : {}),
        available: a2.availableQuantity?.label && a2.availableQuantity?.amount !== undefined
          ? { label: a2.availableQuantity.label, amount: a2.availableQuantity.amount } : undefined,
        ...accessOf(a2),
      })),
      accessMeaning: LIQUIDITY_ACCESS_MEANING,
      missingDebtFields: acc.knowledgeGaps,
      totalsEstimated: acc.totalsEstimated,
    };
  },
};

// ── 7. Net-worth explanation ─────────────────────────────────────────────────

/** The lens roots `lib/history` exposes. Listed so a single-lens answer can name its siblings. */
const EXPLAINABLE_LENSES = [
  'net-worth', 'assets', 'liquid-net-worth', 'investments',
  'crypto', 'cash', 'savings', 'debt', 'liquidity',
] as const;

// ⚠️ RENAMED, BECAUSE IT NEVER EXPLAINED A CHANGE. It took one `date`, passed
// `fromISO === toISO`, and returned a COMPOSITION — and its own description
// invited "why did my net worth drop". Measured twice in dogfood (58b352f and the
// 1b83384 re-run): the model asked it what changed and narrated BALANCES as
// contributions, calling a $12,345.80 savings level "a big chunk" of an
// $11,242.40 rise. The capability is real and unduplicated — one lens, drilled
// bucket → account → holding — so the name moved to meet it rather than the
// other way round. Change now lives where the two endpoints always did:
// `get_net_worth_history`.
export const explainNetWorthComposition: ToolDefinition = {
  name: 'explain_net_worth_composition',
  description:
    'Break ONE total into the components it is MADE OF on a single date, and drill into '
    + 'them. This is a composition at a point in time, not a movement: for what CHANGED '
    + 'between two dates use get_net_worth_history, and for a whole position on one date '
    + 'use get_financial_snapshot(asOf). Each result names the population the lens covers '
    + 'and its sibling lenses — `cash` is checking only, `savings` is separate. Call again '
    + 'with a component id to drill deeper.',
  parameters: obj({
    date: str('YYYY-MM-DD to explain. Required.'),
    lens: { type: 'string',
      enum: ['net-worth', 'assets', 'liquid-net-worth', 'investments', 'crypto', 'cash', 'savings', 'debt'],
      description: 'Which total to break down. Default net-worth.' },
    componentId: str('A component id from a previous call, to drill one level deeper.'),
  }, ['date']),
  async run(a, ctx) {
    // ⚠️ SAME CEILING, SAME REASON. A composition on a date after the cutoff is a
    // balance from the future wearing a historical label.
    const dateISO = clampToCeiling(String(a.date), ctx.asOfISO);
    const lens = String(a.lens ?? 'net-worth');
    const nodeId = a.componentId ? String(a.componentId) : null;
    const res = await resolveExplorationNode(ctx.readClient, {
      spaceId: ctx.spaceId, lens,
      nodeType: nodeId ? (nodeId.startsWith('account:') ? 'account'
        : nodeId.startsWith('holding:') ? 'holding' : 'bucket') : 'lens',
      nodeId, dateISO, fromISO: dateISO, toISO: dateISO,
    });
    if (res.error || !res.node) return { unavailable: res.error ?? 'node not resolved' };
    const n = res.node;
    const components = (n.components ?? []).map((c) => ({
      id: c.id, label: c.label, value: c.displayedValue,
      canDrillDeeper: c.drilldown?.available ?? false,
    }));
    return {
      date: dateISO, lens, label: n.label,
      value: n.displayedValue, currency: n.currency,
      explainedByComponents: n.explainedValue,
      unexplainedRemainder: n.unattributedObservedAmount,
      assertable: n.assertable, unavailableReason: n.unavailableReason,
      components,
      // ⚠️ WHAT THIS LENS COVERS, AND WHAT IT DOES NOT. `cash` is the checking
      // bucket; `savings` is a SEPARATE lens; and a reader who wants the spendable
      // total wants neither on its own. Stating the population and the siblings is
      // what stops a single-bucket figure being read as a whole-position one.
      population: {
        lens, label: n.label,
        covers: components.map((c) => c.label),
        siblingLenses: EXPLAINABLE_LENSES.filter((l) => l !== lens),
        note: 'This is ONE component of the position on that date. For the whole '
          + 'picture in one call, use get_financial_snapshot with an asOf.',
      },
    };
  },
};
