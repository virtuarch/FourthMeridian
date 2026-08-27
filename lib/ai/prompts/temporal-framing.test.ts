/**
 * lib/ai/prompts/temporal-framing.test.ts   (CF-2)
 *
 * THE TEMPORAL FRAMING MUST SURVIVE INTO THE PROMPT — ALONGSIDE CF-1's.
 *
 *     npx tsx lib/ai/prompts/temporal-framing.test.ts
 *
 * Two halves, and both are load-bearing.
 *
 * ── 1. The ROUTER's reading of the user's words ─────────────────────────────
 * Through `classifyFinancialIntent`, the real production classifier. What a
 * message DENOTES is the first authority in the chain, and CF-0 found it losing
 * four whole categories of request: "ever", "recently", "currently" and
 * "before <date>" all arrived as `undefined` and became the same rolling 90-day
 * window. Two of those are legitimate interpretations and two are silent
 * substitutions, and nothing downstream could tell which.
 *
 * ── 2. The RENDERED prompt ──────────────────────────────────────────────────
 * Through `serializeContextBlock`, the real production serializer. A contract
 * that is correct in an object and absent from the string is worth nothing —
 * the same reason CF-1's disclosure is pinned against rendered text rather than
 * against `BoundedSelection`.
 *
 * ── Why the two disclosures are tested TOGETHER ─────────────────────────────
 * They are independent limitations and must survive simultaneously. An all-time
 * request served by a 90-day window, rendering 8 of 122 merchants, has to leave
 * the model knowing BOTH that this is not all-time evidence AND that these are
 * not all the merchants for even the period supplied. Either disclosure erasing
 * the other would be a regression that neither slice's own tests would catch.
 */

import { classifyFinancialIntent } from '@/lib/ai/intent';
import { serializeContextBlock } from './context-serializer';
import { boundedSelection } from '@/lib/ai/bounded-selection';
import {
  TemporalRequests, SelectionReasons, CoverageBounds, ScopeProvenances, unsuppliedScope,
  type TemporalScope,
} from '@/lib/ai/temporal-scope';
import { mkTxn, mkCtx } from '@/lib/ai/conformance/fixtures';
import type {
  SpaceContext_AI, TransactionsSummaryData, MerchantSummary,
} from '@/lib/ai/types';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

/** Fixed clock — every date assertion below is relative to this instant. */
const NOW = new Date('2026-08-27T00:00:00.000Z');
const win = (msg: string) => classifyFinancialIntent(msg, NOW).transactionWindow;

// ══ THE ROUTER READS THE USER'S TEMPORAL CLAIM ════════════════════════════════
//
// Cases A–J of the acceptance corpus, at the authority that owns "requested".

// A. exact month
{
  const w = win('How much did I spend last month?');
  check('A: "last month" ⇒ CALENDAR_MONTH, the prior full month',
    w?.requested === 'CALENDAR_MONTH' && w.startDate === '2026-07-01' && w.endDate === '2026-07-31',
    JSON.stringify(w));
}

// B. exact calendar year
{
  const w = win('How much did I spend in 2024?');
  check('B: a past year ⇒ CALENDAR_YEAR over the WHOLE year',
    w?.requested === 'CALENDAR_YEAR'
      && w.requestedStart === '2024-01-01' && w.requestedEnd === '2024-12-31',
    JSON.stringify(w));
}

// C. YTD
{
  const w = win('How much have I spent this year?');
  check('C: "this year" ⇒ YTD, not a full calendar year',
    w?.requested === 'YTD' && w.requestedStart === '2026-01-01' && w.requestedEnd === '2026-08-27',
    'the current year denotes only the part that has happened');
}

