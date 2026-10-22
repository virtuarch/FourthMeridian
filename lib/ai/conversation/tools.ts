/**
 * lib/ai/conversation/tools.ts
 *
 * THE TOOL SURFACE — the adapters in `TOOLS` at the bottom of this file (the
 * registry is the count; ARCH-012: prose counts drifted 13/16/18/20), over
 * authorities that already exist, plus the memory tools from `memory-tools.ts`.
 *
 * ⚠️ ADAPTERS, NOT AUTHORITIES. Not one line here computes a financial figure.
 * Every tool resolves parameters, calls a canonical function, and reshapes the
 * result into something compact and semantically explicit. If a tool ever needs
 * to add two money numbers together, that is a signal the composition belongs in
 * an authority, not here.
 *
 * There is exactly ONE arithmetic exception, and it is named rather than hidden:
 * `scenario_projection` reconciles the accounts authority's own totals to find
 * what is neither cash nor an investment (a house, a car) so the ledger can hold
 * it flat instead of dropping it. The scenario arithmetic itself is not here — it
 * is `scenario-ledger.ts`, which is a pure function with no data access at all.
 *
 * ⚠️ READ AND CALCULATE ONLY, WITH ONE NAMED EXCEPTION. Nothing in THIS file
 * writes: there is no correction tool, no categorise tool, and no Prisma client
 * in scope, all of which a test asserts. The single write verb in the harness is
 * `remember`, which lives in `memory-tools.ts` and can reach exactly one table —
 * `SpaceMemory`, which holds intentions and dated statements and structurally
 * cannot hold a balance. The harness remains incapable of mutating financial
 * data.
 *
 * ⚠️ THE VOCABULARY IS THE USER'S, NOT THE ARCHITECTURE'S. `get_spending`, not
 * `assembleTransactionsSummary`; `explain_net_worth_composition`, not
 * `resolveExplorationNode`. A model should not have to learn Fourth Meridian's
 * internal names to ask a question, and exposing them would leak the thing the
 * reset removed.
 */

import { monthEndsBetween } from './scenario-ledger';
// ⚠️ THE ONE WRITE PATH, IMPORTED RATHER THAN INLINED. Keeping the memory tools
// in their own module is what lets THIS file keep an exact "no Prisma client,
// no write op" scan while `memory-tools.ts` gets its own, equally exact, "may
// reach db.spaceMemory and nothing else". One loose assertion covering both
// would have protected neither.
import { MEMORY_TOOLS } from './memory-tools';
import { describeFourthMeridian } from './product';
import { yearEndsBetween } from './scenario-checkpoints';
import { getFinancialSnapshot, explainNetWorthComposition } from './tools/snapshot';
import type { ToolDefinition } from './tools/types';
import { getSpending } from './tools/spending';
import { getTransactions } from './tools/transactions';
import { getIncome, getPayDates } from './tools/income';
import { measureFlows, getBaselines } from './tools/measures';
import { getInvestments, investmentScenario } from './tools/investments';
import { getNetWorthHistory, findInBalanceHistory } from './tools/history';
import { projectCash, reconcileProjection } from './tools/projection';
import { scenarioProjection, scenarioCrossing } from './tools/scenario/run';
import { scenarioGoalSeek } from './tools/scenario/goal-seek';
import { stageAssumptions } from './tools/scenario/staging';

/**
 * CQ-011 — every name this module exported before the split, re-exported from the
 * module that now holds it. Callers keep importing `@/lib/ai/conversation/tools`.
 */
export type { CashSpineReads, ToolContext, ToolDefinition } from './tools/types';
export { clampToCeiling } from './tools/shared/values';
export type { TransactionPager } from './tools/shared/read-window';
export { readWindowToExhaustion } from './tools/shared/read-window';
export { interestModelledLiabilityIds, rebindDerivedFloors, rebindDerivedFloorsByDate } from './tools/scenario/setup';

/**
 * ⚠️ RE-EXPORTED, NOT REIMPLEMENTED. The month-end grid moved into
 * `scenario-ledger.ts` when a surplus share had to generate its own dates. Every
 * caller here is unmoved and there is still exactly one implementation.
 */
export { monthEndsBetween };
export { yearEndsBetween };

// ── Registry ─────────────────────────────────────────────────────────────────

export const TOOLS: readonly ToolDefinition[] = [
  getFinancialSnapshot, getSpending, measureFlows, getBaselines, getTransactions, getIncome,
  getInvestments,
  getNetWorthHistory, findInBalanceHistory, explainNetWorthComposition, projectCash,
  getPayDates, investmentScenario,
  scenarioProjection, scenarioCrossing, scenarioGoalSeek, reconcileProjection,
  stageAssumptions,
  ...MEMORY_TOOLS,
  describeFourthMeridian,
];

/** OpenAI function-tool definitions for the tool-capable arms. */
export function openAiToolSchemas(): unknown[] {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}
