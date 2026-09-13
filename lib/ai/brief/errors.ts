/**
 * lib/ai/brief/errors.ts
 *
 * The one refusal every Daily Brief entry shares, in a module with no imports so
 * the lifecycle and the one-shot generator can both raise it.
 */

/**
 * The owner is not an active member of the named Space.
 *
 * `resolveSpaceContext` falls back to the user's PERSONAL Space by design — right
 * for a page, wrong here: a Brief quietly written about a different Space is a
 * Brief about the wrong money. The production chat route refuses the same
 * mismatch with a 403.
 */
export class BriefScopeError extends Error {
  constructor(readonly requestedSpaceId: string) {
    super('[brief] the owner is not an active member of the requested Space');
    this.name = 'BriefScopeError';
  }
}
