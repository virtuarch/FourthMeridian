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
  recallMemories, rememberStated, recordProjection, PROJECTIONS_ARE_AUTOMATIC,
  type MemoryScope, type ProjectionStatement,
} from './memory-store';
import {
  STATED_CLASSES, SHAPE_KEY, REMEMBERED, GOAL_METRICS, EXAMPLES, readMemory, stateOf, describeMemory, expectedFrom,
  admitWrite,
  type MemoryClass, type MemoryRow, type Fields,
} from './memory-model';
import { ALLOCATION_TARGET_WORDS } from './scenario-rules';

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
 * The statement a `project_cash` result makes, or null when it makes none.
 *
 * PURE — the whole decision of WHETHER a projection is a statement lives here,
 * so it is tested on fixtures of the result shape without a database.
 *
 * ⚠️ ONLY AN EVIDENCE-BASED STATEMENT IS A STATEMENT. Four refusals, one rule:
 *   • any tool but `project_cash` — a scenario ending balance is conditional on
 *     assumptions the user supplied; reconciling it later would measure whether
 *     they did what they said, not whether we were right;
 *   • a RETROSPECTIVE run — a recomputation, not a statement; checkpointing it
 *     would let the system mark its own homework;
 *   • a projection that rested on a figure the user STATED
 *     (`basis.spending.source === 'USER_STATED'`). `assumedMonthlySpending` makes
 *     `project_cash` exactly the conditional projection the first rule excludes —
 *     17 of 36 recorded checkpoints rested on a conversational $5k — and because
 *     the subject is `liquid-<horizon>`, "…what if I spend $5k?" used to REPLACE
 *     the evidence-based statement for that horizon, so a later "were you right?"
 *     graded the hypothetical;
 *   • an INTERVAL projection (`from` → a sibling `interval` block). The user was
 *     told what happens INSIDE a window; nobody stated the ending balance, and a
 *     window's change must never be recorded as one.
 *
 * ⚠️ THE WRITE IS A COPY, NOT A COMPUTATION. Every field below already exists in
 * `project_cash`'s own `basis` block. Nothing is derived, rounded or summarised
 * on the way in — a checkpoint that recomputed anything would be a second
 * authority on the same number. `basis` is a CLOSED, code-written key set.
 */
export function projectionStatement(
  toolName: string, result: unknown, asOfISO: string,
): ProjectionStatement | null {
  if (toolName !== 'project_cash') return null;
  const r = result as Record<string, unknown> | null;
  const horizonBlock = r?.horizon as { to?: string; asOf?: string } | undefined;
  const projection = r?.projection as Record<string, unknown> | null | undefined;
  if (!r || r.retrospective === true) return null;
  if ('interval' in r) return null;
  if (!projection || typeof projection.endingCash !== 'number') return null;
  const horizon = horizonBlock?.to;
  if (typeof horizon !== 'string' || !horizon) return null;

  const basis = (projection.basis ?? {}) as Record<string, unknown>;
  const spending = (basis.spending ?? {}) as Record<string, unknown>;
  if (spending.source === 'USER_STATED') return null;

  return {
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
    metric: 'liquid', horizon, value: projection.endingCash,
    basis: {
      spendingSource: spending.source ?? null,
      dailyRate: spending.dailyRate ?? null,
      monthsAveraged: spending.monthsAveraged ?? null,
      incomeEvents: basis.incomeEventsCounted ?? null,
      // Always empty now: a projection that applied a user's figure is not recorded.
      userAssumptions: [],
      openingCash: basis.openingCash ?? null,
    },
    statedAs: `Projected ${projection.endingCash} liquid (checking plus savings) for `
      + `${horizon}, stated on ${asOfISO}.`,
    statedAt: asOfISO,
  };
}

