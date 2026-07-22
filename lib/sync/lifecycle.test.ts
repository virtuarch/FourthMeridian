/**
 * lib/sync/lifecycle.test.ts  (CONN-1)
 *
 * Pure tests for the connection lifecycle projection. Standalone `tsx` script
 * (exit 0/1), no DB:
 *
 *     npx tsx lib/sync/lifecycle.test.ts
 *
 * Covers: stage sets per provider, the importing long-pole (transactions for
 * Plaid / discovery for wallet), the all-done `ready` state, the failed-state
 * fallback, monotonic done→active→pending ordering, and the invariant that the
 * projection never invents an `intelligenceReady` stage.
 */

import { deriveConnectionLifecycle, type LifecycleStage } from "./lifecycle";
import type { SyncConnection } from "./status";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

function conn(p: Pick<SyncConnection, "provider" | "state">) {
  return deriveConnectionLifecycle(p);
}
const keys = (s: LifecycleStage[]) => s.map((x) => x.key);
const active = (s: LifecycleStage[]) => s.find((x) => x.status === "active")?.key ?? null;
const statusOf = (s: LifecycleStage[], k: string) => s.find((x) => x.key === k)?.status ?? null;

console.log("Plaid — stage set + importing long pole");
{
  const p = conn({ provider: "PLAID", state: "importing" });
  // historyBuilt added 2026-07-23: the wealth-history rebuild runs after the
  // transactions land and was previously invisible, so the card reached "Ready"
  // while the history it was about to show was still being written.
  check("Plaid stage set is connected→accounts→balances→transactions→history→ready",
    JSON.stringify(keys(p)) === JSON.stringify([
      "connected", "accountsDiscovered", "balancesImported", "transactionsImported",
      "historyBuilt", "ready",
    ]));
  check("importing: transactions is the active stage", active(p) === "transactionsImported");
  check("importing: connected/accounts/balances all done",
    statusOf(p, "connected") === "done" &&
    statusOf(p, "accountsDiscovered") === "done" &&
    statusOf(p, "balancesImported") === "done");
  check("importing: ready is still pending", statusOf(p, "ready") === "pending");
}

console.log("Plaid — ready = all done");
{
  const p = conn({ provider: "PLAID", state: "ready" });
  check("ready: every stage is done", p.every((s) => s.status === "done"));
  check("ready: no stage is active", active(p) === null);
}

console.log("Wallet — discovery is the long pole");
{
  const w = conn({ provider: "WALLET", state: "importing" });
  check("Wallet stage set is connected→addresses→balances→ready",
    JSON.stringify(keys(w)) === JSON.stringify([
      "connected", "addressesDiscovered", "balancesImported", "ready",
    ]));
  check("importing: address discovery is the active stage", active(w) === "addressesDiscovered");
  check("importing: balances not yet done (discovery precedes it)", statusOf(w, "balancesImported") === "pending");
  check("wallet ready: all done", conn({ provider: "WALLET", state: "ready" }).every((s) => s.status === "done"));
}

console.log("Failed states — connected done, remainder pending, no crash");
{
  for (const state of ["needs_reauth", "error"] as const) {
    const p = conn({ provider: "PLAID", state });
    check(`${state}: connected is done`, statusOf(p, "connected") === "done");
    check(`${state}: ready is not done`, statusOf(p, "ready") !== "done");
    check(`${state}: no stage falsely active past connected`,
      p.filter((s) => s.status === "done").length === 1);
  }
}

console.log("Monotonic ordering — done* active? pending* (never out of order)");
{
  for (const provider of ["PLAID", "WALLET"] as const) {
    for (const state of ["importing", "ready", "needs_reauth", "error"] as const) {
      const s = conn({ provider, state });
      const rank = (st: string) => (st === "done" ? 0 : st === "active" ? 1 : 2);
      const ranks = s.map((x) => rank(x.status));
      const monotonic = ranks.every((r, i) => i === 0 || r >= ranks[i - 1]);
      const atMostOneActive = s.filter((x) => x.status === "active").length <= 1;
      check(`${provider}/${state}: statuses are monotonic + ≤1 active`, monotonic && atMostOneActive);
    }
  }
}

console.log("Plaid — history rebuild advances the active node past transactions");
{
  const p = conn({
    provider: "PLAID",
    state: "importing",
    historyBuild: { doneDays: 40, totalDays: 730 },
  } as Pick<SyncConnection, "provider" | "state"> & Pick<SyncConnection, "historyBuild">);
  check("rebuilding: historyBuilt is the active stage", active(p) === "historyBuilt");
  check("rebuilding: transactions already done", statusOf(p, "transactionsImported") === "done");
  check("rebuilding: ready still pending", statusOf(p, "ready") === "pending");
  // Without historyBuild the same state must still point at transactions —
  // otherwise every ordinary import would claim to be building history.
  const plain = conn({ provider: "PLAID", state: "importing" });
  check("importing without a rebuild stays on transactions", active(plain) === "transactionsImported");
}

console.log("Invariant — no fabricated intelligenceReady stage");
{
  const all = [
    ...conn({ provider: "PLAID", state: "ready" }),
    ...conn({ provider: "WALLET", state: "ready" }),
  ];
  check("no stage key is 'intelligenceReady' (would need a real persisted marker)",
    !all.some((s) => (s.key as string) === "intelligenceReady"));
}

if (failures > 0) { console.error(`\nlifecycle: ${failures} failure(s).`); process.exit(1); }
console.log("\nlifecycle: all passed.");
