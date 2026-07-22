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
 * The state machine is derived from PlaidItem fields — no SyncJob:
 *   - status = ACTIVE   & syncIncompleteAt ≠ null → "importing"  (history still loading / interrupted)
 *   - status = ACTIVE   & syncIncompleteAt = null → "ready"      (a full sync has completed)
 *   - status = NEEDS_REAUTH                       → "needs_reauth"
 *   - status = ERROR                              → "error"
 *   - status = REVOKED                            → excluded (deriveConnectionState → null)
 *
 * D2.x resume — "ready" is keyed on syncIncompleteAt, NOT the old cursor===null
 * heuristic. The cursor is now persisted after every page (so a resume can
 * continue mid-import), which means cursor≠null no longer implies "done"; the
 * dedicated syncIncompleteAt marker is the completion signal. `syncIncompleteAt`
 * is consumed ONLY here to compute state and MUST NEVER appear on the outward
 * SyncConnection — same contract the Plaid `cursor` had (asserted by the test).
 */

export type SyncConnectionState = "importing" | "ready" | "needs_reauth" | "error";

/** Provider-agnostic. PLAID + WALLET today; CSV / COINBASE / SCHWAB / … later. */
export type SyncProvider = "PLAID" | "WALLET";

/**
 * Client-safe Investments capability for a connection, derived from
 * PlaidItem.investmentsConsent. Deliberately narrower than the DB enum:
 *   ENABLED          → "enabled"   (holdings sync active)
 *   CONSENT_REQUIRED → "available" (supported; user can enable via update mode)
 *   UNSUPPORTED      → null        (never surface an action — see invariant)
 *   null (unknown)   → null        (not yet probed; don't mislead)
 * Only "available" renders an "Enable Investments" action; "enabled" renders a
 * connected/synced indicator; null renders nothing.
 */
export type InvestmentsCapability = "enabled" | "available";

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
  /**
   * Investments capability for this connection, or null when not applicable
   * (unsupported, unknown, or non-Plaid). Never carries the raw access token
   * or any credential — a pure display-capability enum.
   */
  investments:  InvestmentsCapability | null;
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
  PLAID:  "Plaid",
  WALLET: "Self-custody",
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
  /**
   * D2.x resume completion marker. Non-null on an ACTIVE item = first-run
   * history still importing (or a prior attempt was interrupted). Consumed only
   * to derive state; never forwarded onto SyncConnection.
   */
  syncIncompleteAt: Date | null;
  lastSyncedAt:    Date | null;
  errorCode:       string | null;
  /**
   * Raw PlaidItem.investmentsConsent (string union of the DB enum), or null
   * when unknown/never derived. Consumed only to compute the client-safe
   * `investments` capability — never forwarded verbatim.
   */
  investmentsConsent?: "ENABLED" | "CONSENT_REQUIRED" | "UNSUPPORTED" | null;
}

/**
 * Maps the raw PlaidItem.investmentsConsent enum to the client-safe
 * capability. UNSUPPORTED and unknown both collapse to null so no misleading
 * "Enable Investments" action is ever surfaced (see task invariant).
 */
export function deriveInvestmentsCapability(
  consent: PlaidItemStateInput["investmentsConsent"],
): InvestmentsCapability | null {
  switch (consent) {
    case "ENABLED":          return "enabled";
    case "CONSENT_REQUIRED": return "available";
    default:                 return null; // UNSUPPORTED | null | undefined
  }
}

/**
 * Derives the normalized state for a single Plaid connection, or null when
 * the connection should be excluded from the surface entirely (REVOKED).
 */
export function deriveConnectionState(
  item: Pick<PlaidItemStateInput, "status" | "syncIncompleteAt">,
): SyncConnectionState | null {
  switch (item.status) {
    case "REVOKED":
      return null;
    case "NEEDS_REAUTH":
      return "needs_reauth";
    case "ERROR":
      return "error";
    case "ACTIVE":
      // syncIncompleteAt is cleared only after syncTransactionsForItem's full
      // loop completes, so a non-null value on an ACTIVE item = first-run
      // history still importing (or a prior attempt was interrupted and is
      // awaiting resume).
      return item.syncIncompleteAt !== null ? "importing" : "ready";
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
      investments:  deriveInvestmentsCapability(item.investmentsConsent),
    });
  }

  const building = connections.some((c) => c.state === "importing");
  return { building, connections };
}

// ── Wallet Provider (self-custody) ───────────────────────────────────────────
//
// Wallet connections ride the SAME SyncConnection contract as Plaid. State is
// derived from the v1.5 provider-sync-truth fields on Connection(provider=WALLET)
// — Connection.status / lastSyncedAt / errorCode — no schema, no cursor:
//   - REVOKED                          → excluded
//   - status ERROR                     → "error"
//   - status NEEDS_REAUTH              → "error"  (wallets never reauth; NEVER
//                                                  surface Plaid reconnect)
//   - status ACTIVE & lastSyncedAt set → "ready"
//   - status ACTIVE & errorCode set    → "error"  (first sync failed)
//   - status ACTIVE & neither          → "importing" (first sync pending)

/** Structural shape from a Connection(provider=WALLET) row + its display name. */
export interface WalletConnectionStateInput {
  id:           string;
  /** Card title — the wallet account's name (e.g. "My BTC Cold Storage"). */
  displayName:  string;
  status:       "ACTIVE" | "NEEDS_REAUTH" | "ERROR" | "REVOKED";
  lastSyncedAt: Date | null;
  errorCode:    string | null;
}

export function deriveWalletConnectionState(
  input: Pick<WalletConnectionStateInput, "status" | "lastSyncedAt" | "errorCode">,
): SyncConnectionState | null {
  switch (input.status) {
    case "REVOKED":      return null;
    case "ERROR":        return "error";
    case "NEEDS_REAUTH": return "error"; // wallets never reauth → error, never Plaid reconnect
    case "ACTIVE":
      if (input.lastSyncedAt !== null) return "ready";
      if (input.errorCode !== null)    return "error";
      return "importing";
    default:             return null;
  }
}

/** Map Connection(WALLET) rows → provider-agnostic SyncConnection[]. */
export function buildWalletSyncStatus(inputs: WalletConnectionStateInput[]): SyncConnection[] {
  const out: SyncConnection[] = [];
  for (const w of inputs) {
    const state = deriveWalletConnectionState(w);
    if (state === null) continue;
    out.push({
      id:           w.id,
      provider:     "WALLET",
      institution:  w.displayName,
      state,
      lastSyncedAt: w.lastSyncedAt ? w.lastSyncedAt.toISOString() : null,
      errorCode:    w.errorCode ?? null,
      // Investments (Plaid Holdings) is a Plaid-only capability — self-custody
      // wallets never surface it.
      investments:  null,
    });
  }
  return out;
}

/** Combine already-built connections (Plaid + Wallet + …) into one SyncStatus. */
export function finalizeSyncStatus(connections: SyncConnection[]): SyncStatus {
  return { building: connections.some((c) => c.state === "importing"), connections };
}