// D. explicit range
{
  const w = win('How much did I spend between March 2026 and May 2026?');
  check('D: an explicit range is read as a range, not as the year it mentions',
    w?.requested === 'EXPLICIT_RANGE'
      && w.startDate === '2026-03-01' && w.endDate === '2026-05-31',
    `before CF-2 the bare-year rule matched "2026" and selected the whole YTD. Got ${JSON.stringify(w)}`);
  const bare = win('what did I spend from january to march');
  check('D: a range with no year inherits the current one',
    bare?.requested === 'EXPLICIT_RANGE' && bare.startDate === '2026-01-01' && bare.endDate === '2026-03-31',
    JSON.stringify(bare));
}

// E / F. recent, currently — DECLARED interpretations, no dates
{
  for (const [msg, want] of [
    ['What have I spent recently?', 'RECENT'],
    ['What am I currently spending on?', 'CURRENT'],
  ] as const) {
    const w = win(msg);
    check(`${want === 'RECENT' ? 'E' : 'F'}: "${msg}" ⇒ ${want}, carried with NO dates`,
      w?.requested === want && w.startDate === undefined && w.endDate === undefined,
      'the request must travel even when it denotes no servable interval');
  }
}

// G. ever / all time
{
  for (const msg of ['How much have I ever spent?', 'what is my all-time spending', 'how much have I spent in total']) {
    check(`G: "${msg}" ⇒ ALL_TIME`, win(msg)?.requested === 'ALL_TIME', JSON.stringify(win(msg)));
  }
  const w = win('How much have I ever spent?');
  check('G: …denoting NO interval, which is what makes it unservable',
    w?.requestedStart === null && w.requestedEnd === null);
}

// H. before a date
{
  const w = win('What did I spend before June 2024?');
  check('H: "before June 2024" ⇒ BEFORE_DATE ending the day before that month',
    w?.requested === 'BEFORE_DATE' && w.requestedEnd === '2024-05-31' && w.requestedStart === null,
    `before CF-2 this matched "2024" and selected Jun–Dec 2024 — the COMPLEMENT. Got ${JSON.stringify(w)}`);
  check('H: …and produces NO query window, rather than manufacturing history',
    w?.startDate === undefined && w?.endDate === undefined);
}

// I. after a date
{
  const w = win('What did I spend after March 2025?');
  check('I: "after March 2025" ⇒ AFTER_DATE, served as an ordinary bounded range',
    w?.requested === 'AFTER_DATE' && w.startDate === '2025-03-01' && w.endDate === '2026-08-27',
    `before CF-2 this matched "2025" and selected Jan–Dec 2025. Got ${JSON.stringify(w)}`);
  check('I: "since January 1" is still YTD, not AFTER_DATE',
    win('what have I spent since January 1')?.requested === 'YTD',
    'the more specific existing reading must not be stolen');
}

// J. ambiguous wording carries no false precision
{
  check('J: an ordinary question makes no temporal claim at all',
    win('how is my debt looking') === undefined,
    'inventing a request where none was made is the same defect in the other direction');
}

// ══ CF-3 — THE UNPARSED-CLAIM HOLE, AT THE ROUTER ════════════════════════════
//
// CF-R0 measured eight of eleven ordinary temporal phrases resolving to
// UNSPECIFIED, which this contract correctly reads as "nothing was asked" — and
// therefore renders as FULLY COVERS. The contract was right; its input was not.
{
  const WAS_BROKEN = [
    'last year', 'last quarter', 'past year', 'past quarter', 'previous year',
    'previous quarter', 'this quarter', 'quarter to date',
  ];
  for (const p of WAS_BROKEN) {
    const w = win(`What did I spend ${p}?`);
    check(`CF-3: "${p}" no longer resolves to UNSPECIFIED`,
      w?.requested !== undefined,
      'this exact phrase rendered "no particular period" + "FULLY COVERS" at b895d94');
  }

  // The safeguard, at the same authority: an unrecognised period is a period.
  const odd = win('What did I spend during the summer before I moved?');
  check('CF-3: an unrecognised temporal phrase ⇒ UNRESOLVED, not UNSPECIFIED',
    odd?.requested === TemporalRequests.UNRESOLVED, JSON.stringify(odd));
  check('CF-3: …and an ordinary question is still UNSPECIFIED',
    win('What are my top merchants?') === undefined,
    'the safeguard must not turn a no-time question into a hedge');
}

