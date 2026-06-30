/**
 * lib/ai/assembler-registry.ts
 *
 * Registry for domain assembler functions (D4).
 *
 * An assembler is a pure async function that, given a validated SpaceContext
 * and options, returns a ContextDomainSection (or null if the domain produces
 * no data for this Space). Assemblers are registered at module load time by
 * the files in lib/ai/assemblers/.
 *
 * The context builder calls getAssembler(domain) at runtime; if no assembler
 * is registered for a domain, the domain is silently skipped and noted in
 * the audit log metadata.
 *
 * Security invariant:
 *   Assemblers may only read plaintext fields of Prisma models via SpaceContext.
 *   They must never import lib/plaid/encryption or call any decrypt function.
 *   Cross-Space queries are prohibited — assemblers must filter by the
 *   spaceId supplied in SpaceContext.
 */

import type { SpaceContext } from '@/lib/space';
import type { AssemblerOptions, ContextDomainSection } from '@/lib/ai/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A domain assembler function.
 *
 * Return null to indicate that the domain is intentionally empty for this
 * Space (e.g. no accounts linked yet). A null return will be omitted from
 * the assembled context's `domains` map but the domain key will still appear
 * in `resolvedDomains` with a note in the audit log.
 */
export type AssemblerFn = (
  spaceCtx: SpaceContext,
  options:  AssemblerOptions,
) => Promise<ContextDomainSection | null>;

// ---------------------------------------------------------------------------
// Internal registry
// ---------------------------------------------------------------------------

const _registry = new Map<string, AssemblerFn>();

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register an assembler for the given domain key.
 *
 * Throws if an assembler is already registered for that domain — duplicate
 * registration is always a programming error and should fail loudly.
 *
 * Call this at the top level of each assembler module file so it executes
 * when the module is first imported.
 */
export function registerAssembler(domain: string, fn: AssemblerFn): void {
  if (_registry.has(domain)) {
    throw new Error(
      `[assembler-registry] Duplicate assembler registration for domain "${domain}". ` +
      `Each domain may only have one assembler.`,
    );
  }
  _registry.set(domain, fn);
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Return the assembler registered for `domain`, or undefined if none exists.
 * The context builder treats undefined as "no assembler yet — skip domain."
 */
export function getAssembler(domain: string): AssemblerFn | undefined {
  return _registry.get(domain);
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/**
 * Return the list of currently registered domain keys, in insertion order.
 * Useful for diagnostics and test assertions.
 */
export function listRegisteredDomains(): string[] {
  return Array.from(_registry.keys());
}
