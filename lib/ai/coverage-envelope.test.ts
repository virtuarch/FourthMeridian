/**
 * lib/ai/coverage-envelope.test.ts   (CF-5)
 *
 * AVAILABLE IS NOT LOADED.
 *
 *     npx tsx lib/ai/coverage-envelope.test.ts
 *
 * ── The failure ─────────────────────────────────────────────────────────────
 * CF-R0 measured a Space holding thousands of transactions across years, and a
 * prompt carrying ninety days of them with no statement anywhere that the rest
 * existed. Every layer was honest about its own selection and none could
 * describe what lay outside it, so the model's only truthful sentence was "I
 * can only see the last 90 days" — false about the product, and an apology from
 * a system that holds the data.
 *
 * ── What is pinned ──────────────────────────────────────────────────────────
 * That the two halves are rendered TOGETHER and cannot be read as one. A block
 * that says "Jul 2024–Aug 2026" without saying which slice was loaded invites
 * the model to quote figures it was never given; a block that says only what
 * was loaded is the state CF-5 exists to leave behind.
 *
 * And the negatives, which are most of this file: presence is not detail,
 * quantity is not valuation, absence is not advertised, and evidence the Space
 * may not see is never counted.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  describeCoverageEnvelope, EvidenceAvailability, coverageMeaning, loadCoverageEnvelope,
  type CoverageEnvelope, type ChainQuantityCoverage,
} from './coverage-envelope';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

/** An envelope shaped like the real Space's, unless overridden. */
function env(o: Partial<{
  txnFrom: string | null; txnTo: string | null; txnCount: number;
  snapFrom: string | null; snapCount: number;
  cash: number; debt: number; investments: number; digitalAssets: number; other: number;
  chains: ChainQuantityCoverage[];
  unknown: boolean;
  /** RLS-AI-S8 — rows that exist and carry no economic date. */
  txnUndated: number;
}> = {}): CoverageEnvelope {
  const txnCount = o.txnCount ?? 4_156;
  const txnUndated = o.txnUndated ?? 0;
  const snapCount = o.snapCount ?? 768;
  return {
    transactions: {
      availability: o.unknown ? EvidenceAvailability.UNKNOWN
                  : (txnCount + txnUndated) > 0
                    ? EvidenceAvailability.AVAILABLE : EvidenceAvailability.NONE,
      span: { fromISO: o.txnFrom === undefined ? '2024-07-18' : o.txnFrom,
              toISO:   o.txnTo   === undefined ? '2026-08-26' : o.txnTo, count: txnCount,
              ...(txnUndated > 0 ? { undatedCount: txnUndated } : {}) },
    },
    snapshots: {
      availability: snapCount > 0 ? EvidenceAvailability.AVAILABLE : EvidenceAvailability.NONE,
      span: { fromISO: o.snapFrom === undefined ? '2024-07-21' : o.snapFrom,
              toISO: '2026-08-27', count: snapCount },
    },
    accounts: {
      cash: o.cash ?? 4, debt: o.debt ?? 2, investments: o.investments ?? 3,
      digitalAssets: o.digitalAssets ?? 4, other: o.other ?? 0,
    },
    // RLS-AI-S0 — the census ran. `unknown: true` models a census that did NOT.
    unavailability: o.unknown ? 'CENSUS_FAILED' : null,
    chains: o.chains ?? [
      { chain: 'BTC', fromISO: '2023-03-18', toISO: '2026-08-27', claimsHistory: true },
      { chain: 'ETH', fromISO: '2021-04-27', toISO: '2026-08-27', claimsHistory: true },
      { chain: 'SOL', fromISO: '2022-03-26', toISO: '2026-08-27', claimsHistory: true },
    ],
  };
}

const render = (e: CoverageEnvelope, from?: string, to?: string) =>
  describeCoverageEnvelope(e, from ? { fromISO: from, toISO: to! } : null).join('\n');