/**
 * Record what a projection SAID, silently, when `project_cash` states one.
 *
 * ⚠️ IT LIVES IN THE CONVERSATION LOOP, NOT IN THE TOOL. `tools.ts` holds no
 * Prisma client and no write op, and a test asserts it; making `project_cash`
 * write would have made that assertion a lie told by indirection. "4M writes a
 * checkpoint when it states a projection" is a property of the turn, so the turn
 * is where it happens.
 *
 * Silent by product decision, and non-fatal by design: a memory failure must
 * never take down an answer that was already correct.
 */
export async function checkpointProjection(
  ctx: { spaceId: string; asOfISO: string; spaceCtx: { userId: string } },
  toolName: string,
  result: unknown,
): Promise<{ subject: string } | null> {
  const statement = projectionStatement(toolName, result, ctx.asOfISO);
  if (!statement) return null;
  try {
    const written = await recordProjection(scopeOf(ctx), { ...statement, statedAt: ctx.asOfISO });
    return written.stored ? { subject: written.memory.subject } : null;
  } catch {
    // A memory failure must never break a turn that already answered correctly.
    return null;
  }
}


const CLASS_VALUES: readonly MemoryClass[] = [...STATED_CLASSES, 'PROJECTION'];

/**
 * A recalled row, as words plus the fields that ARE the arguments. PURE.
 *
 * ⚠️ A ROW THAT CANNOT BE READ RELIABLY RETURNS NOTHING BUT ITS DATE. Its payload
 * is the wrong part — a month count in a money field, a null date — and its
 * `statedAs` is the model's own paraphrase, which in the recorded rows had
 * already copied a coerced figure back in as "the user's words". Its owner sees
 * it in the Memory panel, with a delete; the model is only told it exists.
 */
export function presentRecall(rows: readonly MemoryRow[], todayISO: string, only?: MemoryClass) {
  const today = todayISO.slice(0, 10);
  const stated: unknown[] = []; const projectionsWeMade: unknown[] = []; const unreadable: { savedOn: string }[] = [];
  for (const row of rows) {
    const read = readMemory(row);
    if (!read.readable) {
      if (!read.tombstone && row.status === 'ACTIVE') unreadable.push({ savedOn: row.statedAt.slice(0, 10) });
      else if (read.tombstone && !only) stated.push({ subject: row.subject, state: 'RETIRED', retiredOn: row.statedAt.slice(0, 10), notedAs: row.statedAs });
      continue;
    }
    if (only && read.cls !== only) continue;
    const state = stateOf(row, read, today);
    if (read.cls === 'PROJECTION') {
      const basis = (read.fields.basis ?? {}) as Record<string, unknown>;
      projectionsWeMade.push({ subject: row.subject, metric: read.fields.metric, horizon: read.fields.horizon,
        value: read.fields.value, statedAt: row.statedAt.slice(0, 10), state,
        ...(basis.spendingSource ? { restedOn: basis.spendingSource } : {}) });
      continue;
    }
    stated.push({ subject: row.subject, class: read.cls, statedAt: row.statedAt.slice(0, 10), state,
      inWords: describeMemory(read.cls, read.fields),
      [SHAPE_KEY[read.cls]]: read.cls === 'BASELINE' ? { ...read.fields, basis: REMEMBERED } : read.fields,
      notedAs: row.statedAs });
  }
  return { stated, projectionsWeMade, unreadable };
}

