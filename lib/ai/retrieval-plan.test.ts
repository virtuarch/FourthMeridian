/**
 * lib/ai/retrieval-plan.test.ts   (CF-8)
 *
 * THE PLAN MUST NEVER OMIT EVIDENCE THE QUESTION NEEDS.
 *
 *     npx tsx lib/ai/retrieval-plan.test.ts
 *
 * SHADOW slice: nothing here affects production retrieval. What is pinned is
 * the plan's SEMANTICS, so the enforcement slice that follows can be judged
 * against a contract rather than against a hunch.
 *
 * ── The asymmetry that shapes this file ─────────────────────────────────────
 * FALSE WIDENING costs tokens. FALSE NARROWING costs the answer — a plan that
 * trims the prompt and cannot answer the question is strictly worse than
 * today's broad one. So the corpus below is weighted toward proving that every
 * question can still reach what it needs, and false widening is measured rather
 * than forbidden.
 *
 * ── What shadow already caught ──────────────────────────────────────────────
 * Running the planner against production on a real corpus found four defects
 * before any of this was enforced, and each is pinned below:
 *
 *   "Where is my money going?"   → no concept, no required domain  (FALSE NARROW)
 *   "What about 2024?" mid-chain → no concept, no required domain  (FALSE NARROW)
 *   "How far back can you see?"  → planned a full aggregate        (missed ENVELOPE)
 *   "Do you have investment accounts?" → ENVELOPE depth WITH a required domain
 *
 * That is the whole argument for planning in shadow first.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  planRetrieval, Concepts, EvidenceDepth, NeedLevel,
  type RetrievalPlan, type Concept,
} from './retrieval-plan';
import { EvidenceAvailability, type CoverageEnvelope } from './coverage-envelope';
import { FinanceDomains, type ContextDomain } from './types';
import { ScopeTransitions } from './chat/conversation-scope';
import { ConceptBreadth } from './economic-concepts';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

const NOW = new Date('2026-08-27T00:00:00.000Z');

/** The real Space's census, unless overridden. */
function envelope(o: Partial<{
  txnCount: number; snapCount: number; investments: number; digitalAssets: number;
}> = {}): CoverageEnvelope {
  const txnCount = o.txnCount ?? 4_156;
  const snapCount = o.snapCount ?? 768;
  return {
    transactions: {
      availability: txnCount > 0 ? EvidenceAvailability.AVAILABLE : EvidenceAvailability.NONE,
      span: { fromISO: '2024-07-18', toISO: '2026-08-26', count: txnCount },
    },
    snapshots: {
      availability: snapCount > 0 ? EvidenceAvailability.AVAILABLE : EvidenceAvailability.NONE,
      span: { fromISO: '2024-07-21', toISO: '2026-08-27', count: snapCount },
    },
    accounts: {
      cash: 4, debt: 2, other: 0,
      investments:   o.investments   ?? 3,
      digitalAssets: o.digitalAssets ?? 4,
    },
    chains: [{ chain: 'BTC', fromISO: '2023-03-18', toISO: '2026-08-27', claimsHistory: true }],
  };
}

function plan(turns: string | string[], env = envelope()): RetrievalPlan {
  const list = Array.isArray(turns) ? turns : [turns];
  const messages: { role: string; content: string }[] = [];
  for (let i = 0; i < list.length; i++) {
    messages.push({ role: 'user', content: list[i] });
    if (i < list.length - 1) messages.push({ role: 'assistant', content: '(elided)' });
  }
  return planRetrieval({ messages, envelope: env, now: NOW });
}

const needOf = (p: RetrievalPlan, d: ContextDomain) =>
  p.domains.find((x) => x.domain === d)?.need;
const required = (p: RetrievalPlan) =>
  p.domains.filter((x) => x.need === NeedLevel.REQUIRED).map((x) => x.domain);
const reaches = (p: RetrievalPlan, d: ContextDomain) => needOf(p, d) !== NeedLevel.NOT_NEEDED;

