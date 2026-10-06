/**
 * lib/ai/conversation/guidance.ts
 *
 * WHAT KIND OF GUIDANCE AN ANSWER IS — AND HOW LOUDLY THE PRODUCT SAYS SO.
 *
 * A Fourth Meridian answer can describe someone's money, help them think through
 * a decision, or tell them what to do with it. Those deserve different framing,
 * and only the last two can carry the weight of "this is AI-generated guidance,
 * not advice from a licensed professional". This module is the whole of that
 * boundary, in three layers that must not be mixed:
 *
 *   MEANING    — `classifyGuidance`. A model reads the exchange and says which
 *                level it reached. No keyword list, no question taxonomy: a
 *                follow-up like "and $10k?" is consequential because of what came
 *                before it, which only a reader of the exchange can know.
 *   SEMANTICS  — `GuidanceSignal` and `disclosureTier`. A closed signal of three
 *                levels and five adjacencies, and ONE table from signal to tier.
 *                The model never chooses copy and never decides to disclaim.
 *   PRESENTATION — `disclosurePlan`. Given every answer's signal in order, which
 *                answers carry the full note, which a one-line reminder, and which
 *                nothing. Deterministic, so "said once, then not again" is a
 *                property of a function rather than of a model's memory.
 *
 * ⚠️ IT DECIDES NOTHING ABOUT WHAT THE ANSWER SAYS. The classifier runs AFTER the
 * answer exists and its output never re-enters the transcript; the turn, the
 * tools and every figure are byte-for-byte what they were. A disclosure is
 * drawn beside an answer — never instead of it, never as a reason to withhold it.
 *
 * ⚠️ NOT A REGULATORY TAXONOMY. The adjacencies name subjects where the product
 * says something more specific than the standard note; they are not a legal
 * classification of the answer, and nothing here asserts what Fourth Meridian
 * legally is. See docs/systems/ai-financial-guidance-boundary.md for what counsel must
 * decide before broad launch.
 *
 * Pure except `classifyGuidance`, which takes its model call as a dependency.
 */

import type { AiGuidance, AiGuidanceAdjacency, AiGuidanceLevel } from '@/types';

/**
 * The levels, in increasing consequence.
 *
 *   UNDERSTANDING   — what is true of their money: balances, spending, runway,
 *                     what changed. Description and analysis.
 *   PLANNING        — options, trade-offs, scenarios, what-ifs, general ways to
 *                     improve, laid out for them to weigh.
 *   RECOMMENDATION  — whether or how THIS person should take a specific
 *                     consequential action with their money: move, spend, borrow,
 *                     invest, sell, withdraw or pay down — asked for or given.
 */
export const GUIDANCE_LEVELS = ['UNDERSTANDING', 'PLANNING', 'RECOMMENDATION'] as const satisfies readonly AiGuidanceLevel[];

/**
 * Subjects where the product has something specific to say. Closed, small, and
 * extended only when the product has a sentence for the new one.
 */
export const GUIDANCE_ADJACENCIES = [
  'SECURITIES', 'TAX', 'LEGAL', 'RETIREMENT_ACCOUNTS', 'LEVERAGE',
] as const satisfies readonly AiGuidanceAdjacency[];

const LEVELS = new Set<string>(GUIDANCE_LEVELS);

/**
 * Narrow an unknown value to a signal, or reject it.
 *
 * ⚠️ USED ON BOTH SIDES OF THE WIRE, like `readKnowledgeGap`: the server narrows
 * what the classifier produced, the client narrows what a response contained.
 * Unknown adjacencies are dropped rather than failing the signal — a level is
 * still worth having — and the result is de-duplicated and canonically ordered,
 * so two equal signals are equal arrays.
 */
export function readGuidance(value: unknown): AiGuidance | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.level !== 'string' || !LEVELS.has(v.level)) return null;
  const raw = Array.isArray(v.adjacencies) ? v.adjacencies : [];
  const adjacencies = GUIDANCE_ADJACENCIES.filter((a) => raw.includes(a));
  return { level: v.level as AiGuidanceLevel, adjacencies };
}

// ── Semantics ────────────────────────────────────────────────────────────────

/**
 * How much the product says beside an answer.
 *
 *   NONE        — the persistent line under the composer is enough.
 *   STANDARD    — "this is AI-generated planning guidance, not licensed advice".
 *   HEIGHTENED  — the standard note plus what is specific to the subject.
 */
export type DisclosureTier = 'NONE' | 'STANDARD' | 'HEIGHTENED';

/**
 * THE TABLE. One function, every case enumerable, exhaustively tested.
 *
 *   UNDERSTANDING, any subject          → NONE   (describing a portfolio is not advising on it)
 *   PLANNING, no adjacency              → NONE   (options and trade-offs are the product)
 *   PLANNING, with an adjacency         → STANDARD
 *   RECOMMENDATION, no adjacency        → STANDARD
 *   RECOMMENDATION, with an adjacency   → HEIGHTENED
 */
