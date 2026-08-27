/**
 * lib/ai/domain-relevance.test.ts   (CF-6)
 *
 * A SPACE CATEGORY MUST NOT DECIDE WHAT EVIDENCE EXISTS.
 *
 *     npx tsx lib/ai/domain-relevance.test.ts
 *
 * ── The failure ─────────────────────────────────────────────────────────────
 * Measured through the production path at ed2dd93. A PERSONAL Space holding
 * three traditional-investment accounts, four digital-asset accounts and eleven
 * live positions worth $24,021 was told, on EVERY question:
 *
 *     "No holdings data in this Space context — existing investments not
 *      visible here."
 *
 * The data was there. Visibility permitted it. The assembler returns those
 * eleven positions in 110 ms when called directly. PERSONAL simply maps to
 * FINANCE_CORE, and FINANCE_CORE omits holdings — so a label decided what
 * evidence existed.
 *
 * ── What is pinned ──────────────────────────────────────────────────────────
 * Both halves, because either alone is a worse system than the one before it:
 *
 *   a relevant question with evidence LOADS the domain,
 *   and everything else does NOT.
 *
 * CF-5 proved a great deal of evidence exists. Answering that by loading all of
 * it every turn would make the 21k-token prompt bigger and the retrieval
 * problem worse. The corpus therefore spends as much effort on what must stay
 * absent as on what must appear.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  resolveDomains, DomainReasons, type DomainResolution,
} from './domain-relevance';
import { FinanceDomains, type ContextDomain } from './types';
import { EvidenceAvailability, type CoverageEnvelope } from './coverage-envelope';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

/** The real Space's manifest: PERSONAL → FINANCE_CORE. */
const FINANCE_CORE: ContextDomain[] = [
  FinanceDomains.ACCOUNTS,
  FinanceDomains.TRANSACTIONS_SUMMARY,
  FinanceDomains.SNAPSHOT_HISTORY,
];

/** A CF-5 census. Defaults match Chris' Space: 3 investment, 4 digital-asset. */
function evidence(o: Partial<{ investments: number; digitalAssets: number }> = {}): CoverageEnvelope {
  return {
    transactions: { availability: EvidenceAvailability.AVAILABLE,
                    span: { fromISO: '2024-07-18', toISO: '2026-08-26', count: 4_156 } },
    snapshots:    { availability: EvidenceAvailability.AVAILABLE,
                    span: { fromISO: '2024-07-21', toISO: '2026-08-27', count: 768 } },
    accounts: {
      cash: 4, debt: 2,
      investments:   o.investments   ?? 3,
      digitalAssets: o.digitalAssets ?? 4,
      other: 0,
    },
    chains: [{ chain: 'BTC', fromISO: '2023-03-18', toISO: '2026-08-27', claimsHistory: true }],
  };
}

const resolve = (question: string, o?: {
  evidence?: CoverageEnvelope; agentScope?: string[]; manifest?: ContextDomain[];
}): DomainResolution => resolveDomains({
  manifest:   o?.manifest ?? FINANCE_CORE,
  agentScope: o?.agentScope ?? [],
  evidence:   o?.evidence === undefined ? evidence() : o.evidence,
  question,
});

const loaded  = (r: DomainResolution, d: ContextDomain) => r.domains.includes(d);
const reasonOf = (r: DomainResolution, d: ContextDomain) =>
  r.decisions.find((x) => x.domain === d)?.reason;

const HOLDINGS = FinanceDomains.HOLDINGS_SUMMARY;

// ══ A / B / C / I — AN INVESTMENT QUESTION REACHES THE EVIDENCE ══════════════
{
  const ASKS = [
    'What are my investments?',
    'How much do I have invested?',
    'What stocks do I own?',
    'How is my portfolio doing?',
    'What ETFs am I holding?',
    'Show me my brokerage positions',
    'Am I diversified?',
    'What is my asset allocation?',
    'How much is in my 401k?',
  ];
  for (const q of ASKS) {
    const r = resolve(q);
    check(`A/B/C: "${q}" loads holdings`, loaded(r, HOLDINGS),
      `reason ${reasonOf(r, HOLDINGS)} — PERSONAL omits holdings from its manifest`);
  }
  check('I: …and the reason is EVIDENCE, not the manifest',
    reasonOf(resolve('What are my investments?'), HOLDINGS) === DomainReasons.EVIDENCE,
    'a PERSONAL Space with investment accounts must not be categorically forbidden');

  // The manifest's own domains are untouched.
  const r = resolve('What are my investments?');
  for (const d of FINANCE_CORE) {
    check(`A: manifest domain ${d} still loads`, loaded(r, d)
      && reasonOf(r, d) === DomainReasons.MANIFEST);
  }
}

