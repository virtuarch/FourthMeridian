/**
 * lib/ai/retrieval-plan.ts
 *
 * CF-8 — ONE OBJECT ANSWERING "WHAT EVIDENCE SHOULD THIS QUESTION NEED?"
 *
 * SHADOW ONLY. Nothing here changes what is assembled, what is serialized, or
 * what the model sees. The plan is computed, logged, and compared against what
 * production actually loaded; the difference is the deliverable.
 *
 * ── Why it exists ───────────────────────────────────────────────────────────
 * Every input already exists as its own deterministic authority, and they are
 * consulted at four different points in the request with no single object
 * describing the decision:
 *
 *   CF-2/3/4  requested and selected temporal scope, and its provenance
 *   CF-5      what evidence exists and is visible
 *   CF-6      which domains the manifest and the question reach
 *   CF-7      which economic concept the question invokes, and how broadly
 *
 * This composes them. It parses nothing itself, censuses nothing itself, and
 * resolves no visibility of its own — a second copy of any of those is a second
 * thing that can disagree.
 *
 * ── Position in the pipeline ────────────────────────────────────────────────
 * BEFORE assembly, deliberately. The previous shadow planner
 * (lib/ai/context-priority) ran AFTER every domain had been fetched and folded,
 * so it could only ever propose dropping serialized text — it saved no
 * retrieval work and could not widen anything. That is the structural mistake
 * this replaces, and it is why the position matters more than the scoring.
 *
 * ── The two dependency questions, kept apart ────────────────────────────────
 * A domain can be needed to COMPUTE the deterministic assessment while its raw
 * payload is not needed in the MODEL's context. `computeAssessment` reads all
 * three baseline domains — but only a handful of scalars from each. So
 * "the question does not need this domain" NEVER implies "do not assemble it";
 * it implies "do not necessarily serialize it". Every plan carries both
 * answers, because conflating them is the way a future enforcement slice breaks
 * the assessment.
 */

import { FinanceDomains, type ContextDomain } from '@/lib/ai/types';
import type { CoverageEnvelope } from '@/lib/ai/coverage-envelope';
import { EvidenceAvailability } from '@/lib/ai/coverage-envelope';
import {
  resolveConversationScope, type ScopeMessage, type ScopeTransition,
} from '@/lib/ai/chat/conversation-scope';
import {
  resolveConceptBreadth, ConceptBreadth, type ConceptBreadthKind,
} from '@/lib/ai/economic-concepts';

/** What the question is economically about. */
export const Concepts = {
  /** Money going out — spend, merchants, categories, purchases. */
  SPENDING:    'SPENDING',
  /** Money coming in. */
  INCOME:      'INCOME',
  /** What is owed. */
  DEBT:        'DEBT',
  /** Investments — see CF-7 for its component composition. */
  INVESTMENTS: 'INVESTMENTS',
  /** Position and totals across everything. */
  NET_WORTH:   'NET_WORTH',
  /** A question ABOUT the data rather than about the money. */
  COVERAGE:    'COVERAGE',
  /**
   * A PREDICTIVE question — what money will do, not what it did.
   *
   * ⚠️ A CONCEPT, NOT A SEPARATE ROUTER. It sits beside the others so a
   * question can be FORECAST *and* SPENDING ("compare what I spent with what my
   * cash could look like") and get both bodies of evidence, which a dedicated
   * forecast path outside CF-8 could not express.
   *
   * ⚠️ NOT A TENSE. Future words alone do not reach it: "pending transactions",
   * "upcoming bill" and "next paycheck" are about records and dates that
   * already exist or are already licensed, and none of them wants a cash path.
   * The requirement is a predictive ECONOMIC ask.
   */
  FORECAST:    'FORECAST',
  /**
   * WHEN money arrives, as distinct from what will be left.
   *
   * ⚠️ A SEPARATE CONCEPT, NOT A FLAVOUR OF FORECAST, because the two need
   * different evidence and different answers. FORECAST-7 licenses NEXT_PAY_DATES
   * from cadence and activity alone — no balance, no spending level, no income
   * amount — so the question is answerable on a Space where a cash forecast is
   * refused. Folding it into FORECAST would assemble an operating state and a
   * policy to reach a generator that needs neither, and would put "Ending cash:
   * REFUSED" in front of an answer that is not refused.
   */
  PAY_DATES:   'PAY_DATES',
  /** Nothing recognised. */
  UNKNOWN:     'UNKNOWN',
} as const;

