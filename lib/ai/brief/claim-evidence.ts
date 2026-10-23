/**
 * lib/ai/brief/claim-evidence.ts
 *
 * CLAIM-SCOPED EVIDENCE — which sources a family of figures rests on, and whether
 * THOSE are current. Completeness is a property of a claim, never of a Space.
 *
 * ⚠️ THE DEFECT THIS REPLACES. Freshness was one global block, and the prompt
 * asked the model to "qualify only conclusions that rest on" the stale sources
 * while giving it nothing to judge that with. Measured on a real Space: a debt
 * claim resting on two CURRENT card connections was narrated as "could be out of
 * date because Charles Schwab data is over a month old", and the caveat tracked
 * the GLOBAL stale list exactly (crypto left the list, crypto left the sentence)
 * and the claim's own population not at all. Two of seven claims depended on the
 * brokerage; the Brief attached it to four.
 *
 * ⚠️ M1'S RULE, APPLIED TO BALANCES. `lib/ai/measures/measure.ts` established it
 * for flow measures: a source is a component of a figure only when its accounts
 * feed THAT figure's population, and it is a gap only when it has not delivered
 * up to the end of the window the figure covers. This module reuses that
 * contract rather than inventing a second one — the same `Completeness` shape,
 * the same tiers, `byComponent` listing every contributing source only when one
 * is behind — with the population supplied by the ONE per-source health
 * authority (`lib/connections/space-data-health.core` `feeds`), so the Brief, the
 * page beside it and the Connections screen can never disagree about a source.
 *
 * ⚠️ DETERMINISTIC, AND THE DEPENDENCY IS CODE'S. The claim → population table
 * below is the whole mapping. The model is told which entry covers which path
 * (`covers`) and never decides what a figure depends on.
 *
 * ⚠️ A LABEL IS NOT AN IDENTITY. Two Plaid items at one institution are both
 * "Chase"; every source the viewer may not name is "A bank connection" or "A
 * crypto wallet". Keyed by label, the CURRENT one overwrote the STALE one (sources
 * sort most-severe first) and a claim came out `incomplete` with every component
 * `observed`, no source named, and the stale row affecting nothing. So nothing
 * here looks a source up by its label: a claim lists one `components` entry PER
 * SOURCE (position is identity, label is a value), what a source reaches is
 * computed from the source itself (`claimsReachedBy`), and M1's label-keyed
 * `byComponent` summary takes the WORST tier among sources sharing a label.
 *
 * ⚠️ NOT ESTABLISHED IS NOT STALE. When the source health could not be read, or
 * carried no populations, there is no evidence block at all; when no source
 * feeds a population (or the banking population was not read), that claim has no
 * entry. An absent entry means "not established" and the prompt says not to
 * qualify on it — a stale source is never attached by default.
 *
 * Pure. No data access, no clock.
 */

import type { Completeness, Tier } from '@/lib/ai/measures/measure';
import type {
  DataSourceView, FedPopulation, SpaceDataHealth,
} from '@/lib/connections/space-data-health.core';
import { BRIEF_CLAIMS, type BriefClaim, type BriefClaimComponent, type BriefClaimEvidence } from './types';

interface ClaimSpec {
  /** What the figures were computed over — a name for the reader, not a rule. */
  population: string;
  /** The source populations whose accounts contribute to these figures. */
  feeds: readonly FedPopulation[];
  /** The package paths the claim governs. `*` stands for any measured window (d1 / w1 / m1). */
  covers: readonly string[];
}

const BALANCES: readonly FedPopulation[] = ['liquid', 'investments', 'digitalAssets', 'realAssets', 'liabilities'];

/** THE mapping. Every figure a Brief may narrate belongs to exactly one claim. */
export const CLAIM_SPECS: Record<BriefClaim, ClaimSpec> = {
  netWorth: {
    population: 'ALL_ACCOUNTS', feeds: BALANCES,
    covers: ['currentState.netWorth', 'recentChanges.*.netWorth'],
  },
  liquid: {
    population: 'CHECKING_AND_SAVINGS_ACCOUNTS', feeds: ['liquid'],
    covers: ['currentState.liquid', 'recentChanges.*.liquid', 'behavior.liquidity'],
  },
  debt: {
    population: 'DEBT_ACCOUNTS', feeds: ['liabilities'],
    covers: ['currentState.debt', 'recentChanges.*.debt', 'behavior.debtRate', 'behavior.debtBurden'],
  },
  investments: {
    population: 'INVESTMENT_ACCOUNTS', feeds: ['investments'],
    covers: ['currentState.investments.traditional', 'recentChanges.*.investments'],
  },
  digitalAssets: {
    population: 'DIGITAL_ASSET_ACCOUNTS', feeds: ['digitalAssets'],
    covers: ['currentState.investments.digital', 'recentChanges.*.digitalAssets'],
  },
  pricedPositions: {
    population: 'INVESTMENT_AND_DIGITAL_ASSET_ACCOUNTS', feeds: ['investments', 'digitalAssets'],
    covers: ['currentState.investments.combined', 'currentState.concentration'],
  },
  cashFlow: {
    population: 'BANKING_TRANSACTIONS', feeds: ['bankingRows'],
    covers: ['recentActivity', 'behavior.monthlyIncome', 'behavior.monthlyExpenses',
      'behavior.monthlyDebtPayments', 'behavior.deficitCause', 'behavior.deficit'],
  },
};

