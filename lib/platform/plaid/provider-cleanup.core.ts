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
 * crash leaves it newest, so the item reads OWED and plaid-removal-retry and
 * the Provider cleanup widget pick it up. It is an obligation, not an attempt,
 * so it is not counted in `attemptCount` and carries no error code.
 */
export const PRE_PROVIDER_PHASE = "PRE_PROVIDER" as const;
export function isPreProviderMarker(m: MarkerRow): boolean {
  return (m.metadata as { phase?: unknown } | null)?.phase === PRE_PROVIDER_PHASE;
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
      latestErrorCode: unconfirmed.length > 0
        ? str((unconfirmed[unconfirmed.length - 1].metadata as { plaidErrorCode?: unknown } | null)?.plaidErrorCode)
        : null,
    });
  }
  return out;
}

