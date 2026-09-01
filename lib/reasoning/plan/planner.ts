/**
 * lib/reasoning/plan/planner.ts
 *
 * V26-REASONING Slice 5 — ONE STRUCTURED MODEL CALL, AND NO FIGURES CROSS IT.
 *
 * ⚠️ THE MEASURE CATALOGUE IS THE SAME EVERY TURN AND IS THEREFORE CACHEABLE.
 * ~800 tokens of ids and one-line descriptions, byte-identical between requests,
 * which is exactly the stable prefix Slice 7 wants and nothing in this pipeline
 * currently has. The variable part is the question and the conversation's state.
 *
 * ⚠️ AND IT FAILS OPEN, NOT CLOSED. A planner that throws returns null and the
 * caller falls back to the legacy routing, which is the whole point of a
 * strangler: the new path may be absent and the product still works. A planner
 * that could break an answer would be a worse trade than the sediment it
 * replaces.
 */

import { generateStructured } from '@/lib/ai/provider';
import { MeasureId, MEASURE_LABEL, type MeasureIdName } from '../measure/types';
import { DeltaStatus, type ConversationState } from '../scenario/types';
import { StateOp, BASE_PLANNED, type ReasoningPlan } from './types';

/**
 * What can be measured, in one line each.
 *
 * ⚠️ DESCRIPTIONS THE MODEL CAN CHOOSE BETWEEN, not labels it has to guess at.
 * The difference between `liquid_cash` and `net_worth` is obvious to us and is
 * the single most common wrong plan otherwise: "how much will I have" means
 * cash, "what am I worth" means net worth, and the two answers differ by
 * $23,000 on the fixture Space.
 */
const CATALOGUE: Record<MeasureIdName, string> = {
  liquid_cash:              'cash in checking and savings — "how much will I have", "what\'s left"',
  investments_value:        'traditional brokerage and retirement holdings',
  digital_assets_value:     'crypto — Bitcoin, ETH, and other wallet holdings',
  real_assets_value:        'property, vehicles and other non-financial assets',
  debt_balance:             'what is owed across cards and loans',
  net_worth:                'everything owned minus everything owed — "what am I worth"',
  monthly_spending:         'the level of spending per month',
  monthly_income:           'the level of income per month',
  monthly_net:              'income minus spending, per month',
  runway_months:            'how many months the cash would cover spending for',
  savings_rate:             'the share of income not spent',
  concentration_top_weight: 'how much of the portfolio sits in its largest holding',
};

export const MEASURE_CATALOGUE = Object.entries(CATALOGUE)
  .map(([id, desc]) => `  ${id.padEnd(26)} ${desc}`)
  .join('\n');

const SYSTEM = `
You interpret a person's question about their money and decide WHAT TO MEASURE.

You never see any of their figures and you never produce one. Your entire job is
to choose measures, dates and scenarios; the arithmetic is done by code you do
not call, and a person you cannot mislead reads the result.

=== MEASURES YOU MAY ASK FOR ===
${MEASURE_CATALOGUE}

=== WHAT TO DECIDE ===

measures   Which of the above the question is about. Usually one. Choose SEVERAL
           only when the question genuinely spans them — "how am I doing?" is
           every measure at once, and answering it with one is why that question
           has always been answered badly.

at         [{"kind":"NOW"}] for a question about today.
           [{"kind":"NOW"},{"kind":"DATE","iso":"YYYY-MM-DD"}] for a question
           about a future date — the present is always worth having beside it.

horizon    The future date the question names, and the words it named it in.
           null when the question names no period. DO NOT INVENT ONE: a question
           with no period gets a disclosed default further down the pipeline, and
           a date you guessed would be indistinguishable from one they chose.

scenarios  BASE is always present. Add one per assumption in force, referencing
           the delta ids you are given — NEVER a value of your own.

stateOps   SET_ASSUMPTION   the question states a new assumption
           DISMISS_ALL      "what's realistic though?", "forget that", "never mind"
           INHERIT_LAST     a follow-up with no subject of its own ("and February?")
           CLEAR_HORIZON    the question moves back to no period at all

breadth    NARROW  one thing was asked about
           BROAD   "how am I doing", "what should I worry about", "anything odd?"

reading    One short line saying what you understood. For humans, never shown to
           the user.

=== THE ONE RULE ===

Choose what is ASKED, not what is answerable. If somebody asks what Bitcoin will
be worth, ask for digital_assets_value at that date — the layer below knows that
nobody can predict a price and will say so honestly. Narrowing the question here
to something easier to answer is how a person ends up with a confident reply to a
question they did not ask.
`.trim();

const PLAN_SCHEMA = {
  name: 'reasoning_plan',
  schema: {
    type: 'object',
    properties: {
      measures: { type: 'array', items: { type: 'string', enum: Object.keys(CATALOGUE) } },
      at: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['NOW', 'DATE'] },
            iso: { type: ['string', 'null'], description: 'YYYY-MM-DD when kind is DATE' },
          },
          required: ['kind', 'iso'],
          additionalProperties: false,
        },
      },
      horizon: {
        type: ['object', 'null'],
        properties: {
          iso: { type: 'string' },
          statedAs: { type: 'string', description: "the user's own words for the period" },
        },
        required: ['iso', 'statedAs'],
        additionalProperties: false,
      },
      scenarios: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            deltaIds: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'label', 'deltaIds'],
          additionalProperties: false,
        },
      },
      stateOps: {
        type: 'array',
        items: { type: 'string', enum: Object.values(StateOp) },
      },
      breadth: { type: 'string', enum: ['NARROW', 'BROAD'] },
      reading: { type: 'string' },
    },
    required: ['measures', 'at', 'horizon', 'scenarios', 'stateOps', 'breadth', 'reading'],
    additionalProperties: false,
  },
} as const satisfies { name: string; schema: Record<string, unknown> };