// ══ THE RENDERED PROMPT ═══════════════════════════════════════════════════════

const merchant = (i: number): MerchantSummary => ({
  canonicalName: `Merchant ${String(i).padStart(3, '0')}`,
  total: 10_000 - i, occurrences: 3, category: 'Shopping',
  firstSeen: '2026-06-01', lastSeen: '2026-08-20',
} as unknown as MerchantSummary);

function render(o: {
  scope?: TemporalScope;
  merchantPop?: number;
  omitTxn?: boolean;
}): string {
  const txn = mkTxn({}) as TransactionsSummaryData & Record<string, unknown>;
  if (o.merchantPop !== undefined) {
    txn.merchants = boundedSelection(
      Array.from({ length: o.merchantPop }, (_, i) => merchant(i)), 25);
  }
  const ctx: SpaceContext_AI = o.omitTxn
    ? ({ ...mkCtx(txn), domains: {} } as SpaceContext_AI)
    : mkCtx(txn);
  return serializeContextBlock(ctx, undefined, o.scope);
}

function scopeOf(o: {
  intent: keyof typeof TemporalRequests; label: string;
  reqStart?: string | null; reqEnd?: string | null;
  selStart?: string; selEnd?: string; days?: number;
  reason?: typeof SelectionReasons[keyof typeof SelectionReasons];
  interpretation?: string | null;
  rows?: number; coverageFrom?: string; capped?: boolean;
}): TemporalScope {
  return {
    requested: { intent: TemporalRequests[o.intent], label: o.label,
                 startDate: o.reqStart ?? null, endDate: o.reqEnd ?? null },
    selected:  { startDate: o.selStart ?? '2026-05-29', endDate: o.selEnd ?? '2026-08-27',
                 days: o.days ?? 90, reason: o.reason ?? SelectionReasons.DEFAULT_WINDOW,
                 interpretation: o.interpretation ?? null },
    coverage:  { fromDate: o.coverageFrom ?? o.selStart ?? '2026-05-29',
                 toDate: o.selEnd ?? '2026-08-27', transactionCount: o.rows ?? 455,
                 boundedBy: o.capped ? CoverageBounds.FETCH_CAP : null },
  };
}

// ── The scope block reaches the prompt, and leads it ────────────────────────
{
  const p = render({ scope: scopeOf({ intent: 'ALL_TIME', label: 'all time' }) });
  check('the scope block is rendered into the prompt',
    p.includes('TRANSACTION SCOPE — what was asked for'));
  check('…BEFORE the analysis-window block whose figures it governs',
    p.indexOf('TRANSACTION SCOPE —') < p.indexOf('Transaction analysis window'),
    'a caveat after the number competes with a number the reader already believes');
}

// ── K. complete interval, zero transactions ────────────────────────────────
{
  const p = render({ scope: scopeOf({
    intent: 'CALENDAR_MONTH', label: 'last month',
    reqStart: '2026-07-01', reqEnd: '2026-07-31',
    selStart: '2026-07-01', selEnd: '2026-07-31', days: 31,
    reason: SelectionReasons.AS_REQUESTED, rows: 0,
  }) });
  check('K: a complete, empty interval LICENSES a no-activity statement',
    /may say there was no recorded activity/.test(p));
  check('K: …and emits no scope warning, because nothing is wrong',
    !/DOES NOT COVER/.test(p));
}

// ── L. incomplete interval, zero returned ──────────────────────────────────
{
  const p = render({ scope: scopeOf({
    intent: 'CALENDAR_MONTH', label: 'last month',
    reqStart: '2026-07-01', reqEnd: '2026-07-31',
    selStart: '2026-07-01', selEnd: '2026-07-31', days: 31,
    reason: SelectionReasons.AS_REQUESTED, rows: 0,
    coverageFrom: '2026-07-20', capped: true,
  }) });
  check('L: a bounded, empty interval FORBIDS a no-activity statement',
    /absence of evidence, not evidence of absence/.test(p) && /do NOT report \$0/.test(p));
  check('L: …and never says the activity was zero',
    !/may say there was no recorded activity/.test(p));
}

