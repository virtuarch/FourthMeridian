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
import { todayUTCISO } from '@/lib/time/clock';
import { AuditAction } from '@/lib/audit-actions';
import type { Prisma } from '@prisma/client';

import { buildFigureTable } from '../figures/table';
import { renderFigureTable, TYPED_NARRATION_INSTRUCTION } from '../render';
import { generateTypedAnswer, type TypedAnswerOutcome } from './generate';
import { resolvePlannedTurn, resolveReasoningPath } from '../plan/for-request';
import { masterMeasureContext } from '../master/dedupe';
import type { Refusal } from '../refusal';
import type { FigureTable } from '../figures/types';

export type AnswerMode = 'prose' | 'typed';

/**
 * How much prompt a typed turn gets.
 *
 * ⚠️ MEASURED BEFORE IT WAS OFFERED. The plan predicted that the ~4,250 tokens
 * of prose doctrine were suppressing the model's compliance with the typed
 * contract, and that cutting them belonged to Slice 1. Measured with them
 * removed entirely — 1,570 tokens against 11,400 on the same seven adversarial
 * cases — compliance did not improve. It also did not get worse in any way the
 * gates could see.
 *
 * So the doctrine is not a confound and it is not load-bearing under `typed`
 * either: it is 86% of a prompt saying in English what the figure table says
 * structurally. `minimal` is that finding turned into a switch.
 *
 * ⚠️ AND `full` IS STILL THE DEFAULT, because the 86% was measured on seven
 * cases and not on the 35-scenario corpus. A saving this large deserves the
 * larger measurement before it becomes what everybody gets.
 */
export type PromptShape = 'full' | 'minimal';

export function resolvePromptShape(raw: string | undefined): PromptShape {
  return String(raw ?? '').toLowerCase() === 'minimal' ? 'minimal' : 'full';
}

/**
 * The whole prompt for a typed turn, when the doctrine is not carried.
 *
 * ⚠️ THIS IS NOT A TRIMMED DOCTRINE, IT IS THE ABSENCE OF ONE. Every rule the
 * doctrine states about which figures may be used, how to hedge them and when to
 * refuse is expressed structurally by the table and enforced by the verifier;
 * restating them here would put back the second, weaker copy that drifts.
 *
 * What survives is what the types cannot say: who is speaking, to whom, and the
 * date.
 */
