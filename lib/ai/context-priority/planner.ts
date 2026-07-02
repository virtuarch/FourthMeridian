/**
 * lib/ai/context-priority/planner.ts
 *
 * Deterministic context selection planner (D6.3D-1, shadow mode).
 *
 * planContextSelection() is a PURE function. Given an intent route, an assembled
 * context, a computed assessment, and a token budget, it produces a
 * SelectionPlan describing which sections *would* be serialized under that
 * budget and which would be trimmed — and why.
 *
 * SHADOW MODE: the returned plan is descriptive only. This module does not
 * mutate the context, the assessment, or any prompt. It performs no I/O, no LLM
 * calls, no clock reads, and no randomness. Identical inputs → identical plan.
 *
 * Algorithm (greedy-tiered; see D6.3D investigation §9c):
 *   1. Resolve the intent family and score every available section as
 *        importance × affinity × confidence   (freshness reserved — neutral).
 *   2. Seed the included set with the Required floor (ALWAYS sections) and its
 *      dependency closure — never trimmed.
 *   3. Consider remaining sections in descending score order (key-ascending tie
 *      break for determinism). SUPPRESS-affinity sections are trimmed outright.
 *   4. Add a candidate (plus its as-yet-unincluded available dependencies) when
 *      its closure fits the remaining budget; otherwise trim it 'over-budget'.
 *   5. A section is never included without its available dependencies.
 */

import type { SpaceContext_AI } from '@/lib/ai/types';
import type { FinancialAssessment, ConfidenceLevel } from '@/lib/ai/intelligence';
import type { IntentRoute } from '@/lib/ai/intent';

import {
  AFFINITY_WEIGHT,
  CONFIDENCE_WEIGHT,
  IMPORTANCE_WEIGHT,
  PLANNER_VERSION,
  affinityFor,
  getDescriptor,
  intentFamilyForIntent,
  listDescriptors,
} from './registry';
import type {
  AffinityLevel,
  ContextSectionDescriptor,
  DependencyEdge,
  IncludedSection,
  IntentFamily,
  SelectionPlan,
  TrimmedSection,
} from './types';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface PlanContextSelectionInput {
  intentRoute: IntentRoute;
  context: SpaceContext_AI;
  assessment: FinancialAssessment;
  budgetTokens: number;
}

/** Default token ceiling used by shadow-mode callers. Value does not affect
 *  prompt output while in shadow mode; it only shapes the logged plan. */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 6000;

/** Characters-per-token divisor for the deterministic length-based estimate. */
const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// Internal per-section working record
// ---------------------------------------------------------------------------

interface Candidate {
  descriptor: ContextSectionDescriptor;
  available: boolean;
  estimatedTokens: number;
  confidence: ConfidenceLevel | null;
  affinity: AffinityLevel;
  score: number;
}

/** Deterministic token estimate from serialized data length. */
function estimateTokens(data: unknown, fallback: number): number {
  if (data === undefined || data === null) return fallback;
  let serialized: string;
  try {
    serialized = JSON.stringify(data);
  } catch {
    return fallback;
  }
  if (!serialized) return fallback;
  return Math.max(1, Math.ceil(serialized.length / CHARS_PER_TOKEN));
}