export type Concept = typeof Concepts[keyof typeof Concepts];

/**
 * How much evidence the ask needs.
 *
 * ENVELOPE is the interesting one: a question about the DATA ("how far back can
 * you see?") is answerable from CF-5's census alone, without assembling a
 * single figure. AGGREGATE and DETAIL are the existing summary/drilldown split
 * named rather than reinvented.
 */
export const EvidenceDepth = {
  /** Coverage facts only. No aggregates, no rows. */
  ENVELOPE:  'ENVELOPE',
  /** Deterministic rollups — the transactions/accounts summaries. */
  AGGREGATE: 'AGGREGATE',
  /** Bounded rows or ranked items — superlatives, "show me", drilldown. */
  DETAIL:    'DETAIL',
} as const;

export type EvidenceDepthKind = typeof EvidenceDepth[keyof typeof EvidenceDepth];

/** Why a domain is, or is not, needed. */
export const NeedLevel = {
  /** The question cannot be answered without it. */
  REQUIRED:    'REQUIRED',
  /** Improves the answer; its absence is not a failure. */
  SUPPORTING:  'SUPPORTING',
  /** The question does not call for it. */
  NOT_NEEDED:  'NOT_NEEDED',
} as const;

export type NeedLevelKind = typeof NeedLevel[keyof typeof NeedLevel];

export interface PlannedDomain {
  domain: ContextDomain;
  need:   NeedLevelKind;
  reason: string;
  /** Does this Space actually hold visible evidence of the kind? */
  available: boolean;
  /**
   * Does the DETERMINISTIC ASSESSMENT need this domain assembled, whatever the
   * question asks? Independent of `need`, and the reason a future enforcement
   * slice must not read `NOT_NEEDED` as "skip the assembler".
   */
  assessmentNeedsIt: boolean;
}

export interface RetrievalPlan {
  shadow: true;
  plannerVersion: string;
  concepts: Concept[];
  /** Whether the concepts came from this message or from an earlier turn. */
  conceptProvenance: 'THIS_TURN' | 'INHERITED';
  /** CF-7's breadth, when INVESTMENTS is in play. */
  investmentBreadth: ConceptBreadthKind;
  temporal: {
    /** CF-4's transition for this turn. */
    provenance: ScopeTransition;
    /** The interval the conversation's active scope resolves to, if any. */
    startDate: string | null;
    endDate:   string | null;
    label:     string | null;
  };
  depth: EvidenceDepthKind;
  domains: PlannedDomain[];
  /** Domains the question requires that this Space cannot supply. */
  unsatisfiable: ContextDomain[];
}

export const PLANNER_VERSION = 'cf8-shadow-1';

/**
 * Domains the deterministic assessment reads to COMPUTE its verdicts.
 *
 * Measured, not assumed: `computeAssessment` calls `getTxnData`, `getSnapData`
 * and `getAcctsData` (lib/ai/intelligence/annotations/metrics.ts) and reads a
 * small set of scalars from each — window days, transaction and snapshot
 * counts, the flow totals, liquid and liability totals, and the accounts array
 * for the debt aggregate.
 *
 * So all three are computation dependencies even for a question that needs none
 * of them, and none of that requires their raw JSON in the prompt.
 */
const ASSESSMENT_DEPENDENCIES: ReadonlySet<string> = new Set([
  FinanceDomains.ACCOUNTS,
  FinanceDomains.TRANSACTIONS_SUMMARY,
  FinanceDomains.SNAPSHOT_HISTORY,
]);

// ── Concept detection ────────────────────────────────────────────────────────
//
// Bounded and deterministic. INVESTMENTS is delegated to CF-7 rather than
// re-derived, so there is one investment vocabulary in the codebase.

