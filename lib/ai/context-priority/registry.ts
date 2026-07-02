/**
 * lib/ai/context-priority/registry.ts
 *
 * Context Priority Registry (D6.3D-1, shadow mode).
 *
 * Declares one ContextSectionDescriptor per existing pipeline section — the
 * four Layer 1 domains that have assemblers today plus the ten Layer 2
 * FinancialAssessment sections. This is the single source of truth the planner
 * reads. Adding a section later is one descriptor here; no central routing edit.
 *
 * Affinity values encode the D6.3D domain × intent matrix (see
 * docs/investigations/D6_3D_CONTEXT_BUDGET_INVESTIGATION.md §2). Base-importance
 * ALWAYS entries (accounts, dataQuality, riskOpportunities) are the Required
 * floor and are never trimmed.
 *
 * No behavior change: this module is data + lookup only. It performs no I/O,
 * no LLM calls, and touches no prompt.
 */

import { FinanceDomains } from '@/lib/ai/types';
import { FinancialIntents, type FinancialIntent } from '@/lib/ai/intent';
import type { ConfidenceLevel } from '@/lib/ai/intelligence';
import type {
  AffinityLevel,
  ContextSectionDescriptor,
  IntentFamily,
} from './types';

/** Bumped when descriptor data or scoring semantics change. */
export const PLANNER_VERSION = 'd6.3d-1';

// ---------------------------------------------------------------------------
// Weight tables
// ---------------------------------------------------------------------------

/** Numeric multiplier for each affinity level. */
export const AFFINITY_WEIGHT: Record<AffinityLevel, number> = {
  PRIMARY:  1.0,
  SUPPORT:  0.6,
  OPTIONAL: 0.3,
  SUPPRESS: 0.0,
};

/** Base weight for each importance tier (ALWAYS handled as floor, not scored). */
export const IMPORTANCE_WEIGHT = {
  ALWAYS:     1.0,
  USUALLY:    0.7,
  ON_REQUEST: 0.5,
  SUPPORTING: 0.35,
  NEVER:      0.0,
} as const;

/** Confidence multiplier — low-confidence findings earn fewer budget tokens. */
export const CONFIDENCE_WEIGHT: Record<ConfidenceLevel, number> = {
  HIGH:   1.0,
  MEDIUM: 0.85,
  LOW:    0.6,
};

/** Affinity applied when a descriptor does not list a family explicitly. */
export const DEFAULT_AFFINITY: AffinityLevel = 'OPTIONAL';

// ---------------------------------------------------------------------------
// Intent → family mapping
// ---------------------------------------------------------------------------

/**
 * Every FinancialIntent maps to exactly one IntentFamily. DEBT_VS_INVESTING is
 * its own family so both debt and investment sections score highly for it.
 */
export const INTENT_FAMILY_BY_INTENT: Record<FinancialIntent, IntentFamily> = {
  [FinancialIntents.CURRENT_DEBT_STATUS]:        'DEBT',
  [FinancialIntents.DEBT_PAYOFF_PLAN]:           'DEBT',
  [FinancialIntents.DEBT_VS_INVESTING]:          'DEBT_VS_INVESTING',
  [FinancialIntents.SPENDING_REDUCTION]:         'SPENDING',
  [FinancialIntents.CASH_FLOW_EXPLANATION]:      'CASH_FLOW',
  [FinancialIntents.GOAL_ALIGNMENT]:             'GOAL',
  [FinancialIntents.INVESTMENT_READINESS]:       'INVESTMENT',
  [FinancialIntents.UPDATE_KNOWLEDGE]:           'UPDATE',
  [FinancialIntents.GENERAL_FINANCIAL_OVERVIEW]: 'OVERVIEW',
  [FinancialIntents.UNKNOWN]:                    'UNKNOWN',
};

