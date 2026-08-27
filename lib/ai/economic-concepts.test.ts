/**
 * lib/ai/economic-concepts.test.ts   (CF-7)
 *
 * WHAT "INVESTMENTS" MEANS, AND WHAT MAY BE ADDED TO WHAT.
 *
 *     npx tsx lib/ai/economic-concepts.test.ts
 *
 * ── The failure ─────────────────────────────────────────────────────────────
 * CF-6 made the evidence reachable and nothing said how it composes. A user's
 * "investments" spans two authorities the product keeps deliberately apart, and
 * the model was left to join them. Measured on the real Space at 93b46c0:
 *
 *     holdings.totalPortfolioValue  $23,943.30
 *     accounts.totalDigitalAssets   $19,014.63
 *     sum                           $42,957.92   ← overstates by $18,936.74
 *
 * That is the obvious addition to make, and it is wrong by 79%, because
 * `holdings_summary` is the canonical POSITION spine and already contains the
 * digital assets.
 *
 * ── What is pinned ──────────────────────────────────────────────────────────
 *   the composition authority is the ACCOUNT totals, never the spine's;
 *   the two components are disjoint BY CONSTRUCTION, not by luck;
 *   a combined total requires every component to be measured or provably empty;
 *   a hidden component can never become zero;
 *   and a specific question does not get the other component.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  composeInvestments, describeInvestmentConcept, resolveConceptBreadth,
  breadthNeedsPositionDetail, ComponentState, ConceptBreadth,
  type ConceptComposition,
} from './economic-concepts';
import type { AccountsSectionData } from './types';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

/** The real Space's account payload, unless overridden. */
function accounts(o: Partial<{
  totalInvestments: number; totalDigitalAssets: number;
  investments: number; digitalAssets: number;
  redactedCount: number; totalsUnconverted: boolean;
}> = {}): AccountsSectionData {
  return {
    totalInvestments:   o.totalInvestments   ?? 5006.557852,
    totalDigitalAssets: o.totalDigitalAssets ?? 19014.62555862176,
    redactedCount:      o.redactedCount      ?? 0,
    totalsUnconverted:  o.totalsUnconverted  ?? false,
    counts: {
      liquid: 4, liabilities: 2, realAssets: 0,
      investments:   o.investments   ?? 3,
      digitalAssets: o.digitalAssets ?? 4,
    },
  } as unknown as AccountsSectionData;
}

const compose = (o?: Parameters<typeof accounts>[0]) => composeInvestments(accounts(o));
const comp = (c: ConceptComposition | null, key: string) =>
  c?.components.find((x) => x.key === key);
const render = (c: ConceptComposition | null, b: Parameters<typeof describeInvestmentConcept>[1]) =>
  describeInvestmentConcept(c, b).join('\n');

const TRAD = 'TRADITIONAL_INVESTMENTS';
const DIG  = 'DIGITAL_ASSETS';

// ══ A / B — THE COMPOSITION, AND ITS ARITHMETIC ══════════════════════════════
{
  const c = compose();
  check('A: both components are assertable',
    comp(c, TRAD)?.state === ComponentState.ASSERTABLE
      && comp(c, DIG)?.state === ComponentState.ASSERTABLE);
  check('A: traditional is the ACCOUNT total, to the cent',
    comp(c, TRAD)?.amount === 5006.56, String(comp(c, TRAD)?.amount));
  check('A: digital is the ACCOUNT total, to the cent',
    comp(c, DIG)?.amount === 19014.63, String(comp(c, DIG)?.amount));
  check('B: the combined figure is the sum of the two',
    c?.combined === 24021.19, String(c?.combined));

  // The reconciliation a person actually performs: add the two numbers shown.
  check('B: combined reconciles to the components a reader can see',
    Math.round(((comp(c, TRAD)!.amount! + comp(c, DIG)!.amount!)) * 100) / 100 === c!.combined,
    'a total that cannot be reproduced from the visible parts reads as a bug, not as rounding');
}