const SPENDING_RE =
  /\b(spend|spent|spending|expense|expenses|purchase|purchases|bought|buy|cost|costs|merchant|merchants|categor(?:y|ies)|transaction|transactions|charge|charges|paid for|outgoing)\b/i
  // Measured in shadow: "Where is my money going?" matched none of the above and
  // planned `required=(none)` — a FALSE NARROW on a plainly spending question.
  ;
const SPENDING_PHRASE_RE =
  /\b(money (?:go|goes|going)|where (?:does|is) (?:my|the) money|what am i paying for|biggest (?:outgoing|drain))\b/i;
const INCOME_RE =
  /\b(income|earn|earned|earning|earnings|salary|paycheck|payroll|revenue|deposit|deposits|inflow|dividend|dividends|interest earned)\b/i;
const INCOME_PHRASE_RE =
  /\b(came? in|coming in|brought in|did i (?:make|take home)|take[- ]home|money (?:in|coming))\b/i;
const DEBT_RE =
  /\b(debt|owe|owed|loan|loans|mortgage|credit card|balance owed|payoff|pay ?off|apr|interest rate|minimum payment)\b/i;
/**
 * Questions about the SHAPE of a change, not its current value.
 *
 * The distinction CF-9 measured: ninety daily snapshot rows are 5,660 prompt
 * tokens, and only a trajectory question actually reads them.
 */
const HISTORICAL_RE =
  /\b(over time|trend|trending|trajectory|history|historical|changed?|change over|grown|growth|growing|progress|since|compared to|month over month|year over year|last year|past year|over the (?:last|past))\b/i;

/** Broad overview phrasings, which legitimately reach for the trajectory. */
const OVERVIEW_RE =
  /\b(how am i doing|financial (?:health|position|picture|situation|overview|shape)|overall finances|full picture|whole picture|balance sheet)\b/i;

const NET_WORTH_RE =
  /\b(net worth|networth|financial (?:health|position|picture|situation|overview|shape)|overall finances|how am i doing|total assets|balance sheet|full picture|whole picture|my position|overall position)\b/i;

/**
 * Questions about the DATA rather than about the money.
 *
 * These are the envelope-only candidates: "how far back can you see?" is
 * answered entirely by CF-5's census, and assembling ninety days of
 * transactions to answer it is pure waste.
 */
/**
 * A predictive economic ask.
 *
 * Two halves, and both are needed. A VERB of projection ("forecast", "project",
 * "runway") is enough on its own. Otherwise a future frame must combine with a
 * cash SUBJECT — "what will my cash look like", "how much cash will I have",
 * "where will I be financially" — so that a future-tense question about
 * something else does not drag in the whole substrate.
 */
const FORECAST_VERB_RE =
  /\b(forecast|forecasts|forecasting|project(?:ion|ions|ed|ing)?|runway|cash ?flow projection|ending cash|burn rate)\b/i;
const FORECAST_PHRASE_RE =
  // ⚠️ BOTH WORD ORDERS. "what will my cash look like" and "what my cash could
  // look like" are the same ask, and the second is how it arrives inside a
  // comparison — "compare what I spent with what my cash could look like" —
  // which is exactly the multi-concept question §22 requires to load both.
  /\b(?:what (?:will|would|could) my (?:cash|balance|money|savings|finances|net worth)|my (?:cash|balance|money|savings|finances) (?:will|would|could) (?:look|be|last|end)|how much (?:cash|money) (?:will|would) i have|where will i be (?:financially|in)|how long (?:will|can) my (?:cash|money|savings) last|what (?:will|would) i have (?:left|by)|will i (?:run out|have enough))\b/i;

/**
 * Future-tense language that is NOT a cash-path request.
 *
 * ⚠️ MEASURED FALSE POSITIVES, listed rather than described. Each of these
 * names a record or a licensed date, and each would otherwise have tripped a
 * looser future-tense rule: a pending transaction already exists, an upcoming
 * bill is an obligation question, and "when is my next paycheck" is answerable
 * from FORECAST-1/2 alone — routing it through the full engine would report a
 * refusal for a question that is not refused.
 */
