/**
 * lib/ai/assemblers/position-class.test.ts   (CF-12)
 *
 * A SECURITIES QUESTION IS NOT ANSWERED WITH CRYPTO.
 *
 *     npx tsx lib/ai/assemblers/position-class.test.ts
 *
 * ── The failure ─────────────────────────────────────────────────────────────
 * Measured live at CF-7, CF-10 and CF-11, identically each time: asked "What
 * stocks do I own?", the model answered with Bitcoin at the top of the list.
 *
 * CF-7 had already established the breadth and told the model not to fold
 * digital assets into the figures — but `holdings_summary` is the canonical
 * POSITION SPINE, and W5 routed digital assets through the same two seams as
 * securities, so it handed over BTC and SOL rows unfiltered. The instruction
 * argued with the evidence, and evidence wins.
 *
 * ── What is pinned ──────────────────────────────────────────────────────────
 * That the split reuses the EXISTING authority — `AssetClass.CRYPTO`, minted on
 * every digital-asset instrument — rather than inventing a second notion of
 * "is this crypto?", and that narrowing the list never redefines a total.
 */

import {
  buildHoldingsSummary, positionMatchesClass, PositionClass, HOLDINGS_TOP_N,
  type CanonicalPositionRow,
} from './holdings-core';

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

/** The real Space's shape: two crypto positions dominating nine securities. */
const ROWS: CanonicalPositionRow[] = [
  { instrumentId: 'i-btc', symbol: 'BTC', name: 'Bitcoin',  reportingValue: 18_937.58, isCash: false, assetClass: 'CRYPTO' },
  { instrumentId: 'i-vrt', symbol: 'VRT', name: 'Vertiv',   reportingValue: 263.81,    isCash: false, assetClass: 'EQUITY' },
  { instrumentId: 'i-vgt', symbol: 'VGT', name: 'Vanguard', reportingValue: 235.98,    isCash: false, assetClass: 'ETF' },
  { instrumentId: 'i-sol', symbol: 'SOL', name: 'Solana',   reportingValue: 74.97,     isCash: false, assetClass: 'CRYPTO' },
  { instrumentId: 'i-cash', symbol: 'CASH', name: 'Cash',   reportingValue: 3_557.74,  isCash: true,  assetClass: 'CASH' },
] as CanonicalPositionRow[];

const allScope = { valuedSubtotal: 23_070.08, cashValue: 3_557.74, anyFxEstimated: false, hasAny: true };
const build = (positionClass?: Parameters<typeof buildHoldingsSummary>[0]['positionClass']) =>
  buildHoldingsSummary({ scopeHint: 'full', fullRows: ROWS, allScope, positionClass });

const symbols = (d: ReturnType<typeof build>) => d!.topPositions!.items.map((p) => p.symbol);

// ══ THE MEASURED FAILURE ═════════════════════════════════════════════════════
{
  const trad = build(PositionClass.TRADITIONAL);
  check('a securities question lists NO crypto',
    !symbols(trad).includes('BTC') && !symbols(trad).includes('SOL'),
    symbols(trad).join(','));
  check('…and still lists the securities', symbols(trad).includes('VRT') && symbols(trad).includes('VGT'));

  const dig = build(PositionClass.DIGITAL);
  check('a crypto question lists ONLY crypto',
    symbols(dig).every((s) => s === 'BTC' || s === 'SOL'), symbols(dig).join(','));
  check('…and both chains survive', symbols(dig).includes('BTC') && symbols(dig).includes('SOL'));

  const all = build();
  check('the default is unchanged — every ANALYZED position', symbols(all).length === 4,
    `absent positionClass must behave exactly as before CF-12 — got ${symbols(all).join(',')}`);
  check('…and cash is excluded from the ranked list, as it always was',
    !symbols(all).includes('CASH'),
    'the ranked list is the ANALYZED (non-cash) portfolio; CF-12 does not change that');
  check('…including crypto', symbols(all).includes('BTC'));
}

// ══ CF-1 — THE DENOMINATOR IS THE FILTERED POPULATION ════════════════════════
{
  const trad = build(PositionClass.TRADITIONAL);
  check('CF-1: the denominator counts SECURITIES, not the mixed total',
    trad!.topPositions!.totalCount === 2, String(trad!.topPositions!.totalCount));
  check('CF-1: …and returnedCount matches what was rendered',
    trad!.topPositions!.returnedCount === symbols(trad).length);

  const dig = build(PositionClass.DIGITAL);
  check('CF-1: the digital denominator counts crypto only',
    dig!.topPositions!.totalCount === 2, String(dig!.topPositions!.totalCount));

  check('CF-1: the unfiltered denominator is the whole analyzed spine',
    build()!.topPositions!.totalCount === 4);
}

