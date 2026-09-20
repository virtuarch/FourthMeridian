/**
 * lib/ai/brief/claim-evidence.test.ts
 *
 * COMPLETENESS IS A PROPERTY OF A CLAIM, NOT OF A SPACE.
 *
 * The measured defect: a debt claim resting on two CURRENT card connections was
 * qualified with "Charles Schwab data is over a month old", because freshness was
 * one global list and the model was asked to judge the dependency itself. Of seven
 * claims, two depended on the brokerage; the Brief attached it to four.
 *
 *   npx tsx lib/ai/brief/claim-evidence.test.ts
 */

import type { DataSourceView, SpaceDataHealth } from '@/lib/connections/space-data-health.core';
import { CLAIM_SPECS, claimCovering, claimEvidence, claimsAffectedBy } from './claim-evidence';
import { BRIEF_CLAIMS } from './types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const ASOF = '2026-09-20';
const source = (label: string, feeds: NonNullable<DataSourceView['feeds']>, over: Partial<DataSourceView> = {}): DataSourceView => ({
  kind: 'BANK', label, state: 'CURRENT', lastUpdatedAt: '2026-09-20T05:00:00.000Z', accountCount: feeds.length,
  needsAttention: false, actionable: true, feeds, ...over });
const health = (sources: DataSourceView[]): SpaceDataHealth =>
  ({ sources, groups: [], attention: sources.filter((s) => s.needsAttention).length });

const SCHWAB_STALE = source('Charles Schwab', ['investments'],
  { state: 'NEEDS_RECONNECT', needsAttention: true, lastUpdatedAt: '2026-08-17T23:41:39.000Z' });
const CHASE = source('Chase', ['liquid', 'liabilities', 'bankingRows']);
const AMEX = source('American Express', ['liabilities', 'bankingRows']);
const WALLET = source('Ledger Wallet', ['digitalAssets'], { kind: 'WALLET' });
const evidenceOf = (sources: DataSourceView[], bankingPopulationKnown = true) =>
  claimEvidence({ health: health(sources), asOf: ASOF, bankingPopulationKnown })!;

console.log('1. the forensic Space — a stale brokerage, current cards');
{
  const e = evidenceOf([SCHWAB_STALE, CHASE, AMEX, WALLET]);
  check('debt: two sources, observed, NOTHING stale attached',
    e.debt?.sources === 2 && e.debt.completeness.tier === 'observed' && e.debt.completeness.byComponent === undefined
      && !/Schwab/.test(JSON.stringify(e.debt)));
  check('liquid / runway: checking + savings sources only, observed', e.liquid?.sources === 1 && e.liquid.completeness.tier === 'observed');
  check('spending and the expense baseline: the banking population, observed',
    e.cashFlow?.sources === 2 && e.cashFlow.completeness.tier === 'observed');
  check('digital assets: the wallet, observed — a brokerage is not a wallet', e.digitalAssets?.completeness.tier === 'observed');
  check('investments: incomplete, and says which source and since when',
    e.investments?.completeness.tier === 'incomplete' && e.investments.completeness.byComponent?.['Charles Schwab'] === 'incomplete'
      && /Charles Schwab \(NEEDS_RECONNECT, last updated 2026-08-17\)/.test(e.investments.completeness.reason));
  check('investment concentration (priced positions): incomplete', e.pricedPositions?.completeness.tier === 'incomplete');
  check('net worth: every population contributes, so the same source qualifies it',
    e.netWorth?.sources === 4 && e.netWorth.completeness.tier === 'incomplete');
  check('exactly the claims the source feeds are affected — three of seven, not "the Space"',
    JSON.stringify(claimsAffectedBy('Charles Schwab', e)) === '["netWorth","investments","pricedPositions"]');
  check('a current source affects nothing', claimsAffectedBy('Chase', e).length === 0);
}

console.log('\n2. the mirror image — a stale card, a current brokerage');
{
  const amexStale = source('American Express', ['liabilities', 'bankingRows'],
    { state: 'OUT_OF_DATE', needsAttention: true, lastUpdatedAt: '2026-09-02T04:00:00.000Z' });
  const e = evidenceOf([source('Charles Schwab', ['investments']), CHASE, amexStale, WALLET]);
  check('NOW the debt claim is incomplete', e.debt?.completeness.tier === 'incomplete' && /American Express \(OUT_OF_DATE, last updated 2026-09-02\)/.test(e.debt.completeness.reason));
  check('…and so is cash flow (the card posts banking rows) and net worth',
    e.cashFlow?.completeness.tier === 'incomplete' && e.netWorth?.completeness.tier === 'incomplete');
  check('…while investments, digital assets and cash are untouched',
    [e.investments, e.digitalAssets, e.pricedPositions, e.liquid].every((c) => c?.completeness.tier === 'observed'));
  check('byComponent lists every source of the claim, the current one included (M1)',
    JSON.stringify(e.debt?.completeness.byComponent) === '{"Chase":"observed","American Express":"incomplete"}');
}