const RANK: Record<Tier, number> = { observed: 0, derived: 1, estimated: 2, incomplete: 3, unknown: 4 };
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

/**
 * M1's gap rule: a contributing source is a gap for a figure only when it needs
 * attention AND has not delivered up to the day the figure is for. A connection
 * that must be re-authorised but delivered today is the page's business, not a
 * reason to doubt today's balance.
 */
const isGap = (s: DataSourceView, asOf: string) =>
  s.needsAttention && (day(s.lastUpdatedAt) === null || (day(s.lastUpdatedAt) as string) < asOf);

const tierOf = (s: DataSourceView): Tier => (s.lastUpdatedAt === null ? 'unknown' : 'incomplete');

const describe = (s: DataSourceView) =>
  `${s.label} (${s.state}${s.lastUpdatedAt ? `, last updated ${day(s.lastUpdatedAt)}` : ', never updated'})`;

export interface ClaimEvidenceInput {
  health: SpaceDataHealth | null;
  /** The day the package's figures are for. */
  asOf:   string;
  /** The banking population was read, so `bankingRows` is known for every source. */
  bankingPopulationKnown: boolean;
}

/**
 * The evidence block, or undefined when source populations were not established.
 * Claims are emitted in `BRIEF_CLAIMS` order so the package is byte-stable.
 */
export function claimEvidence(i: ClaimEvidenceInput): Partial<Record<BriefClaim, BriefClaimEvidence>> | undefined {
  const sources = i.health?.sources ?? [];
  if (!sources.some((s) => Array.isArray(s.feeds))) return undefined;

  const out: Partial<Record<BriefClaim, BriefClaimEvidence>> = {};
  for (const claim of BRIEF_CLAIMS) {
    const spec = CLAIM_SPECS[claim];
    if (claim === 'cashFlow' && !i.bankingPopulationKnown) continue;
    const contributing = sources.filter((s) => (s.feeds ?? []).some((f) => spec.feeds.includes(f)));
    if (contributing.length === 0) continue;

    const gaps = contributing.filter((s) => isGap(s, i.asOf));
    // One entry per SOURCE — never collapsed by label.
    const components: BriefClaimComponent[] = contributing.map((s) => ({
      label: s.label, tier: isGap(s, i.asOf) ? tierOf(s) : 'observed', state: s.state, lastUpdated: day(s.lastUpdatedAt) }));
    const completeness: Completeness = gaps.length === 0
      ? { tier: 'observed', reason: `every source of this figure (${contributing.length}) delivered up to ${i.asOf}` }
      : { tier: worst(gaps.map(tierOf)),
          reason: `${gaps.map(describe).join(', ')} ${gaps.length === 1 ? 'feeds' : 'feed'} this figure and `
            + `${gaps.length === 1 ? 'has' : 'have'} not delivered up to ${i.asOf}`,
          byComponent: worstTierByLabel(components) };

    out[claim] = { covers: [...spec.covers], population: spec.population, sources: contributing.length, completeness,
      ...(gaps.length > 0 ? { components } : {}) };
  }
  return out;
}

const worst = (tiers: Tier[]): Tier => tiers.reduce<Tier>((w, t) => (RANK[t] > RANK[w] ? t : w), 'observed');

/** M1's label-keyed summary: sources sharing a label collapse to their WORST tier, never the last one written. */
function worstTierByLabel(components: readonly BriefClaimComponent[]): Record<string, Tier> {
  const out: Record<string, Tier> = {};
  for (const c of components) out[c.label] = c.label in out ? worst([out[c.label], c.tier]) : c.tier;
  return out;
}

/**
 * The claims ONE source's staleness actually reaches — the inverse projection of
 * the block above, computed from the source itself (what it feeds, whether it is
 * a gap), never by looking its label up in another structure.
 */
export function claimsReachedBy(source: DataSourceView, i: Omit<ClaimEvidenceInput, 'health'>): BriefClaim[] {
  if (!isGap(source, i.asOf)) return [];
  return BRIEF_CLAIMS.filter((c) => !(c === 'cashFlow' && !i.bankingPopulationKnown)
    && (source.feeds ?? []).some((f) => CLAIM_SPECS[c].feeds.includes(f)));
}

/**
 * What a reader should be told is out of date for one claim: each distinct NAME
 * once, with the oldest last update among the behind sources that carry it (null
 * when any of them never delivered). Two stale "Chase" items are one "Chase".
 */
export function outOfDateNames(e: BriefClaimEvidence): { source: string; lastUpdated: string | null }[] {
  const byName = new Map<string, string | null>();
  for (const c of e.components ?? []) {
    if (c.tier === 'observed') continue;
    const prior = byName.get(c.label);
    byName.set(c.label, !byName.has(c.label) ? c.lastUpdated
      : prior === null || c.lastUpdated === null ? null
      : c.lastUpdated < (prior as string) ? c.lastUpdated : (prior as string));
  }
  return [...byName].map(([source, lastUpdated]) => ({ source, lastUpdated }));
}

/** The evidence entry that governs a package path, or undefined. */
export function claimCovering(path: string): BriefClaim | undefined {
  const p = path.trim().replace(/\[(\d+)\]/g, '.$1');
  return BRIEF_CLAIMS.find((c) => CLAIM_SPECS[c].covers.some((cover) => {
    const re = new RegExp(`^${cover.replace(/[.]/g, '\\.').replace(/\*/g, '[^.]+')}(\\.|$)`);
    return re.test(p);
  }));
}
