/**
 * lib/sync/connection-copy.ts
 *
 * W-M2b — CONNECTED IS NOT SYNCED.
 *
 * Pure: no React, no DB, no clock. The provider sub-line every connection card
 * renders, extracted from the component because it is not decoration — it is a
 * CLAIM ABOUT WHAT HAPPENED, and a claim needs a test.
 *
 * ── The contradiction this exists to prevent ────────────────────────────────
 * The failure arms read "Previously synced via …" unconditionally, on the
 * assumption that a connection in an error state must have worked at some point.
 * That held while `error` only arose after a working connection broke. It
 * stopped holding the moment a connection could be terminal WITHOUT ever having
 * succeeded: a wallet on a chain this deployment cannot reach rendered
 *
 *     "Previously synced via Self-custody"
 *     "This wallet has not been synced."
 *
 * one line apart. Both cannot be true, and the "previously" half was the lie.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * `lastSyncedAt` is the ONLY record that a successful synchronization has ever
 * happened. With it null, no state may claim one — not error, not needs_reauth,
 * not even ready. Persisting a connection and obtaining data through it are two
 * different facts, and only the first is proved by the connection existing.
 *
 * Generic by construction: nothing here branches on a provider or a chain, so
 * Ethereum, Solana and every future network inherit it unchanged.
 */

import { providerName, type SyncConnection } from "./status";

/**
 * The provider sub-line for a connection card.
 *
 *   never synced           → "Connected via X"   (whatever the state)
 *   ready, has synced      → "Synced via X"
 *   failed, synced before  → "Previously synced via X"
 */
export function providerLine(
  connection: Pick<SyncConnection, "provider" | "state" | "lastSyncedAt">,
): string {
  const name = providerName(connection.provider);
  const hasEverSynced = connection.lastSyncedAt !== null;
  switch (connection.state) {
    case "importing":
      return `Connected via ${name}`;
    case "sync_deferred":
      // The connection is real and healthy — say so. The reason it has no data
      // yet is a platform condition, covered by the card body.
      return `Connected via ${name}`;
    case "ready":
      return hasEverSynced ? `Synced via ${name}` : `Connected via ${name}`;
    case "needs_reauth":
    case "error":
      return hasEverSynced ? `Previously synced via ${name}` : `Connected via ${name}`;
  }
}

/**
 * Has this connection ever produced a successful synchronization?
 *
 * Exported so a consumer never re-derives it from something weaker — the
 * connection existing, an account count above zero, or a state that merely
 * implies past success.
 */
export function hasEverSynced(
  connection: Pick<SyncConnection, "lastSyncedAt">,
): boolean {
  return connection.lastSyncedAt !== null;
}