/** Resolve the live data + availability for a section. */
function resolveSection(
  descriptor: ContextSectionDescriptor,
  context: SpaceContext_AI,
  assessment: FinancialAssessment,
): { available: boolean; data: unknown } {
  if (descriptor.layer === 'DOMAIN') {
    const section = context.domains[descriptor.key];
    return { available: section != null, data: section?.data };
  }
  // ASSESSMENT: sections are always produced by computeAssessment().
  const record = assessment as unknown as Record<string, unknown>;
  const data = record[descriptor.key];
  return { available: data !== undefined, data };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function planContextSelection(
  input: PlanContextSelectionInput,
): SelectionPlan {
  const { intentRoute, context, assessment } = input;
  const budgetTokens =
    Number.isFinite(input.budgetTokens) && input.budgetTokens > 0
      ? input.budgetTokens
      : DEFAULT_CONTEXT_BUDGET_TOKENS;

  const family: IntentFamily = intentFamilyForIntent(intentRoute.intent);

  // ── Score every registered section ────────────────────────────────────────
  const candidates = new Map<string, Candidate>();
  let estimatedTokensAvailable = 0;

  for (const descriptor of listDescriptors()) {
    const { available, data } = resolveSection(descriptor, context, assessment);
    const estimatedTokens = estimateTokens(data, descriptor.staticEstimatedTokens);
    const confidence = descriptor.confidenceFrom?.(assessment) ?? null;
    const affinity = affinityFor(descriptor, family);

    const confidenceFactor = confidence ? CONFIDENCE_WEIGHT[confidence] : 1.0;
    const freshnessFactor = 1.0; // Reserved (D6.3D §5): neutral until a pure
    //                              asOf signal is threaded in a later slice.
    const score =
      IMPORTANCE_WEIGHT[descriptor.baseImportance] *
      AFFINITY_WEIGHT[affinity] *
      confidenceFactor *
      freshnessFactor;

    candidates.set(descriptor.key, {
      descriptor,
      available,
      estimatedTokens,
      confidence,
      affinity,
      score,
    });
    if (available) estimatedTokensAvailable += estimatedTokens;
  }

  // ── Build the included set ────────────────────────────────────────────────
  const included = new Map<string, IncludedSection>();
  let tokensUsed = 0;

  const add = (
    key: string,
    includedAs: IncludedSection['includedAs'],
  ): void => {
    if (included.has(key)) return;
    const c = candidates.get(key);
    if (!c || !c.available) return; // never include an unavailable section
    included.set(key, {
      key,
      layer: c.descriptor.layer,
      includedAs,
      score: c.score,
      estimatedTokens: c.estimatedTokens,
      affinity: c.affinity,
      confidence: c.confidence,
    });
    tokensUsed += c.estimatedTokens;
  };

  /** Transitive available dependencies of a key not yet included. */
  const closureOf = (key: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>([key]);
    const stack = [...(getDescriptor(key)?.dependsOn ?? [])];
    while (stack.length > 0) {
      const dep = stack.pop() as string;
      if (seen.has(dep)) continue;
      seen.add(dep);
      const depCand = candidates.get(dep);
      if (!depCand || !depCand.available) continue;
      if (!included.has(dep)) out.push(dep);
      stack.push(...(getDescriptor(dep)?.dependsOn ?? []));
    }
    return out;
  };

  // 1. Required floor (ALWAYS) + its closure. Never trimmed.
  const requiredFloor: string[] = listDescriptors()
    .filter((d) => d.baseImportance === 'ALWAYS' && candidates.get(d.key)?.available)
    .map((d) => d.key);

  for (const key of requiredFloor) {
    add(key, 'floor');
    for (const dep of closureOf(key)) add(dep, 'dependency');
  }

  // 2. Score-ordered candidates (exclude floor, unavailable, suppressed).
  const trimmed: TrimmedSection[] = [];

  const scored = [...candidates.values()]
    .filter((c) => c.available && !included.has(c.descriptor.key))
    .sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : a.descriptor.key.localeCompare(b.descriptor.key),
    );

  const pushTrim = (c: Candidate, reason: TrimmedSection['reason']): void => {
    trimmed.push({
      key: c.descriptor.key,
      layer: c.descriptor.layer,
      reason,
      score: c.score,
      estimatedTokens: c.estimatedTokens,
      affinity: c.affinity,
      confidence: c.confidence,
    });
  };

  for (const c of scored) {
    if (c.affinity === 'SUPPRESS') {
      pushTrim(c, 'suppressed');
      continue;
    }
    const closure = closureOf(c.descriptor.key);
    const deltaTokens =
      c.estimatedTokens +
      closure.reduce((sum, dep) => sum + (candidates.get(dep)?.estimatedTokens ?? 0), 0);

    if (tokensUsed + deltaTokens <= budgetTokens) {
      add(c.descriptor.key, 'scored');
      for (const dep of closure) add(dep, 'dependency');
    } else {
      pushTrim(c, 'over-budget');
    }
  }

  // 3. Unavailable registered sections → informational trims.
  for (const c of candidates.values()) {
    if (!c.available) pushTrim(c, 'unavailable');
  }

  // ── Dependency edges (traceability) ───────────────────────────────────────
  const dependencies: DependencyEdge[] = listDescriptors()
    .filter((d) => d.dependsOn.length > 0 && included.has(d.key))
    .map((d) => ({ key: d.key, dependsOn: [...d.dependsOn] }));

  return {
    shadow: true,
    plannerVersion: PLANNER_VERSION,
    budgetTokens,
    intent: intentRoute.intent,
    intentFamily: family,
    requiredFloor,
    included: [...included.values()],
    trimmed,
    dependencies,
    estimatedTokensUsed: tokensUsed,
    estimatedTokensAvailable,
    fitsInBudget: tokensUsed <= budgetTokens && !trimmed.some((t) => t.reason === 'over-budget'),
  };
}