const FORECAST_EXCLUSION_RE =
  /\b(pending transactions?|future transactions?|upcoming (?:bill|charge|payment|transaction)s?|long[- ]term investments?|my future\b)\b/i;

/**
 * A turn that REFINES the previous ask rather than starting a new one.
 *
 * ⚠️ CF-4's LESSON, ONE LEVEL IN. CF-8 already inherits the concept when a turn
 * resolves nothing at all. Measured here: "Forecast my cash for the next 3
 * months" → "What if I spend $5,000 a month?" resolved SPENDING — on the word
 * "spend" — and DROPPED forecast, which is a false narrow of the worse kind
 * because it looks like a successful resolution. A follow-up that supplies a
 * scenario parameter is refining the forecast, not opening a spending question.
 *
 * Deliberately a list of REFINEMENT ACTS ("what if", "instead", "what about"),
 * not an attempt to detect that a topic continued — the same discipline CF-4's
 * discard list documents.
 */
const REFINEMENT_RE =
  /\b(what if|what about|how about|and if|instead|assume|assuming|suppose|say i|make it|try)\b/i;

/**
 * Future pay-date intent. Mirrors `detectPayDateAsk` in lib/ai/forecast/pay-dates.ts,
 * which owns the capability; this is the retrieval half of the same question.
 *
 * ⚠️ THE EXCLUSIONS CARRY THE WEIGHT. Every phrase below names a paycheck, and
 * only some ask when one arrives.
 */
// ⚠️ "check" ONLY WITH A POSSESSIVE OR FORWARD FRAME. Bare "check" is a verb
// far more often than a noun — "check my balance", "check my spending" — and
// the capability half of this pair already made that distinction. Measured:
// "When should my next check hit?" resolved UNKNOWN while the capability
// detector correctly read it as NEXT_ONE, so the two halves disagreed.
const PAY_DATE_NOUN_RE =
  /\b(?:pay ?checks?|pay ?days?|pay dates?|paid|deposits?)\b|\b(?:next|my)\s+check\b/i;
const PAY_DATE_WHEN_RE = /\b(?:when|what date|which day|how soon)\b/i;
/** The schedule named directly. "paycheck" is deliberately absent — see the
 *  capability half in lib/ai/forecast/pay-dates.ts for the measured reason. */
const PAY_DATE_SCHEDULE_RE = /\b(?:pay ?dates?|pay ?days?)\b/i;
/** A cash-forecast request, whatever pay nouns it contains, is never this. */
const PAY_DATE_CASH_RE = /\b(?:forecast|project(?:ion|ed|ing)?|cash|balance|runway|spend|spending|budget)\b/i;
const PAY_DATE_EXCLUDE_RE =
  /\b(?:was|were|last (?:pay ?check|pay ?day|month)|how much|amount|lower|higher|why|total|average|earn|make|income (?:is|was|of))\b/i;

const COVERAGE_RE =
  /\b(?:how far back|how much (?:data|history)|what (?:data|history|records) do you have|can you see|going back to|since when|what (?:period|range) (?:do|can) you|do you have (?:any|my|the )?\s?(?:any ?thing|data|history|records|transactions|crypto|investments?))\b/i;

/**
 * Superlatives and evidence asks — the questions an aggregate cannot answer.
 *
 * "How much did I spend in 2025" is a total; "what was my largest purchase in
 * 2025" is a row. A future retrieval layer needs to know the difference so it
 * can perform a bounded evidence read instead of folding a whole year.
 */
const DETAIL_RE =
  /\b(largest|biggest|most expensive|highest|top|smallest|cheapest|show me|list|which (?:transaction|purchase|merchant)|what was my|who did i|break ?down|itemi[sz]e|individual|each)\b/i;

/**
 * A question that names a figure, not just a period or a record.
 *
 * Separates "how far back can you see my transactions?" from "how much did I
 * spend?" — the first mentions transactions as DATA and needs only the census.
 */
const FIGURE_ASK_RE = /\b(how much|total|totals|sum|average|amount|balance|worth|\$)\b/i;

