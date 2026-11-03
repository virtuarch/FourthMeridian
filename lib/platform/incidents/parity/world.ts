/**
 * lib/platform/incidents/parity/world.ts  (PB-1 §13 — the shared fixture world, TEST-ONLY)
 *
 * One synthetic world that every incident reader is run over, so their verdicts
 * can be compared row by row. Synthetic ids and values only. Each row exists to
 * exercise one divergence from PB-1 §13.2 (named in `exercises`).
 */

export interface WorldRow {
  id: string;
  provider: string;
  kind: string;
  plaidItemId: string | null;
  financialAccountId: string | null;
  plaidTransactionId: string | null;
  detail: Record<string, unknown> | null;
  resolved: boolean;
  createdAt: Date;
  firstOccurredAt: Date | null;
  lastOccurredAt: Date | null;
  incidentKey: string | null;
  /** Which §13.2 divergence(s) this row is here to exercise. */
  exercises: string[];
}

export interface WorldItem { id: string; userId: string; deleted: boolean }
export interface WorldAccount {
  id: string;
  ownerUserId: string | null;
  createdByUserId: string | null;
  /** Soft-deleted (deletedAt set). */
  softDeleted: boolean;
  /** Row hard-deleted (does not exist at all). */
  hardDeleted: boolean;
  /** The Plaid item it is linked through (an AccountConnection), or null (manual account). */
  viaItemId: string | null;
}

export interface World {
  now: Date;
  /** Convergence's default window (DEFAULT_WINDOW_DAYS). */
  windowDays: number;
  users: string[];
  items: WorldItem[];
  accounts: WorldAccount[];
  rows: WorldRow[];
}

const DAY = 86_400_000;
const NOW = new Date("2026-11-03T12:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

function row(id: string, over: Partial<WorldRow>): WorldRow {
  return {
    id, provider: "PLAID", kind: "UPSERT_ERROR", plaidItemId: "item_a", financialAccountId: null,
    plaidTransactionId: null, detail: null, resolved: false,
    createdAt: ago(2), firstOccurredAt: ago(2), lastOccurredAt: ago(1), incidentKey: null, exercises: [],
    ...over,
  };
}

export function buildWorld(): World {
  return {
    now: NOW,
    windowDays: 14,
    users: ["u_alice", "u_bob"],
    items: [
      { id: "item_a", userId: "u_alice", deleted: false },
      { id: "item_gone", userId: "u_alice", deleted: true },
    ],
    accounts: [
      { id: "acct_live", ownerUserId: "u_alice", createdByUserId: "u_alice", softDeleted: false, hardDeleted: false, viaItemId: "item_a" },
      { id: "acct_soft", ownerUserId: "u_alice", createdByUserId: "u_alice", softDeleted: true, hardDeleted: false, viaItemId: "item_a" },
      { id: "acct_hard", ownerUserId: "u_alice", createdByUserId: "u_alice", softDeleted: false, hardDeleted: true, viaItemId: "item_a" },
      { id: "acct_manual", ownerUserId: null, createdByUserId: "u_bob", softDeleted: false, hardDeleted: false, viaItemId: null },
    ],
    rows: [
      row("r_condition_open", { exercises: ["baseline"] }),
      row("r_condition_resolved", { resolved: true, exercises: ["baseline"] }),
      row("r_tombstone_open", { kind: "REMOVED_TOMBSTONE", exercises: ["D1"] }),
      row("r_superseded_open", { kind: "BALANCE_TX_MISMATCH", plaidItemId: null, financialAccountId: "acct_live", detail: { basis: "pending" }, exercises: ["D1"] }),
      row("r_orphan_item", { plaidItemId: "item_gone", exercises: ["D1", "D2"] }),
      row("r_item_live_acct_hard", { plaidItemId: "item_a", financialAccountId: "acct_hard", exercises: ["D2"] }),
      row("r_acct_soft_deleted", { plaidItemId: null, financialAccountId: "acct_soft", exercises: ["D2"] }),
      row("r_txn_scoped", { kind: "UPSERT_ERROR", plaidTransactionId: "txn_1", exercises: ["D3"] }),
      row("r_manual_account", { plaidItemId: null, financialAccountId: "acct_manual", exercises: ["D4"] }),
      row("r_old_but_active", { createdAt: ago(40), firstOccurredAt: ago(40), lastOccurredAt: ago(1), exercises: ["D6", "D7"] }),
      row("r_recur_1", { resolved: true, incidentKey: "k_recur", createdAt: ago(10), firstOccurredAt: ago(10), lastOccurredAt: ago(9), exercises: ["D8"] }),
      row("r_recur_2", { incidentKey: "k_recur", createdAt: ago(3), firstOccurredAt: ago(3), lastOccurredAt: ago(1), exercises: ["D8"] }),
    ],
  };
}
