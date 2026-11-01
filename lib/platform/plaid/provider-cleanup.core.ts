/**
 * lib/platform/plaid/provider-cleanup.core.ts  (PB-5)
 *
 * The PURE half of lib/platform/plaid/provider-cleanup.ts — the marker shape,
 * the per-item grouping and the per-item verdict — split out with no database
 * import so the Removed connections fold (and the client widget that reads its
 * vocabulary) can share it. The doctrine is the parent module's header: newest
 * marker wins, rows ascending, `PlaidItem.status` is never cleanup evidence.
 */

import { AuditAction } from "@/lib/audit-actions";

/** The two markers that constitute the provider-cleanup lifecycle. */
export const CLEANUP_MARKERS = [
  AuditAction.PLAID_ITEM_REVOCATION_UNCONFIRMED,
  AuditAction.PLAID_ITEM_REVOCATION_CONFIRMED,
] as const;

export type MarkerRow = {
  action: string;
  createdAt: Date;
  metadata: unknown;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * PB-5 — the PRE-PROVIDER marker. lib/plaid/disconnect.ts writes its verdict
 * marker only AFTER Plaid answered, so a process that dies between itemRemove
 * and that write left no trace. The operator removal therefore writes an
 * UNCONFIRMED marker tagged `phase: "PRE_PROVIDER"` BEFORE the call (through
 * disconnectAccounts' beforeProviderRevocation hook). Newest-wins does the
 * rest with no new rule: a completed attempt's own marker supersedes it; a
 * crash leaves it newest, so the item reads OWED: the Provider cleanup widget
 * and the Removed list show it (after the grace window below) and the operator
 * Retry works on it; plaid-removal-retry picks it up only once the product
 * status reached REVOKED (its relinked-item protection skips ACTIVE items). It is an obligation, not an attempt,
 * so it is not counted in `attemptCount` and carries no error code.
 */
export const PRE_PROVIDER_PHASE = "PRE_PROVIDER" as const;
export function isPreProviderMarker(m: MarkerRow): boolean {
  return (m.metadata as { phase?: unknown } | null)?.phase === PRE_PROVIDER_PHASE;
}

/**
 * PB-5 (S2) — THE GRACE WINDOW. A PRE_PROVIDER marker is newest from the moment
 * it is written until the attempt's own marker lands — normally seconds. While
 * it is younger than this, the removal is IN PROGRESS, not crashed: nothing
 * else may start a second provider call for it (the scheduled
 * plaid-removal-retry skips it; the operator Retry refuses it with
 * IN_PROGRESS; the UIs hide Retry and say "removal in progress"). Older than
 * this with nothing after it, the removal is treated as interrupted and the
 * obligation is retryable as any other owed item.
 *
 * It still COUNTS as owed everywhere (widget and Removed list alike — one
 * verdict, one count): an in-flight removal is genuinely unconfirmed.
 * 15 minutes is far above the route's own duration (one request; itemRemove is
 * a single HTTP call) and far below the daily retry cadence.
 */
export const PRE_PROVIDER_GRACE_MS = 15 * 60_000;

/** Is this owed verdict an operator removal still inside its grace window? Pure; `now` is handed in. */
export function isRemovalInProgress(v: Pick<CleanupVerdict, "verdict" | "latestIsPreProvider" | "latestMarkerAt"> | undefined, now: Date): boolean {
  return !!v && v.verdict === "OWED" && v.latestIsPreProvider && now.getTime() - v.latestMarkerAt.getTime() < PRE_PROVIDER_GRACE_MS;
}

/** Markers grouped per plaidItemId, preserving the (ascending) input order. */
export function groupByItem(rows: MarkerRow[]): Map<string, MarkerRow[]> {
  const byItem = new Map<string, MarkerRow[]>();
  for (const r of rows) {
    const id = str((r.metadata as { plaidItemId?: unknown } | null)?.plaidItemId);
    if (!id) continue;
    const list = byItem.get(id);
    if (list) list.push(r);
    else byItem.set(id, [r]);
  }
  return byItem;
}

/**
 * PB-5 — ONE ITEM'S VERDICT, the unit both readers count.
 *
 * The Provider cleanup widget (counts) and the Removed connections list (one
 * row per removed connection) must never disagree about how many removals are
 * owed or confirmed, so neither re-derives the lifecycle: both read the verdict
 * this function produces. `foldCleanupStatus` counts it; the removed-connections
 * reader (lib/platform/connections/removed-connections.core.ts) labels rows
 * with it. A pinned test asserts the two counts agree over one fixture.
 *
 * `outcome` is the CONFIRMED marker's own word (REMOVED / ALREADY_GONE), null
 * on an owed verdict or on a legacy CONFIRMED row written before the outcome
 * field existed — never inferred from `PlaidItem.status`.
 */
export type CleanupVerdict = {
  verdict: "OWED" | "CONFIRMED";
  outcome: "REMOVED" | "ALREADY_GONE" | null;
  /** UNCONFIRMED attempts ever recorded for the item. */
  attemptCount: number;
  /** The newest marker's time — when the provider question was last answered. */
  latestMarkerAt: Date;
  /** PB-5 — the newest marker is a PRE_PROVIDER one (an operator removal opened it; no attempt recorded since). */
  latestIsPreProvider: boolean;
  /** The provider's code on the newest UNCONFIRMED marker, when it gave one. */
  latestErrorCode: string | null;
};

/** The per-item verdicts, keyed by plaidItemId. Rows must be ascending (see the header). */
export function cleanupVerdicts(rows: MarkerRow[]): Map<string, CleanupVerdict> {
  const out = new Map<string, CleanupVerdict>();
  for (const [id, markers] of groupByItem(rows)) {
    const newest = markers[markers.length - 1];
    // Attempts only: a PRE_PROVIDER marker records an obligation, not an attempt.
    const unconfirmed = markers.filter((m) => m.action === AuditAction.PLAID_ITEM_REVOCATION_UNCONFIRMED && !isPreProviderMarker(m));
    const owed = newest.action === AuditAction.PLAID_ITEM_REVOCATION_UNCONFIRMED;
    const word = str((newest.metadata as { outcome?: unknown } | null)?.outcome);
    out.set(id, {
      verdict:         owed ? "OWED" : "CONFIRMED",
      outcome:         owed ? null : word === "REMOVED" || word === "ALREADY_GONE" ? word : null,
      attemptCount:    unconfirmed.length,
      latestMarkerAt:  newest.createdAt,
      latestIsPreProvider: isPreProviderMarker(newest),
      latestErrorCode: unconfirmed.length > 0
        ? str((unconfirmed[unconfirmed.length - 1].metadata as { plaidErrorCode?: unknown } | null)?.plaidErrorCode)
        : null,
    });
  }
  return out;
}