export function minimalPreamble(spaceName: string | undefined, todayISO: string): string {
  return [
    `You are the financial assistant for ${spaceName ? `"${spaceName}"` : 'this Space'}.`,
    "Answer the user's question directly, in plain language, in the second person.",
    'Be brief. Do not pad, do not lecture, and do not refuse a question you can',
    'partly answer.',
    `Today's date is ${todayISO}.`,
  ].join('\n');
}

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
  /** Slice 4 — turn-level withholdings, such as "nobody knows a future price". */
  turnWithheld?: readonly import('../figures/types').LicensedRefusal[];
}): Promise<TypedAnswerOutcome> {
  const { suffix, table } = buildTypedPromptSuffix({
    forecast: args.forecast, ctx: args.ctx, assessment: args.assessment,
    messages: args.history ?? args.messages, scope: args.scope,
    measures: args.measures, framing: args.framing, turnWithheld: args.turnWithheld,
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

/**
 * The whole typed path for one turn, or undefined when prose should answer.
 *
 * ⚠️ EVERY FLAG DECISION AND EVERY FAILURE PATH IS HERE RATHER THAN IN THE
 * ROUTE. The route asks one question — "is there a typed answer for this turn?"
 * — and gets a reply or nothing, which is the same shape `buildForecastSurfaces`
 * and `guardForecastAnswer` already have and for the same reason.
 *
 * ⚠️ THE PLANNER ONLY RUNS UNDER `typed`. It selects MEASURES, and a measure
 * reaches the user through the typed answer boundary; selecting them and then
 * narrating in free prose would buy the interpretation without the verification.
 *
 * ⚠️ AND THE CALLER MUST INVOKE THIS INSIDE ITS ERROR BOUNDARY. It sat ABOVE the
 * chat route's `try` until an audit found it — harmless while `AI_ANSWER_MODE`
 * is unset, because it returns immediately, and not harmless under `typed`,
 * where it makes one or two OpenAI calls and an `auditLog.create`. A throw from
 * any of them became an unhandled 500 instead of the 502 / 503 envelope the
 * client is built to distinguish between "provider is misconfigured" and
 * "provider is having a bad minute". The boundary itself needed no change; only
 * the position of this call did.
 */
export async function answerThisTurn(args: {
  answerMode:    string | undefined;
  reasoningPath: string | undefined;
  /** Slice 7 — `minimal` drops the doctrine the typed table replaces. */
  promptShape?:  string | undefined;
  systemPrompt:  string;
  messages:      ChatMessage[];
  userId:        string;
  spaceId:       string;
  /** The Space the guard row is attributed to, which master mode overrides. */
  guardSpaceId:  string;
  ctx?:          SpaceContext_AI;
  assessment?:   FinancialAssessment;
  forecast?:     AssembledForecast;
  /** True when the turn resolved PAY_DATES — dates are licensed, amounts are not. */
  payDates:      boolean;
  retrieval?:    import('@/lib/ai/retrieval-plan').RetrievalPlan;
  question:      string;
  /**
   * Slice 6 — every Space in scope, in master mode.
   *
   * ⚠️ THE DEFAULT ENTRY POINT STOPS REFUSING. `master-surfaces.ts` declined a
   * forecast whenever `spaceIds.length !== 1`, on the grounds that there was
   * "no deduplicated balance to project from". There is one: the product
   * already deduplicates account IDS three lines away, for
   * `distinctAccountCount`, and this applies the same technique to BALANCES.
   */
  masterContexts?: readonly SpaceContext_AI[];
}): Promise<TypedAnswerOutcome | undefined> {
  if (resolveAnswerMode(args.answerMode) !== 'typed') return undefined;

  // ⚠️ ONE SHARED BODY, NOT A MASTER BRANCH. PARITY-1/2/3 exist because master
  // and named-Space diverged once already, and `system-prompt.ts` records the
  // lesson: "an allowlist of capabilities is a list that is always one
  // capability out of date." So master composes a deduplicated context and then
  // takes exactly the path a named Space takes.
  let ctx = args.ctx;
  let masterRefusal: Refusal | undefined;
  if (args.masterContexts && args.masterContexts.length > 1) {
    const m = masterMeasureContext(args.masterContexts);
    if (m.ok) ctx = m.ctx;
    else masterRefusal = m.reason;
  }

  const planned = await resolvePlannedTurn({
    enabled: resolveReasoningPath(args.reasoningPath) === 'new',
    spaceId: args.spaceId, ctx, messages: args.messages,
    retrieval: args.retrieval, question: args.question,
  });

  // ⚠️ THE DOCTRINE IS DROPPED, NOT SHORTENED. See `minimalPreamble`.
  const systemPrompt = resolvePromptShape(args.promptShape) === 'minimal'
    ? minimalPreamble(ctx?.space?.name, todayUTCISO())
    : args.systemPrompt;

  return answerTyped({
    systemPrompt, messages: args.messages,
    userId: args.userId, spaceId: args.guardSpaceId,
    forecast: planned?.forecast ?? args.forecast,
    ctx, assessment: args.assessment,
    history: args.messages,
    measures: planned?.measures,
    framing: planned?.framing,
    // A deduplication that could not be done is a WITHHOLDING with a reason,
    // never a silent omission and never the number of Spaces.
    turnWithheld: masterRefusal
      ? [...(planned?.withheld ?? []), {
        subject: 'a combined figure across all your Spaces',
        code: masterRefusal.code, detail: masterRefusal.detail,
      }]
      : planned?.withheld,
    // ⚠️ THE SAME SCOPE THE PROSE PROMPT APPLIES, where `buildSpaceSystemPrompt`
    // is handed `payDates ? undefined : forecast`. A pay-date turn is answered
    // with dates; every money figure offered on one is a figure the answer is
    // forbidden to state.
    scope: args.payDates && !args.forecast ? 'PAY_DATES' : 'FULL',
  });
}