const recall: ToolDefinition = {
  name: 'recall',
  description:
    'What THIS user previously asked us to remember — goals, planned purchases, standing rules ' +
    'and planning figures, as they stated them — and the projections we made and when. Call it ' +
    'when the question refers to something from an earlier session ("what strategy did I want?", ' +
    '"how are we doing?", "what did we say?"). Nothing it returns is in effect or a current ' +
    'figure: current money is always re-read from the financial tools.',
  parameters: obj({
    class: { type: 'string', enum: CLASS_VALUES,
      description: 'GOAL, PLANNED_EXPENSE, RULE (a standing allocation policy), BASELINE (a planning '
        + 'figure they gave — not measured), or PROJECTION (a statement we made, with its horizon). Omit for all.' },
    subject: str('Narrow to one subject, e.g. "cash-strategy". Omit for all.'),
    includeHistory: { type: 'boolean',
      description: 'True to see earlier versions of a subject, and what was retired.' },
  }),
  async run(a, ctx) {
    const rows = await recallMemories(scopeOf(ctx), {
      ...(a.subject ? { subject: String(a.subject) } : {}),
      ...(a.includeHistory ? { includeSuperseded: true } : {}),
      limit: 50,
    });
    const only = CLASS_VALUES.includes(a.class as MemoryClass) ? a.class as MemoryClass : undefined;
    const { stated, projectionsWeMade, unreadable } = presentRecall(rows, ctx.asOfISO, only);
    const nothing = stated.length === 0 && projectionsWeMade.length === 0;
    return {
      scope: 'this user, in this Space',
      // ⚠️ SAID WHERE THE MODEL WILL READ IT. Remembering never computes: what is
      // listed is what they SAID, on the date shown, and a projection's `value` is
      // a sentence about a future date. Quoting either as the present is the one
      // way this table can do harm.
      meaning: nothing
        ? 'Nothing has been remembered for this user yet. Say so plainly rather than guessing '
          + 'at a goal, a rule or a planning figure.'
        : 'What they asked us to remember, as stated on the dates shown. None of it is in effect and '
          + 'none of it has been applied to any number. A rule\'s fields are the arguments a scenario '
          + 'tool takes; a BASELINE is a planning figure they gave (REMEMBERED) — never their measured '
          + 'spending. Use one only by passing it as explicit tool arguments when they ask, and say it '
          + 'was remembered. A projection is what we SAID on `statedAt` about `horizon` — it is '
          + 'NOT a current balance and must never be quoted as one.',
      stated,
      projectionsWeMade,
      ...(unreadable.length ? { unreadable: { count: unreadable.length, savedOn: unreadable.map((u) => u.savedOn),
        note: 'Older notes that cannot be read reliably, so their contents are not shown. The user can see and '
          + 'delete them under Memory; restating one records it properly.' } } : {}),
    };
  },
};

const num = (description: string) => ({ type: 'number', description });
const shape = (props: Record<string, unknown>, description: string) =>
  ({ type: 'object', properties: props, additionalProperties: false, description });

/** The shape keys, in the order a refusal names them. */
const SHAPES = STATED_CLASSES.map((c) => [c, SHAPE_KEY[c]] as const);

/**
 * `remember` — record, amend or retire ONE thing the user stated.
 *
 * ⚠️ THE CLASS IS NAMED BY WHICH PROPERTY IS PRESENT, so a class and a shape
 * cannot disagree. ⚠️ THE `rule` PROPERTIES ARE ENUMERATED, NOT DESCRIBED: of 138
 * first attempts at a rule in the recorded traces, 4 used the contract's exact
 * key and the dominant wrong one was `monthsOfExpenses` — a key the model had to
 * guess because the schema said `additionalProperties: true` and named shapes in
 * prose. A key it can read is a key it does not have to invent.
 *
 * ⚠️ AND A REFUSAL HANDS BACK THE RIGHT SHAPE, NEVER A LIST OF MISSING KEYS. "an
 * INTENTION needs intent + amount + label" is the sentence that produced
 * `amount: 0`: 32 of the 45 rows stored after a refusal carried a coerced amount.
 */