// ══ THE DOUBLE-COUNT TRAP ════════════════════════════════════════════════════
//
// The whole reason this module exists.
{
  const c = compose();
  const spineTotal = 23943.29869062176;   // holdings.totalPortfolioValue, measured
  const trap = Math.round((spineTotal + comp(c, DIG)!.amount!) * 100) / 100;

  check('the spine total is NOT the combined figure',
    c!.combined !== Math.round(spineTotal * 100) / 100);
  check('spine + digital overstates by ~$18.9k and is never produced',
    Math.abs(trap - c!.combined!) > 18_000 && c!.combined === 24021.19,
    `trap ${trap} vs correct ${c!.combined}`);

  // Structural: the composer must not read the spine at all.
  const src = readFileSync(join(process.cwd(), 'lib/ai/economic-concepts.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  const composer = src.slice(src.indexOf('export function composeInvestments'),
                            src.indexOf('export const ConceptBreadth'));
  check('the composer never reads the position spine',
    !/\.totalPortfolioValue|\.positionCount|\.topPositions|holdings\w*\./i.test(composer),
    'a detail authority must never become the arithmetic authority');
  check('…and composes from the account totals',
    /totalInvestments/.test(src) && /totalDigitalAssets/.test(src));

  // The prompt warns wherever the spine is also present.
  check('the rendered block warns against the addition',
    /portfolio total already includes the digital assets/.test(render(c, ConceptBreadth.BROAD)));
}

// ══ DISJOINTNESS IS BY CONSTRUCTION ══════════════════════════════════════════
//
// Asserted against the CLASSIFIER, not against this Space's numbers — the
// property must hold for every corpus, or the sum is a heuristic.
{
  const cls = readFileSync(join(process.cwd(), 'lib/account-classifier.ts'), 'utf8');
  check('traditional is exactly type === "investment"',
    /investments\s*=\s*accounts\.filter\(\(a\) => a\.type === "investment"\)/.test(cls));
  check('digital is exactly the digital-asset type predicate',
    /digitalAssets\s*=\s*accounts\.filter\(\(a\) => isDigitalAssetAccountType\(a\.type\)\)/.test(cls));
  check('…over a type set that excludes "investment"',
    /DIGITAL_ASSET_ACCOUNT_TYPES = \["crypto"\]/.test(cls),
    'one scalar field, two mutually exclusive predicates ⇒ no account in both');
}

// ══ C / D / E — MISSING-COMPONENT SEMANTICS ══════════════════════════════════
{
  // D — a genuinely empty component is ZERO, and zero is a fact.
  const noCrypto = compose({ digitalAssets: 0, totalDigitalAssets: 0 });
  check('D: no digital-asset accounts ⇒ ABSENT, amount 0',
    comp(noCrypto, DIG)?.state === ComponentState.ABSENT && comp(noCrypto, DIG)?.amount === 0);
  check('D: …and the combined total is still allowed',
    noCrypto?.combined === 5006.56, String(noCrypto?.combined));
  check('D: …rendered as "none", never as an unknown',
    /Digital assets: none/.test(render(noCrypto, ConceptBreadth.BROAD)));

  // E — a hidden account makes BOTH components indeterminate, because the
  // redaction is not attributable to a class.
  const hidden = compose({ redactedCount: 2 });
  check('E: a hidden account ⇒ UNKNOWN, not zero',
    comp(hidden, TRAD)?.state === ComponentState.UNKNOWN
      && comp(hidden, DIG)?.state === ComponentState.UNKNOWN);
  check('E: …amounts are withheld, not defaulted',
    comp(hidden, TRAD)?.amount === null && comp(hidden, DIG)?.amount === null);
  check('E: …and the combined total is WITHHELD',
    hidden?.combined === null && hidden?.withheldReason !== null);
  const hr = render(hidden, ConceptBreadth.BROAD);
  check('E: the prompt forbids treating it as zero',
    /Do not treat this as zero/.test(hr));
  check('E: …and forbids summing what is present',
    /Do NOT add up what is present and present it as the whole/.test(hr));

  // An unconvertible balance is the same class of problem.
  const fx = compose({ totalsUnconverted: true });
  check('E: an unconverted balance also withholds the total',
    fx?.combined === null && /could not be converted/.test(fx!.withheldReason!));

  // J — nothing of either kind: the concept does not apply at all.
  check('J: no investment evidence ⇒ no composition, not a row of zeroes',
    compose({ investments: 0, digitalAssets: 0,
              totalInvestments: 0, totalDigitalAssets: 0 }) === null);
  check('J: …and nothing is rendered',
    render(compose({ investments: 0, digitalAssets: 0 }), ConceptBreadth.BROAD) === '');
}

// ══ G / H — ONE-SIDED SPACES ═════════════════════════════════════════════════
{
  // G — traditional only.
  const tradOnly = compose({ digitalAssets: 0, totalDigitalAssets: 0 });
  const g = render(tradOnly, ConceptBreadth.BROAD);
  check('G: traditional stated, digital proven empty, combined allowed',
    /Traditional investments: \$5,006\.56/.test(g)
      && /Digital assets: none/.test(g)
      && /Combined investments: \$5,006\.56/.test(g));

  // H — digital only, symmetric.
  const digOnly = compose({ investments: 0, totalInvestments: 0 });
  const h = render(digOnly, ConceptBreadth.BROAD);
  check('H: digital stated, traditional proven empty, combined allowed',
    /Digital assets: \$19,014\.63/.test(h)
      && /Traditional investments: none/.test(h)
      && /Combined investments: \$19,014\.63/.test(h));
}

// ══ BREADTH — BROAD vs SPECIFIC ══════════════════════════════════════════════
{
  const BROAD = [
    'What are my investments?', 'How much do I have invested?',
    'What is my investment portfolio?', 'Traditional vs crypto?',
    'How is my investment portfolio allocated?', 'Am I diversified?',
    'What is my asset allocation?', 'How am I doing financially?',
    'What is my net worth?',
    'How do my stocks compare to my bitcoin?',    // both sides named
  ];
  for (const q of BROAD) {
    check(`breadth: "${q}" ⇒ BROAD`, resolveConceptBreadth(q) === ConceptBreadth.BROAD,
      `got ${resolveConceptBreadth(q)}`);
  }

  const TRADITIONAL = [
    'What stocks do I own?', 'What securities do I hold?',
    'How much is in my brokerage accounts?', 'Which ETFs am I in?',
    'How much is in my 401k?',
  ];
  for (const q of TRADITIONAL) {
    check(`breadth: "${q}" ⇒ TRADITIONAL_ONLY`,
      resolveConceptBreadth(q) === ConceptBreadth.TRADITIONAL_ONLY, `got ${resolveConceptBreadth(q)}`);
  }

  const DIGITAL = [
    'What crypto do I own?', 'How much Bitcoin do I have?',
    'Show me my ethereum', 'What are my digital assets?', 'How much SOL do I hold?',
  ];
  for (const q of DIGITAL) {
    check(`breadth: "${q}" ⇒ DIGITAL_ONLY`,
      resolveConceptBreadth(q) === ConceptBreadth.DIGITAL_ONLY, `got ${resolveConceptBreadth(q)}`);
  }

  for (const q of ['Where is my money going?', 'What did I spend last month?',
                   'How much do I owe?', 'Who did I spend the most with?']) {
    check(`breadth: "${q}" ⇒ NONE`, resolveConceptBreadth(q) === ConceptBreadth.NONE);
  }
  check('breadth: no question ⇒ NONE', resolveConceptBreadth(undefined) === ConceptBreadth.NONE);
}

// ══ D / E — A SPECIFIC QUESTION GETS ONE COMPONENT ═══════════════════════════
{
  const c = compose();

  const trad = render(c, ConceptBreadth.TRADITIONAL_ONLY);
  check('D: a stocks question shows traditional only',
    /Traditional investments: \$5,006\.56/.test(trad) && !/Digital assets:/.test(trad));
  check('D: …no combined total is offered',
    !/Combined investments/.test(trad),
    'a combined figure would answer a question that was not asked');
  check('D: …and crypto is explicitly kept out',
    /do not fold digital assets into the figures/.test(trad));

  const dig = render(c, ConceptBreadth.DIGITAL_ONLY);
  check('E: a crypto question shows digital only',
    /Digital assets: \$19,014\.63/.test(dig) && !/Traditional investments:/.test(dig));
  check('E: …no combined total', !/Combined investments/.test(dig));
  check('E: …and securities are explicitly kept out',
    /do not fold traditional securities into the figures/.test(dig));

  check('a NONE breadth renders nothing at all',
    render(c, ConceptBreadth.NONE) === '');
}

// ══ RETRIEVAL COMPOSITION WITH CF-6 ══════════════════════════════════════════
{
  check('BROAD needs the position spine', breadthNeedsPositionDetail(ConceptBreadth.BROAD));
  check('TRADITIONAL_ONLY needs it', breadthNeedsPositionDetail(ConceptBreadth.TRADITIONAL_ONLY));
  check('DIGITAL_ONLY does NOT',
    !breadthNeedsPositionDetail(ConceptBreadth.DIGITAL_ONLY),
    'the crypto facts are already in the accounts domain and the CF-5 envelope');
  check('NONE does not', !breadthNeedsPositionDetail(ConceptBreadth.NONE));

  // One vocabulary, not two: CF-6 must consume this resolver rather than
  // carrying its own copy that can drift.
  const dr = readFileSync(join(process.cwd(), 'lib/ai/domain-relevance.ts'), 'utf8');
  check('CF-6 consumes the concept breadth resolver',
    /breadthNeedsPositionDetail\(resolveConceptBreadth\(question\)\)/.test(dr));
  check('…and keeps no investment vocabulary of its own',
    !/INVESTMENT_VOCABULARY|BROAD_FINANCIAL_VOCABULARY/.test(dr));
}

// ══ NEGATIVE — THE MODEL CONTRACT IS STATED, NOT IMPLIED ═════════════════════
{
  const r = render(compose(), ConceptBreadth.BROAD);
  check('NEG: the model is told not to redefine the concept',
    /do not redefine what counts as an investment/.test(r));
  check('NEG: …not to add any other total',
    /do not add any other total to them/.test(r));
  check('NEG: …and that components accompany the combined figure',
    /Always give the components alongside this total/.test(r));
  check('NEG: the combined figure states WHY it is valid',
    /disjoint by account classification/.test(r));

  // The block is compact and carries no conclusion.
  check('NEG: it stays compact', Math.ceil(r.length / 4) < 220, `${Math.ceil(r.length / 4)} tokens`);
  check('NEG: it grades nothing',
    !/HEALTHY|EXCELLENT|good|poor|should|recommend/i.test(r),
    'composition is arithmetic; advice is the model\'s job and the assessment\'s');
}

// ══ NEGATIVE — PURE, AND NO SECOND CLASSIFICATION ════════════════════════════
{
  const src = readFileSync(join(process.cwd(), 'lib/ai/economic-concepts.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  check('NEG: no queries', !/\bdb\b|prisma|findMany|aggregate|await/.test(src));
  check('NEG: no second account classification',
    !/a\.type|filter\(\(a\)/.test(src),
    'the partition has one authority — lib/account-classifier.ts');
  check('NEG: the combined total is derived, never stored',
    !/combined:\s*\d/.test(src));
}

console.log(`\neconomic-concepts: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