// ══ A / D — A NARROW SELECTION FROM A WIDER RECORD ═══════════════════════════
//
// The default 90-day window, and the sentence the whole slice exists for.
{
  const r = render(env(), '2026-05-29', '2026-08-26');

  check('A: the available range is stated', /Transactions EXIST Jul 2024–Aug 2026/.test(r));
  check('A: …with how much evidence there is', /4,156 records/.test(r));
  check('A: …and what THIS TURN actually loaded',
    /this turn LOADED only 2026-05-29 to 2026-08-26/.test(r));
  check('A: the loaded period is named a SELECTION, not a limit',
    /a selection from that record, not its limit/.test(r));
  check('A: the model may state the reach of the record',
    /State the full range when asked what exists/.test(r));
  check('A: …but may NOT quote figures from outside it',
    /quote figures only from the loaded period/.test(r),
    'availability without this line invites answers from history never computed');

  // The two halves are one sentence. A future edit that renders availability
  // somewhere else would break this, which is the point.
  const line = r.split('\n').find((l) => /Transactions EXIST/.test(l)) ?? '';
  check('A: AVAILABLE and LOADED appear on the SAME line',
    /Jul 2024/.test(line) && /2026-05-29/.test(line));
}

// ══ B — A WIDE SELECTION ═════════════════════════════════════════════════════
{
  const r = render(env(), '2024-07-18', '2026-08-26');
  check('B: when the loaded range IS the available range, no shortfall is implied',
    /this turn loaded that full range/.test(r) && !/LOADED only/.test(r),
    'hedging a complete load teaches the reader to ignore the hedge');
}

// ══ C — AN ALL-TIME QUESTION ═════════════════════════════════════════════════
//
// CF-2 still says the request is unsatisfied. CF-5's job is only that the model
// can now say what DOES exist instead of "only 90 days".
{
  const r = render(env(), '2026-05-29', '2026-08-26');
  check('C: the block never claims only the loaded period exists',
    !/only (?:the )?(?:last )?90 days/i.test(r) && /Jul 2024/.test(r));
  check('C: …and the header says outright that this is not what was loaded',
    /This is NOT what was loaded below/.test(r));
}

// ══ E — INVESTMENT AND DIGITAL-ASSET PRESENCE ════════════════════════════════
//
// CF-5 establishes presence. It must NOT teach composition — that is CF-6's
// slice — and must not let presence be read as loaded detail.
{
  const r = render(env(), '2026-05-29', '2026-08-26');
  check('E: traditional investment presence is stated', /traditional investments \(3\)/.test(r));
  check('E: digital-asset presence is stated', /digital assets \(4\)/.test(r));
  check('E: presence is explicitly NOT detail',
    /Those accounts EXIST; their detail may not be loaded/.test(r));
  check('E: …and the model is forbidden from reporting absence',
    /never say the Space has none/.test(r),
    'the measured failure: an assessment saying "existing investments not visible here"');

  // The composition rule belongs to CF-6. CF-5 must not sum the two classes or
  // name them as one concept.
  check('E: the block does NOT teach investments = traditional + crypto',
    !/investments?\s*=/.test(r) && !/combined|total investments|altogether/i.test(r),
    'composition is CF-6; asserting it here would be a rule with no authority behind it');
}

// ══ F — CRYPTO: QUANTITY IS NOT VALUATION ════════════════════════════════════
//
// The hard requirement. ETH's quantity is provable years before its price is.
{
  const r = render(env(), '2026-05-29', '2026-08-26');
  check('F: per-chain quantity coverage is stated',
    /BTC Mar 2023/.test(r) && /ETH Apr 2021/.test(r) && /SOL Mar 2022/.test(r));
  check('F: the heading says QUANTITY',
    /Digital-asset QUANTITY history/.test(r));
  check('F: …and the quantity/valuation distinction is stated as a rule',
    /prove HOW MUCH was held, not what it was worth/.test(r));
  check('F: …forbidding the conversion outright',
    /never convert a quantity range into a portfolio-value range/i.test(r));
  check('F: no valuation range is asserted anywhere',
    !/value (?:history|range) (?:from|since)/i.test(r) && !/worth .* since/i.test(r));

  // A chain with a current position and no proven past claims nothing.
  const currentOnly = render(env({ chains: [
    { chain: 'BTC', fromISO: '2023-03-18', toISO: '2026-08-27', claimsHistory: true },
    { chain: 'XYZ', fromISO: null, toISO: null, claimsHistory: false },
  ] }), '2026-05-29', '2026-08-26');
  check('F: a chain with no licensed history is not advertised',
    /BTC/.test(currentOnly) && !/XYZ/.test(currentOnly),
    'a CURRENT_POSITION_SUPPORTED chain has a balance and no proven past');
}