/** The conversation's state, described without a single figure. */
function describeState(state: ConversationState, todayISO: string): string {
  const lines = [`Today is ${todayISO}.`];
  if (state.horizon) {
    lines.push(`A period is already in force: ${state.horizon.iso} `
      + `(the user said "${state.horizon.statedAs}" at turn ${state.horizon.statedAtTurn + 1}).`);
  } else {
    lines.push('No period is in force.');
  }
  const active = state.deltas.filter((d) => d.status === DeltaStatus.ACTIVE);
  if (active.length === 0) lines.push('No assumptions are in force.');
  else {
    lines.push('Assumptions in force:');
    // ⚠️ THE DELTA'S ID AND DIMENSION, AND ITS OWN WORDS — NOT ITS VALUE. The
    // planner references a delta; it never learns what number it carries, so it
    // cannot arrive at one by arithmetic on the way past.
    for (const d of active) {
      lines.push(`  ${d.id}  ${d.dimension}  the user said: "${d.statedAs}"`);
    }
  }
  if (state.lastAnswer) {
    lines.push(`The previous answer was about: ${state.lastAnswer.measureIds.join(', ')}`
      + `${state.lastAnswer.horizonISO ? ` at ${state.lastAnswer.horizonISO}` : ''}.`);
  }
  return lines.join('\n');
}

export interface PlannerArgs {
  question: string;
  state:    ConversationState;
  todayISO: string;
  model?:   string;
}

/**
 * Plan one turn, or null.
 *
 * ⚠️ NULL IS A REAL ANSWER AND THE CALLER MUST HANDLE IT. A provider failure, a
 * malformed plan, or a plan naming a measure that does not exist all return
 * null, and the caller falls back to the legacy routing. This is the strangler's
 * safety property: the new path may be absent and the product still works.
 */
export async function planTurn(args: PlannerArgs): Promise<ReasoningPlan | null> {
  const user = [
    describeState(args.state, args.todayISO),
    '',
    `THE QUESTION: ${args.question}`,
  ].join('\n');

  let raw: unknown;
  try {
    raw = await generateStructured<ReasoningPlan>(
      SYSTEM, [{ role: 'user', content: user }], PLAN_SCHEMA,
      // ⚠️ TEMPERATURE 0. Interpretation is not a place for variety; the same
      // question twice must select the same measures, or a comparison against
      // legacy routing is measuring sampling noise.
      { model: args.model, temperature: 0, maxTokens: 400 },
    );
  } catch {
    return null;
  }
  return normalise(raw);
}

/**
 * A plan the rest of the pipeline can trust, or null.
 *
 * ⚠️ VALIDATED, NOT COERCED WHERE COERCING WOULD INVENT. An unknown measure id
 * is dropped; a DATE with no iso is dropped; but a plan left with no measures at
 * all becomes null rather than being given a default, because a default here is
 * this module answering a question it did not understand.
 */
export function normalise(raw: unknown): ReasoningPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<ReasoningPlan>;
  const known = new Set<string>(Object.values(MeasureId));

  const measures = (Array.isArray(p.measures) ? p.measures : [])
    .filter((m): m is MeasureIdName => typeof m === 'string' && known.has(m));
  if (measures.length === 0) return null;

  const at = (Array.isArray(p.at) ? p.at : [])
    .filter((i) => i && typeof i === 'object')
    .map((i) => (i.kind === 'DATE' && typeof i.iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(i.iso)
      ? { kind: 'DATE' as const, iso: i.iso }
      : { kind: 'NOW' as const }));
  const instants = at.length > 0 ? at : [{ kind: 'NOW' as const }];

  const horizon = p.horizon && typeof p.horizon === 'object'
    && typeof p.horizon.iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.horizon.iso)
    ? { iso: p.horizon.iso, statedAs: String(p.horizon.statedAs ?? p.horizon.iso) }
    : null;

  const scenarios = (Array.isArray(p.scenarios) ? p.scenarios : [])
    .filter((s) => s && typeof s.id === 'string' && s.id !== 'BASE')
    .map((s) => ({
      id: String(s.id), label: String(s.label ?? s.id),
      deltaIds: (Array.isArray(s.deltaIds) ? s.deltaIds : []).map(String),
    }));

  const ops = new Set(Object.values(StateOp) as string[]);
  const stateOps = (Array.isArray(p.stateOps) ? p.stateOps : [])
    .filter((o): o is typeof StateOp[keyof typeof StateOp] => typeof o === 'string' && ops.has(o));

  return {
    measures: [...new Set(measures)],
    at: instants,
    horizon,
    scenarios: [BASE_PLANNED, ...scenarios],
    stateOps,
    breadth: p.breadth === 'BROAD' ? 'BROAD' : 'NARROW',
    reading: typeof p.reading === 'string' ? p.reading.slice(0, 200) : '',
  };
}

/** The label a measure is described by, for a comparison report. */
export const measureLabel = (id: MeasureIdName) => MEASURE_LABEL[id];
