/**
 * lib/ai/intent/prompt.ts
 *
 * Layer 3 integration for Layer 0 routing metadata (D4).
 *
 * serializeRoutingBlock(route) renders an IntentRoute into the
 * `=== QUESTION ROUTING ===` prompt block. The chat route injects this block
 * immediately BEFORE `=== FINANCIAL ASSESSMENT ===` so the LLM reads the
 * routing guidance first and lets it shape how it draws on the assessment and
 * space context that follow.
 *
 * The block is guidance, not a hard filter: the full context is still present
 * below it. The routing block only tells the model where to focus.
 *
 * Prompt-polish responsibilities carried here (behaviour only — no new data is
 * serialized, no calculations change):
 *   - POLISH 1: intent-aware knowledge-gap emphasis (which gaps become
 *     conversational guidance, and how prominently).
 *   - POLISH 3: intent-aware Risk & Opportunity focus (reuse the existing
 *     Layer 2.6 output as the executive-summary engine, scoped to the topic).
 *   - POLISH 4: routing-confidence banding (HIGH prioritizes routed sections;
 *     LOW allows broader reasoning; UNKNOWN permits all sections).
 */

import { FinancialIntents, TemporalFrames, type IntentRoute, type FinancialIntent } from './types';

/** Confidence bands used to tune how strictly the LLM follows the routing. */
export type RoutingConfidenceBand = 'HIGH' | 'LOW' | 'UNKNOWN';

/** At or above this score a matched intent is treated as HIGH confidence. */
const HIGH_CONFIDENCE_THRESHOLD = 0.8;

/** Map a route to a coarse confidence band (POLISH 4). */
export function confidenceBand(route: IntentRoute): RoutingConfidenceBand {
  if (route.intent === FinancialIntents.UNKNOWN) return 'UNKNOWN';
  return route.confidence >= HIGH_CONFIDENCE_THRESHOLD ? 'HIGH' : 'LOW';
}

/** Renders a section-key list for the prompt, or "(none)" when empty. */
function fmtSections(keys: string[]): string {
  return keys.length > 0 ? keys.join(', ') : '(none)';
}

/**
 * Temporal-framing instruction. Explicitly tells the model whether to lead
 * with current state or historical aggregates, per the two required cases,
 * with sensible guidance for TREND / PLANNING / GENERAL as well.
 */
function temporalGuidance(route: IntentRoute): string {
  switch (route.temporalFrame) {
    case TemporalFrames.CURRENT:
      return 'This is a CURRENT question. Lead with current balances and present-day state. '
        + 'Do NOT open with historical aggregates or long-run trends.';
    case TemporalFrames.HISTORICAL:
      return 'This is a HISTORICAL question. Use transaction history first; '
        + 'explain what happened over the relevant past period before commenting on the present.';
    case TemporalFrames.TREND:
      return 'This is a TREND question. Lead with the direction and rate of change across periods '
        + '(e.g. snapshot history, category trends), not a single point-in-time balance.';
    case TemporalFrames.PLANNING:
      return 'This is a PLANNING question. Lead with a forward-looking plan or projection grounded '
        + 'in current balances and known rates; be explicit about assumptions.';
    case TemporalFrames.GENERAL:
    default:
      return 'No dominant temporal framing. Use whichever of current state or history best answers the question.';
  }
}

/**
 * Confidence-band directive (POLISH 4). Tunes how strictly the LLM should
 * confine itself to the routed PRIMARY sections.
 */
function confidenceGuidance(route: IntentRoute): string {
  switch (confidenceBand(route)) {
    case 'HIGH':
      return 'Routing confidence is HIGH. Strongly prioritize the PRIMARY sections; treat SUPPORTING '
        + 'as background only, and do not let SUPPRESS sections shape the answer.';
    case 'LOW':
      return 'Routing confidence is MODERATE. Prefer the PRIMARY sections, but reason more broadly '
        + 'across SUPPORTING sections if the question clearly needs them.';
    case 'UNKNOWN':
    default:
      return 'Intent is UNKNOWN. You may draw on any section as needed. If the question is ambiguous, '
        + 'briefly ask what the user wants to focus on rather than guessing.';
  }
}

/**
 * Intent-aware knowledge-gap emphasis (POLISH 1).
 *
 * Controls how prominently missing data (especially APR, income, and
 * transaction-history completeness) surfaces as conversational guidance.
 * This governs PROSE emphasis only — it does not change which KnowledgeGap
 * rows are assembled or the Knowledge Acquisition card behaviour.
 */