// ── M. transaction fetch cap hit ───────────────────────────────────────────
{
  const p = render({ scope: scopeOf({
    intent: 'CALENDAR_YEAR', label: '2026',
    reqStart: '2026-01-01', reqEnd: '2026-12-31',
    selStart: '2026-01-01', selEnd: '2026-12-31', days: 365,
    reason: SelectionReasons.AS_REQUESTED,
    rows: 5000, coverageFrom: '2026-03-14', capped: true,
  }) });
  check('M: the fetch cap is disclosed as a coverage limit',
    /evidence covers only 2026-03-14 to 2026-12-31/.test(p));
  check('M: …and is stated as SEPARATE from the period being loaded',
    /even though the period was loaded/.test(p));
}

// ── The requested period was never queried ─────────────────────────────────
{
  const p = render({
    omitTxn: true,
    scope: unsuppliedScope({ intent: TemporalRequests.CALENDAR_YEAR, label: '2023',
                             startDate: '2023-01-01', endDate: '2023-12-31' }),
  });
  check('an unqueried period still produces a scope block with no transactions present',
    /TRANSACTION SCOPE/.test(p) && /Transactions loaded: NONE/.test(p),
    'measured: "spend in 2023" clamps past its own ceiling, drops the domain, and said NOTHING');
  check('…and forbids answering from another period or reporting $0',
    /Do NOT answer the question from any other period/.test(p));
}

// ══ N — CF-1 COMPOSITION: BOTH LIMITATIONS SURVIVE TOGETHER ══════════════════
//
// An all-time request, a 90-day window, and 8 of 122 merchants. The model must
// end up knowing this is neither all-time evidence nor the whole merchant set.
{
  const p = render({
    scope: scopeOf({ intent: 'ALL_TIME', label: 'all time' }),
    merchantPop: 122,
  });

  check('N: the temporal shortfall survives',
    /DOES NOT COVER what was asked/.test(p) && /answer to "all time"/.test(p));
  check('N: the bounded-list disclosure survives ALONGSIDE it',
    /showing 8 of 122 spending merchants/.test(p) && /114 further spending merchant\(s\)/.test(p),
    'CF-1 and CF-2 are independent; neither may erase the other');

  // Order matters for neither, but co-presence does — assert both are intact in
  // ONE rendered string, which is the only place the interaction can go wrong.
  const scopeAt = p.indexOf('TRANSACTION SCOPE —');
  const boundsAt = p.indexOf('showing 8 of 122');
  check('N: both disclosures are present in the same prompt',
    scopeAt >= 0 && boundsAt >= 0 && scopeAt !== boundsAt);

  // The converse composition: a fully satisfied window, still a bounded list.
  const q = render({
    scope: scopeOf({ intent: 'CALENDAR_MONTH', label: 'last month',
                     reqStart: '2026-07-01', reqEnd: '2026-07-31',
                     selStart: '2026-07-01', selEnd: '2026-07-31', days: 31,
                     reason: SelectionReasons.AS_REQUESTED }),
    merchantPop: 122,
  });
  check('N: a SATISFIED window keeps the merchant bound',
    /FULLY COVERS what was asked/.test(q) && /showing 8 of 122 spending merchants/.test(q),
    'a good date window must not read as "everything here is complete"');

  // And complete merchants under an insufficient window.
  const r = render({
    scope: scopeOf({ intent: 'ALL_TIME', label: 'all time' }),
    merchantPop: 5,
  });
  check('N: a COMPLETE merchant list keeps the temporal shortfall',
    /showing all 5 spending merchants/.test(r) && /DOES NOT COVER what was asked/.test(r));
}

