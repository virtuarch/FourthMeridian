/**
 * lib/reasoning/answer/generate.ts
 *
 * V26-REASONING Slice 1 — THE TYPED ANSWER PATH, END TO END.
 *
 * One structured call, one identity check, at most one repair, then the
 * deterministic fallback. Exactly the sequence `assessment-guard.ts` proved
 * works, applied where the model can actually comply with it rather than to a
 * prose it has already committed to.
 *
 * ⚠️ THE FALLBACK IS NOT AN APOLOGY. When a second attempt still states an
 * unlicensed figure, the answer becomes the figures themselves, said plainly,
 * plus what is withheld and why. That is a worse answer than a good narration
 * and a much better one than a confident wrong number, and it is never empty.
 */

import { generateStructured, type ChatMessage } from '@/lib/ai/provider';
import { renderFigureTable } from '../render';
import { verifyAnswer, buildRepairInstruction } from '../verify/verify';
import { FigureKind, renderFigure, type FigureTable } from '../figures/types';
import { ANSWER_SCHEMA } from './schema';
import type { Answer, VerificationFailure } from './types';

export interface TypedAnswerOutcome {
  reply: string;
  /** `clean` · `repaired` · `fallback` · `malformed`. Logged, never shown. */
  outcome: 'clean' | 'repaired' | 'fallback' | 'malformed';
  /** What the first attempt got wrong, for the audit row. Values only. */
  failures: VerificationFailure[];
  /** How many model calls this turn cost. */
  calls: number;
}

function isAnswer(v: unknown): v is Answer {
  return !!v && typeof v === 'object'
    && typeof (v as Answer).prose === 'string'
    && Array.isArray((v as Answer).claims)
    // ⚠️ EVERY CLAIM MUST DECLARE ITS FRAME. A claim without one is not a
    // partially-valid claim to be defaulted — defaulting it would pick an
    // authority the model did not choose, which is the whole thing `frame`
    // exists to stop. A malformed answer takes the deterministic fallback.
    && (v as Answer).claims.every((c) => !!c && typeof c.fid === 'string'
      && typeof c.statedAs === 'string'
      && (c.frame === 'FACT' || c.frame === 'ASSUMPTION'));
}

export async function generateTypedAnswer(args: {
  systemPrompt: string;
  messages:     ChatMessage[];
  table:        FigureTable;
  model?:       string;
}): Promise<TypedAnswerOutcome> {
  const { systemPrompt, messages, table } = args;
  const opts = args.model ? { model: args.model } : undefined;

  let first: unknown;
  try {
    first = await generateStructured<Answer>(systemPrompt, messages, ANSWER_SCHEMA, opts);
  } catch (err) {
    // A provider-level failure is the caller's existing error path, not ours.
    throw err;
  }
  if (!isAnswer(first)) {
    return {
      reply: deterministicFallback(table),
      outcome: 'malformed',
      failures: [{ kind: 'MALFORMED', detail: 'the model did not return an Answer' }],
      calls: 1,
    };
  }

  const v1 = verifyAnswer(first, table);
  if (v1.ok) return { reply: first.prose, outcome: 'clean', failures: [], calls: 1 };

  // ⚠️ EXACTLY ONE REPAIR. Naming the offence, not re-asking the question.
  const repaired = await generateStructured<Answer>(
    `${systemPrompt}\n\n${buildRepairInstruction(v1.failures)}`, messages, ANSWER_SCHEMA, opts,
  ).catch(() => null);

  if (isAnswer(repaired)) {
    const v2 = verifyAnswer(repaired, table);
    if (v2.ok) {
      return { reply: repaired.prose, outcome: 'repaired', failures: v1.failures, calls: 2 };
    }
  }
  return {
    reply: deterministicFallback(table),
    outcome: 'fallback',
    failures: v1.failures,
    calls: repaired === null ? 1 : 2,
  };
}

/**
 * The answer when narration cannot be trusted: the licensed figures, said
 * plainly, and the withholdings with their reasons.
 *
 * ⚠️ IT STATES THE MEASURES AND NOT THE PREMISES. Quoting the user's own numbers
 * back at them in a fallback would be the one sentence most likely to read as a
 * finding, and the fallback has no narration to frame it.
 */
export function deterministicFallback(table: FigureTable): string {
  const out: string[] = [];
  const measures = table.figures.filter((f) => f.kind === FigureKind.MEASURE);
  if (measures.length > 0) {
    out.push('Here is what I can state, from the figures I have:');
    // The same rendering edge the table and the verifier use; see `renderFigure`.
    for (const f of measures) out.push(`- ${f.label}: ${renderFigure(f.value, f.unit, f.currency)}`);
  }
  if (table.withheld.length > 0) {
    out.push('');
    out.push('And what I cannot tell you, with the reason:');
    for (const w of table.withheld) out.push(`- ${w.subject} — ${w.detail}`);
  }
  if (out.length === 0) {
    out.push('I do not have enough of your data assembled to answer that reliably yet.');
  }
  return out.join('\n');
}

export { renderFigureTable };
