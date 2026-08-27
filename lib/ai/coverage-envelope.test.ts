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
  describeCoverageEnvelope, EvidenceAvailability,
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
}> = {}): CoverageEnvelope {
  const txnCount = o.txnCount ?? 4_156;
  const snapCount = o.snapCount ?? 768;
  return {
    transactions: {
      availability: o.unknown ? EvidenceAvailability.UNKNOWN
                  : txnCount > 0 ? EvidenceAvailability.AVAILABLE : EvidenceAvailability.NONE,
      span: { fromISO: o.txnFrom === undefined ? '2024-07-18' : o.txnFrom,
              toISO:   o.txnTo   === undefined ? '2026-08-26' : o.txnTo, count: txnCount },
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

// ══ UNKNOWN CENSUS RENDERS AS SILENCE ════════════════════════════════════════
{
  check('a failed census emits NOTHING rather than a false absence',
    render(env({ unknown: true }), '2026-05-29', '2026-08-26') === '',
    'UNKNOWN is not NONE — awareness is additive and must never cost an answer');
}

// ══ H — VISIBILITY IS ENFORCED AT THE SOURCE ═════════════════════════════════
//
// Structural, because the property is about the QUERY. Measured on the live
// corpus: Austin Home holds a BALANCE_ONLY checking account with 74
// transactions, and the envelope reports count = 0.
{
  const src = readFileSync(join(process.cwd(), 'lib/ai/coverage-envelope.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

  check('H: account presence goes through the CANONICAL visibility resolver',
    /resolveFullVisibleAccountIds\(spaceId, client\)/.test(src),
    'a fourth hand-rolled traversal is exactly what the parity guard exists to catch');
  check('H: …and does not hand-roll the link query itself',
    !/spaceAccountLink\.findMany/.test(src),
    'a BALANCE_ONLY account must not be advertised as user-visible evidence');
  check('H: snapshot extent goes through the snapshot authority',
    /getSnapshotExtent\(spaceId\)/.test(src) && !/spaceSnapshot\./.test(src),
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

console.log(`\ncoverage-envelope: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
