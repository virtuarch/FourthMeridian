/**
 * lib/ai/signal-registry.ts
 *
 * Registry for signal detector functions (D4).
 *
 * A signal detector examines the assembled ContextDomainSection for a given
 * domain and emits zero or more ContextSignals. Detectors are deterministic
 * and rule-based — no LLM calls.
 *
 * Unlike assemblers (one per domain), multiple detectors may be registered
 * for the same domain. detectSignals() calls all detectors registered for
 * each assembled domain and concatenates results.
 *
 * No detectors are registered in Slice 1. The infrastructure exists so that
 * Slice 9 (signal baseline) can add them without touching this file.
 */

import type { ContextDomainSection, ContextSignal } from '@/lib/ai/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A signal detector function.
 *
 * Receives the assembled section for a single domain, the domain key, and
 * the spaceId (for stamping signals). Returns an array of signals — may be
 * empty if the detector finds nothing noteworthy.
 */
export type SignalDetectorFn = (
  domain:  string,
  section: ContextDomainSection,
  spaceId: string,
) => ContextSignal[];

// ---------------------------------------------------------------------------
// Internal registry
// ---------------------------------------------------------------------------

// Multiple detectors per domain — stored as an array per key.
const _registry = new Map<string, SignalDetectorFn[]>();

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register a signal detector for the given domain key.
 *
 * Multiple detectors may be registered for the same domain; all will be
 * called in registration order by detectSignals().
 */
export function registerSignalDetector(domain: string, fn: SignalDetectorFn): void {
  const existing = _registry.get(domain);
  if (existing) {
    existing.push(fn);
  } else {
    _registry.set(domain, [fn]);
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Run all registered detectors over the supplied domain map.
 *
 * Only domains that have both an assembled section and at least one
 * registered detector are processed. Detector errors are caught and logged
 * to stderr — a broken detector must not abort context assembly.
 *
 * Returns all signals sorted: 'critical' first, then 'warning', then 'info';
 * within each severity, ordered by detectedAt ascending.
 */
export function detectSignals(
  domains: Record<string, ContextDomainSection>,
  spaceId: string,
): ContextSignal[] {
  const signals: ContextSignal[] = [];

  for (const [domain, section] of Object.entries(domains)) {
    const detectors = _registry.get(domain);
    if (!detectors || detectors.length === 0) continue;

    for (const detector of detectors) {
      try {
        const emitted = detector(domain, section, spaceId);
        signals.push(...emitted);
      } catch (err) {
        // A detector failure must not abort context assembly.
        console.error(
          `[signal-registry] Detector for domain "${domain}" threw:`,
          err,
        );
      }
    }
  }

  return sortSignals(signals);
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/**
 * Return the list of domain keys that have at least one registered detector.
 * Useful for diagnostics and test assertions.
 */
export function listDetectorDomains(): string[] {
  return Array.from(_registry.keys());
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