export function intentFamilyForIntent(intent: FinancialIntent): IntentFamily {
  return INTENT_FAMILY_BY_INTENT[intent] ?? 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Confidence readers
// ---------------------------------------------------------------------------
//
// Each reader pulls an ALREADY-COMPUTED confidence off the assessment. Nothing
// is recomputed. The assessment argument is typed `unknown` in the descriptor
// contract; these readers narrow defensively so a shape change degrades to null
// (neutral) rather than throwing.

function readField(a: unknown, section: string, field: string): ConfidenceLevel | null {
  const root = a as Record<string, unknown> | null | undefined;
  const sec = root?.[section] as Record<string, unknown> | undefined;
  const v = sec?.[field];
  return v === 'HIGH' || v === 'MEDIUM' || v === 'LOW' ? v : null;
}

const conf = (section: string, field = 'confidence') =>
  (a: unknown): ConfidenceLevel | null => readField(a, section, field);

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------
//
// Affinity shorthand aligned to the D6.3D matrix. Families omitted default to
// OPTIONAL. Static token estimates are conservative upper bounds used only when
// live data is unavailable.

const DESCRIPTORS: ContextSectionDescriptor[] = [
  // ── Layer 1 domains ──────────────────────────────────────────────────────
  {
    key: FinanceDomains.ACCOUNTS, // 'accounts'
    layer: 'DOMAIN',
    baseImportance: 'ALWAYS', // Required floor — the balance/net-worth spine.
    intentAffinity: {
      DEBT: 'SUPPORT', DEBT_VS_INVESTING: 'PRIMARY', SPENDING: 'SUPPORT',
      INVESTMENT: 'PRIMARY', CASH_FLOW: 'SUPPORT', GOAL: 'SUPPORT',
      OVERVIEW: 'PRIMARY', UPDATE: 'PRIMARY', UNKNOWN: 'PRIMARY',
    },
    dependsOn: [],
    staticEstimatedTokens: 600,
  },
  {
    key: FinanceDomains.TRANSACTIONS_SUMMARY, // 'transactions_summary'
    layer: 'DOMAIN',
    baseImportance: 'USUALLY',
    intentAffinity: {
      DEBT: 'SUPPORT', DEBT_VS_INVESTING: 'SUPPORT', SPENDING: 'PRIMARY',
      INVESTMENT: 'SUPPORT', CASH_FLOW: 'PRIMARY', GOAL: 'SUPPORT',
      OVERVIEW: 'SUPPORT', UPDATE: 'OPTIONAL', UNKNOWN: 'SUPPORT',
    },
    dependsOn: [],
    staticEstimatedTokens: 700,
  },
  {
    key: FinanceDomains.GOALS, // 'goals'
    layer: 'DOMAIN',
    baseImportance: 'ON_REQUEST',
    intentAffinity: {
      DEBT: 'SUPPORT', DEBT_VS_INVESTING: 'OPTIONAL', SPENDING: 'OPTIONAL',
      INVESTMENT: 'SUPPORT', CASH_FLOW: 'OPTIONAL', GOAL: 'PRIMARY',
      OVERVIEW: 'SUPPORT', UPDATE: 'OPTIONAL', UNKNOWN: 'OPTIONAL',
    },
    dependsOn: [],
    staticEstimatedTokens: 300,
  },
  {
    key: FinanceDomains.SNAPSHOT_HISTORY, // 'snapshot_history'
    layer: 'DOMAIN',
    baseImportance: 'SUPPORTING',
    intentAffinity: {
      DEBT: 'SUPPORT', DEBT_VS_INVESTING: 'SUPPORT', SPENDING: 'OPTIONAL',
      INVESTMENT: 'SUPPORT', CASH_FLOW: 'SUPPORT', GOAL: 'SUPPORT',
      OVERVIEW: 'SUPPORT', UPDATE: 'OPTIONAL', UNKNOWN: 'OPTIONAL',
    },
    dependsOn: [],
    staticEstimatedTokens: 400,
  },

  // ── Layer 2 assessment sections ──────────────────────────────────────────
  {
    key: 'dataQuality',
    layer: 'ASSESSMENT',
    baseImportance: 'ALWAYS', // Required floor — gates confidence of every claim.
    intentAffinity: {
      DEBT: 'SUPPORT', DEBT_VS_INVESTING: 'SUPPORT', SPENDING: 'SUPPORT',
      INVESTMENT: 'SUPPORT', CASH_FLOW: 'SUPPORT', GOAL: 'SUPPORT',
      OVERVIEW: 'SUPPORT', UPDATE: 'SUPPORT', UNKNOWN: 'SUPPORT',
    },
    dependsOn: [],
    staticEstimatedTokens: 120,
    confidenceFrom: conf('dataQuality', 'incomeConfidence'),
  },
  {
    key: 'cashFlow',
    layer: 'ASSESSMENT',
    baseImportance: 'USUALLY',
    intentAffinity: {
      DEBT: 'SUPPORT', DEBT_VS_INVESTING: 'SUPPORT', SPENDING: 'PRIMARY',
      INVESTMENT: 'SUPPORT', CASH_FLOW: 'PRIMARY', GOAL: 'SUPPORT',
      OVERVIEW: 'SUPPORT', UPDATE: 'OPTIONAL', UNKNOWN: 'SUPPORT',
    },
    dependsOn: [FinanceDomains.TRANSACTIONS_SUMMARY],
    staticEstimatedTokens: 200,
    confidenceFrom: conf('cashFlow'),
  },
  {
    key: 'debt',
    layer: 'ASSESSMENT',
    baseImportance: 'USUALLY',
    intentAffinity: {
      DEBT: 'PRIMARY', DEBT_VS_INVESTING: 'PRIMARY', SPENDING: 'SUPPORT',
      INVESTMENT: 'SUPPORT', CASH_FLOW: 'SUPPORT', GOAL: 'SUPPORT',
      OVERVIEW: 'SUPPORT', UPDATE: 'OPTIONAL', UNKNOWN: 'SUPPORT',
    },
    dependsOn: [FinanceDomains.ACCOUNTS],
    staticEstimatedTokens: 220,
    confidenceFrom: conf('debt'),
  },
  {
    key: 'debtStrategy',
    layer: 'ASSESSMENT',
    baseImportance: 'ON_REQUEST',
    intentAffinity: {
      DEBT: 'PRIMARY', DEBT_VS_INVESTING: 'PRIMARY', SPENDING: 'OPTIONAL',
      INVESTMENT: 'SUPPORT', CASH_FLOW: 'OPTIONAL', GOAL: 'OPTIONAL',
      OVERVIEW: 'OPTIONAL', UPDATE: 'OPTIONAL', UNKNOWN: 'OPTIONAL',
    },
    dependsOn: ['debt', FinanceDomains.ACCOUNTS],
    staticEstimatedTokens: 260,
    confidenceFrom: conf('debtStrategy'),
  },
  {
    key: 'liquidity',
    layer: 'ASSESSMENT',
    baseImportance: 'USUALLY',
    intentAffinity: {
      DEBT: 'SUPPORT', DEBT_VS_INVESTING: 'PRIMARY', SPENDING: 'SUPPORT',
      INVESTMENT: 'PRIMARY', CASH_FLOW: 'SUPPORT', GOAL: 'SUPPORT',
      OVERVIEW: 'SUPPORT', UPDATE: 'OPTIONAL', UNKNOWN: 'SUPPORT',
    },
    dependsOn: [FinanceDomains.ACCOUNTS],
    staticEstimatedTokens: 180,
    confidenceFrom: conf('liquidity'),
  },
  {
    key: 'capitalAllocation',
    layer: 'ASSESSMENT',
    baseImportance: 'ON_REQUEST',
    intentAffinity: {
      DEBT: 'PRIMARY', DEBT_VS_INVESTING: 'PRIMARY', SPENDING: 'OPTIONAL',
      INVESTMENT: 'PRIMARY', CASH_FLOW: 'SUPPORT', GOAL: 'SUPPORT',
      OVERVIEW: 'SUPPORT', UPDATE: 'OPTIONAL', UNKNOWN: 'OPTIONAL',
    },
    dependsOn: ['debt', 'liquidity', 'cashFlow'],
    staticEstimatedTokens: 300,
    confidenceFrom: conf('capitalAllocation'),
  },
  {
    key: 'spendingOpportunities',
    layer: 'ASSESSMENT',
    baseImportance: 'ON_REQUEST',
    intentAffinity: {
      DEBT: 'OPTIONAL', DEBT_VS_INVESTING: 'OPTIONAL', SPENDING: 'PRIMARY',
      INVESTMENT: 'OPTIONAL', CASH_FLOW: 'SUPPORT', GOAL: 'OPTIONAL',
      OVERVIEW: 'OPTIONAL', UPDATE: 'OPTIONAL', UNKNOWN: 'OPTIONAL',
    },
    dependsOn: ['cashFlow', FinanceDomains.TRANSACTIONS_SUMMARY],
    staticEstimatedTokens: 320,
    confidenceFrom: conf('spendingOpportunities'),
  },
  {
    key: 'goalAlignment',
    layer: 'ASSESSMENT',
    baseImportance: 'ON_REQUEST',
    intentAffinity: {
      DEBT: 'SUPPORT', DEBT_VS_INVESTING: 'OPTIONAL', SPENDING: 'OPTIONAL',
      INVESTMENT: 'SUPPORT', CASH_FLOW: 'OPTIONAL', GOAL: 'PRIMARY',
      OVERVIEW: 'SUPPORT', UPDATE: 'OPTIONAL', UNKNOWN: 'OPTIONAL',
    },
    dependsOn: [FinanceDomains.GOALS, FinanceDomains.TRANSACTIONS_SUMMARY],
    staticEstimatedTokens: 280,
    confidenceFrom: conf('goalAlignment'),
  },
  {
    key: 'investmentReadiness',
    layer: 'ASSESSMENT',
    baseImportance: 'ON_REQUEST',
    intentAffinity: {
      DEBT: 'OPTIONAL', DEBT_VS_INVESTING: 'PRIMARY', SPENDING: 'SUPPRESS',
      INVESTMENT: 'PRIMARY', CASH_FLOW: 'OPTIONAL', GOAL: 'OPTIONAL',
      OVERVIEW: 'OPTIONAL', UPDATE: 'OPTIONAL', UNKNOWN: 'OPTIONAL',
    },
    dependsOn: ['liquidity', 'debt'],
    staticEstimatedTokens: 200,
    confidenceFrom: conf('investmentReadiness'),
  },
  {
    key: 'riskOpportunities',
    layer: 'ASSESSMENT',
    baseImportance: 'ALWAYS', // Required floor — the executive-summary engine.
    intentAffinity: {
      DEBT: 'PRIMARY', DEBT_VS_INVESTING: 'PRIMARY', SPENDING: 'PRIMARY',
      INVESTMENT: 'PRIMARY', CASH_FLOW: 'PRIMARY', GOAL: 'PRIMARY',
      OVERVIEW: 'PRIMARY', UPDATE: 'SUPPORT', UNKNOWN: 'PRIMARY',
    },
    dependsOn: [],
    staticEstimatedTokens: 260,
    confidenceFrom: conf('riskOpportunities'),
  },
];

// ---------------------------------------------------------------------------
// Registry (immutable — descriptors are declared statically above)
// ---------------------------------------------------------------------------

const _byKey: Map<string, ContextSectionDescriptor> = new Map(
  DESCRIPTORS.map((d) => [d.key, d]),
);

/** All registered descriptors, in declaration order. */
export function listDescriptors(): ContextSectionDescriptor[] {
  return [...DESCRIPTORS];
}

/** Look up a descriptor by section key, or undefined if not registered. */
export function getDescriptor(key: string): ContextSectionDescriptor | undefined {
  return _byKey.get(key);
}

/** Resolve a section's affinity level for a family, applying the default. */
export function affinityFor(
  descriptor: ContextSectionDescriptor,
  family: IntentFamily,
): AffinityLevel {
  return descriptor.intentAffinity[family] ?? DEFAULT_AFFINITY;
}