// ══ CF-3 — UNRESOLVED RENDERS AS UNCERTAINTY, NOT AS A SHORTFALL ═════════════
//
// A shortfall compares two known intervals. Here the requested one is unknown,
// so there is nothing to compare and nothing to quantify — and saying "does not
// cover" would imply we know what it failed to cover.
{
  const p = render({ scope: scopeOf({ intent: 'UNRESOLVED', label: 'the period named in the question' }) });

  check('CF-3: the prompt says the period could not be resolved',
    /could NOT be resolved to dates/.test(p));
  check('CF-3: …and never claims the default covers it',
    !/FULLY COVERS/.test(p) && !/no particular period/.test(p),
    'the exact two sentences the CF-R0 reproduction found');
  check('CF-3: …names the default period the figures DO describe',
    /DEFAULT period — not the period the user asked about/.test(p));
  check('CF-3: …permits the figures rather than refusing outright',
    /Then give the figures/.test(p),
    'an unresolved period is not a reason to answer nothing');
  check('CF-3: …and offers the useful next move',
    /Ask which dates the user means/.test(p));

  // The instructions are SEPARATE and ORDERED. A compound "name the period and
  // say you could not resolve it" was half-followed in 1 of 2 live runs — the
  // model named the period and dropped the admission.
  check('CF-3: the admission is its own numbered instruction, and comes first',
    /1\. Say FIRST that you could not work out which dates/.test(p)
      && p.indexOf('1. Say FIRST') < p.indexOf('2. Then give the figures'));
  check('CF-3: …and leading with the numbers is explicitly forbidden',
    /do NOT open with the numbers/.test(p));
  check('CF-3: it does NOT borrow the shortfall wording',
    !/DOES NOT COVER what was asked/.test(p),
    'that sentence quantifies a gap between two known intervals');
}

// ══ CF-3 — THE HARD INVARIANT, IN THE RENDERED STRING ════════════════════════
//
// "The user asked about no particular period" may appear ONLY when the
// classifier proved there was no temporal claim.
{
  const noClaim = render({ scope: scopeOf({ intent: 'UNSPECIFIED', label: 'no period named' }) });
  check('INVARIANT: an UNSPECIFIED request may say "no particular period"',
    /no particular period/.test(noClaim));

  for (const intent of [
    'UNRESOLVED', 'CALENDAR_YEAR', 'CALENDAR_QUARTER', 'LAST_N_MONTHS',
    'ALL_TIME', 'RECENT', 'BEFORE_DATE',
  ] as const) {
    const r = render({ scope: scopeOf({ intent, label: 'x', reqStart: '2025-01-01', reqEnd: '2025-12-31' }) });
    check(`INVARIANT: a ${intent} request never says "no particular period"`,
      !/no particular period/.test(r));
  }
}

