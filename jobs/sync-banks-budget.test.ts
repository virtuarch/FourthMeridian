/**
 * jobs/sync-banks-budget.test.ts  (OPS-001 / OPS-010)
 *
 * The bank sweep's budget, order and continuation, with a FAKE CLOCK and
 * injected item processing — no Plaid, no database. Standalone tsx:
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs jobs/sync-banks-budget.test.ts
 */

import {
  syncBanks, syncBanksOrder, SYNC_BANKS_BUDGET_MS, SYNC_BANKS_PER_ITEM_RESERVE_MS, SYNC_BANKS_RECENT_MS,
  SYNC_BANKS_ITEM_DEADLINE_MS, type SyncBanksCandidate,
} from "@/jobs/sync-banks";
import { decideJobDue, CONTINUATION_DELAY_MS } from "@/lib/jobs/cadence-policy.core";
import { SCHEDULED_JOBS } from "@/lib/jobs/registry";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

const NOW = Date.UTC(2026, 9, 22, 6, 0, 0);
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000);
const item = (id: string, last: Date | null): SyncBanksCandidate =>
  ({ id, institutionName: `Bank ${id}`, investmentsConsent: null, encryptedToken: "x", lastSyncedAt: last });

function harness(items: SyncBanksCandidate[], stepMs: number | ((id: string) => number)) {
  let t = NOW;
  const order: string[] = [];
  const quiet = { log: console.log, warn: console.warn };
  const run = async (budgetMs?: number) => {
    console.log = () => {}; console.warn = () => {};
    try {
      return await syncBanks({
        loadItems: async () => items,
        admit: async () => ({ decision: "ADMIT" as const, reason: null }),
        clock: () => t,
        budgetMs,
        processItem: async (it) => { order.push(it.id); t += typeof stepMs === "number" ? stepMs : stepMs(it.id); return "succeeded"; },
      });
    } finally { Object.assign(console, quiet); }
  };
  return { run, order };
}

async function main() {
  console.log("order");
  {
    const o = syncBanksOrder([item("c", hoursAgo(30)), item("a", null), item("b", hoursAgo(48)), item("fresh", hoursAgo(1)), item("a2", null)], NOW);
    check("never-synced first (id tie-break), then oldest lastSyncedAt; fresh dropped", o.map((x) => x.id).join() === "a,a2,b,c", o.map((x) => x.id).join());
    check("an Item synced exactly RECENT_MS ago is eligible again", syncBanksOrder([item("x", new Date(NOW - SYNC_BANKS_RECENT_MS))], NOW).length === 1);
  }

  console.log("\nbudget (fake clock)");
  {
    // 10 items × 30 s each. Budget 180 s, reserve 45 s ⇒ start while elapsed ≤ 135 s:
    // starts at 0,30,60,90,120 (5 items), the 6th would start at 150 > 135.
    const items = Array.from({ length: 10 }, (_, i) => item(`i${i}`, hoursAgo(30 - i)));
    const h = harness(items, 30_000);
    const r = await h.run();
    check("five items run inside the budget", r.succeeded === 5 && h.order.join() === "i0,i1,i2,i3,i4", h.order.join());
    check("the other five are DEFERRED (not failed, not skipped)", r.deferred === 5 && r.failed === 0 && r.skipped === 0);
    check("the summary carries `deferred` for the continuation", typeof r.deferred === "number" && r.total === 10);
    check("constants: budget 180 s, reserve 45 s", SYNC_BANKS_BUDGET_MS === 180_000 && SYNC_BANKS_PER_ITEM_RESERVE_MS === 45_000);
  }
  {
    const h = harness([item("a", null), item("b", null)], 1_000);
    const r = await h.run();
    check("small fleet: everything runs, nothing deferred", r.succeeded === 2 && r.deferred === 0);
  }
  {
    const h = harness([item("slow", null), item("ok", null)], (id) => (id === "slow" ? SYNC_BANKS_ITEM_DEADLINE_MS + 1 : 1_000));
    const r = await h.run();
    check("an Item over the per-item deadline is reported slow, and the sweep continues", r.slowItems === 1 && r.succeeded === 2);
  }
  {
    const h = harness([item("a", null)], 1_000);
    let t = 0;
    const r = await syncBanks({ loadItems: async () => [item("a", null)], admit: async () => ({ decision: "DENY" as const, reason: "MAINTENANCE_MODE" as const }), clock: () => t++, processItem: async () => { h.order.push("x"); return "succeeded"; } });
    check("not admitted ⇒ nothing started, every candidate deferred", r.notAdmitted === "MAINTENANCE_MODE" && r.deferred === 1 && h.order.length === 0);
  }

  console.log("\ncontinuation (the dispatcher's decision)");
  {
    const sb = SCHEDULED_JOBS.find((j) => j.name === "sync-banks")!;
    check("sync-banks is registered selfContinues", sb.selfContinues === true);
    const now = new Date(NOW);
    const ran = (minAgo: number, summary: unknown, status = "succeeded") =>
      decideJobDue(sb, { hours: 24 }, { lastStartedAt: new Date(NOW - minAgo * 60_000), lastStatus: status, lastSummary: summary }, now);
    check("deferred work + delay elapsed ⇒ due (SELF_CONTINUATION)", ran(CONTINUATION_DELAY_MS / 60_000 + 1, { deferred: 3 }).reason === "SELF_CONTINUATION");
    check("deferred work but too soon ⇒ not due", ran(5, { deferred: 3 }).due === false);
    check("nothing deferred ⇒ the 24 h cadence holds", ran(30, { deferred: 0 }).due === false);
    check("a FAILED run is not a continuation trigger", ran(30, { deferred: 3 }, "failed").due === false);
    const crypto = SCHEDULED_JOBS.find((j) => j.name === "sync-crypto")!;
    check("sync-crypto keeps its separate continuation job (not selfContinues)", !crypto.selfContinues
      && decideJobDue(crypto, { hours: 6 }, { lastStartedAt: new Date(NOW - 30 * 60_000), lastStatus: "succeeded", lastSummary: { deferred: 2 } }, now).due === false);
  }

  if (failures > 0) { console.error(`\n❌ sync-banks budget: ${failures} check(s) failed`); process.exit(1); }
  console.log("\n✅ sync-banks budget: all checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