function detectConcepts(question: string, breadth: ConceptBreadthKind): Concept[] {
  // Coverage WINS when the question is about the record and asks for no figure.
  //
  // Measured in shadow: "How far back can you see my transactions?" also matched
  // the spending vocabulary — on the DATA noun "transactions" — and planned a
  // full aggregate. It needs the census and nothing else.
  if (COVERAGE_RE.test(question) && !FIGURE_ASK_RE.test(question)) {
    return [Concepts.COVERAGE];
  }

  const out: Concept[] = [];
  if (COVERAGE_RE.test(question)) out.push(Concepts.COVERAGE);
  // ⚠️ CHECKED BEFORE FORECAST, AND EXCLUSIVE OF IT. "When do my paychecks land
  // over the next 3 months" contains a forward frame that FORECAST's own
  // phrases do not match, so there is no contest today — but a question that
  // asked for both would want the cheaper, more specific answer first.
  const payDates = !PAY_DATE_EXCLUDE_RE.test(question)
    && !PAY_DATE_CASH_RE.test(question)
    && PAY_DATE_NOUN_RE.test(question)
    && (PAY_DATE_WHEN_RE.test(question) || PAY_DATE_SCHEDULE_RE.test(question));
  if (payDates) out.push(Concepts.PAY_DATES);
  // ⚠️ The exclusion is checked against the WHOLE question, not the match, so
  // "what will my cash look like after the pending transactions clear" is still
  // a forecast — the exclusion removes a question that is ONLY about records.
  if ((FORECAST_VERB_RE.test(question) || FORECAST_PHRASE_RE.test(question))
    && !(FORECAST_EXCLUSION_RE.test(question) && !FORECAST_PHRASE_RE.test(question))) {
    out.push(Concepts.FORECAST);
  }
  if (breadth !== ConceptBreadth.NONE) out.push(Concepts.INVESTMENTS);
  if (SPENDING_RE.test(question) || SPENDING_PHRASE_RE.test(question)) out.push(Concepts.SPENDING);
  if (INCOME_RE.test(question) || INCOME_PHRASE_RE.test(question)) out.push(Concepts.INCOME);
  if (DEBT_RE.test(question))      out.push(Concepts.DEBT);
  if (NET_WORTH_RE.test(question)) out.push(Concepts.NET_WORTH);
  return out.length > 0 ? out : [Concepts.UNKNOWN];
}

function detectDepth(question: string, concepts: Concept[]): EvidenceDepthKind {
  // A pure coverage question needs nothing but the census.
  if (concepts.length === 1 && concepts[0] === Concepts.COVERAGE) return EvidenceDepth.ENVELOPE;
  if (DETAIL_RE.test(question)) return EvidenceDepth.DETAIL;
  return EvidenceDepth.AGGREGATE;
}

// ── The plan ─────────────────────────────────────────────────────────────────

/**
 * Compose a retrieval plan from the authorities that already exist.
 *
 * Pure: the caller supplies the conversation and the census, and every temporal
 * and semantic decision is delegated. Nothing here computes a financial value,
 * an assessment verdict, an FX conversion or a classification — those are
 * downstream authorities and stay there.
 */
