/**
 * lib/perspective-engine/registry.ts
 *
 * Registry for Perspective lens functions. Deliberately mirrors
 * lib/ai/assembler-registry.ts — same shape, same duplicate-registration
 * discipline — so the two "pure function registered per key" layers in the
 * codebase read identically. (The engine is the assemblers' sibling, not a
 * new invention: see PERSPECTIVE_ENGINE_FOUNDATION_INVESTIGATION.md §1.2.)
 *
 * Lens modules (lib/perspective-engine/lenses/*, commits 2–3) call
 * registerLens at module top level so registration happens on first import.
 * Commit 1 ships the registry empty: nothing registers yet, and
 * computePerspective() answers unregistered ids with a shaped
 * LENS_NOT_REGISTERED result rather than a throw (index.ts).
 *
 * Security invariant (guard-tested in engine.test.ts):
 *   Lens modules read only through the visibility-enforced data layer
 *   (lib/data/accounts.ts). Nothing under lib/perspective-engine/ may import
 *   lib/plaid/encryption, lib/ai/provider, or query Prisma directly.
 */

import type { LensFn, LensId } from "./types";

// ---------------------------------------------------------------------------
// Internal registry
// ---------------------------------------------------------------------------

const _registry = new Map<LensId, LensFn>();

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register a lens implementation for the given id.
 *
 * Throws if a lens is already registered for that id — duplicate
 * registration is always a programming error and should fail loudly.
 *
 * Call this at the top level of each lens module file so it executes when
 * the module is first imported.
 */
export function registerLens(lensId: LensId, fn: LensFn): void {
  if (_registry.has(lensId)) {
    throw new Error(
      `[perspective-engine] Duplicate lens registration for id "${lensId}". ` +
      `Each lens id may only have one implementation.`,
    );
  }
  _registry.set(lensId, fn);
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Return the lens registered for `lensId`, or undefined if none exists.
 * computePerspective() treats undefined as "not registered" and returns a
 * shaped LENS_NOT_REGISTERED error result.
 */
export function getLens(lensId: LensId): LensFn | undefined {
  return _registry.get(lensId);
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/**
 * Return the list of currently registered lens ids, in insertion order.
 * computePerspectives() iterates this; also useful for diagnostics and the
 * guard test that every PERSPECTIVE_LIBRARY entry carrying a lensId has a
 * registered implementation (investigation §6.9, wired in a later commit).
 */
export function listRegisteredLenses(): LensId[] {
  return Array.from(_registry.keys());
}