// ══ D / E — WHAT MUST NOT GROW ═══════════════════════════════════════════════
//
// The counterweight, and the half that keeps CF-6 from being a regression.
{
  const NOT_RELEVANT = [
    'Where is my money going?',
    'What did I spend last month?',
    'Who did I spend the most with?',
    'How much do I owe?',
    'What was my most expensive purchase?',
    'How much did I earn this year?',
    'Am I overspending?',
  ];
  for (const q of NOT_RELEVANT) {
    const r = resolve(q);
    check(`E: "${q}" does NOT load holdings`, !loaded(r, HOLDINGS),
      'availability must expand what a question CAN reach, not what it does reach');
    check(`E: …reported as NOT_RELEVANT`, reasonOf(r, HOLDINGS) === DomainReasons.NOT_RELEVANT);
  }

  // D — crypto questions specifically. `holdings_summary` is the canonical
  // POSITION spine and already contains the digital assets ($19,012 of the real
  // Space's $24,021), so a crypto question does not need it: presence, chain
  // coverage and account totals are already in the accounts domain and the CF-5
  // envelope.
  for (const q of ['What crypto do I have?', 'How much bitcoin do I own?',
                   'Show me my ethereum', 'What are my digital assets worth?']) {
    check(`D: "${q}" does NOT pull in the whole position spine`, !loaded(resolve(q), HOLDINGS),
      'the future investments = traditional + digital rule is CF-7, not a reason to load here');
  }
}

// ══ F — BROAD FINANCIAL QUESTIONS ════════════════════════════════════════════
{
  for (const q of ['How am I doing financially?', 'What is my net worth?',
                   'Give me my full financial picture', 'What is my overall financial health?']) {
    check(`F: "${q}" may reach holdings`, loaded(resolve(q), HOLDINGS));
  }
  // …but "broad" is narrow on purpose. Treating every general word as broad
  // would reintroduce load-everything through the back door.
  for (const q of ['How much money do I have?', 'What is going on with my money?']) {
    check(`F: "${q}" is NOT treated as broad`, !loaded(resolve(q), HOLDINGS),
      'a broad-vocabulary list that swallows ordinary phrasing is a load-everything rule');
  }
}

// ══ G — NO EVIDENCE, NO DOMAIN ═══════════════════════════════════════════════
//
// A Space without investment accounts must not load or advertise holdings
// merely because the user asked.
{
  const none = evidence({ investments: 0, digitalAssets: 0 });
  const r = resolve('What are my investments?', { evidence: none });
  check('G: no investment evidence ⇒ holdings not loaded', !loaded(r, HOLDINGS));
  check('G: …reported as NO_EVIDENCE, distinct from NOT_RELEVANT',
    reasonOf(r, HOLDINGS) === DomainReasons.NO_EVIDENCE,
    'the two absences are different facts and a reader must be able to tell them apart');

  // Either class alone is enough: the spine holds securities and digital assets.
  check('G: digital assets alone make holdings reachable',
    loaded(resolve('What are my investments?',
      { evidence: evidence({ investments: 0, digitalAssets: 4 }) }), HOLDINGS));
  check('G: securities alone make holdings reachable',
    loaded(resolve('What are my investments?',
      { evidence: evidence({ investments: 3, digitalAssets: 0 }) }), HOLDINGS));

  // A spending question on an evidence-free Space is NOT_RELEVANT, not
  // NO_EVIDENCE — the domain was never wanted, and reporting absence would read
  // as a finding about the Space rather than about the question.
  check('G: relevance is decided before evidence',
    reasonOf(resolve('Where is my money going?', { evidence: none }), HOLDINGS)
      === DomainReasons.NOT_RELEVANT);
}