// ══ CF-4 — WHY THIS PERIOD, IN THE RENDERED PROMPT ═══════════════════════════
//
// Four provenances, four distinguishable renderings. The model must never have
// to infer why a period was selected — an inherited scope in particular looks
// identical to a freshly-asked one unless the prompt says otherwise.
{
  const inherited = render({ scope: {
    ...scopeOf({ intent: 'CALENDAR_YEAR', label: '2025',
                 reqStart: '2025-01-01', reqEnd: '2025-12-31',
                 selStart: '2025-01-01', selEnd: '2025-12-31', days: 365,
                 reason: SelectionReasons.AS_REQUESTED }),
    requested: { intent: TemporalRequests.CALENDAR_YEAR, label: '2025',
                 startDate: '2025-01-01', endDate: '2025-12-31',
                 provenance: ScopeProvenances.INHERITED, inheritedFrom: '2025' },
  } });
  check('CF-4: an inherited period says it was NOT restated',
    /NOT restated in the latest message/.test(inherited));
  check('CF-4: …names the phrase it came from',
    /carries forward from earlier in this conversation \("2025"\)/.test(inherited));
  check('CF-4: …and tells the model to name it so the user can change it',
    /name it in your reply/.test(inherited) && /change it if they meant another/.test(inherited));

  const cleared = render({ scope: {
    ...scopeOf({ intent: 'UNSPECIFIED', label: 'no period named' }),
    requested: { intent: TemporalRequests.UNSPECIFIED, label: 'no period named',
                 startDate: null, endDate: null,
                 provenance: ScopeProvenances.CLEARED, inheritedFrom: null },
  } });
  check('CF-4: a cleared scope says the earlier period was discarded',
    /just DISCARDED the period established earlier/.test(cleared));
  check('CF-4: …and forbids answering from it',
    /Do not answer from it/.test(cleared));

  const dflt = render({ scope: {
    ...scopeOf({ intent: 'UNSPECIFIED', label: 'no period named' }),
    requested: { intent: TemporalRequests.UNSPECIFIED, label: 'no period named',
                 startDate: null, endDate: null,
                 provenance: ScopeProvenances.NONE, inheritedFrom: null },
  } });
  check('CF-4: a scope-free question names the period as a DEFAULT',
    /this is the DEFAULT period this system loads/.test(dflt));
  check('CF-4: …and is still answered directly, with the period named',
    /Answer directly from it, and name the period your figures describe/.test(dflt));
  check('CF-4: …rather than the unqualified "no scope caveat" line',
    !/with no scope caveat/.test(dflt),
    'a 90-day figure presented with no caveat is how a default becomes a claim');

  // A period the user DID name this turn keeps the original wording.
  const thisTurn = render({ scope: {
    ...scopeOf({ intent: 'CALENDAR_YEAR', label: '2025',
                 reqStart: '2025-01-01', reqEnd: '2025-12-31',
                 selStart: '2025-01-01', selEnd: '2025-12-31', days: 365,
                 reason: SelectionReasons.AS_REQUESTED }),
    requested: { intent: TemporalRequests.CALENDAR_YEAR, label: '2025',
                 startDate: '2025-01-01', endDate: '2025-12-31',
                 provenance: ScopeProvenances.THIS_TURN, inheritedFrom: null },
  } });
  check('CF-4: a period asked for THIS turn carries no inheritance notice',
    !/NOT restated/.test(thisTurn) && /FULLY COVERS what was asked/.test(thisTurn));

  // All four are distinguishable from one another.
  const heads = [inherited, cleared, dflt, thisTurn].map((p) =>
    p.slice(p.indexOf('TRANSACTION SCOPE'), p.indexOf('TRANSACTION SCOPE') + 700));
  check('CF-4: the four provenances render four DIFFERENT blocks',
    new Set(heads).size === 4);
}

// ══ NEGATIVE — CF-2 ADDS FRAMING AND NOTHING ELSE ════════════════════════════
{
  const withScope = render({ scope: scopeOf({ intent: 'ALL_TIME', label: 'all time' }), merchantPop: 122 });
  const without   = render({ merchantPop: 122 });

  // Every line of the no-scope rendering must still appear, unchanged, in the
  // scoped one. CF-2 may ADD lines; it may not alter or drop a figure.
  const missing = without.split('\n').filter((l) => l.trim() !== '' && !withScope.includes(l));
  check('NEG: the scope block only ADDS lines — nothing existing is altered',
    missing.length === 0, `changed/dropped: ${missing.slice(0, 3).join(' | ')}`);

  check('NEG: merchant figures are untouched',
    withScope.includes('Merchant 000: $10,000.00') && withScope.includes('Merchant 007: $9,993.00'));
  check('NEG: the KD-16 availability caveat still ships',
    /only period FETCHED into this context/.test(withScope));
  check('NEG: the KD-18 attribution disclosure still ships',
    /attribut/i.test(withScope));
  check('NEG: an ordinary prompt with no temporal claim gains no warning',
    !/⚠/.test(render({ scope: scopeOf({ intent: 'UNSPECIFIED', label: 'no period named' }) })),
    'warning on every prompt is how a real warning gets ignored');
}

console.log(`\ntemporal-framing: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
