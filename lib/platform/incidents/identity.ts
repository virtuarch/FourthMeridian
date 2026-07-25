/**
 * lib/platform/incidents/identity.ts  (OPS-2D-5A-1)
 *
 * THE incident identity builder. Pure, and the only place a key is constructed.
 *
 * Identity answers "is this the same operational problem, still going?" — which
 * is a different question from "what does this row mean?". The second already
 * has an authority (lib/platform/sync-issue-semantics.ts) and this module does
 * not duplicate it: domain and nature are asked FOR, never re-derived here.
 *
 * WHY IT IS STORED WHEN SEVERITY IS NOT
 * -------------------------------------
 * The semantics authority deliberately derives severity/domain/nature and
 * refuses to persist them, because a stored opinion drifts from the rule that
 * produced it. Identity is not an opinion. It is a CONSTRAINT: the database
 * enforces one active episode per key, and a constraint cannot be evaluated at
 * read time. That is the whole distinction, and it is why storing this is not an
 * exception to that doctrine.
 *
 * WHAT IDENTITY IS BUILT FROM
 * ---------------------------
 *   provider · connection (plaidItemId) · derived domain · semantic scope
 *
 * and never from message text, stack traces, database error wording, timestamps,
 * or an execution id. Those either differ between two occurrences of one problem
 * (so the incident would fragment) or collide across unrelated problems.
 *
 * SCOPE, AND WHY IT IS NOT JUST `kind`
 * ------------------------------------
 * `UPSERT_ERROR` currently spans at least five unrelated failures, separated
 * only by `detail.stage`. Keying on `kind` alone would collapse an
 * opening-position repair and a lost bank transaction into one incident on the
 * same item — a merge no later taxonomy split could undo, because the episodes
 * would already share a row. So `stage` participates in identity now, and the
 * deferred OPS-2D-5B split can refine categories without rebuilding the
 * lifecycle: it bumps KEY_VERSION and new episodes key differently, while
 * historical episodes keep the identity they were recorded under.
 */

import type { SyncIssueDomain } from "@/lib/platform/sync-issue-semantics";

/**
 * Bumped when the identity RULE changes. Stored beside the key so a future
 * taxonomy refinement cannot silently merge episodes built under two rules.
 */
export const INCIDENT_KEY_VERSION = 1;

/** Used when a row carries no stage and no resource scope to discriminate on. */
export const LEGACY_UNSPECIFIED = "legacy-unspecified";

export interface IncidentIdentityInput {
  provider: string;
  /** The provider connection. Null for producers that do not name one. */
  plaidItemId: string | null;
  /** From classifySyncIssue — asked for, never re-derived here. */
  domain: SyncIssueDomain;
  /** `detail.stage`, when the producer records one. */
  stage?: string | null;
  /**
   * Account/resource scope, ONLY when the failure is genuinely account-scoped.
   * A transaction-persistence failure is item-scoped (the cursor is held for the
   * whole item), so passing an account here would fragment one held page into
   * one incident per account.
   */
  resourceScope?: string | null;
}

/**
 * Build the canonical key.
 *
 * Deterministic and order-stable: the same problem always produces the same
 * string, which is what makes the partial unique index meaningful. Segments are
 * joined with a separator that cannot appear in an id or a stage name.
 */
export function buildIncidentKey(input: IncidentIdentityInput): string {
  const scope =
    input.stage?.trim() ||
    input.resourceScope?.trim() ||
    LEGACY_UNSPECIFIED;

  return [
    `v${INCIDENT_KEY_VERSION}`,
    input.provider,
    input.plaidItemId ?? "no-item",
    input.domain,
    scope,
  ].join("::");
}
