/**
 * scripts/ai-baseline/probes.ts
 *
 * TEN DISCRIMINATING CONVERSATIONS, drawn from the goldens.
 *
 * ⚠️ EACH PROBE IS ONE CONVERSATION, NOT TEN QUESTIONS. Turns are replayed in
 * order against a growing transcript, because continuity is a large part of what
 * is being tested — "February?" only means anything after "assume I spend 6k".
 *
 * ⚠️ THE GOLDENS' ANSWERS ARE NOT IN HERE, and must never be. `docs/plans/
 * AI-CONVERSATION-GOLDENS.md` evaluates behaviour; leaking its wording into the
 * prompt would test whether a model can copy rather than whether it can reason.
 * `whatItDiscriminates` is a note for the human reader of the transcript — it is
 * never sent to the model, and a test pins that.
 *
 * Selection rationale: every probe distinguishes an ARCHITECTURE choice, not a
 * capability. A question both a good and a bad design answer identically tells us
 * nothing and is not here.
 */

export interface Probe {
  id:    string;
  title: string;
  /** User turns, in order. Messy on purpose — this is how Chris types. */
  turns: string[];
  /** For the human reading the transcript. NEVER sent to the model. */
  whatItDiscriminates: string;
  /** The goldens this is drawn from, for cross-reading. */
  goldens: string;
}