console.log('\n3. M1\'s gap rule: behind AND not delivered up to the day the figure is for');
{
  const reauthToday = source('Chase', ['liquid', 'liabilities'], { state: 'NEEDS_RECONNECT', needsAttention: true, lastUpdatedAt: '2026-09-20T01:00:00.000Z' });
  check('a connection needing re-authorisation that delivered TODAY is not a gap in today\'s balance',
    evidenceOf([reauthToday]).liquid?.completeness.tier === 'observed');
  const never = source('New Bank', ['liquid'], { state: 'NEVER_UPDATED', needsAttention: true, lastUpdatedAt: null });
  const e = evidenceOf([never]);
  check('a source that never delivered makes the claim unknown, not merely incomplete',
    e.liquid?.completeness.tier === 'unknown' && /New Bank \(NEVER_UPDATED, never updated\)/.test(e.liquid.completeness.reason));
  const importing = source('Chase', ['liquid'], { state: 'IMPORTING', needsAttention: false });
  check('an import in progress needs no attention and is no gap', evidenceOf([importing]).liquid?.completeness.tier === 'observed');
}

console.log('\n4. not established is not stale');
{
  check('no health ⇒ undefined', claimEvidence({ health: null, asOf: ASOF, bankingPopulationKnown: true }) === undefined);
  const noFeeds = health([{ ...SCHWAB_STALE, feeds: undefined }]);
  check('sources without populations ⇒ undefined (nothing can be scoped, so nothing is attached)',
    claimEvidence({ health: noFeeds, asOf: ASOF, bankingPopulationKnown: true }) === undefined);
  const e = evidenceOf([SCHWAB_STALE, CHASE], false);
  check('banking population not read ⇒ no cash-flow entry, other claims unaffected', !('cashFlow' in e) && !!e.debt);
  check('a population no source feeds has no entry', !('digitalAssets' in evidenceOf([CHASE])));
  check('a source that feeds nothing (its only account is hidden) touches no claim',
    Object.values(evidenceOf([CHASE, source('Hidden Bank', [], { state: 'OUT_OF_DATE', needsAttention: true, lastUpdatedAt: '2026-08-01T00:00:00.000Z' })]))
      .every((c) => c!.completeness.tier === 'observed'));
}

console.log('\n5. the mapping is code\'s — every narratable figure belongs to exactly one claim');
{
  const expectCover: [string, string][] = [
    ['currentState.debt', 'debt'], ['recentChanges.w1.debt', 'debt'], ['recentChanges.m1.debt.abs', 'debt'],
    ['behavior.debtRate', 'debt'], ['behavior.debtRate.reasonMetrics.weightedAprPct', 'debt'], ['behavior.debtBurden', 'debt'],
    ['currentState.liquid', 'liquid'], ['behavior.liquidity.coverageMonths', 'liquid'], ['recentChanges.d1.liquid', 'liquid'],
    ['currentState.investments.traditional', 'investments'], ['recentChanges.w1.investments', 'investments'],
    ['currentState.investments.digital', 'digitalAssets'], ['recentChanges.w1.digitalAssets', 'digitalAssets'],
    ['currentState.investments.combined', 'pricedPositions'], ['currentState.concentration.topWeightPct', 'pricedPositions'],
    ['currentState.netWorth', 'netWorth'], ['recentChanges.m1.netWorth', 'netWorth'],
    ['recentActivity.top.0', 'cashFlow'], ['recentActivity.top[2]', 'cashFlow'], ['behavior.monthlyExpenses', 'cashFlow'],
    ['behavior.monthlyIncome', 'cashFlow'], ['behavior.deficitCause', 'cashFlow'],
  ];
  for (const [path, claim] of expectCover) check(`${path} → ${claim}`, claimCovering(path) === claim, String(claimCovering(path)));
  check('a path that is not a sourced figure has no claim', claimCovering('plans.goals.0') === undefined && claimCovering('identity.asOf') === undefined);
  check('a prefix is not a match (debtRateX is not debtRate)', claimCovering('behavior.debtRateX') === undefined);
  const all = BRIEF_CLAIMS.flatMap((c) => CLAIM_SPECS[c].covers);
  check('no path is governed by two claims', new Set(all).size === all.length);
  check('claims are emitted in a fixed order (byte-stable package)',
    JSON.stringify(Object.keys(evidenceOf([SCHWAB_STALE, CHASE, AMEX, WALLET]))) === JSON.stringify([...BRIEF_CLAIMS]));
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