function gapEmphasisGuidance(intent: FinancialIntent): string {
  switch (intent) {
    case FinancialIntents.CURRENT_DEBT_STATUS:
      return 'Data-gap emphasis: if APR is unknown, mention it once, briefly. Do not re-explain why '
        + 'it is missing or dwell on it — the user asked for status, not a payoff plan.';
    case FinancialIntents.DEBT_PAYOFF_PLAN:
      return 'Data-gap emphasis: APR is CRITICAL for a payoff timeline. State prominently that the '
        + 'estimate depends on it and ask the user to update it — but say this once, not repeatedly.';
    case FinancialIntents.DEBT_VS_INVESTING:
      return 'Data-gap emphasis: raise APR only if the debt-vs-investing comparison actually depends on '
        + 'it. If a missing APR blocks the comparison, say so once and ask for it.';
    case FinancialIntents.INVESTMENT_READINESS:
      return 'Data-gap emphasis: mention APR only if the debt-vs-market comparison depends on it. '
        + 'Otherwise do not raise debt-metadata gaps.';
    case FinancialIntents.SPENDING_REDUCTION:
      return 'Data-gap emphasis: do NOT mention APR or debt-metadata gaps — they are immaterial to a '
        + 'spending question.';
    case FinancialIntents.CASH_FLOW_EXPLANATION:
      return 'Data-gap emphasis: if income or transaction history is incomplete, note it once as the '
        + 'reason the picture is partial, then continue. Do not raise APR.';
    case FinancialIntents.GOAL_ALIGNMENT:
      return 'Data-gap emphasis: raise a data gap only when it blocks a specific goal assessment. '
        + 'Otherwise focus on alignment, not missing fields.';
    case FinancialIntents.UPDATE_KNOWLEDGE:
      return 'Data-gap emphasis: the user is updating a value — confirm the value and point to the save '
        + 'form. Do not enumerate other unrelated gaps.';
    case FinancialIntents.GENERAL_FINANCIAL_OVERVIEW:
      return 'Data-gap emphasis: summarize the major data gaps ONCE, together, near the relevant point. '
        + 'Do not repeat the same gap in every section of the overview.';
    case FinancialIntents.UNKNOWN:
    default:
      return 'Data-gap emphasis: mention only gaps that block the specific answer. Avoid a generic '
        + 'recap of every missing field.';
  }
}

/**
 * Intent-aware Risk & Opportunity focus (POLISH 3).
 *
 * The === FINANCIAL ASSESSMENT === block already contains a RISK & OPPORTUNITY
 * section (Layer 2.6). This directive tells the LLM to treat that existing
 * output as the executive-summary engine and to scope it to the question's
 * topic — WITHOUT serializing any additional data.
 */
function riskOpportunityFocus(intent: FinancialIntent): string {
  switch (intent) {
    case FinancialIntents.GENERAL_FINANCIAL_OVERVIEW:
      return 'Risk & Opportunity: use the RISK & OPPORTUNITY section as your executive summary — surface '
        + 'the top risks and top opportunities. Do not dump every assessment section.';
    case FinancialIntents.CURRENT_DEBT_STATUS:
    case FinancialIntents.DEBT_PAYOFF_PLAN:
    case FinancialIntents.DEBT_VS_INVESTING:
      return 'Risk & Opportunity: reference only DEBT-related risks and opportunities from the RISK & '
        + 'OPPORTUNITY section. Ignore unrelated items.';
    case FinancialIntents.INVESTMENT_READINESS:
      return 'Risk & Opportunity: reference investment-readiness risks (e.g. liquidity, high-APR debt '
        + 'that should be cleared first) from the RISK & OPPORTUNITY section.';
    case FinancialIntents.SPENDING_REDUCTION:
      return 'Risk & Opportunity: reference SPENDING-related opportunities (from SPENDING OPPORTUNITIES '
        + 'and the RISK & OPPORTUNITY section). Ignore unrelated risks.';
    case FinancialIntents.CASH_FLOW_EXPLANATION:
      return 'Risk & Opportunity: reference cash-flow and income-visibility risks from the RISK & '
        + 'OPPORTUNITY section.';
    case FinancialIntents.GOAL_ALIGNMENT:
      return 'Risk & Opportunity: reference goal-related risks and opportunities from the RISK & '
        + 'OPPORTUNITY section.';
    case FinancialIntents.UPDATE_KNOWLEDGE:
    case FinancialIntents.UNKNOWN:
    default:
      return 'Risk & Opportunity: draw on the RISK & OPPORTUNITY section only where it is relevant to '
        + 'the question.';
  }
}

/**
 * Serialize an IntentRoute into the QUESTION ROUTING prompt block body
 * (without the surrounding === markers — the caller adds those, matching the
 * FINANCIAL ASSESSMENT / SPACE CONTEXT block convention).
 */
export function serializeRoutingBlock(route: IntentRoute): string {
  const lines: string[] = [];

  lines.push(`Classified intent: ${route.intent} (confidence ${route.confidence.toFixed(2)} — ${confidenceBand(route)})`);
  lines.push(`Temporal frame: ${route.temporalFrame}`);
  lines.push('');
  lines.push('Section focus (these keys refer to the domains in SPACE CONTEXT below):');
  lines.push(`  PRIMARY    — most relevant; these should drive the answer: ${fmtSections(route.primarySections)}`);
  lines.push(`  SUPPORTING — may be referenced briefly for support: ${fmtSections(route.supportingSections)}`);
  lines.push(`  SUPPRESS   — present in context but must NOT drive the answer: ${fmtSections(route.suppressSections)}`);
  lines.push('');
  lines.push(confidenceGuidance(route));
  lines.push('');
  lines.push(temporalGuidance(route));

  // Dynamic transaction window (D6): when the user named a historical period,
  // the transaction summary below has been assembled for THAT period. Tell the
  // model the exact bounds so its provenance statements match the real window.
  if (route.transactionWindow && route.transactionWindow.startDate && route.transactionWindow.endDate) {
    const w = route.transactionWindow;
    lines.push('');
    lines.push(
      `Requested transaction period: ${w.label} (${w.startDate} to ${w.endDate}). `
      + 'The transaction summary in the context below was assembled for exactly this period — '
      + 'use these dates when stating the analysis window, and do not describe a different span.',
    );
  }

  lines.push('');
  lines.push(gapEmphasisGuidance(route.intent));
  lines.push('');
  lines.push(riskOpportunityFocus(route.intent));
  lines.push('');
  lines.push('This routing is guidance for focus and ordering only. The full assessment and context '
    + 'below remain authoritative; never invent data to satisfy the routing.');

  return lines.join('\n');
}