// ══ G — A SPACE WITH NO EVIDENCE ADVERTISES NONE ═════════════════════════════
{
  const empty = render(env({
    txnFrom: null, txnTo: null, txnCount: 0, snapCount: 0,
    cash: 0, debt: 0, investments: 0, digitalAssets: 0, other: 0, chains: [],
  }), null as never);

  check('G: no transactions ⇒ said plainly, no range invented',
    /Transactions: none recorded in this Space/.test(empty));
  check('G: …no net-worth line', !/Net-worth history/.test(empty));
  check('G: …no account presence line', !/Accounts with evidence/.test(empty));
  check('G: …and no crypto line', !/Digital-asset/.test(empty));
  check('G: nothing is advertised that does not exist',
    !/investments|digital assets|BTC|ETH|SOL/.test(empty));

  // A partial Space advertises only what it has.
  const debtOnly = render(env({
    txnCount: 40, txnFrom: '2026-03-23', txnTo: '2026-07-16',
    cash: 0, debt: 2, investments: 0, digitalAssets: 0, other: 0, chains: [],
  }), '2026-05-29', '2026-08-26');
  check('G: a debt-only Space names debt and nothing else',
    /debt \(2\)/.test(debtOnly)
      && !/traditional investments/.test(debtOnly)
      && !/digital assets/.test(debtOnly));
}

// ══ THE PAIR THAT SEPARATES THE FIX FROM THE BUG ═════════════════════════════
//
// ⚠️ THIS IS THE ONLY TEST THAT DISTINGUISHES THEM. Both Spaces produce the SAME
// empty aggregates; the only difference is whether the absence oracle could
// establish that the identity may observe the Space. One must say "none", the
// other must not — and must not fall silent either, because the rest of the
// prompt instructs the model to answer record-span questions from this block.
//
// Previously this suite asserted UNKNOWN renders as the empty string. It no
// longer does, deliberately: silence left the model free to answer from nothing
// with nothing saying so, which is the second half of the same defect. Nothing
// here costs an answer — no range, no total, no conclusion, one sentence.
{
  const emptyButVisible = render(env({
    txnFrom: null, txnTo: null, txnCount: 0, snapCount: 0,
    cash: 0, debt: 0, investments: 0, digitalAssets: 0, other: 0, chains: [],
  }), null as never);
  const notObservable = describeCoverageEnvelope(
    { ...env({ unknown: true }), unavailability: 'SPACE_NOT_OBSERVABLE' },
    { fromISO: '2026-05-29', toISO: '2026-08-26' },
  ).join('\n');
  const censusFailed = render(env({ unknown: true }), '2026-05-29', '2026-08-26');

  check('PAIR: empty-but-VISIBLE still says none recorded',
    /Transactions: none recorded in this Space/.test(emptyButVisible));
  check('PAIR: empty-and-INACCESSIBLE never says none recorded',
    !/none recorded/.test(notObservable) && !/no transactions/i.test(notObservable),
    notObservable);
  check('PAIR: …it says the record could not be established',
    /COULD NOT BE ESTABLISHED/.test(notObservable)
      && /could not read its record/.test(notObservable));
  check('PAIR: …and it PROHIBITS the absence claim rather than merely omitting it',
    /treat every class of evidence here as UNKNOWN/i.test(notObservable)
      && /do not describe any record as empty/.test(notObservable));
  // ⚠️ AND THE PROHIBITION DOES NOT CONTAIN THE SENTENCE IT FORBIDS. The first
  // draft read "do NOT state … that there are no transactions", which a
  // word-presence check cannot tell from the claim itself — the erratum recorded
  // in bb2f6ec, reproduced here in one line of prose.
  check('PAIR: …without putting the forbidden sentence in the model\'s mouth',
    !/no transactions/i.test(notObservable), notObservable);
  check('PAIR: …and advertises no range',
    !/\d{4}/.test(notObservable), notObservable);
  check('PAIR: the two renderings are not the same string',
    emptyButVisible !== notObservable);

  check('a FAILED census is also stated, and is not an absence either',
    /COULD NOT BE ESTABLISHED/.test(censusFailed)
      && /census failed/.test(censusFailed)
      && !/none recorded/.test(censusFailed),
    censusFailed);
  check('a failed census and an unobservable Space say WHY, differently',
    censusFailed !== notObservable);

  // AVAILABLE with no datable row is a third non-absence, and used to fall into
  // the "none recorded" branch.
  // ⚠️ RLS-AI-S8 — `count` IS NOW THE DATED COUNT, so the all-undated fixture
  // carries its 12 rows in `undatedCount`. Before, `count: 12` sat beside a null
  // range: a true number over a population the range did not describe.
  const undated = describeCoverageEnvelope(
    { ...env({ txnCount: 0, txnUndated: 12, txnFrom: null, txnTo: null, snapCount: 0,
               cash: 0, debt: 0, investments: 0, digitalAssets: 0, other: 0, chains: [] }) },
    null,
  ).join('\n');
  check('rows that exist but cannot be dated are NOT reported as none',
    !/none recorded/.test(undated) && /Transactions EXIST \(12 records\)/.test(undated),
    undated);
  check('…and the undated sentence forbids placing them in a period',
    /no record belongs to any period/.test(undated)
      && /do not place them in a period/.test(undated), undated);

  // A MIXED Space: the range's own denominator, and the remainder beside it.
  const mixed = describeCoverageEnvelope(env({ txnCount: 4_144, txnUndated: 12 }), null).join('\n');
  check('a MIXED Space quotes the DATED count for the range',
    /4,144 records/.test(mixed) && !/4,156 records/.test(mixed), mixed);
  check('…and states the undatable remainder OUTSIDE the range',
    /PLUS 12 further record/.test(mixed) && /fall in NO period/.test(mixed), mixed);
}

