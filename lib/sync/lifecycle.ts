/**
 * lib/sync/lifecycle.ts  (CONN-1)
 *
 * The connection LIFECYCLE projection — a pure, I/O-free read model that turns a
 * normalized `SyncConnection` into the ordered stages of "building intelligence"
 * (connected → discovered → balances → history → ready). It is the single
 * authority for *which stage* a connection is in, so every surface (the importing
 * card stepper today, the Connections redesign later) renders one truthful model
 * instead of hand-rolling stage logic inline.
 *
 * TRUTHFULNESS INVARIANTS (CONN-1):
 *   - Every stage status is DERIVED from a persisted signal (`SyncConnection`,
 *     itself derived from PlaidItem.syncIncompleteAt / Connection.lastSyncedAt).
 *     No stage is fabricated and none is driven by a best-effort notification.
 *   - This module carries NO money — no balances, valuations, or tiers (PCS-2).
 *     `balancesImported` is a *stage marker*, not a balance value.
 *   - Labels are intentionally NOT here: wording is presentation and lives in the
 *     consumer (ConnectionCard). This projection speaks only in stable `key`s +
 *     a `status`, so a label change never touches lifecycle logic and vice-versa.
 *   - `intelligenceReady` is NOT modeled as a distinct stage: there is no
 *     dedicated persisted marker for it today (it would alias `ready`), and
 *     CONN-1 must not invent one. When a real signal exists it can be added here.
 *
 * Kept Prisma-free and dependency-light (only the SyncConnection type) so it is
 * unit-testable with a standalone `tsx` script, matching lib/sync/status.ts.
 */

import type { SyncConnection, SyncProvider, SyncConnectionState } from "@/lib/sync/status";

/**
 * Ordered lifecycle stage keys, per provider family. Plaid's long pole is
 * transaction-history import; a self-custody wallet's is on-chain address
 * discovery — so the two families have genuinely different stage sets, not a
 * forced-common shape.
 */
export type PlaidLifecycleStageKey =
  | "connected"
  | "accountsDiscovered"
  | "balancesImported"
  | "transactionsImported"
  | "ready";

export type WalletLifecycleStageKey =
  | "connected"
  | "addressesDiscovered"
  | "balancesImported"
  | "ready";

export type LifecycleStageKey = PlaidLifecycleStageKey | WalletLifecycleStageKey;

/** Same three-valued status the card stepper renders — no "blocked": a failed
 *  connection renders dedicated needs-reauth/error content, not a stepper. */
export type LifecycleStageStatus = "done" | "active" | "pending";

export interface LifecycleStage {
  key:    LifecycleStageKey;
  status: LifecycleStageStatus;
}

const PLAID_STAGES: PlaidLifecycleStageKey[] = [
  "connected",
  "accountsDiscovered",
  "balancesImported",
  "transactionsImported",
  "ready",
];

const WALLET_STAGES: WalletLifecycleStageKey[] = [
  "connected",
  "addressesDiscovered",
  "balancesImported",
  "ready",
];

/**
 * Given the ordered stage keys and the index of the stage currently in flight,
 * mark everything before it `done`, that stage `active`, and everything after
 * `pending`. `activeIndex === keys.length` means the whole lifecycle is done.
 */
function project(keys: LifecycleStageKey[], activeIndex: number): LifecycleStage[] {
  return keys.map((key, i) => ({
    key,
    status: i < activeIndex ? "done" : i === activeIndex ? "active" : "pending",
  }));
}

/**
 * The index of the stage currently in flight for a connection, by provider +
 * state. This is the ONE place lifecycle progress is decided.
 *
 * Plaid — at connect the item is born with accounts + balances + today's
 * snapshot already written and `syncIncompleteAt = now`, so `importing` means
 * transaction-history import is the live stage; `ready` (syncIncompleteAt null)
 * means the whole lifecycle is complete.
 *
 * Wallet — a fresh wallet's long pole is on-chain address discovery, which runs
 * (and resumes) before balances settle; `importing` puts discovery in flight,
 * `ready` (Connection.lastSyncedAt set) means complete.
 *
 * needs_reauth / error — the import did not complete: `connected` stays done and
 * the rest is pending. The card renders dedicated content for these states, so
 * this representation is a truthful fallback, not the rendered surface.
 */
function activeIndexFor(provider: SyncProvider, state: SyncConnectionState): number {
  const keys = provider === "WALLET" ? WALLET_STAGES : PLAID_STAGES;
  switch (state) {
    case "ready":
      return keys.length; // all done
    case "importing":
      // The long-pole stage: transactions (Plaid) / discovery (wallet).
      return provider === "WALLET"
        ? WALLET_STAGES.indexOf("addressesDiscovered")
        : PLAID_STAGES.indexOf("transactionsImported");
    case "needs_reauth":
    case "error":
      return 1; // connected done; nothing further completed
    default:
      return 1;
  }
}

/**
 * Derive the ordered lifecycle stages for a connection. Pure — the same input
 * always yields the same stages. The consumer maps each `key` to human wording
 * appropriate to its `status`.
 */
export function deriveConnectionLifecycle(
  connection: Pick<SyncConnection, "provider" | "state">,
): LifecycleStage[] {
  const keys: LifecycleStageKey[] =
    connection.provider === "WALLET" ? WALLET_STAGES : PLAID_STAGES;
  return project(keys, activeIndexFor(connection.provider, connection.state));
}