const TXN  = FinanceDomains.TRANSACTIONS_SUMMARY;
const ACCT = FinanceDomains.ACCOUNTS;
const SNAP = FinanceDomains.SNAPSHOT_HISTORY;
const HOLD = FinanceDomains.HOLDINGS_SUMMARY;

// ══ ZERO FALSE NARROWING — THE DISQUALIFYING ERROR ═══════════════════════════
//
// Every question that genuinely needs transactions must REQUIRE them. Phrasings
// chosen to avoid the obvious keywords, because that is where narrowing hides.
{
  const NEEDS_TRANSACTIONS = [
    'What did I spend in 2025?',
    'Where is my money going?',              // caught in shadow as a false narrow
    'Where does my money go?',
    'Who did I spend the most with?',
    'What was my most expensive purchase?',
    'How much did I earn last month?',
    'What am I paying for every month?',
    'Show me the largest transactions',
    'Break down my dining costs',
    'Am I spending more than I earn?',
    'What are my top merchants?',
    'How much came in last quarter?',
  ];
  for (const q of NEEDS_TRANSACTIONS) {
    check(`FALSE_NARROW: "${q}" requires transactions`,
      needOf(plan(q), TXN) === NeedLevel.REQUIRED,
      `got ${needOf(plan(q), TXN)} — a plan that omits this cannot answer`);
  }

  const NEEDS_HOLDINGS = [
    'What are my investments?', 'What stocks do I own?',
    'How is my portfolio allocated?', 'Which ETFs am I in?',
    'Traditional vs crypto?',
  ];
  for (const q of NEEDS_HOLDINGS) {
    check(`FALSE_NARROW: "${q}" requires holdings`,
      needOf(plan(q), HOLD) === NeedLevel.REQUIRED, `got ${needOf(plan(q), HOLD)}`);
  }

  const NEEDS_ACCOUNTS = [
    'What are my investments?', 'How much do I owe?',
    'What is my net worth?', 'How much crypto do I have?',
  ];
  for (const q of NEEDS_ACCOUNTS) {
    check(`FALSE_NARROW: "${q}" requires accounts`,
      needOf(plan(q), ACCT) === NeedLevel.REQUIRED, `got ${needOf(plan(q), ACCT)}`);
  }
}

// ══ CONCEPT INHERITANCE — CF-4's LESSON, APPLIED TO SUBJECT ══════════════════
//
// A refinement inherits the subject for the same reason it inherits the period:
// the user did not change it. Caught in shadow — "What about 2024?" mid-chain
// planned no concept and no required domain.
{
  const chain = [
    'What did I spend in 2025?',
    'What was my biggest purchase?',
    'Who was the merchant?',
    'What about 2024?',
    'And my biggest purchase?',
  ];
  const scopes = ['2025-01-01', '2025-01-01', '2025-01-01', '2024-01-01', '2024-01-01'];
  const transitions = [
    ScopeTransitions.SET, ScopeTransitions.INHERIT, ScopeTransitions.INHERIT,
    ScopeTransitions.SET, ScopeTransitions.INHERIT,
  ];
  for (let i = 0; i < chain.length; i++) {
    const p = plan(chain.slice(0, i + 1));
    check(`chain T${i + 1}: scope ${scopes[i]}`,
      p.temporal.startDate === scopes[i], `got ${p.temporal.startDate}`);
    check(`chain T${i + 1}: provenance ${transitions[i]}`,
      p.temporal.provenance === transitions[i], `got ${p.temporal.provenance}`);
    check(`chain T${i + 1}: still a SPENDING question`,
      p.concepts.includes(Concepts.SPENDING), p.concepts.join('+'));
    check(`chain T${i + 1}: transactions still required`,
      needOf(p, TXN) === NeedLevel.REQUIRED);
  }
  check('chain: the inherited-subject turn is marked INHERITED',
    plan(chain.slice(0, 4)).conceptProvenance === 'INHERITED');
  check('chain: a self-describing turn is marked THIS_TURN',
    plan(chain.slice(0, 2)).conceptProvenance === 'THIS_TURN');
}