// ══ I — THE PROHIBITION TRAVELS ON THE OBJECT, NOT ONLY THE RENDERER ═════════
//
// ⚠️ THIS SUITE'S OWN BLIND SPOT, NAMED. Everything above renders a HAND-BUILT
// envelope — and `describeCoverageEnvelope` HAS NO PRODUCTION CALLER. The shipped
// A2 orientation serializes the ENVELOPE OBJECT as JSON into the prompt, so every
// sentence asserted above was being checked on a code path the product does not
// use. `coverageMeaning` is the derived field that fixes that, and it is pure.
{
  const failed = coverageMeaning({ ...env({ unknown: true }) });
  check('a failed census CARRIES its prohibition as a field',
    typeof failed === 'string' && /COULD NOT BE ESTABLISHED/.test(failed)
      && /do not describe any record as empty/.test(failed), String(failed));
  // ⚠️ THE WORDING IS UNCHANGED BY S8, AND THAT IS THE ASSERTION. The renderer's
  // sentence was already shipped prompt text; moving it onto the object must not
  // reword it, so the two are compared directly rather than both pattern-matched.
  check('…and it is EXACTLY the sentence the renderer already shipped',
    describeCoverageEnvelope({ ...env({ unknown: true }) }, null).join('\n') === failed,
    describeCoverageEnvelope({ ...env({ unknown: true }) }, null).join('\n'));

  const notObs = coverageMeaning({ ...env({ unknown: true }), unavailability: 'SPACE_NOT_OBSERVABLE' });
  check('…and an unobservable Space says WHY, differently from a failed census',
    typeof notObs === 'string' && notObs !== failed
      && /could not read its record/.test(notObs), String(notObs));

  check('an ORDINARY envelope carries NO notice — the field is omitted, not empty',
    coverageMeaning(env()) === undefined, String(coverageMeaning(env())));

  const und = coverageMeaning(env({ txnCount: 4_144, txnUndated: 12 }));
  check('undated rows carry their own prohibition on the object',
    typeof und === 'string' && /12 transaction record\(s\) EXIST/.test(und)
      && /never describe them as absent or missing/.test(und), String(und));

  // The renderer and the object must not hold two copies of the wording.
  const rendered = describeCoverageEnvelope(
    { ...env({ unknown: true }), unavailability: 'SPACE_NOT_OBSERVABLE',
      meaning: notObs }, null).join('\n');
  check('the RENDERER reads the same wording rather than keeping a second copy',
    rendered === String(notObs), rendered);
}

