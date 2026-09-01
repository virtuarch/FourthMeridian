/**
 * lib/reasoning/answer/for-request.ts
 *
 * V26-REASONING Slice 1 — ONE CALL FOR THE CHAT ROUTE.
 *
 * Same shape, and for the same reason, as `lib/ai/forecast/for-request.ts`:
 * `route-authority.aiarch` caps the chat route at 700 lines, and the answer to
 * a boundary that pushes it over is to move the boundary, not the ceiling.
 * The route asks one question — "answer this turn under the typed boundary" —
 * and gets a reply plus an outcome to log.
 *
 * ⚠️ THE TABLE IS APPENDED TO THE EXISTING PROMPT, NOT SUBSTITUTED FOR IT. That
 * is deliberate for this slice and it is not the end state. Cutting the ~4,250
 * tokens of doctrine is Slice 7's measured job; doing it here would change two
 * variables at once and make the `prose`-versus-`typed` comparison meaningless.
 * What the block does carry is an explicit statement that it OVERRIDES anything
 * above it about how to state a figure, because the doctrine it sits under is
 * mostly a prose restatement of the same rules and the two must not compete.
 */

import type { ChatMessage } from '@/lib/ai/provider';
import type { SpaceContext_AI } from '@/lib/ai/types';
import type { FinancialAssessment } from '@/lib/ai/intelligence/annotations/types';
import type { AssembledForecast } from '@/lib/ai/forecast/assemble';
import { db } from '@/lib/db';
import { AuditAction } from '@/lib/audit-actions';
import type { Prisma } from '@prisma/client';

import { buildFigureTable } from '../figures/table';
import { renderFigureTable, TYPED_NARRATION_INSTRUCTION } from '../render';
import { generateTypedAnswer, type TypedAnswerOutcome } from './generate';
import type { FigureTable } from '../figures/types';

export type AnswerMode = 'prose' | 'typed';

/**
 * ⚠️ UNSET IS `prose`, AND THAT IS THE CORRECT DEFAULT FOR THIS ONE. A boundary
 * that has not yet been measured against the pipeline it replaces should not
 * arrive silently on. This is the opposite call from `AI_FORECAST_GUARD_MODE`,
 * where unset meant SERVING arithmetic already measured to be wrong — the two
 * flags fail in opposite directions and get opposite defaults.
 */
export function resolveAnswerMode(raw: string | undefined): AnswerMode {
  return String(raw ?? '').toLowerCase() === 'typed' ? 'typed' : 'prose';
}

const OVERRIDE_HEADER = [
  '',
  '════════════════════════════════════════════════════════════════════════',
  'THE FOLLOWING OVERRIDES EVERYTHING ABOVE ABOUT STATING FIGURES.',
  'Anything earlier in this prompt that reads as guidance on which amounts you',
  'may use, how to hedge them, or when to refuse is superseded by the tables',
  'below. Those tables are complete: an AMOUNT, RATE, PERCENTAGE or MONTH COUNT',
  'that is not in them does not exist for the purposes of this answer.',
  '',
  '⚠️ DATES AND PLAIN COUNTS ARE NOT COVERED BY THE TABLES and are not',
  'restricted by them. Pay dates, horizon endpoints, "the last 3 months", the',
  "number of accounts — say those from the context above as you always would.",
  'The tables govern money, rates, percentages and month counts, and nothing',
  'else.',
  '════════════════════════════════════════════════════════════════════════',
  '',
].join('\n');

/** The prompt suffix for a typed turn, and the table it was built from. */
export function buildTypedPromptSuffix(args: {
  forecast?:   AssembledForecast;
  ctx?:        SpaceContext_AI;
  assessment?: FinancialAssessment;
  messages?:   readonly { role: string; content: string }[];
  currency?:   string;
  /** See `buildFigureTable`. A pay-date turn licenses dates, not amounts. */
  scope?:      'FULL' | 'PAY_DATES';
  /** Slice 4 — measures resolved for this turn, under this turn's scenario. */
  measures?:   readonly import('../measure/types').Measure[];
  /** Slice 4 — every ACTIVE assumption, in the user's own words. Rule 1. */
  framing?:    readonly string[];
  /** Slice 4 — turn-level withholdings, such as "nobody knows a future price". */
  turnWithheld?: readonly import('../figures/types').LicensedRefusal[];
}): { suffix: string; table: FigureTable } {
  const table = buildFigureTable(args);
  return {
    table,
    suffix: `${OVERRIDE_HEADER}${renderFigureTable(table, args.framing ?? [])}`
      + `\n\n${TYPED_NARRATION_INSTRUCTION}\n`,
  };
}

/**
 * Answer one turn under the typed boundary.
 *
 * Failure is the caller's existing provider-error path: a throw here means the
 * model was unreachable, which is not a boundary event.
 */
export async function answerTyped(args: {
  systemPrompt: string;
  messages:     ChatMessage[];
  userId:       string;
  spaceId:      string;
  forecast?:    AssembledForecast;
  ctx?:         SpaceContext_AI;
  assessment?:  FinancialAssessment;
  history?:     readonly { role: string; content: string }[];
  model?:       string;
  /** See `buildFigureTable`. A pay-date turn licenses dates, not amounts. */
  scope?:       'FULL' | 'PAY_DATES';
  /** Slice 4 — measures resolved for this turn, under this turn's scenario. */
  measures?:    readonly import('../measure/types').Measure[];
  /** Slice 4 — every ACTIVE assumption, in the user's own words. Rule 1. */
  framing?:     readonly string[];
}): Promise<TypedAnswerOutcome> {
  const { suffix, table } = buildTypedPromptSuffix({
    forecast: args.forecast, ctx: args.ctx, assessment: args.assessment,
    messages: args.history ?? args.messages, scope: args.scope,
    measures: args.measures, framing: args.framing,
  });

  const result = await generateTypedAnswer({
    systemPrompt: `${args.systemPrompt}\n${suffix}`,
    messages: args.messages,
    table,
    model: args.model,
  });

  // ⚠️ OBSERVABLE FROM THE FIRST TURN. Finding kinds and offending renderings
  // only — no balances, no user prose. Same contract as the forecast guard's
  // own audit row, so the two rates are comparable on one query.
  if (result.outcome !== 'clean') {
    await db.auditLog.create({
      data: {
        action: AuditAction.AI_OUTPUT_VALIDATION_FLAGGED,
        userId: args.userId, spaceId: args.spaceId,
        metadata: {
          guard: 'typed-answer-boundary',
          outcome: result.outcome,
          calls: result.calls,
          figures: table.figures.length,
          withheld: table.withheld.length,
          failures: result.failures.map((f) => ({ kind: f.kind, offending: f.offending })),
        } as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    }).catch(() => undefined);
  }
  return result;
}