// ══ ENVELOPE DEPTH — THE TOKEN-SAVING PATH ═══════════════════════════════════
{
  const ENVELOPE_ONLY = [
    'How far back can you see my transactions?',
    'Do you have anything from 2025?',
    'Do you have my crypto history?',
    'Do you have investment accounts?',
    'What data do you have?',
    'Since when do you have records?',
  ];
  for (const q of ENVELOPE_ONLY) {
    const p = plan(q);
    check(`ENVELOPE: "${q}"`, p.depth === EvidenceDepth.ENVELOPE, `got ${p.depth}`);
    check(`ENVELOPE: "${q}" requires NO domain`, required(p).length === 0,
      `required ${required(p).join(',')} — the census already answers this`);
  }

  // …and the guard against over-claiming it. A question that opens like a
  // coverage ask but wants a FIGURE is not envelope-only.
  const NOT_ENVELOPE = [
    'Do you have my spending total?',
    'Do you have a breakdown by merchant?',
    'Do you have my biggest purchase?',
    'How much data did I spend?',
  ];
  for (const q of NOT_ENVELOPE) {
    check(`ENVELOPE guard: "${q}" is NOT envelope-only`,
      plan(q).depth !== EvidenceDepth.ENVELOPE,
      'an envelope plan for a figure question is a false narrow');
  }
}

// ══ AGGREGATE vs DETAIL — THE SUPERLATIVE DISTINCTION ════════════════════════
//
// Not implemented as retrieval yet (CF-8 changes nothing), but represented so a
// later layer knows a bounded evidence read is needed rather than a fold.
{
  for (const q of ['How much did I spend in 2025?', 'What did I earn last year?']) {
    check(`depth: "${q}" ⇒ AGGREGATE`, plan(q).depth === EvidenceDepth.AGGREGATE);
  }
  for (const q of ['What was my largest purchase in 2025?', 'Show me the biggest transactions',
                   'Who did I spend the most with?', 'List my top merchants']) {
    check(`depth: "${q}" ⇒ DETAIL`, plan(q).depth === EvidenceDepth.DETAIL,
      `got ${plan(q).depth}`);
  }
}

// ══ SCENARIO CORPUS A–N ══════════════════════════════════════════════════════
{
  const cases: [string, string | string[], Concept[], ContextDomain[]][] = [
    ['A', 'What did I spend in 2025?',                 [Concepts.SPENDING],    [TXN]],
    ['B', 'What was my most expensive purchase?',      [Concepts.SPENDING],    [TXN]],
    ['C', ['What did I spend in 2025?', 'What was my most expensive purchase?'],
                                                        [Concepts.SPENDING],    [TXN]],
    ['D', 'Who did I spend the most with?',            [Concepts.SPENDING],    [TXN]],
    ['E', 'What are my investments?',                  [Concepts.INVESTMENTS], [ACCT, HOLD]],
    ['F', 'What stocks do I own?',                     [Concepts.INVESTMENTS], [ACCT, HOLD]],
    ['G', 'What crypto do I own?',                     [Concepts.INVESTMENTS], [ACCT]],
    ['H', 'Traditional vs crypto?',                    [Concepts.INVESTMENTS], [ACCT, HOLD]],
    ['J', 'Where is my money going?',                  [Concepts.SPENDING],    [TXN]],
  ];
  for (const [id, q, concepts, req] of cases) {
    const p = plan(q);
    for (const c of concepts) {
      check(`${id}: concept ${c}`, p.concepts.includes(c), p.concepts.join('+'));
    }
    check(`${id}: required = ${req.join(',')}`,
      required(p).sort().join(',') === [...req].sort().join(','),
      `got ${required(p).join(',')}`);
  }

  // G — the crypto case, stated as the negative it is.
  check('G: a crypto question does NOT require the position spine',
    needOf(plan('What crypto do I own?'), HOLD) === NeedLevel.NOT_NEEDED,
    'the account totals and the CF-5 envelope already answer it');
  check('G: …and its breadth is DIGITAL_ONLY',
    plan('What crypto do I own?').investmentBreadth === ConceptBreadth.DIGITAL_ONLY);

  // I — a broad overview legitimately spans several domains.
  const overview = plan('How am I doing financially?');
  check('I: an overview reaches accounts, snapshots and holdings',
    reaches(overview, ACCT) && reaches(overview, SNAP) && reaches(overview, HOLD));
  check('I: …and still reaches transactions',
    reaches(overview, TXN), 'cash flow contextualises a position question');

  // M — an unresolved period is preserved, never invented.
  const m = plan('What did I spend during the summer before I moved?');
  check('M: UNRESOLVED survives into the plan',
    m.temporal.provenance === ScopeTransitions.UNRESOLVED, m.temporal.provenance);
  check('M: …and no interval is manufactured',
    m.temporal.startDate === null && m.temporal.endDate === null);
  check('M: …while the question still requires transactions',
    needOf(m, TXN) === NeedLevel.REQUIRED);

  // N — required but unavailable is reported, not silently dropped.
  const bare = plan('What are my investments?',
    envelope({ investments: 0, digitalAssets: 0 }));
  check('N: a required-but-unavailable domain is named',
    bare.unsatisfiable.includes(HOLD),
    'the plan asked correctly; the Space cannot supply it');
  check('N: …and the need stays REQUIRED rather than being downgraded',
    needOf(bare, HOLD) === NeedLevel.REQUIRED,
    'downgrading it would hide that the question could not be served');

  const noTxn = plan('What did I spend in 2025?', envelope({ txnCount: 0 }));
  check('N: no transaction evidence ⇒ unsatisfiable',
    noTxn.unsatisfiable.includes(TXN));
}