export function disclosureTier(g: AiGuidance): DisclosureTier {
  if (g.level === 'UNDERSTANDING') return 'NONE';
  const adjacent = g.adjacencies.length > 0;
  if (g.level === 'PLANNING') return adjacent ? 'STANDARD' : 'NONE';
  return adjacent ? 'HEIGHTENED' : 'STANDARD';
}

// ── Presentation plan ────────────────────────────────────────────────────────

/**
 * One answer's entry, as the surface holds it.
 *
 *   AiGuidance      — the route classified this answer.
 *   'UNCLASSIFIED'  — a real answer whose classification failed.
 *   null            — not an answer this boundary covers: a user turn, a
 *                     refusal or error sentence, a restored transcript line.
 */
export type GuidanceEntry = AiGuidance | 'UNCLASSIFIED' | null;

export interface PlannedDisclosure {
  tier: Exclude<DisclosureTier, 'NONE'>;
  /**
   * FULL — the note, with its subject-specific sentences.
   * COMPACT — a one-line reminder that this is still AI planning guidance.
   */
  form: 'FULL' | 'COMPACT';
  /** The adjacencies the note speaks to (FULL only names them). */
  adjacencies: AiGuidanceAdjacency[];
}

/**
 * Which answers carry a note, and in which form.
 *
 * ⚠️ SAID ONCE PER CONVERSATION, THEN REMINDED — NEVER SILENTLY DROPPED. The full
 * note appears the first time a conversation reaches a tier (and again for each
 * subject it has not yet spoken to). Every later answer at or above STANDARD
 * still carries the compact reminder — and so does a PLANNING answer that
 * follows one, since it is still working the same decision — so a follow-up
 * never loses the boundary because the user rephrased or the classifier read it
 * as planning. An answer that falls back to UNDERSTANDING carries nothing and
 * ends the decision, so asking what you spent last month in the middle of a debt
 * decision is not footnoted.
 *
 * ⚠️ A FAILED CLASSIFICATION INHERITS, IT DOES NOT RESET. An UNCLASSIFIED answer
 * after a consequential one carries the compact reminder of the last tier seen:
 * the cost of being wrong that way is one quiet line, and the cost of the other
 * way is exactly the silent loss this exists to prevent. With nothing to inherit
 * it carries nothing — the persistent line still stands.
 */
export function disclosurePlan(entries: readonly GuidanceEntry[]): (PlannedDisclosure | null)[] {
  const said = new Set<string>();
  let last: PlannedDisclosure | null = null;
  return entries.map((entry) => {
    if (entry === null) return null;
    if (entry === 'UNCLASSIFIED') {
      return last ? { tier: last.tier, form: 'COMPACT', adjacencies: last.adjacencies } : null;
    }
    const tier = disclosureTier(entry);
    if (tier === 'NONE') {
      // ⚠️ A DECISION IS LEFT BY CHANGING THE SUBJECT, NOT BY REPHRASING IT. Planning
      // that follows a consequential answer is still about that decision ("what
      // about $10k instead?" was labelled PLANNING in 1 of 5 live runs), so it keeps
      // the reminder; only a return to plain UNDERSTANDING leaves it.
      if (entry.level === 'PLANNING' && last) return { tier: last.tier, form: 'COMPACT', adjacencies: last.adjacencies };
      last = null; return null;
    }
    const keys = ['STANDARD', ...entry.adjacencies];
    const fresh = keys.some((k) => !said.has(k));
    keys.forEach((k) => said.add(k));
    last = { tier, form: fresh ? 'FULL' : 'COMPACT', adjacencies: entry.adjacencies };
    return last;
  });
}

// ── Meaning: the classifier ──────────────────────────────────────────────────

/**
 * The classifier's instruction.
 *
 * ⚠️ IT JUDGES THE EXCHANGE, NOT THE WORDS. "Should" is not a signal; "and the
 * other account?" can be. The prior turns are there so a follow-up is read as
 * part of the decision it continues, and the answer is there so a recommendation
 * volunteered under an innocent question is still seen.
 */
export const GUIDANCE_CLASSIFIER_INSTRUCTION = [
  'You label one exchange from a personal-finance assistant. You do not answer or rewrite it.',
  '',
  'level — the most consequential thing the latest question asks for OR the latest answer does,',
  'read in the light of the earlier turns:',
  '- UNDERSTANDING: describes their finances as they are or were (balances, spending, income,',
  '  net worth, runway, what changed, what they hold).',
  '- PLANNING: lays out options, trade-offs, scenarios or projections, or general ways to improve,',
  '  for them to weigh, without settling whether they should take a specific consequential action.',
  '- RECOMMENDATION: whether or how this person should take a specific consequential action with',
  '  their money (move, spend, borrow, invest, sell, withdraw, pay down), or which of such actions',
  '  to take; including a short follow-up that continues such a decision. A question that asks this',
  '  is RECOMMENDATION even when the answer declines, hedges or only lays out options.',
  '',
  'Then answer each subject flag on its own: true only when that subject bears on the decision',
  'or question in the latest exchange.',
].join('\n');