export function planRetrieval(input: {
  messages: readonly ScopeMessage[];
  envelope: CoverageEnvelope;
  now: Date;
}): RetrievalPlan {
  const { messages, envelope, now } = input;
  const question =
    [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

  const scope   = resolveConversationScope(messages, now);
  const breadth = resolveConceptBreadth(question);

  // CF-4's lesson, applied to CONCEPT as well as to scope.
  //
  // Measured in shadow: in "spend in 2025 → biggest purchase → who was the
  // merchant → WHAT ABOUT 2024? → and my biggest purchase", the fourth turn
  // named no financial subject and planned `required=(none)` — a FALSE NARROW
  // in the middle of a spending conversation. A refinement inherits the subject
  // for the same reason it inherits the period: the user did not change it.
  let concepts = detectConcepts(question, breadth);
  let conceptProvenance: 'THIS_TURN' | 'INHERITED' = 'THIS_TURN';
  if (concepts.length === 1 && concepts[0] === Concepts.UNKNOWN) {
    const users = messages.filter((m) => m.role === 'user');
    for (let i = users.length - 2; i >= 0; i--) {
      const prior = detectConcepts(
        users[i].content, resolveConceptBreadth(users[i].content));
      if (!(prior.length === 1 && prior[0] === Concepts.UNKNOWN)) {
        concepts = prior;
        conceptProvenance = 'INHERITED';
        break;
      }
    }
  }
  // ⚠️ FORECAST SURVIVES A REFINEMENT. Unlike the whole-concept inheritance
  // above, this ADDS to what this turn resolved rather than replacing it: "what
  // if I spend $5,000" is genuinely about spending AND still the forecast, and
  // a rule that replaced the concepts would lose the half the user just named.
  if (!concepts.includes(Concepts.FORECAST) && REFINEMENT_RE.test(question)) {
    const users = messages.filter((m) => m.role === 'user');
    for (let i = users.length - 2; i >= 0; i--) {
      const prior = detectConcepts(users[i].content, resolveConceptBreadth(users[i].content));
      if (prior.includes(Concepts.FORECAST)) {
        concepts = [...concepts.filter((c) => c !== Concepts.UNKNOWN), Concepts.FORECAST];
        if (conceptProvenance === 'THIS_TURN') conceptProvenance = 'INHERITED';
        break;
      }
      // ⚠️ WALK PAST INTERVENING REFINEMENTS, AND STOP AT A FRESH ASK. Measured:
      // "forecast my cash" → "what if I spend $5,000?" → "what about 6 months?"
      // The third turn inherits the SECOND's concepts, which are themselves a
      // refinement's, so stopping at the first non-UNKNOWN turn loses the
      // forecast two turns after it was asked for. Walking only through
      // refinements is what keeps this from resurrecting a forecast the user
      // moved on from: one turn that names a different economic ask ends it.
      const priorIsRefinement = REFINEMENT_RE.test(users[i].content)
        || (prior.length === 1 && prior[0] === Concepts.UNKNOWN);
      if (!priorIsRefinement) break;
    }
  }

  const depth = detectDepth(question, concepts);

  const has = (c: Concept) => concepts.includes(c);
  const txnAvailable   = envelope.transactions.availability === EvidenceAvailability.AVAILABLE;
  const snapAvailable  = envelope.snapshots.availability === EvidenceAvailability.AVAILABLE;
  const holdAvailable  = envelope.accounts.investments > 0 || envelope.accounts.digitalAssets > 0;

  const domains: PlannedDomain[] = [];
  const add = (
    domain: ContextDomain, need: NeedLevelKind, reason: string, available: boolean,
  ) => domains.push({
    domain, need, reason, available,
    assessmentNeedsIt: ASSESSMENT_DEPENDENCIES.has(domain),
  });

  // ── transactions ─────────────────────────────────────────────────────────
  //
  // ⚠️ THE EXECUTION / SERIALIZATION SPLIT, AND FORECAST IS ITS SHARPEST CASE
  // (§6/§7). A forecast NEEDS transaction evidence — FORECAST-1/2/5 derive a
  // cadence, an activity licence and a current level from dated income rows, and
  // `loadForecastIncomeStreams` reads them through the canonical authority. What
  // the MODEL needs is the resulting forecast, not the evidence that produced
  // it: ninety days of rollups and 1,512 tokens of analysis prose beside a
  // deterministic cash path is not extra rigour, it is a second opinion the
  // model can average with the first.
  //
  // So a forecast-only question marks this NOT_NEEDED for the model, and the
  // forecast's own read is unaffected — it does not go through this domain at
  // all. A question that asks for BOTH keeps the evidence, because then the
  // history is part of the ask rather than a byproduct of it.
  // ⚠️ PAY_DATES FIRST. The word "paycheck" also matches the INCOME vocabulary,
  // and INCOME requires the rollups — which answer nothing about WHEN the next
  // payment lands. A question that genuinely asks about spending still wins.
  if (has(Concepts.PAY_DATES) && !has(Concepts.SPENDING)) {
    add(FinanceDomains.TRANSACTIONS_SUMMARY, NeedLevel.NOT_NEEDED,
      'the pay-date capability derives its own dated series; rollups answer nothing about '
      + 'when the next payment lands',
      txnAvailable);
  } else if (has(Concepts.SPENDING) || has(Concepts.INCOME)) {
    add(FinanceDomains.TRANSACTIONS_SUMMARY, NeedLevel.REQUIRED,
      depth === EvidenceDepth.DETAIL
        ? 'the question asks for a specific row or ranking, not a total'
        : 'the question asks for flow totals',
      txnAvailable);
  } else if (has(Concepts.FORECAST)) {
    add(FinanceDomains.TRANSACTIONS_SUMMARY, NeedLevel.NOT_NEEDED,
      'the forecast substrate derives its own dated income series through the canonical read; '
      + 'historical rollups would restate the same period as a competing answer',
      txnAvailable);
  } else if (has(Concepts.NET_WORTH)) {
    add(FinanceDomains.TRANSACTIONS_SUMMARY, NeedLevel.SUPPORTING,
      'cash flow contextualises a position question', txnAvailable);
  } else {
    add(FinanceDomains.TRANSACTIONS_SUMMARY, NeedLevel.NOT_NEEDED,
      'no spending or income question', txnAvailable);
  }

  // ── accounts ─────────────────────────────────────────────────────────────
  //
  // The one domain almost everything wants: balances, debt and the investment
  // component totals all live here, and it is the cheapest of the three.
  // ⚠️ NOT `concepts.length === 1`. "When is my next paycheck?" also trips the
  // INCOME vocabulary on the word itself, which is harmless but would have
  // re-required the largest payload a forecast question loads. The test is
  // whether any concept in play actually needs a balance.
  if (has(Concepts.PAY_DATES)
    && ![Concepts.NET_WORTH, Concepts.DEBT, Concepts.INVESTMENTS, Concepts.FORECAST]
      .some((c) => has(c))) {
    // ⚠️ NOT EVEN SUPPORTING. A pay date has no balance in it, and the accounts
    // payload is the largest thing a forecast question loads.
    add(FinanceDomains.ACCOUNTS, NeedLevel.NOT_NEEDED,
      'a pay date is a schedule; no balance contributes to it', true);
  } else if (has(Concepts.NET_WORTH) || has(Concepts.DEBT) || has(Concepts.INVESTMENTS)
    || has(Concepts.FORECAST)) {
    add(FinanceDomains.ACCOUNTS, NeedLevel.REQUIRED,
      has(Concepts.INVESTMENTS)
        ? 'carries both INVESTMENTS component totals (CF-7 composition authority)'
        : has(Concepts.FORECAST)
          ? 'the liquid total is the forecast opening balance, and nothing else may substitute for it'
          : 'carries balances and debt totals',
      true);
  } else {
    add(FinanceDomains.ACCOUNTS, NeedLevel.SUPPORTING,
      'account context is broadly useful but not required by this question', true);
  }

  // ── snapshot history ─────────────────────────────────────────────────────
  //
  // CF-9 asked whether a CURRENT net-worth question needs ninety daily rows.
  // It does not: "what is my net worth?" is answered by `accounts.netWorth`,
  // and the compact trend signal ("Net worth up $7,726 (+29.7%) since Jun")
  // is produced by the signal detector and survives independently of this
  // payload. Only a question about the SHAPE of the change needs the series.
  //
  // A broad overview keeps it — a general "how am I doing" reasonably reaches
  // for the trajectory, and CF-9's rule is not to optimise away evidence the
  // planner legitimately wants.
  if (has(Concepts.NET_WORTH) && (HISTORICAL_RE.test(question) || OVERVIEW_RE.test(question))) {
    add(FinanceDomains.SNAPSHOT_HISTORY, NeedLevel.REQUIRED,
      'the question is about the SHAPE of the change over time', snapAvailable);
  } else if (has(Concepts.NET_WORTH)) {
    add(FinanceDomains.SNAPSHOT_HISTORY, NeedLevel.NOT_NEEDED,
      'a current position question is answered by account balances; the trend signal covers direction',
      snapAvailable);
  } else if (has(Concepts.PAY_DATES)) {
    add(FinanceDomains.SNAPSHOT_HISTORY, NeedLevel.NOT_NEEDED,
      'balance history says nothing about when the next payment lands', snapAvailable);
  } else if (has(Concepts.FORECAST)) {
    add(FinanceDomains.SNAPSHOT_HISTORY, NeedLevel.NOT_NEEDED,
      'a forecast starts from the CURRENT balance; ninety historical rows are the input to an '
      + 'extrapolation nobody licensed',
      snapAvailable);
  } else {
    add(FinanceDomains.SNAPSHOT_HISTORY, NeedLevel.NOT_NEEDED,
      'no position-over-time question', snapAvailable);
  }

  // ── holdings ─────────────────────────────────────────────────────────────
  //
  // CF-7's breadth decides: the spine is where individual securities live, and
  // a digital-only question does not need it — the account totals and the
  // envelope's per-chain coverage already answer it.
  if (breadth === ConceptBreadth.BROAD || breadth === ConceptBreadth.TRADITIONAL_ONLY) {
    add(FinanceDomains.HOLDINGS_SUMMARY, NeedLevel.REQUIRED,
      'position-level detail for an investment question', holdAvailable);
  } else if (breadth === ConceptBreadth.DIGITAL_ONLY) {
    add(FinanceDomains.HOLDINGS_SUMMARY, NeedLevel.NOT_NEEDED,
      'digital-asset facts come from the accounts domain and the coverage envelope',
      holdAvailable);
  } else {
    add(FinanceDomains.HOLDINGS_SUMMARY, NeedLevel.NOT_NEEDED,
      'not an investment question', holdAvailable);
  }

  // ENVELOPE depth answers from the census alone, so nothing is REQUIRED.
  //
  // Enforced here rather than left to rule ordering: "Do you have investment
  // accounts?" is a COVERAGE question that still trips the CF-7 breadth
  // vocabulary, and without this it planned ENVELOPE depth WITH a required
  // domain — a contradiction that a later enforcement slice would have to
  // resolve by guessing.
  const finalDomains = depth === EvidenceDepth.ENVELOPE
    ? domains.map((d) => d.need === NeedLevel.REQUIRED
        ? { ...d, need: NeedLevel.SUPPORTING,
            reason: 'the coverage envelope answers this question; the domain would only add detail' }
        : d)
    : domains;

  return {
    shadow: true,
    plannerVersion: PLANNER_VERSION,
    concepts,
    conceptProvenance,
    investmentBreadth: breadth,
    temporal: {
      provenance: scope.transition,
      startDate:  scope.window?.startDate ?? null,
      endDate:    scope.window?.endDate ?? null,
      label:      scope.window?.label ?? scope.inheritedFrom ?? null,
    },
    depth,
    domains: finalDomains,
    unsatisfiable: finalDomains
      .filter((d) => d.need === NeedLevel.REQUIRED && !d.available)
      .map((d) => d.domain),
  };
}

/**
 * The plan, reduced to what an audit row should carry.
 *
 * Deliberately free of financial content: concepts, dates, domain names and
 * reasons. A planning diagnostic has no business storing balances.
 */
export function planAuditPayload(plan: RetrievalPlan): Record<string, unknown> {
  return {
    shadow: true,
    plannerVersion: plan.plannerVersion,
    concepts: plan.concepts,
    conceptProvenance: plan.conceptProvenance,
    investmentBreadth: plan.investmentBreadth,
    temporal: plan.temporal,
    depth: plan.depth,
    domains: plan.domains.map((d) => ({
      domain: d.domain, need: d.need, available: d.available,
      // CF-9 — the four facts an operator needs to explain a prompt after the
      // fact, kept separate because they are separate questions.
      assessmentNeeded:   d.assessmentNeedsIt,
      modelContextNeeded: d.need !== NeedLevel.NOT_NEEDED,
      reason: d.reason,
    })),
    unsatisfiable: plan.unsatisfiable,
  };
}
