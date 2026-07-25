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

/**
 * The stable thing a failure is scoped to (OPS-2D-5A-2).
 *
 * 5A-1 keyed on `plaidItemId` because both adopted producers had one. Most of
 * the remaining producers do NOT: investment repair and import rollback are
 * account-scoped, BTC sync is wallet-scoped, and instrument resolution may have
 * neither. Keying those on a null item would collapse every account, import and
 * wallet on the platform into ONE episode per domain+stage — a merge that would
 * make the incident model actively misleading the moment it was adopted.
 *
 * PREFIXED so an account id can never collide with an item id.
 */
export type ConnectionScope =
  | { kind: "PLAID_ITEM"; id: string }
  | { kind: "FINANCIAL_ACCOUNT"; id: string }
  | { kind: "WALLET"; id: string }
  /** No stable scope exists — used only when every id above is absent. */
  | { kind: "LEGACY_UNSCOPED" };

export interface IncidentIdentityInput {
  provider: string;
  /**
   * The provider connection, when the producer has one. Kept as its own field
   * rather than folded into `scope` because its serialization is deliberately
   * UNPREFIXED — see buildIncidentKey.
   */
  plaidItemId: string | null;
  /** Used when there is no plaidItemId. */
  scope?: ConnectionScope;
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
function serializeScope(input: IncidentIdentityInput): string {
  // BACKWARD COMPATIBLE ON PURPOSE. A Plaid item still serializes to its bare
  // id, exactly as v1 did, so every episode opened by OPS-2D-5A-1 keeps its key
  // and an active v1 episode still converges with new observations. Prefixing it
  // would have been tidier and would have orphaned live episodes behind a
  // version bump — the churn the generalization was supposed to avoid.
  if (input.plaidItemId) return input.plaidItemId;
  const s = input.scope;
  if (!s) return "no-item";
  return s.kind === "LEGACY_UNSCOPED" ? "LEGACY_UNSCOPED" : `${s.kind}:${s.id}`;
}

export function buildIncidentKey(input: IncidentIdentityInput): string {
  const stage =
    input.stage?.trim() ||
    input.resourceScope?.trim() ||
    LEGACY_UNSPECIFIED;

  return [
    `v${INCIDENT_KEY_VERSION}`,
    input.provider,
    serializeScope(input),
    input.domain,
    stage,
  ].join("::");
}

// ── Reading a key back (OPS-2D-5C-minimal) ───────────────────────────────────
//
// WHY THE READER LIVES BESIDE THE BUILDER, AND WHY IT IS NOT A SECOND AUTHORITY
// ----------------------------------------------------------------------------
// The key FORMAT is this module's private business. Anything that needs a
// segment back out of a stored key must therefore ask this module, or the format
// gets re-derived — a component splitting on "::" would be a second, silent
// owner of the layout, free to disagree the moment a version changed.
//
// So this is a READER, not a second builder: it produces no key, decides no
// identity, and is not consulted by the lifecycle. It exists because the
// OPERATION that failed is already persisted (it is the last segment of
// `SyncIssue.incidentKey`), and an operator surface needs to name it without a
// new column, a new projection field, or a second trip to the database.
//
// IT NEVER THROWS. Legacy rows carry a null key, historical rows carry keys
// written under rules this code has never seen, and a future version may add
// segments. Every one of those is answered with `null` — an honest "unknown" —
// rather than an exception on an operator's dashboard or, worse, a guess.

/**
 * One incident key, taken apart. Every field is the string AS RECORDED, which is
 * not the same thing as the current verdict about the row.
 *
 * ⚠️ `domain` in particular is a HISTORICAL ARTEFACT of identity — what the
 * classifier said at write time, frozen so the episode keeps converging. It is
 * NOT the classification. Anything asking "what domain is this incident?" must
 * ask `classifySyncIssue`, which reads the row's current `detail`; using the
 * value below instead would resurrect a stored opinion the semantics authority
 * deliberately refuses to persist.
 */
export interface ParsedIncidentKey {
  /** The identity rule this key was built under (`v1` → 1). */
  version: number;
  provider: string;
  /** Serialized scope, exactly as `serializeScope` wrote it. */
  scope: string;
  /** See the warning above: recorded, not current. */
  domain: string;
  /**
   * The stable operation discriminator — a registered `OperationKey`, an
   * `unregistered:<stage>` namespace, or `legacy-unspecified`. Consumers must
   * treat anything they do not recognise as UNKNOWN, never as a stage to render.
   */
  operation: string;
}

/**
 * The inverse of `buildIncidentKey`. Pure, total, and never throwing.
 *
 * Returns null for a key that does not match the shape this module writes —
 * absent, blank, too few segments, or an unrecognisable version prefix. The
 * separator is duplicated from `buildIncidentKey` rather than shared, because
 * touching the builder was out of scope for the slice that added this; the
 * round-trip is pinned by test instead, which is the stronger guarantee anyway.
 */
export function parseIncidentKey(key: string | null | undefined): ParsedIncidentKey | null {
  if (typeof key !== "string") return null;
  const parts = key.split("::");
  // Fewer than five segments is not a key this module ever produced.
  if (parts.length < 5) return null;

  const [versionTag, provider, scope, domain, ...operationParts] = parts;
  const match = /^v(\d+)$/.exec(versionTag);
  if (!match) return null;

  // A stage is a raw producer string and could in principle contain the
  // separator; the operation is the TAIL, so such a stage is reassembled rather
  // than silently truncated to its first fragment.
  const operation = operationParts.join("::");
  if (!provider || !scope || !domain || !operation) return null;

  return { version: Number(match[1]), provider, scope, domain, operation };
}