export const PROBES: readonly Probe[] = [
  {
    id: 'broad',
    title: 'Broad assessment → why → correction',
    turns: [
      'How am I looking financially?',
      'why was august so high',
      'yeah that was a trip',
    ],
    whatItDiscriminates:
      'Does the model PRIORITISE without a rules engine? $25.46 of liabilities and two ' +
      'missing APRs are present in every arm. A0 has only the facts; A1 additionally has ' +
      'four assessment risks, three of them APR-derived. Whether the third turn actually ' +
      'moves a downstream number is the correction test.',
    goldens: '1',
  },
  {
    id: 'projection',
    title: 'Projection with a carried, edited assumption stack',
    turns: [
      'how much money will i have by november',
      'break it down for me',
      "that's cash right?",
      'what would net worth be',
      'nah assume i spend like 6 grand a month',
      'February?',
      'what if bitcoin does 10% too',
      "okay what's actually realistic though",
    ],
    whatItDiscriminates:
      'THE STATE PROBE, and the most important one. Eight turns with no explicit state ' +
      'machine: does the $6k assumption survive a horizon change, does the bitcoin ' +
      'assumption stack on top, and does "realistic" drop the USER\'S suppositions while ' +
      'keeping the evidence? Turn 2 is the reset\'s founding failure — "break it down" ' +
      'must explain THAT figure, not dump every measure.',
    goldens: '2, 19',
  },
  {
    id: 'cadence',
    title: 'Payroll cadence vs a pay cut',
    turns: [
      'did my income go down',
      "what's my normal monthly income then",
      'how many checks am i getting in october',
    ],
    whatItDiscriminates:
      'July had three biweekly paychecks ($15,860), August two ($10,554) — a −33% month ' +
      'over month that the deterministic assessment reports as income FALLING and ' +
      'trajectory WORSENING. A0/A1 must INFER the cadence from occurrence counts and ' +
      'typical amounts; A2/A3 can call get_income and read it. The cleanest test of ' +
      'model-reasoning versus wired evidence.',
    goldens: '4, 15',
  },
  {
    id: 'debt',
    title: 'Debt materiality, then the same field at scale',
    turns: [
      "how's my debt",
      'should i pay it off',
      'what if i was carrying 25k on it',
    ],
    whatItDiscriminates:
      'THE A0-vs-A1 DIAGNOSTIC. Same missing APR, two magnitudes. A0 sees ' +
      'totalLiabilities 25.46 and apr null; A1 additionally sees APR_MISSING_FOR_DEBT, ' +
      'DEBT_PAYOFF_BLOCKED_BY_DATA, a blocked capital-allocation recommendation, an ' +
      'IMPROVE_DATA_QUALITY opportunity and an ungraded debt section. Turn 3 checks the ' +
      'judgment is about the BALANCE, not the field.',
    goldens: '5',
  },
  {
    id: 'investments',
    title: 'Investment composition vs a within-subset statistic',
    turns: [
      'what am i invested in',
      'am i too heavy in bitcoin',
      'what if the market gets smoked',
    ],
    whatItDiscriminates:
      'THE SCOPE DIAGNOSTIC, against the corrected evidence. The composition is ~79% ' +
      'digital assets; the position detail can price 4 of 13 positions and reports a ' +
      '~75% concentration over $11.62 with its population attached. A correct answer ' +
      'leads with the composition and, if it mentions the narrow statistic at all, ' +
      'qualifies it. Restating it as portfolio concentration is a visible failure.',
    goldens: '8',
  },
  {
    id: 'affordability',
    title: 'Affordability across several facts',
    turns: [
      'can i afford a 7k trip',
      'what if i put 3k of it on the card',
      'would that mess up getting to 25k by november',
    ],
    whatItDiscriminates:
      'No single number answers this. Requires cash, near-term income, observed ' +
      'spending, card behaviour and — on turn 3 — a target the user set in the same ' +
      'conversation. Tests judgment composed from facts rather than a metric lookup.',
    goldens: '6',
  },
  {
    id: 'networth',
    title: 'A wrong premise about net worth, then a narrower period',
    turns: [
      'why did my net worth drop',
      'no i mean earlier in the summer',
      'what drove that',
    ],
    whatItDiscriminates:
      'Net worth is UP ~30% over the month. Does the model correct the premise rather ' +
      'than inventing a drop or arguing? Then: A0/A1 have 90 daily points in context; ' +
      'A2/A3 can call explain_net_worth_change against lib/history, which no AI has ever ' +
      'used. Component attribution versus reading a series.',
    goldens: '7',
  },
  {
    id: 'spending',
    title: 'Progressive depth: glance → explain → deep dive',
    turns: [
      'where did all my money go',
      "what's the other category",
      'show me exactly',
    ],
    whatItDiscriminates:
      'Depth must be driven by the user, not volunteered. Turn 1 should be a short ' +
      'shape-of-it answer; turn 3 should reach transaction level. A0/A1 have a 25-row ' +
      'merchant rollup and no rows; A2/A3 can call get_transactions. Tests whether the ' +
      'lack of raw rows in broad context actually bites.',
    goldens: '3, 18',
  },
  {
    id: 'strategy',
    title: 'Grounded judgment',
    turns: [
      'what would you do',
      'am i keeping too much cash',
      'so where should the next paycheck go',
    ],
    whatItDiscriminates:
      'Does the model form a judgment and rank it, or list metrics and hedge? Also the ' +
      'clearest place to see whether A1\'s assessment priorities (LIQUIDITY warning, ' +
      'CASH_FLOW deficit "driven by debt payments") lead it somewhere A0 does not go.',
    goldens: '9, 13',
  },
  {
    id: 'format',
    title: 'Format instructions are format instructions',
    turns: [
      'how am i looking',
      'break it down',
      "layman's terms",
      'lose the bullet points..just talk to me regular',
    ],
    whatItDiscriminates:
      'Every turn after the first is a CONVERSATIONAL instruction, not a new financial ' +
      'question. In the dogfood session that killed the last architecture, turn 3 ' +
      'returned the same dump and turn 4 returned a 502. Tests whether structured ' +
      'evidence pulls a model toward bullets and whether it can simply be asked to stop.',
    goldens: '11, 16',
  },
] as const;

export const PROBE_IDS = PROBES.map((p) => p.id);

export function findProbe(id: string): Probe | undefined {
  return PROBES.find((p) => p.id === id);
}
