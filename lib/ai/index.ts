/**
 * lib/ai/index.ts
 *
 * Public barrel for the AI Context Builder (D4).
 *
 * Exports only the consumer-facing surface:
 *   - buildContext() and its options type
 *   - The SpaceContext_AI output type and its sub-types
 *   - FinanceDomains constants and the ContextDomain type
 *
 * Registry internals (registerAssembler, registerSignalDetector, etc.)
 * are intentionally NOT re-exported here. Assembler and detector modules
 * import from their respective registry files directly.
 *
 * Security note: this barrel inherits the server-only constraint from
 * context-builder.ts — importing lib/ai in a client component will fail
 * at build time via the 'server-only' guard in context-builder.ts.
 */

export { buildContext } from '@/lib/ai/context-builder';
export type { BuildContextOptions } from '@/lib/ai/context-builder';

export type {
  SpaceContext_AI,
  ContextDomain,
  ContextDomainSection,
  ContextSignal,
  AssemblerOptions,
} from '@/lib/ai/types';

export { FinanceDomains } from '@/lib/ai/types';
export type { FinanceDomain } from '@/lib/ai/types';

// Signals engine
export { SignalType } from '@/lib/ai/signals';
export type { SignalTypeValue } from '@/lib/ai/signals';

// Domain-specific data types (for consumer type-narrowing)
export type {
  AccountsSectionData,
  AccountSummaryItem,
  AccountHealthSummary,
  TransactionsSummaryData,
  CategorySpend,
  RecurringCandidate,
  SnapshotSectionData,
  SnapshotDataPoint,
  GoalsSectionData,
  GoalSummaryItem,
} from '@/lib/ai/types';
