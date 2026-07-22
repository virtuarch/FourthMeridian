/**
 * lib/ai/prompts/system-prompt.ts
 *
 * Composes the full grounded system prompt for space and master (cross-Space)
 * chat sessions. Pure functions: assembled context(s) + assessment(s) + intent
 * route in, prompt string out. All doctrine, routing, assessment, and context
 * serialization are delegated to the focused modules below — this file only
 * orders the sections and adds the header. No DB, no LLM, no computation.
 *
 * Extracted verbatim from app/api/ai/chat/route.ts (AI-ARCH).
 */

import type { SpaceContext_AI } from '@/lib/ai/types';
import type { FinancialAssessment } from '@/lib/ai/intelligence';
import type { IntentRoute } from '@/lib/ai/intent';
import { serializeRoutingBlock } from '@/lib/ai/intent';
import { displaySpaceName } from '@/lib/format';
import {
  ADVISOR_PRINCIPLES,
  RESPONSE_STYLE,
  KNOWLEDGE_GAPS_RULES,
  EXECUTIVE_SUMMARY_DOCTRINE,
  EXPLAINABILITY_DOCTRINE,
} from './doctrine';
import { analysisWindowNote } from './format';
import { serializeAssessmentBlock } from './assessment-serializer';
import { serializeContextBlock } from './context-serializer';
import type { DebtPaymentLine } from './context-serializer';

/** Returns today's date as a UTC ISO date string (YYYY-MM-DD). Computed per-request. */
function todayDateString(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Alias guidance for a single-Space session.
 * Tells the AI that informal terms like "personal", "my finances", "dashboard"
 * refer to the named space, so the user is never required to use the exact name.
 */
function buildSpaceAliasGuidance(spaceName: string): string {
  return (
    `Space alias guidance: The user may refer to this space as "${spaceName}", ` +
    'or by informal terms such as "personal", "personal space", "home", "dashboard", ' +
    '"my finances", "my money", or similar. Interpret these as references to the ' +
    'current space unless context clearly indicates otherwise.'
  );
}

export function buildSpaceSystemPrompt(
  ctx: SpaceContext_AI,
  annotations: FinancialAssessment,
  route: IntentRoute,
  debtPayments?: DebtPaymentLine[],
): string {
  return [
    'You are a skilled, direct financial advisor powered by Fourth Meridian.',
    'You advise on the space described below.',
    `Today's date: ${todayDateString()}.`,
    'Answer using ONLY the supplied financial context.',
    'Never invent accounts, balances, transactions, or any financial data.',
    'If the context is insufficient, explain what is missing and why.',
    'Do not claim to execute trades, rebalance portfolios, or modify accounts or transaction records.',
    'Saving debt metadata (APR, minimum payment, due day, statement close day) is a supported user action via the form below your message — direct users there when they want to save those values.',
    '',
    ADVISOR_PRINCIPLES,
    '',
    RESPONSE_STYLE,
    '',
    KNOWLEDGE_GAPS_RULES,
    '',
    buildSpaceAliasGuidance(displaySpaceName(ctx.space.name)),
    '',
    EXECUTIVE_SUMMARY_DOCTRINE,
    '',
    EXPLAINABILITY_DOCTRINE,
    '',
    '=== QUESTION ROUTING ===',
    serializeRoutingBlock(route),
    '=== END ROUTING ===',
    '',
    '=== FINANCIAL ASSESSMENT ===',
    serializeAssessmentBlock(annotations, analysisWindowNote(ctx)),
    '=== END ASSESSMENT ===',
    '',
    '=== SPACE CONTEXT ===',
    serializeContextBlock(ctx, debtPayments),
    '=== END CONTEXT ===',
  ].join('\n');
}

/**
 * Alias guidance for master (cross-Space) sessions.
 * Lists all space names and instructs the AI to map informal references
 * to the most likely space without requiring exact name matches.
 */
function buildMasterAliasGuidance(contexts: SpaceContext_AI[]): string {
  const names = contexts
    .map((ctx) => `"${displaySpaceName(ctx.space.name)}"`)
    .join(', ');
  return (
    `Space alias guidance: The user has access to these spaces: ${names}. ` +
    'Informal terms like "personal", "personal space", "home", "dashboard", ' +
    '"my finances", or "my money" typically refer to a personal or primary space. ' +
    'When the user\'s intent is ambiguous across spaces, use the most relevant ' +
    'space\'s data or ask which space they mean.'
  );
}

/**
 * Build the full system prompt for master (cross-Space) chat.
 * Each Space gets its own clearly delimited block to prevent cross-leakage.
 */
export function buildMasterSystemPrompt(
  contexts: SpaceContext_AI[],
  annotationsList: FinancialAssessment[],
  route: IntentRoute,
  debtPaymentsList?: DebtPaymentLine[][],
): string {
  const spaceBlocks = contexts
    .map((ctx, i) => {
      const assessment = annotationsList[i];
      return [
        `--- Space ${i + 1} of ${contexts.length} ---`,
        '=== FINANCIAL ASSESSMENT ===',
        assessment ? serializeAssessmentBlock(assessment, analysisWindowNote(ctx)) : '(no assessment available)',
        '=== END ASSESSMENT ===',
        serializeContextBlock(ctx, debtPaymentsList?.[i]),
      ].join('\n');
    })
    .join('\n\n');

  return [
    'You are a skilled, direct financial advisor powered by Fourth Meridian.',
    `You have context for ${contexts.length} space(s) the user belongs to.`,
    `Today's date: ${todayDateString()}.`,
    'Answer using ONLY the supplied financial context.',
    'Never invent accounts, balances, transactions, or any financial data.',
    'If the context is insufficient, explain what is missing and why.',
    'Do not claim to execute trades, rebalance portfolios, or modify accounts or transaction records.',
    'Saving debt metadata (APR, minimum payment, due day, statement close day) is a supported user action via the form below your message — direct users there when they want to save those values.',
    'When referencing data, attribute it to the correct space by name.',
    '',
    ADVISOR_PRINCIPLES,
    '',
    RESPONSE_STYLE,
    '',
    KNOWLEDGE_GAPS_RULES,
    '',
    buildMasterAliasGuidance(contexts),
    '',
    EXECUTIVE_SUMMARY_DOCTRINE,
    '',
    EXPLAINABILITY_DOCTRINE,
    '',
    '=== QUESTION ROUTING ===',
    serializeRoutingBlock(route),
    '=== END ROUTING ===',
    '',
    '=== SPACE CONTEXTS ===',
    spaceBlocks,
    '=== END CONTEXTS ===',
  ].join('\n');
}
