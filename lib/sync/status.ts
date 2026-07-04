/**
 * lib/sync/status.ts
 *
 * D2.x Slice 3 — provider-agnostic sync-status derivation.
 *
 * Pure, I/O-free logic that turns raw provider connection rows (today only
 * PlaidItem) into the normalized `SyncStatus` contract the Connections
 * experience reads. Kept Prisma-free (accepts a plain structural input, not a
 * Prisma model) so it can be unit-tested with a standalone `tsx` script
 * without `prisma generate`.
 *
 * The state machine is derived entirely from EXISTING PlaidItem fields — no
 * schema, no SyncJob:
 *   - status = ACTIVE   & cursor = null → "importing"   (first-run history still loading)
 *   - status = ACTIVE   & cursor ≠ null → "ready"
 *   - status = NEEDS_REAUTH             → "needs_reauth"
 *   - status = ERROR                    → "error"
 *   - status = REVOKED                  → excluded (deriveConnectionState → null)
 *
 * `cursor` is consumed ONLY here to compute state. It is a Plaid access
 * cursor and MUST NEVER appear on the outward-facing SyncConnection / leave
 * the server — see the SyncConnection shape below (no cursor field) and the
 * unit test that asserts its absence.
 */

export type SyncConnectionState = "importing" | "ready" | "needs_reauth" | "error";

/** Provider-agnostic. PLAID today; WALLET / CSV / COINBASE / SCHWAB / … later. */
export type SyncProvider = "PLAID";

export interface SyncConnection {
  /** Opaque connection id (PlaidItem.id today). */
  id:           string;
  provider:     SyncProvider;
  institution:  string;
  state:        SyncConnectionState;
  /** ISO timestamp of the last completed full sync; null until first completes. */
  lastSyncedAt: string | null;
  /** Provider error code — only meaningful for needs_reauth / error. */
  errorCode:    string | null;
}

export interface SyncStatus {
  /** True iff at least one connection is still importing first-run history. */
  building:    boolean;
  connections: SyncConnection[];
}

/**
 * Provider display identity for the Connections cards — provider is part of a
 * connection's identity ("Synced via Plaid"), not a hidden implementation
 * detail. Pure display map (no I/O, no API). Adding a future provider is a
 * one-line entry here, not a card rewrite:
 *   COINBASE → "Coinbase", SCHWAB → "Schwab API", CSV → "CSV" (verb "Imported via"),
 *   WALLET → "Hardware Wallet" (verb "Connected via"), QUICKBOOKS → "QuickBooks"
 *   (verb "Imported via"), etc.
 */
export const PROVIDER_LABEL: Record<SyncProvider, string> = {
  PLAID: "Plaid",
};

export function providerName(provider: SyncProvider): string {
  return PROVIDER_LABEL[provider] ?? provider;
}

/**
 * Minimal structural shape this module needs from a PlaidItem row. Declared
 * locally (not imported from @prisma/client) to keep the module Prisma-free
 * and testable without generated types. `status` is a plain string union of
 * the PlaidItemStatus values.
 */
export interface PlaidItemStateInput {
  id:              string;
  institutionName: string;
  status:          "ACTIVE" | "NEEDS_REAUTH" | "ERROR" | "REVOKED";
  cursor:          string | null;
  lastSyncedAt:    Date | null;
  errorCode:       string | null;
}

/**
 * Derives the normalized state for a single Plaid connection, or null when
 * the connection should be excluded from the surface entirely (REVOKED).
 */
export function deriveConnectionState(
  item: Pick<PlaidItemStateInput, "status" | "cursor">,
): SyncConnectionState | null {
  switch (item.status) {
    case "REVOKED":
      return null;
    case "NEEDS_REAUTH":
      return "needs_reauth";
    case "ERROR":
      return "error";
    case "ACTIVE":
      // cursor is written only after syncTransactionsForItem's full loop
      // completes, so a null cursor on an ACTIVE item = first-run history
      // still importing (Slice 1 deferred the inline sync).
      return item.cursor === null ? "importing" : "ready";
    default:
      // Unknown/unexpected status — omit rather than guess.
      return null;
  }
}

/**
 * Maps raw Plaid connection rows into the provider-agnostic SyncStatus.
 * Excludes rows whose state is null (REVOKED / unknown). Never leaks `cursor`.
 */
export function buildSyncStatus(items: PlaidItemStateInput[]): SyncStatus {
  const connections: SyncConnection[] = [];

  for (const item of items) {
    const state = deriveConnectionState(item);
    if (state === null) continue;

    connections.push({
      id:           item.id,
      provider:     "PLAID",
      institution:  item.institutionName,
      state,
      lastSyncedAt: item.lastSyncedAt ? item.lastSyncedAt.toISOString() : null,
      errorCode:    item.errorCode ?? null,
    });
  }

  const building = connections.some((c) => c.state === "importing");
  return { building, connections };
}