// ══ J — THE CENSUS ITSELF, WHICH THIS SUITE COULD NOT PREVIOUSLY REACH ═══════
//
// ⚠️ A FAKE CLIENT PROVES ARITHMETIC, NEVER A POLICY, AND THE DIVISION IS THE
// POINT. The dated/undated split is a `_count: { _all, economicDate }` aggregate
// read and a subtraction — pure arithmetic over what Postgres returned, testable
// here. Whether Postgres returns the RIGHT ROWS is a question about RLS, which no
// fake client can answer; that half runs as real `fm_app` in
// scripts/rls-ai-acceptance.ts (cases 51-56). Both halves exist because neither
// is sufficient: this suite was blind to the census, and the acceptance suite
// cannot be run from a unit gate.
{
  const census = (all: number, dated: number, min: string | null, max: string | null) => {
    const client = {
      spaceAccountLink: { findMany: async () => [
        { financialAccountId: 'acct_1' }] },
      financialAccount: { findMany: async () => [
        { id: 'acct_1', type: 'checking', walletChain: null }] },
      transaction: { aggregate: async () => ({
        _min: { economicDate: min ? new Date(`${min}T00:00:00Z`) : null },
        _max: { economicDate: max ? new Date(`${max}T00:00:00Z`) : null },
        _count: { _all: all, economicDate: dated },
      }) },
      spaceSnapshot: { aggregate: async () => ({
        _min: { date: null }, _max: { date: null }, _count: { _all: 0 } }) },
      positionCoverage: { findMany: async () => [] },
      positionObservation: { groupBy: async () => [] },
      spaceMember: { findFirst: async () => ({ id: 'm_1' }) },
    };
    return loadCoverageEnvelope(client as never, 'space_1');
  };

  void (async () => {
    const mixed = await census(4_156, 4_144, '2024-07-18', '2026-08-26');
    check('CENSUS: a mixed ledger reports the DATED count and the remainder apart',
      mixed.transactions.span.count === 4_144
        && mixed.transactions.span.undatedCount === 12
        && mixed.transactions.availability === EvidenceAvailability.AVAILABLE,
      JSON.stringify(mixed.transactions.span));

    const allUndated = await census(12, 0, null, null);
    check('CENSUS: an ENTIRELY undated ledger is AVAILABLE, never NONE',
      allUndated.transactions.availability === EvidenceAvailability.AVAILABLE
        && allUndated.transactions.span.count === 0
        && allUndated.transactions.span.undatedCount === 12
        && allUndated.unavailability === null,
      JSON.stringify(allUndated.transactions));
    check('CENSUS: …and it never renders as "none recorded"',
      !/none recorded/.test(describeCoverageEnvelope(allUndated, null).join('\n')),
      describeCoverageEnvelope(allUndated, null).join('\n'));

    const genuinelyEmpty = await census(0, 0, null, null);
    check('CENSUS: NOT VACUOUS — a genuinely empty ledger IS still NONE',
      genuinelyEmpty.transactions.availability === EvidenceAvailability.NONE
        && genuinelyEmpty.transactions.span.undatedCount === undefined
        && genuinelyEmpty.meaning === undefined,
      JSON.stringify(genuinelyEmpty.transactions));

    const clean = await census(4_156, 4_156, '2024-07-18', '2026-08-26');
    check('CENSUS: a fully dated ledger carries NO undated key and NO notice',
      clean.transactions.span.undatedCount === undefined && clean.meaning === undefined,
      JSON.stringify(clean.transactions.span));

    // ⚠️ THE OBJECT MUST CARRY THE PROHIBITION, AND A MUTATION TEST FOUND THAT
    // THIS SUITE DID NOT CHECK IT. Deleting `const meaning = coverageMeaning(…)`
    // from the census left all 63 checks green, because every `meaning`
    // assertion above calls the PURE function directly or asserts the field is
    // ABSENT. Only the real-role acceptance suite caught it — which needs Docker
    // and therefore gates nothing in a unit run. These two close that.
    const mixedNotice = await census(4_156, 4_144, '2024-07-18', '2026-08-26');
    check('CENSUS: the ENVELOPE carries the undated prohibition as a field',
      typeof mixedNotice.meaning === 'string'
        && /12 transaction record\(s\) EXIST/.test(mixedNotice.meaning)
        && JSON.stringify(mixedNotice).includes('EXIST but carry no economic date'),
      String(mixedNotice.meaning));

    const thrown = await loadCoverageEnvelope({
      spaceAccountLink: { findMany: async () => { throw new Error('authority failure'); } },
    } as never, 'space_1');
    check('CENSUS: a THROWN authority is CENSUS_FAILED, and the object says so',
      thrown.unavailability === 'CENSUS_FAILED'
        && thrown.transactions.availability === EvidenceAvailability.UNKNOWN
        && typeof thrown.meaning === 'string'
        && /COULD NOT BE ESTABLISHED/.test(thrown.meaning)
        && /the coverage census failed/.test(thrown.meaning),
      JSON.stringify({ u: thrown.unavailability, m: thrown.meaning }));
    check('CENSUS: …and a failed census is NEVER rendered as an absence',
      !/none recorded/.test(describeCoverageEnvelope(thrown, null).join('\n')),
      describeCoverageEnvelope(thrown, null).join('\n'));

    report();
  })();
}

