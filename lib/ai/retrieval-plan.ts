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
const NET_WORTH_RE =
  /\b(net worth|networth|financial (?:health|position|picture|situation|overview|shape)|overall finances|how am i doing|total assets|balance sheet|full picture|whole picture)\b/i;

/**
 * Questions about the DATA rather than about the money.
 *
 * These are the envelope-only candidates: "how far back can you see?" is
 * answered entirely by CF-5's census, and assembling ninety days of
 * transactions to answer it is pure waste.
 */
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
  if (has(Concepts.SPENDING) || has(Concepts.INCOME)) {
    add(FinanceDomains.TRANSACTIONS_SUMMARY, NeedLevel.REQUIRED,
      depth === EvidenceDepth.DETAIL
        ? 'the question asks for a specific row or ranking, not a total'
        : 'the question asks for flow totals',
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
  if (has(Concepts.NET_WORTH) || has(Concepts.DEBT) || has(Concepts.INVESTMENTS)) {
    add(FinanceDomains.ACCOUNTS, NeedLevel.REQUIRED,
      has(Concepts.INVESTMENTS)
        ? 'carries both INVESTMENTS component totals (CF-7 composition authority)'
        : 'carries balances and debt totals',
      true);
  } else {
    add(FinanceDomains.ACCOUNTS, NeedLevel.SUPPORTING,
      'account context is broadly useful but not required by this question', true);
  }

  // ── snapshot history ─────────────────────────────────────────────────────
  if (has(Concepts.NET_WORTH)) {
    add(FinanceDomains.SNAPSHOT_HISTORY, NeedLevel.REQUIRED,
      'net-worth trajectory is the question', snapAvailable);
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
      assessmentNeedsIt: d.assessmentNeedsIt, reason: d.reason,
    })),
    unsatisfiable: plan.unsatisfiable,
  };
}