const remember: ToolDefinition = {
  name: 'remember',
  description:
    'Record ONE thing this user asked you to remember, so a later session can pick it up — or change or ' +
    'withdraw one. Use it when they say to remember a goal ("I want $1M by 2030"), a planned expense ("a car ' +
    'around 20k in 2027"), a standing rule ("keep six months of expenses in cash"), or a planning figure ' +
    '("use $5k monthly spending for planning"). Give exactly one of ' +
    '`goal`, `plannedExpense`, `rule`, `baseline`. Store what they SAID: a multiple stays a multiple (six ' +
    'months is `liquidFloorMonthsOfExpenses: 6`, never the dollars it works out to), and a money value must be ' +
    'a figure they stated — never a balance, a projection or anything you read from another tool. Leave out ' +
    'every field they did not say: a floor alone is a complete rule. When they change part of something remembered, use `op: "amend"` with `set`; when ' +
    'they withdraw it, `op: "retire"`. Remembering never runs or applies anything.',
  parameters: obj({
    op: { type: 'string', enum: ['record', 'amend', 'retire'],
      description: 'record (default) = a new item, or a whole re-statement. amend = change some fields of the item '
        + 'already under `subject`, keeping the rest. retire = they no longer want it used.' },
    subject: str('A short stable key: "cash-strategy", "planning-spending", "net-worth-target", "car". '
      + 'Re-use the subject shown in memory to change or retire that item.'),
    statedAs: str('The user\'s own words for this, or a faithful one-sentence paraphrase. Required.'),
    goal: shape({
      targetMetric: { type: 'string', enum: [...GOAL_METRICS], description: 'What should reach the level.' },
      targetAmount: num('The level, in dollars, as they stated it. 0 only with `debt` (debt-free).'),
      byDate: str('YYYY-MM-DD, only if they gave a date.'),
    }, 'A level they want a measure to reach.'),
    plannedExpense: shape({
      label: str('What it is for, as a short name: "car".'),
      amount: num('Roughly how much, in dollars, as they stated it.'),
      earliest: str('YYYY-MM-DD, only if they said not before a date.'),
    }, 'A one-off outlay they intend.'),
    rule: shape({
      liquidFloorMonthsOfExpenses: num('Cash to keep, as a number of MONTHS of expenses ("six months" = 6). '
        + 'Resolved against the spending level in force whenever it is run — never stored as dollars.'),
      liquidFloor: num('Cash to keep, in DOLLARS — only when the user stated a dollar level ("keep $50k").'),
      fractionOfExcess: num('Share (0–1] of the cash ABOVE the floor moved each month-end. "The rest" = 1. '
        + 'Omit if they did not say what happens to the rest.'),
      surplusFraction: num('Share (0–1] of what each MONTH adds. Keeps no cash floor. Not with a floor.'),
      target: { description: 'Where it goes, ONLY if they said: "investments", "highest_apr", or an ordered list — '
        + '["highest_apr","investments"] pays debt first, then invests.',
        anyOf: [{ type: 'string', enum: [...ALLOCATION_TARGET_WORDS] },
          { type: 'array', items: { type: 'string', enum: [...ALLOCATION_TARGET_WORDS] } }] },
      from: str('YYYY-MM-DD the rule starts, if they said.'),
      to: str('YYYY-MM-DD the rule ends, if they said.'),
    }, 'A standing allocation policy, in the SAME fields, with the same meanings, as a scenario `contributions` item.'),
    baseline: shape({
      monthlySpending: num('A monthly spending level they asked to PLAN with, in dollars, as they stated it.'),
      annualReturnPct: num('An annual return they asked to plan with, in percent.'),
    }, 'A planning figure they gave. Exactly one. It is remembered as theirs — not measured, and not applied to anything.'),
    set: { type: 'object', additionalProperties: true,
      description: 'amend: the fields to change and their new values, e.g. {"liquidFloorMonthsOfExpenses": 9}.' },
    unset: { type: 'array', items: { type: 'string' }, description: 'amend: field names to remove.' },
    replace: { type: 'boolean',
      description: 'record over an existing item: true ONLY when the user replaced the whole thing, accepting that fields they did not repeat are dropped.' },
  }, ['subject', 'statedAs']),
  async run(a, ctx) {
    const op = a.op === 'amend' || a.op === 'retire' ? a.op : 'record';
    const given = SHAPES.filter(([, key]) => a[key] !== undefined && a[key] !== null);
    // ⚠️ A V1-SHAPED CALL IS ANSWERED WITH THE V2 SHAPE BUILT FROM ITS OWN PAYLOAD.
    if (op === 'record' && given.length !== 1) {
      return { stored: false,
        reason: a.kind === 'CHECKPOINT' ? PROJECTIONS_ARE_AUTOMATIC
          : given.length === 0
            ? 'give exactly one of `goal`, `plannedExpense`, `rule` or `baseline`, holding what the user stated. '
              + 'A standing policy such as "keep N months of expenses" is a `rule`; a planning figure is a `baseline`'
            : `one call records one thing: ${given.map(([, k]) => `\`${k}\``).join(' and ')} are separate items, each with its own subject`,
        ...(expectedFrom(a) ? { expected: expectedFrom(a) } : {}),
        example: EXAMPLES.RULE };
    }
    const [cls, key] = given[0] ?? [];
    const fields = key ? a[key] : undefined;
    // ⚠️ WITH NO CONVERSATION EVIDENCE A MONEY VALUE FAILS CLOSED — before the
    // store is reached, so a context built without the turn loop writes no money.
    if (op === 'record' && cls && !ctx.turn && fields && typeof fields === 'object') {
      const blind = admitWrite({ cls, supplied: fields as Fields, current: null, evidence: null, asOf: ctx.asOfISO });
      if (!blind.ok) return { stored: false, reason: blind.reason };
    }
    const result = await rememberStated(scopeOf(ctx), {
      op,
      ...(cls ? { cls } : {}),
      subject:  String(a.subject ?? ''),
      statedAs: String(a.statedAs ?? ''),
      ...(op === 'record' ? { fields: (fields && typeof fields === 'object' ? fields : {}) as Fields } : {}),
      ...(op === 'amend' ? { set: { ...(typeof fields === 'object' && fields ? fields as Fields : {}), ...((a.set ?? {}) as Fields) },
        unset: Array.isArray(a.unset) ? a.unset.map(String) : [] } : {}),
      ...(a.replace === true ? { replace: true } : {}),
      // The conversation's clock, so a stated date and a recorded one agree.
      statedAt: ctx.asOfISO,
    },
    // ⚠️ THE GATE RIDES ON THE TOOL PATH, WHICH IS WHERE A MODEL IS. With no
    // conversation evidence on the context, a money value fails closed.
    { evidence: ctx.turn ?? null, asOf: ctx.asOfISO });

    // `stored` stays the FIRST key of every result: `turnEvidence` recognises a
    // memory write's own echo by it, so a refusal is never evidence against its retry.
    if (!result.stored) return result;
    const { memory, superseded, ...rest } = result;
    return {
      ...rest,
      subject: memory.subject, statedAt: memory.statedAt.slice(0, 10),
      // ⚠️ A CHANGE IS WORTH A SENTENCE, NOT A CEREMONY. The user changed their
      // mind and should hear that it landed — and what was kept.
      note: result.unchanged
        ? 'Already remembered, exactly so. Nothing was written.'
        : op === 'retire'
        ? 'Retired: it will no longer be listed or used. The history is kept; the user can erase it under Memory.'
        : superseded
          ? `This replaces what was remembered before ("${superseded.statedAs}"). The earlier version is kept in the history.`
          : 'Remembered. Nothing was run or applied. Mention it in one clause at most — this is bookkeeping, not the answer.',
    };
  },
};

/** The write exception, named. Everything else in the harness is read-only. */
export const MEMORY_TOOLS: readonly ToolDefinition[] = [recall, remember];
/** The single tool permitted to write, asserted by name in the read-only test. */
export const WRITE_TOOL_NAME = 'remember';
