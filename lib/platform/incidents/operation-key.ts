/**
 * lib/platform/incidents/operation-key.ts  (OPS-2D-5B-0)
 *
 * The stable machine identity of a failed operation.
 *
 * THE PROBLEM THIS CLOSES
 * -----------------------
 * Incident identity is currently `v1::provider::scope::domain::stage`, where
 * `stage` is a raw string a producer types into `detail`. That single string is
 * doing three jobs at once:
 *
 *   1. diagnostic context   ("what was happening")
 *   2. operator wording     (it surfaces in describeSyncIssue)
 *   3. identity discriminator (it is IN the incident key)
 *
 * Job 3 is the dangerous one. Renaming `"transaction-persist"` to something
 * clearer — an ordinary, well-intentioned edit — silently orphans every active
 * episode keyed on the old string: the old episodes stay open forever and new
 * failures open duplicates beside them. Nothing fails, nothing warns.
 *
 * So identity stops reading the raw string and reads a REGISTERED operation key
 * instead. Producers keep writing `detail.stage` for diagnostics; the registry
 * decides what that means for identity, and an alias table lets wording change
 * without moving the key.
 *
 * WHY NO NEW COLUMN
 * -----------------
 * The resolved identity is ALREADY persisted — it is embedded in
 * `SyncIssue.incidentKey`, which is indexed and carries the partial unique
 * constraint. A separate `operationKey` column would store the same fact twice
 * and add a migration, a backfill, and a second thing to keep in sync. The
 * registry normalizes at the one place identity is built; that is enough to make
 * the invariant enforceable, which is the bar.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a taxonomy. Public issue codes (OPS-2D-5B-1) are a separate axis and are
 * deliberately NOT part of identity: a taxonomy deployment must not read as
 * recovery, supersession, or a new failure episode. An operation key outlives
 * the issue code that describes it.
 */

/**
 * Every operation that can currently produce an incident, keyed by the raw
 * `detail.stage` a producer writes today.
 *
 * The VALUE is the stable identity; the KEY is what producers happen to write.
 * They are equal on purpose right now — that keeps every existing incidentKey
 * byte-identical, so no active episode moves when this lands. They are separate
 * CONCEPTS with different change contracts:
 *
 *   renaming a stage string  → add an alias, identity unchanged
 *   renaming an operation    → deliberate identity change, needs a key version
 */
export const OPERATION_KEYS = {
  // ── Bank transactions — the only financial-data-critical path ──────────────
  "transaction-persist": "transaction-persist",

  // ── Investments (internal repair; optional data) ───────────────────────────
  "investment-events-fetch":      "investment-events-fetch",
  "investment-events":            "investment-events",
  "investment-events-instrument": "investment-events-instrument",
  "reconstruction-repair":        "reconstruction-repair",
  "investment-import-repair":     "investment-import-repair",
  "opening-position-repair":      "opening-position-repair",

  // ── Instrument identity (EVENT evidence) ───────────────────────────────────
  "import-weak-ambiguous":  "import-weak-ambiguous",
  "import-strong-conflict": "import-strong-conflict",

  // ── User imports ───────────────────────────────────────────────────────────
  "import-rollback-repair": "import-rollback-repair",

  // ── Wallet sync (BTC) ──────────────────────────────────────────────────────
  discovery: "discovery",
  balance:   "balance",
  price:     "price",
} as const;

export type OperationKey = (typeof OPERATION_KEYS)[keyof typeof OPERATION_KEYS];

/**
 * Retired stage spellings → the operation key they still mean.
 *
 * EMPTY TODAY, and that is the point: it exists so the first rename has an
 * obvious, safe home. Without it the only way to rename a stage is to orphan
 * every episode carrying the old one.
 */
export const OPERATION_KEY_ALIASES: Record<string, OperationKey> = {};

/**
 * Legacy or unrecognised stages keep this instead of being forced into a
 * registered key. Two different unknown stages must NOT collapse together —
 * see resolveOperationKey.
 */
export const UNREGISTERED_PREFIX = "unregistered:";

/**
 * Resolve a producer's raw stage into the stable identity discriminator.
 *
 * An unknown stage is NOT rejected and NOT normalised away. Historical rows
 * carry stages this registry has never heard of, and a future producer may ship
 * before its registration does. Both stay readable, and — critically — two
 * different unknown stages stay DIFFERENT: collapsing them to one sentinel
 * would merge unrelated failures into a single global episode, which is the
 * precise defect the scope work in 5A-2 existed to prevent.
 */
export function resolveOperationKey(stage: string | null | undefined): string | null {
  if (stage == null) return null;
  const trimmed = stage.trim();
  if (trimmed === "") return null;
  if (trimmed in OPERATION_KEYS) return OPERATION_KEYS[trimmed as keyof typeof OPERATION_KEYS];
  const alias = OPERATION_KEY_ALIASES[trimmed];
  if (alias) return alias;
  return `${UNREGISTERED_PREFIX}${trimmed}`;
}

/** Is this stage known to the registry (directly or by alias)? */
export function isRegisteredOperation(stage: string | null | undefined): boolean {
  if (stage == null) return false;
  const t = stage.trim();
  return t in OPERATION_KEYS || t in OPERATION_KEY_ALIASES;
}