// ══ H — VISIBILITY IS ENFORCED AT THE SOURCE ═════════════════════════════════
//
// Structural, because the property is about the QUERY. Measured on the live
// corpus: Austin Home holds a BALANCE_ONLY checking account with 74
// transactions, and the envelope reports count = 0.
{
  const src = readFileSync(join(process.cwd(), 'lib/ai/coverage-envelope.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

  // ⚠️ THE RESOLVER IS THE PROPERTY; ITS ARGUMENT ORDER IS NOT. This pinned
  // `resolveFullVisibleAccountIds(spaceId, client)` until RLS slice B made the
  // client that helper's required FIRST parameter, so the same call now reads
  // `(client, spaceId)`. What must not regress is that presence is resolved by
  // the canonical helper rather than a fourth hand-rolled traversal.
  check('H: account presence goes through the CANONICAL visibility resolver',
    /resolveFullVisibleAccountIds\([^)]*\bspaceId\b[^)]*\)/.test(src),
    'a fourth hand-rolled traversal is exactly what the parity guard exists to catch');
  check('H: …and does not hand-roll the link query itself',
    !/spaceAccountLink\.findMany/.test(src),
    'a BALANCE_ONLY account must not be advertised as user-visible evidence');
  check('H: snapshot extent goes through the snapshot authority',
    // RLS-C-S3 — through the authority this census already resolved, not a
    // second one reached from inside the snapshot boundary.
    /getSnapshotExtent\(client, spaceId\)/.test(src) && !/spaceSnapshot\./.test(src),
    'an aggregate is still a read; snapshot reads have one home');
  check('H: the transaction census reuses the SHARED population predicate',
    /bankingTransactionWhere\(spaceId\)/.test(src),
    'AVAILABLE and LOADED must be measured over ONE population, or they can disagree');
  check('H: …with no date filter, so it measures the whole record',
    !/economicDate:\s*\{\s*gte/.test(src));
  check('H: soft-delete and ACTIVE filtering are inherited, not re-implemented',
    !/deletedAt:\s*null/.test(src) && !/status:\s*'ACTIVE'/.test(src),
    'those live in the resolver, under the parity guard — a local copy could drift');
  check('H: the census reads no transaction ROWS',
    !/transaction\.findMany/.test(src),
    'the envelope is aggregates only; a row read here would be a retrieval change');
}

// ══ NEGATIVE — THE ENVELOPE CARRIES NO FINANCIAL CONCLUSION ══════════════════
{
  const r = render(env(), '2026-05-29', '2026-08-26');
  check('NEG: no money amount appears', !/\$/.test(r));
  check('NEG: no balance, total or net worth is stated',
    !/balance|net worth|total (?:of|is)|worth \$/i.test(r));
  check('NEG: no assessment vocabulary leaks in',
    !/HEALTHY|EXCELLENT|classification|readiness|overspend/i.test(r));
  check('NEG: it stays compact', r.length < 1_400,
    `${r.length} chars ≈ ${Math.ceil(r.length / 4)} tokens — the budget is 150–300`);
  check('NEG: …and within the token target',
    Math.ceil(r.length / 4) <= 300, `${Math.ceil(r.length / 4)} tokens`);
}

/**
 * ⚠️ THE REPORT IS A FUNCTION BECAUSE THE CENSUS BLOCK IS ASYNC, AND THIS WAS A
 * REAL TRAP. The tail used to be a bare `console.log` + `process.exit` at module
 * scope: the first async check added below would have resolved AFTER the process
 * had already exited 0, and the suite would have reported "N passed" over checks
 * that never ran. A suite that exits before its own assertions is the purest form
 * of the vacuous pass this file exists to prevent.
 */
function report(): void {
  console.log(`\ncoverage-envelope: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
