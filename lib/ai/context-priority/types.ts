/**
 * lib/ai/context-priority/types.ts
 *
 * Type contracts for the Context Priority Registry & deterministic planner
 * (D6.3D-1, shadow mode).
 *
 * This module introduces a *selection* concept that the D6 pipeline does not
 * have today: given an intent, an assembled context, and a deterministic
 * assessment, decide which context/assessment sections would be worth
 * serializing under a token budget.
 *
 * SHADOW MODE INVARIANT (D6.3D-1):
 *   Nothing in this module mutates a prompt, a context, an assessment, the
 *   Context Builder, or the schema. planContextSelection() is a PURE function
 *   that returns a SelectionPlan describing what *would* be included/trimmed.
 *   The plan is computed and logged; it never removes a section from the
 *   prompt. Enforcement is a separate, later, flag-gated slice.
 *
 * Determinism invariant:
 *   No LLM calls, no model calls, no clock, no randomness. The same
 *   (intentRoute, context, assessment, budgetTokens) inputs always produce the
 *   same SelectionPlan. Token cost is estimated from serialized data length —
 *   a deterministic function of the inputs, not a tokenizer service.
 */

import type { ConfidenceLevel } from '@/lib/ai/intelligence';

// ---------------------------------------------------------------------------
// Layer & tier vocabulary
// ---------------------------------------------------------------------------

/**
 * Which layer of the pipeline produced a section:
 *   'DOMAIN'     — a Layer 1 ContextDomainSection (raw assembled data).
 *   'ASSESSMENT' — a Layer 2 FinancialAssessment section (interpreted finding).
 */
export type SectionLayer = 'DOMAIN' | 'ASSESSMENT';

/**
 * Base importance tier for a section, independent of the current question.
 * ALWAYS sections form the Required floor and are never trimmed.
 *
 *   ALWAYS     — Required floor. Always included, no intent needed.
 *   USUALLY    — included unless intent suppresses it or the budget is starved.
 *   ON_REQUEST — included when the intent matches (primary/supporting affinity).
 *   SUPPORTING — included mainly as a dependency of another section.
 *   NEVER      — excluded unless explicitly named (reserved; no such sections yet).
 */
export type ImportanceTier =
  | 'ALWAYS'
  | 'USUALLY'
  | 'ON_REQUEST'
  | 'SUPPORTING'
  | 'NEVER';

/**
 * Coarse intent families the registry scores against. Every FinancialIntent
 * maps to exactly one family (see INTENT_FAMILY_BY_INTENT in registry.ts). This
 * keeps affinity tables compact and mirrors the D6.3D domain × intent matrix.
 */
export type IntentFamily =
  | 'DEBT'
  | 'DEBT_VS_INVESTING'
  | 'SPENDING'
  | 'INVESTMENT'
  | 'CASH_FLOW'
  | 'GOAL'
  | 'OVERVIEW'
  | 'UPDATE'
  | 'UNKNOWN';

/**
 * Per-family affinity level for a section, expressed as a symbolic level that
 * maps to a numeric multiplier (see AFFINITY_WEIGHT in registry.ts):
 *   PRIMARY  (1.0) — this section should drive the answer for the family.
 *   SUPPORT  (0.6) — referenced to justify/qualify the answer.
 *   OPTIONAL (0.3) — include only if the budget allows.
 *   SUPPRESS (0.0) — must not be selected for this family (hard exclude).
 */
export type AffinityLevel = 'PRIMARY' | 'SUPPORT' | 'OPTIONAL' | 'SUPPRESS';

// ---------------------------------------------------------------------------
// Descriptor
// ---------------------------------------------------------------------------

/**
 * The static metadata a section declares to the registry. This is the single
 * source of truth the planner reads — it replaces the hard-coded
 * primary/supporting/suppress lists that today live in the intent classifier.
 *
 * `confidenceFrom` reads an already-computed confidence off the assessment
 * (never recomputed here). DOMAIN sections that carry no confidence omit it.
 */
export interface ContextSectionDescriptor {
  /** Stable section key. Matches a ContextDomain key (DOMAIN) or a
   *  FinancialAssessment field name (ASSESSMENT). */
  key: string;
  layer: SectionLayer;
  /** Base importance independent of the question. ALWAYS ⇒ Required floor. */
  baseImportance: ImportanceTier;
  /** Per-family affinity levels. A family absent from the map defaults to
   *  OPTIONAL, so a new intent never accidentally suppresses a section. */
  intentAffinity: Partial<Record<IntentFamily, AffinityLevel>>;
  /** Hard inclusion edges: keys that must travel with this section. Applied as
   *  a closure before trimming — a section is never selected without them. */
  dependsOn: string[];
  /** Static upper-bound token estimate, used only when live data is
   *  unavailable (documentation / unavailable listing). The planner prefers a
   *  length-derived estimate from the actual section data. */
  staticEstimatedTokens: number;
  /** Reads a precomputed confidence level off the assessment, or null when the
   *  section has no confidence concept. Never recomputes anything. */
  confidenceFrom?: (assessment: unknown) => ConfidenceLevel | null;
}

// ---------------------------------------------------------------------------
// SelectionPlan
// ---------------------------------------------------------------------------

/** Why a section landed in the included set. */
export type InclusionReason = 'floor' | 'scored' | 'dependency';

/** Why a section was left out (shadow mode: informational only). */
export type TrimReason = 'suppressed' | 'over-budget' | 'unavailable';

/** A section that the plan would include. */
export interface IncludedSection {
  key: string;
  layer: SectionLayer;
  includedAs: InclusionReason;
  /** Composite score used for ordering (floor/dependency entries may be 0). */
  score: number;
  /** Length-derived token estimate for this section's serialized data. */
  estimatedTokens: number;
  /** Affinity level resolved for the active intent family. */
  affinity: AffinityLevel;
  /** Confidence level read from the assessment, when the section carries one. */
  confidence: ConfidenceLevel | null;
}

/** A section that the plan would trim (shadow mode: not actually removed). */
export interface TrimmedSection {
  key: string;
  layer: SectionLayer;
  reason: TrimReason;
  score: number;
  estimatedTokens: number;
  affinity: AffinityLevel;
  confidence: ConfidenceLevel | null;
}

/** A resolved dependency edge, for traceability in the plan. */
export interface DependencyEdge {
  key: string;
  dependsOn: string[];
}

/**
 * The output of planContextSelection(). A pure description of what the pipeline
 * *would* serialize under the budget. In D6.3D-1 this is logged only.
 */
export interface SelectionPlan {
  /** Marks this as a shadow-mode plan that changed no prompt output. */
  shadow: true;
  /** Registry/planner version, so logged plans can be correlated to logic. */
  plannerVersion: string;
  /** The token ceiling this plan was computed against. */
  budgetTokens: number;

  /** The classified intent and the family it mapped to. */
  intent: string;
  intentFamily: IntentFamily;

  /** Section keys in the Required floor (baseImportance ALWAYS, available). */
  requiredFloor: string[];
  /** Sections the plan would include, ordered floor → dependency → scored. */
  included: IncludedSection[];
  /** Sections the plan would leave out, with reasons. */
  trimmed: TrimmedSection[];
  /** Dependency edges that were resolved during closure. */
  dependencies: DependencyEdge[];

  /** Sum of estimatedTokens across `included`. */
  estimatedTokensUsed: number;
  /** Sum of estimatedTokens across every available registered section. */
  estimatedTokensAvailable: number;
  /** True when the included set fit within budgetTokens (no over-budget trims). */
  fitsInBudget: boolean;
}
