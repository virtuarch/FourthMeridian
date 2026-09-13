/**
 * lib/ai/brief/relevance.ts
 *
 * WHAT A DAILY BRIEF MAY REPEAT — decided by code, from the previous Brief's facts.
 *
 * ⚠️ THE WALLPAPER DEFECT. Dogfood showed the same sentence every day: "digital
 * assets are highly concentrated in one holding". It was true, and it was not news.
 * Three things made it recur: the package carried concentration as a bare current
 * state, the instruction invited standing facts on quiet days, and nothing knew
 * what an earlier Brief had already said.
 *
 * ⚠️ THE FIX IS DETERMINISTIC, NOT A LONGER PROMPT. Each generated Brief persists a
 * tiny projection of its standing facts. The next day's generation compares
 * today's facts with the previous DAY's:
 *
 *   no earlier Brief (or one older than RELEVANCE_PRIOR_MAX_DAYS)   → NEW       shown
 *   classification or top holding changed, or weight moved ≥ step   → CHANGED   shown
 *   otherwise                                                        → UNCHANGED omitted —
 *       unless today's investment movement is material, when it is shown marked
 *       UNCHANGED so it can explain that movement and nothing else
 *
 * An omitted fact is simply not in the model's input, so it cannot be narrated.
 *
 * ⚠️ NOT MEMORY. Nothing here is SpaceMemory or a record of "what we told the user".
 * It is a property of the previous artifact, compared against the next — the same
 * row that already holds the Brief. The material digest is computed on the FULL
 * package, before this filter, so relevance never causes or suppresses a
 * regeneration by itself.
 *
 * ⚠️ ACTION IS NOT NOVELTY. Unresolved connection problems are not filtered here:
 * they are shown deterministically on the page for as long as they last, and the
 * generated prose is kept from restating them (contract.ts).
 */

import { changeBucket } from './digest';
import { CONCENTRATION_WEIGHT_STEP_PCT, RELEVANCE_PRIOR_MAX_DAYS } from './policy';
import type { BriefPackage } from './types';

export type Novelty = 'NEW' | 'CHANGED' | 'UNCHANGED';

/** The standing facts a Brief persists beside its content. Small, typed, versioned. */
export interface StandingFacts {
  v: 1;
  concentration: {
    classification: string;
    topSymbol: string | null;
    topWeightPct: number;
    populationIsComplete: boolean;
  } | null;
}

export function standingFactsOf(pkg: BriefPackage): StandingFacts {
  const c = pkg.currentState.concentration;
  return {
    v: 1,
    concentration: c ? {
      classification: c.classification, topSymbol: c.topSymbol,
      topWeightPct: c.topWeightPct, populationIsComplete: c.populationIsComplete,
    } : null,
  };
}

/** Read standing facts back from persisted content; anything malformed is "none". */
export function readStandingFacts(content: unknown): StandingFacts | null {
  if (!content || typeof content !== 'object') return null;
  const f = (content as { standingFacts?: unknown }).standingFacts;
  if (!f || typeof f !== 'object' || (f as { v?: unknown }).v !== 1) return null;
  const c = (f as { concentration?: unknown }).concentration;
  if (c === null) return { v: 1, concentration: null };
  if (!c || typeof c !== 'object') return null;
  const cc = c as Record<string, unknown>;
  if (typeof cc.classification !== 'string' || typeof cc.topWeightPct !== 'number') return null;
  return { v: 1, concentration: {
    classification: cc.classification,
    topSymbol: typeof cc.topSymbol === 'string' ? cc.topSymbol : null,
    topWeightPct: cc.topWeightPct,
    populationIsComplete: cc.populationIsComplete === true,
  } };
}

export function concentrationNovelty(
  today: StandingFacts['concentration'], prior: StandingFacts | null,
): Novelty {
  if (!today || !prior || !prior.concentration) return 'NEW';
  const p = prior.concentration;
  if (p.classification !== today.classification || p.topSymbol !== today.topSymbol) return 'CHANGED';
  if (Math.abs(p.topWeightPct - today.topWeightPct) >= CONCENTRATION_WEIGHT_STEP_PCT) return 'CHANGED';
  return 'UNCHANGED';
}

/** A material investment or digital-asset movement today (d1) or this week (w1). */
function investmentsMovedMaterially(pkg: BriefPackage): boolean {
  const { d1, w1 } = pkg.recentChanges;
  return [d1?.investments, d1?.digitalAssets, w1?.investments, w1?.digitalAssets]
    .some((d) => d !== undefined && changeBucket(d) !== '0' && changeBucket(d) !== 'NA');
}

export interface RelevanceDecision {
  concentration: { novelty: Novelty; shown: boolean } | null;
}

/**
 * The model's view of the package: today's facts, minus standing facts that are
 * neither new, changed, nor needed to explain today's movement.
 *
 * `prior` is the previous DAY's Brief — never today's own row, so a same-day
 * regeneration keeps a fact introduced this morning as NEW rather than hiding it.
 */
export function applyRelevance(
  pkg: BriefPackage,
  prior: { facts: StandingFacts | null; briefDay: string } | null,
): { pkg: BriefPackage; decision: RelevanceDecision } {
  const conc = pkg.currentState.concentration;
  if (!conc) return { pkg, decision: { concentration: null } };

  const ageDays = prior
    ? Math.round((Date.parse(`${pkg.identity.briefDay}T00:00:00Z`) - Date.parse(`${prior.briefDay}T00:00:00Z`)) / 86_400_000)
    : Infinity;
  const usablePrior = prior && ageDays <= RELEVANCE_PRIOR_MAX_DAYS ? prior.facts : null;
  const novelty = concentrationNovelty(standingFactsOf(pkg).concentration, usablePrior);
  const shown = novelty !== 'UNCHANGED' || investmentsMovedMaterially(pkg);

  const next: BriefPackage = structuredClone(pkg);
  if (shown) next.currentState.concentration = { ...conc, novelty };
  else delete next.currentState.concentration;
  return { pkg: next, decision: { concentration: { novelty, shown } } };
}