// ══ NARROWING THE LIST NEVER REDEFINES A TOTAL ═══════════════════════════════
//
// `totalPortfolioValue` is what it says it is. Silently making it mean
// "securities only" on a stocks question would be a second, contradictory
// definition of the same field — the CF-7 double-count trap in another form.
{
  const all = build(), trad = build(PositionClass.TRADITIONAL), dig = build(PositionClass.DIGITAL);
  for (const [name, get] of [
    ['totalPortfolioValue', (d: typeof all) => d!.totalPortfolioValue],
    ['investedValue',       (d: typeof all) => d!.investedValue],
    ['cashValue',           (d: typeof all) => d!.cashValue],
    ['positionCount',       (d: typeof all) => d!.positionCount],
    ['analyzedInvestedValue', (d: typeof all) => d!.analyzedInvestedValue],
  ] as const) {
    check(`${name} is whole-portfolio regardless of the question`,
      get(all) === get(trad) && get(all) === get(dig),
      `${get(all)} / ${get(trad)} / ${get(dig)}`);
  }
  check('concentration is computed over the whole portfolio',
    JSON.stringify(all!.concentration) === JSON.stringify(trad!.concentration));

  // Weights stay relative to the whole analyzed portfolio.
  const vrtAll  = build()!.topPositions!.items.find((p) => p.symbol === 'VRT')!;
  const vrtTrad = build(PositionClass.TRADITIONAL)!.topPositions!.items.find((p) => p.symbol === 'VRT')!;
  check('a position\'s weight does not change when the list is narrowed',
    vrtAll.weight === vrtTrad.weight,
    'a share is a share OF something; narrowing must not move the denominator');
}

// ══ THE PREDICATE REUSES THE EXISTING AUTHORITY ══════════════════════════════
{
  check('CRYPTO is digital', positionMatchesClass({ assetClass: 'CRYPTO' }, PositionClass.DIGITAL));
  check('CRYPTO is not traditional', !positionMatchesClass({ assetClass: 'CRYPTO' }, PositionClass.TRADITIONAL));
  for (const c of ['EQUITY', 'ETF', 'MUTUAL_FUND', 'FIXED_INCOME', 'OPTION', 'CASH', 'OTHER']) {
    check(`${c} is traditional`, positionMatchesClass({ assetClass: c }, PositionClass.TRADITIONAL));
    check(`${c} is not digital`, !positionMatchesClass({ assetClass: c }, PositionClass.DIGITAL));
  }
  // An unclassified instrument is NOT silently called crypto. Fails toward the
  // securities side, which is where an unknown brokerage holding belongs.
  check('UNKNOWN is treated as traditional, never as crypto',
    positionMatchesClass({ assetClass: 'UNKNOWN' }, PositionClass.TRADITIONAL)
      && !positionMatchesClass({ assetClass: 'UNKNOWN' }, PositionClass.DIGITAL));
  check('a row with no class at all is traditional',
    positionMatchesClass({}, PositionClass.TRADITIONAL));
  check('ALL matches everything',
    positionMatchesClass({ assetClass: 'CRYPTO' }, PositionClass.ALL)
      && positionMatchesClass({}, PositionClass.ALL));
}

// ══ EDGES ════════════════════════════════════════════════════════════════════
{
  const cryptoOnly = buildHoldingsSummary({
    scopeHint: 'full', allScope,
    fullRows: ROWS.filter((r) => r.assetClass === 'CRYPTO'),
    positionClass: PositionClass.TRADITIONAL,
  });
  check('a crypto-only portfolio asked about stocks returns an EMPTY list, not crypto',
    cryptoOnly!.topPositions!.items.length === 0 && cryptoOnly!.topPositions!.totalCount === 0,
    'an honest empty answer beats the wrong asset class');
  check('…and the payload still exists so the totals can be stated',
    cryptoOnly !== null && cryptoOnly.totalPortfolioValue !== undefined);

  check('the render cap still applies after filtering', HOLDINGS_TOP_N === 10);
}

console.log(`\nposition-class: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
