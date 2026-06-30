/**
 * lib/ai/signals/index.ts
 *
 * Public barrel and bootstrap entry point for the Signals Engine (D4 Slice 5).
 *
 * Importing this module:
 *   1. Side-effect imports execute all detector files, causing each to call
 *      registerDetector() and wire into the registry.
 *   2. runSignalDetectors() is exported for use by the context builder.
 *
 * The context builder imports from this barrel — not from individual detector
 * files. New detectors are added by:
 *   1. Creating lib/ai/signals/detectors/<name>.ts
 *   2. Adding one side-effect import line here
 *   Nothing else changes.
 *
 * Consumer-facing exports:
 *   runSignalDetectors — call after domain assembly; returns ContextSignal[]
 *   SignalType         — string constants for all implemented signal types
 */

// ── Bootstrap: register all detectors ─────────────────────────────────────
// Each import executes the module's top-level registerDetector() call.
import './detectors/transactions';
import './detectors/snapshot';
import './detectors/goals';
import './detectors/accounts';

// ── Public API ─────────────────────────────────────────────────────────────
export { runSignalDetectors } from '@/lib/ai/signals/registry';
export { SignalType }         from '@/lib/ai/signals/types';
export type { SignalType as SignalTypeValue } from '@/lib/ai/signals/types';