// ══ H — VISIBILITY AND AGENT SCOPE ═══════════════════════════════════════════
{
  // The envelope is the visibility authority: CF-5 counts only accounts whose
  // link grants transaction-level detail, so a BALANCE_ONLY investment account
  // never appears here and the domain is never reached for it.
  const restricted = evidence({ investments: 0, digitalAssets: 0 });
  check('H: an account the Space may not see in detail yields no domain',
    !loaded(resolve('What are my investments?', { evidence: restricted }), HOLDINGS),
    'measured: CF-5 excludes BALANCE_ONLY links, so they cannot make a domain available');

  // agentScope is a PERMISSION, not a default — a question cannot argue with it.
  const scoped = resolve('What are my investments?', {
    agentScope: [FinanceDomains.ACCOUNTS, FinanceDomains.TRANSACTIONS_SUMMARY],
  });
  check('H: agentScope still excludes holdings, evidence and relevance regardless',
    !loaded(scoped, HOLDINGS) && reasonOf(scoped, HOLDINGS) === DomainReasons.OUT_OF_SCOPE);
  check('H: …and excludes manifest domains too',
    !loaded(scoped, FinanceDomains.SNAPSHOT_HISTORY)
      && reasonOf(scoped, FinanceDomains.SNAPSHOT_HISTORY) === DomainReasons.OUT_OF_SCOPE);
  check('H: an agentScope that permits holdings still needs evidence + relevance',
    loaded(resolve('What are my investments?',
      { agentScope: [...FINANCE_CORE, HOLDINGS] }), HOLDINGS));
}

// ══ CATEGORY DEFAULTS SURVIVE ════════════════════════════════════════════════
{
  // A manifest that already includes holdings is unaffected — no double entry,
  // and the reason stays MANIFEST.
  const withHoldings = [...FINANCE_CORE, HOLDINGS];
  const r = resolve('Where is my money going?', { manifest: withHoldings });
  check('an INVESTMENT-category manifest keeps holdings on an unrelated question',
    loaded(r, HOLDINGS) && reasonOf(r, HOLDINGS) === DomainReasons.MANIFEST,
    'CF-6 removes the category VETO, not the category default');
  check('…and the domain appears exactly once',
    r.domains.filter((d) => d === HOLDINGS).length === 1);
}

// ══ NEGATIVE — NO EVIDENCE OR QUESTION ⇒ EXACTLY THE OLD BEHAVIOUR ═══════════
{
  const bare = resolveDomains({ manifest: FINANCE_CORE, agentScope: [] });
  check('NEG: no envelope and no question ⇒ manifest only',
    bare.domains.join(',') === FINANCE_CORE.join(','),
    'every existing caller — the Brief included — must be untouched');
  check('NEG: …with no conditional decisions recorded',
    bare.decisions.every((d) => d.reason === DomainReasons.MANIFEST));

  check('NEG: a question with no envelope cannot expand',
    !loaded(resolveDomains({ manifest: FINANCE_CORE, agentScope: [], question: 'What are my investments?' }), HOLDINGS),
    'relevance without an availability authority would be a guess');
  check('NEG: an envelope with no question cannot expand',
    !loaded(resolveDomains({ manifest: FINANCE_CORE, agentScope: [], evidence: evidence() }), HOLDINGS),
    'availability alone must never load a domain — that is the load-everything failure');
}

// ══ NEGATIVE — THE RESOLVER IS PURE AND CENSUSES NOTHING ═════════════════════
{
  const src = readFileSync(join(process.cwd(), 'lib/ai/domain-relevance.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

  check('NEG: the resolver runs no queries of its own',
    !/\bdb\b|prisma|findMany|aggregate|await/.test(src),
    'CF-5 already censused this; a second copy is a second thing that can disagree');
  check('NEG: …and reads visibility from the envelope, not from links',
    !/visibilityLevel|spaceAccountLink|TRANSACTION_DETAIL/.test(src),
    'one visibility implementation, under the parity guard');
  const envReads = [...src.matchAll(/env(?:elope)?\.(\w+)(?:\.(\w+))?/g)]
    .map((m) => [m[1], m[2]].filter(Boolean).join('.'));
  check('NEG: it reads only account PRESENCE counts from the envelope',
    envReads.every((r) => r.startsWith('accounts.')),
    `also read: ${[...new Set(envReads.filter((r) => !r.startsWith('accounts.')))].join(', ')}`);
  check('NEG: …and never a span, a total or a figure',
    !/\.span\b|\.count\b|totalValue|reportingValue/.test(src),
    'a domain resolver that reads amounts has started making financial decisions');
}

console.log(`\ndomain-relevance: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