/**
 * One required, described boolean per subject — the model judges each subject on
 * its own rather than composing a list.
 *
 * ⚠️ MEASURED: as a free list, "Should I sell $20k of investments to pay this
 * loan?" came back LEVERAGE (the answer said "you're still levered") on Preview,
 * and TAX in 0 of 5 relabels even with TAX defined to include sales. The flags
 * are the classifier's own shape; `fromClassifierOutput` maps them onto the public
 * `AiGuidance`, which did not change.
 */
const FLAG_DESCRIPTIONS: Record<AiGuidanceAdjacency, [string, string]> = {
  SECURITIES: ['securities', 'Buying, selling or choosing securities or funds — including selling investments to raise '
    + 'cash — or a portfolio allocation. Describing what they already hold is false.'],
  TAX: ['tax', 'Taxes bear on it: something would be taxed, or the action has a tax consequence (selling '
    + 'investments, withdrawing from a retirement account) — true even when the answer never mentions tax.'],
  LEGAL: ['legal', 'A legal right, obligation or determination.'],
  RETIREMENT_ACCOUNTS: ['retirementAccounts', 'Withdrawing from, borrowing from or contributing to retirement accounts.'],
  LEVERAGE: ['leverage', 'Borrowing money in order to invest (margin, loans against investments). Having, owing or '
    + 'paying down ordinary debt is false.'],
};

/** The JSON schema the classifier answers in. `strict` makes every field required. */
export const GUIDANCE_SCHEMA = {
  name: 'guidance_signal',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['level', ...GUIDANCE_ADJACENCIES.map((a) => FLAG_DESCRIPTIONS[a][0])],
    properties: {
      level: { type: 'string', enum: [...GUIDANCE_LEVELS] },
      ...Object.fromEntries(GUIDANCE_ADJACENCIES.map((a) =>
        [FLAG_DESCRIPTIONS[a][0], { type: 'boolean', description: FLAG_DESCRIPTIONS[a][1] }])),
    },
  },
} as const;

/** The classifier's flags → the public signal. Off-shape ⇒ null, like `readGuidance`. */
export function fromClassifierOutput(raw: unknown): AiGuidance | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return readGuidance({ level: r.level,
    adjacencies: GUIDANCE_ADJACENCIES.filter((a) => r[FLAG_DESCRIPTIONS[a][0]] === true) });
}

/** How much of the exchange the classifier reads. Enough for a follow-up; never the evidence. */
export const CLASSIFIER_PRIOR_MESSAGES = 4;
export const CLASSIFIER_PRIOR_CHARS = 1_500;
export const CLASSIFIER_ANSWER_CHARS = 6_000;
/** A label, not an answer: abandoned well before the user would notice it. */
export const CLASSIFIER_TIMEOUT_MS = 15_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} …[truncated]` : s);

/**
 * The exchange as the classifier sees it. PURE.
 *
 * ⚠️ PROSE ONLY — the user's words and the assistant's answers. No orientation,
 * no tool result, no balance the user did not already read on screen. The
 * classifier needs to know what was asked and said, not what is true.
 */
export function classifierMessages(args: {
  prior: readonly { role: 'user' | 'assistant'; content: string }[];
  asked: string;
  answer: string;
}): { role: 'user'; content: string }[] {
  const prior = args.prior.slice(-CLASSIFIER_PRIOR_MESSAGES)
    .map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${clip(m.content, CLASSIFIER_PRIOR_CHARS)}`);
  const body = [
    prior.length ? `EARLIER TURNS\n${prior.join('\n\n')}` : 'EARLIER TURNS\n(none)',
    `LATEST QUESTION\n${clip(args.asked, CLASSIFIER_PRIOR_CHARS)}`,
    `LATEST ANSWER\n${clip(args.answer, CLASSIFIER_ANSWER_CHARS)}`,
  ].join('\n\n');
  return [{ role: 'user', content: body }];
}

/** The model call, injected so the contract is testable without a provider. */
export type GuidanceModelCall = (
  system: string,
  messages: { role: 'user'; content: string }[],
  schema: typeof GUIDANCE_SCHEMA,
) => Promise<unknown>;

/**
 * Label one exchange. Never throws.
 *
 * ⚠️ NULL IS A RESULT, NOT A FAILURE OF THE TURN. A provider error, a timeout or
 * an off-schema reply costs the answer its label — the surface then inherits
 * (see `disclosurePlan`) — and never the answer.
 */
export async function classifyGuidance(
  exchange: Parameters<typeof classifierMessages>[0],
  call: GuidanceModelCall,
): Promise<AiGuidance | null> {
  try {
    const raw = await call(GUIDANCE_CLASSIFIER_INSTRUCTION, classifierMessages(exchange), GUIDANCE_SCHEMA);
    return fromClassifierOutput(raw);
  } catch (err) {
    console.warn('[guidance] classification failed (non-fatal):', err instanceof Error ? err.message : err);
    return null;
  }
}
