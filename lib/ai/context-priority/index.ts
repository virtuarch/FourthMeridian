/**
 * lib/ai/context-priority/index.ts
 *
 * Public barrel for the Context Priority Registry & deterministic planner
 * (D6.3D-1, shadow mode).
 *
 * Shadow-mode contract: consumers may compute and log a SelectionPlan, but must
 * NOT use it to trim, reorder, or otherwise change prompt output in this slice.
 * Enforcement is a separate, flag-gated slice (D6.3D-3).
 */

export {
  planContextSelection,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  type PlanContextSelectionInput,
} from './planner';

export {
  PLANNER_VERSION,
  listDescriptors,
  getDescriptor,
  intentFamilyForIntent,
} from './registry';

export type {
  SelectionPlan,
  IncludedSection,
  TrimmedSection,
  DependencyEdge,
  ContextSectionDescriptor,
  SectionLayer,
  ImportanceTier,
  IntentFamily,
  AffinityLevel,
  InclusionReason,
  TrimReason,
} from './types';