// ══ ASSESSMENT COMPUTE vs MODEL CONTEXT ══════════════════════════════════════
//
// The distinction a future enforcement slice must not lose: `NOT_NEEDED` is a
// statement about the PROMPT, never about the assembler.
{
  const p = plan('What are my investments?');
  for (const d of [ACCT, TXN, SNAP]) {
    check(`assessment depends on ${d}, whatever the question asks`,
      p.domains.find((x) => x.domain === d)?.assessmentNeedsIt === true);
  }
  check('holdings is NOT an assessment dependency',
    p.domains.find((x) => x.domain === HOLD)?.assessmentNeedsIt === false,
    'investmentReadiness records only whether the domain was present');

  check('a NOT_NEEDED domain can still be an assessment dependency',
    p.domains.some((d) => d.need === NeedLevel.NOT_NEEDED && d.assessmentNeedsIt),
    'this pair is exactly what stops "not in the prompt" becoming "do not assemble"');
}

// ══ NEGATIVE — SHADOW, PURE, AND NO SECOND AUTHORITY ═════════════════════════
{
  const src = readFileSync(join(process.cwd(), 'lib/ai/retrieval-plan.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

  check('NEG: every plan is marked shadow', plan('anything').shadow === true);
  check('NEG: no queries', !/\bdb\b|prisma|findMany|aggregate|await|async/.test(src));
  check('NEG: no second temporal parser',
    /resolveConversationScope/.test(src)
      && !/classifyFinancialIntent|detectTransactionWindow|CALENDAR_|LAST_N_MONTHS/.test(src),
    'CF-2/3/4 own temporal resolution');
  check('NEG: no second concept vocabulary',
    /resolveConceptBreadth/.test(src) && !/stock|brokerage|bitcoin|ethereum/i.test(src),
    'CF-7 owns the investment vocabulary');
  check('NEG: no second availability census',
    !/spaceAccountLink|visibilityLevel|bankingTransactionWhere/.test(src),
    'CF-5 owns availability, and it already resolved visibility');
  check('NEG: it computes no financial value',
    !/totalInvestments|totalLiquid|expenseTotal|netWorth|\+ *amount/.test(src));

  // The audit payload must carry diagnostics, not financial content.
  const payloadFn = src.slice(src.indexOf('export function planAuditPayload'));
  check('NEG: the audit payload carries no financial content',
    !/amount|total|balance|value/i.test(payloadFn),
    'a planning diagnostic has no business storing balances');
}

console.log(`\nretrieval-plan: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
