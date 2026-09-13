/**
 * lib/ai/conversation/memory-tools.ts
 *
 * THE TWO MEMORY TOOLS — and the harness's only write verb.
 *
 * ⚠️ THEY LIVE APART FROM `tools.ts` ON PURPOSE, and not to slip past its
 * read-only scan. That scan asserts `tools.ts` imports no Prisma client and
 * contains no write op; it now has a sibling that asserts THIS file may reach
 * `db.spaceMemory` and nothing else. Splitting the files is what lets both
 * assertions be exact instead of one of them being loosened into uselessness.
 *
 * ⚠️ NO MEMORY IS INJECTED INTO ANY PROMPT. Retrieval is model-driven, exactly
 * like every other tool — A2 and A3 already showed a model with no pre-loaded
 * evidence picks the right tool from a natural question, and "how are we doing?"
 * is not a harder retrieval problem than "what was my biggest purchase in
 * August". Whether the model reaches for `recall` unprompted is a measurement,
 * not something to pre-empt with an always-on summary line.
 */

import type { ToolDefinition } from './tools';
import {
  recallMemories, rememberMemory, MemoryKind,
  type MemoryPayload, type MemoryScope,
} from './memory-store';

const obj = (props: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (description: string) => ({ type: 'string', description });

/**
 * The scope every memory call runs under.
 *
 * ⚠️ THE OWNER IS THE AUTHENTICATED USER AND THE MODEL CANNOT NAME ONE. There is
 * no `userId` argument on either schema, so no prompt, no question and no
 * confusion can address another member's memories. In a shared Space that is the
 * difference between a household ledger and reading somebody's diary.
 */
const scopeOf = (ctx: { spaceId: string; spaceCtx: { userId: string } }): MemoryScope =>
  ({ spaceId: ctx.spaceId, ownerUserId: ctx.spaceCtx.userId });

// ── Slice 7: the automatic checkpoint ────────────────────────────────────────

/**
 * Record what a projection SAID, silently, when `project_cash` states one.
 *
 * ⚠️ THE WRITE IS A COPY, NOT A COMPUTATION. Every field below already exists in
 * `project_cash`'s own `basis` block. Nothing is derived, rounded or summarised
 * on the way in — a checkpoint that recomputed anything would be a second
 * authority on the same number.
 *
 * ⚠️ IT LIVES IN THE CONVERSATION LOOP, NOT IN THE TOOL. `tools.ts` holds no
 * Prisma client and no write op, and a test asserts it; making `project_cash`
 * write would have made that assertion a lie told by indirection. "4M writes a
 * checkpoint when it states a projection" is a property of the turn, so the turn
 * is where it happens.
 *
 * ⚠️ ONLY THE DETERMINISTIC PROJECTION IS CHECKPOINTED. A `scenario_projection`
 * ending balance is conditional on assumptions the user supplied; reconciling it
 * against reality later would measure whether they did what they said, not
 * whether we were right. And a RETROSPECTIVE run is a recomputation, not a
 * statement — checkpointing it would let the system mark its own homework.
 *
 * Silent by product decision, and non-fatal by design: a memory failure must
 * never take down an answer that was already correct.
 */
export async function checkpointProjection(
  ctx: { spaceId: string; asOfISO: string; spaceCtx: { userId: string } },
  toolName: string,
  result: unknown,
): Promise<{ subject: string } | null> {
  if (toolName !== 'project_cash') return null;
  const r = result as Record<string, unknown> | null;
  const horizonBlock = r?.horizon as { to?: string; asOf?: string } | undefined;
  const projection = r?.projection as Record<string, unknown> | null | undefined;
  if (!r || r.retrospective === true) return null;
  if (!projection || typeof projection.endingCash !== 'number') return null;
  const horizon = horizonBlock?.to;
  if (typeof horizon !== 'string' || !horizon) return null;

  const basis = (projection.basis ?? {}) as Record<string, unknown>;
  const spending = (basis.spending ?? {}) as Record<string, unknown>;

  try {
    const written = await rememberMemory(scopeOf(ctx), {
      kind: MemoryKind.CHECKPOINT,
      // ⚠️ THE SUBJECT IS METRIC + HORIZON, WHICH MAKES REPETITION SELF-LIMITING.
      // Ten calls about the same year end leave ONE active statement and nine in
      // the chain, rather than ten rows competing to be the thing we said.
      //
      // ⚠️ AND THE METRIC IS `liquid`, NOT `cash`. `project_cash` returns
      // checking PLUS savings; the exploration tree's `cash` lens is checking
      // alone. A tool result carrying the loose name is read beside its own
      // description — a STORED row is read months later with neither, so it gets
      // the precise name. Slice 1's source scan caught this draft too.
      subject: `liquid-${horizon}`,
      payload: {
        metric: 'liquid', horizon, value: projection.endingCash,
        basis: {
          spendingSource: spending.source ?? null,
          dailyRate: spending.dailyRate ?? null,
          monthsAveraged: spending.monthsAveraged ?? null,
          incomeEvents: basis.incomeEventsCounted ?? null,
          userAssumptions: (r.appliedUserFacts as unknown[]) ?? [],
          openingCash: basis.openingCash ?? null,
        },
      },
      statedAs: `Projected ${projection.endingCash} liquid (checking plus savings) for `
        + `${horizon}, stated on ${ctx.asOfISO}.`,
      statedAt: ctx.asOfISO,
    });
    return written.stored ? { subject: written.memory.subject } : null;
  } catch {
    // A memory failure must never break a turn that already answered correctly.
    return null;
  }
}

const KIND_VALUES = Object.values(MemoryKind);

const recall: ToolDefinition = {
  name: 'recall',
  description:
    'What THIS user previously decided, assumed, or was told — goals, planned purchases, ' +
    'stated assumptions, and projections we made and when. Call it when the question ' +
    'refers to something from an earlier session ("how are we doing?", "am I on track?", ' +
    '"what did we say?"). It never returns balances: current money is always re-read from ' +
    'the financial tools.',
  parameters: obj({
    kind: { type: 'string', enum: KIND_VALUES,
      description: 'INTENTION = what they decided. ASSUMPTION = a premise they stated. '
        + 'CHECKPOINT = a projection we made, with its horizon and basis. Omit for all.' },
    subject: str('Narrow to one subject, e.g. "net-worth-target". Omit for all.'),
    includeSuperseded: { type: 'boolean',
      description: 'True to see the history of a subject, including what it replaced.' },
  }),
  async run(a, ctx) {
    const memories = await recallMemories(scopeOf(ctx), {
      ...(a.kind ? { kind: a.kind as MemoryKind } : {}),
      ...(a.subject ? { subject: String(a.subject) } : {}),
      ...(a.includeSuperseded ? { includeSuperseded: true } : {}),
    });
    return {
      scope: 'this user, in this Space',
      count: memories.length,
      memories,
      // ⚠️ SAID WHERE THE MODEL WILL READ IT. A checkpoint's `value` is a
      // sentence about a future date, spoken on `statedAt`. Quoting it as a
      // present balance is the one way this table can do harm.
      meaning: memories.length === 0
        ? 'Nothing has been recorded for this user yet. Say so plainly rather than guessing '
          + 'at a goal.'
        : 'A CHECKPOINT is what we SAID on `statedAt` about `horizon` — it is NOT a current '
          + 'balance and must never be quoted as one. For what the user has now, call the '
          + 'financial tools; then compare.',
    };
  },
};

const remember: ToolDefinition = {
  name: 'remember',
  description:
    'Record ONE thing this user decided, assumed, or that we projected, so a later session ' +
    'can pick it up. Use it when they state a goal ("I want $1M by 2030"), a plan ("a car ' +
    'around 20k in 2027"), or when they change one. A later memory on the same subject ' +
    'supersedes the earlier one and the history is kept. It stores intentions and dated ' +
    'statements ONLY — never a balance, a holding or anything you read from another tool.',
  parameters: obj({
    kind: { type: 'string', enum: KIND_VALUES,
      description: 'INTENTION for a decision or goal. CHECKPOINT for a projection we stated '
        + '(needs metric, horizon and value). ASSUMPTION only when it belongs to an '
        + 'intention or checkpoint that already exists on the same subject.' },
    subject: str('A short stable key for what this is about: "net-worth-target", '
      + '"summer-2027-spending", "car". Re-use it to update the same thing.'),
    payload: { type: 'object', additionalProperties: true,
      description: 'INTENTION: {targetMetric, targetAmount, byDate} or {intent, amount, '
        + 'label, earliest}. ASSUMPTION: {monthlySpending} or {annualReturnPct, appliesTo}. '
        + 'CHECKPOINT: {metric, horizon, value, basis}. No other keys are accepted.' },
    statedAs: str('The user\'s own words, or the sentence you stated. Required.'),
    appliesFrom: str('YYYY-MM-DD, when this starts to apply. Optional.'),
    appliesTo:   str('YYYY-MM-DD, when it stops. Optional.'),
  }, ['kind', 'subject', 'payload', 'statedAs']),
  async run(a, ctx) {
    const kind = String(a.kind) as MemoryKind;
    if (!KIND_VALUES.includes(kind)) {
      return { stored: false, reason: `unknown kind "${a.kind}"`, kinds: KIND_VALUES };
    }
    const result = await rememberMemory(scopeOf(ctx), {
      kind,
      subject:  String(a.subject ?? ''),
      payload:  (a.payload ?? {}) as MemoryPayload,
      statedAs: String(a.statedAs ?? ''),
      // The conversation's clock, so a stated date and a recorded one agree.
      statedAt: ctx.asOfISO,
      ...(a.appliesFrom ? { appliesFrom: String(a.appliesFrom) } : {}),
      ...(a.appliesTo   ? { appliesTo:   String(a.appliesTo)   } : {}),
    });
    if (!result.stored) return result;
    return {
      ...result,
      // ⚠️ A SUPERSESSION IS WORTH A SENTENCE, NOT A CEREMONY. The user changed
      // their mind and should hear that it landed; the previous statement is
      // kept and still retrievable.
      note: result.superseded
        ? `This replaces what was recorded before: "${result.superseded.statedAs}". The `
          + 'earlier one is kept and can be retrieved with includeSuperseded.'
        : 'Recorded. Mention it in one clause at most — this is bookkeeping, not the answer.',
    };
  },
};

/** The write exception, named. Everything else in the harness is read-only. */
export const MEMORY_TOOLS: readonly ToolDefinition[] = [recall, remember];
/** The single tool permitted to write, asserted by name in the read-only test. */
export const WRITE_TOOL_NAME = 'remember';
