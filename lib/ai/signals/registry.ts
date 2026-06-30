/**
 * lib/ai/signals/registry.ts
 *
 * Signals Engine registry — D4 Slice 5.
 *
 * Detectors register themselves by calling `registerDetector()` at module
 * load time (same pattern as assembler-registry.ts). The bootstrap barrel
 * (lib/ai/signals/index.ts) imports all detector modules, triggering
 * registration before `runSignalDetectors()` is called by the context builder.
 *
 * Detector signature:
 *   (domains, spaceId) → ContextSignal[]
 *
 * Each detector receives the full assembled domain map. This allows future
 * cross-domain signals (e.g. "spending up while income down") without
 * restructuring the registry. For now, each detector reads only its own
 * domain.
 *
 * A detector error is caught and logged; it must never abort context assembly.
 */

import type { ContextDomainSection, ContextSignal } from '@/lib/ai/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A signal detector function.
 * Receives the full assembled domain map and the Space ID; returns zero or
 * more signals. Must be deterministic and side-effect-free.
 */
export type SignalDetectorFn = (
  domains: Record<string, ContextDomainSection>,
  spaceId: string,
) => ContextSignal[];

// ---------------------------------------------------------------------------
// Internal registry
// ---------------------------------------------------------------------------

const _detectors: SignalDetectorFn[] = [];

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register a signal detector. Called at module load time by each detector
 * file — do not call after the module bootstrap phase.
 *
 * Multiple detectors may be registered; all are executed in registration
 * order by runSignalDetectors().
 */
export function registerDetector(fn: SignalDetectorFn): void {
  _detectors.push(fn);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Execute all registered detectors over the assembled domain map and return
 * a deduplicated, sorted list of signals.
 *
 * Sorting order: 'critical' → 'warning' → 'info'; within each severity,
 * ascending by detectedAt.
 *
 * A detector that throws is logged to stderr and skipped; other detectors
 * are not affected.
 */
export function runSignalDetectors(
  domains: Record<string, ContextDomainSection>,
  spaceId: string,
): ContextSignal[] {
  const signals: ContextSignal[] = [];

  for (const detector of _detectors) {
    try {
      signals.push(...detector(domains, spaceId));
    } catch (err) {
      console.error('[signals/registry] Detector threw — skipping:', err);
    }
  }

  return sortSignals(deduplicateById(signals));
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/** Number of detectors currently registered. Useful for test assertions. */
export function registeredDetectorCount(): number {
  return _detectors.length;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<ContextSignal['severity'], number> = {
  critical: 0,
  warning:  1,
  info:     2,
};

function sortSignals(signals: ContextSignal[]): ContextSignal[] {
  return [...signals].sort((a, b) => {
    const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sev !== 0) return sev;
    return a.detectedAt.localeCompare(b.detectedAt);
  });
}

/**
 * If two detectors somehow emit signals with the same id, keep the first.
 * This prevents duplicate alerts from reaching consumers.
 */
function deduplicateById(signals: ContextSignal[]): ContextSignal[] {
  const seen  = new Set<string>();
  const out: ContextSignal[] = [];
  for (const s of signals) {
    if (!seen.has(s.id)) {
      seen.add(s.id);
      out.push(s);
    }
  }
  return out;
}
