/**
 * lib/plaid/webhook-skip-signal.test.ts  (P2 — Production 2026-11-01)
 *
 * A Plaid TRANSACTIONS webhook that lands while another sync holds the item's
 * lock loses the claim and stamps syncIncompleteAt. Before this fix the HOLDER's
 * successful release cleared that marker unconditionally, so the "history is
 * ready" signal was erased: in production a card's HISTORICAL_UPDATE landed 9 s
 * into a 15 s RECONNECT run, its execution was SKIPPED, and the history pull
 * only happened because the user pressed Refresh (otherwise ~8 h later).
 *
 * Now: the release keeps a marker stamped at/after the holder's claim and
 * reports it; syncPlaidItemFromWebhook runs exactly ONE follow-up pass; and
 * anything the follow-up does not absorb stays a resume-stale-imports candidate.
 *
 * NO LIVE DATABASE, NO PROVIDER: the real lock primitives run against an
 * in-memory row whose `where` evaluation mirrors Postgres (fence equality, the
 * claim's stale-lock OR, the release's marker OR). Standalone tsx:
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/plaid/webhook-skip-signal.test.ts
 */

import { readFileSync } from "node:fs";
import {
  claimPlaidItemSyncLockAt, releasePlaidItemSyncLock, withPlaidItemSyncLock,
  type PlaidItemSyncLockClient,
} from "@/lib/plaid/sync-lock";
import {
  syncPlaidItemFromWebhook, shouldRunFollowUp, FOLLOW_UP_MAX_FIRST_RUN_MS,
  type LockedRunResult, type WebhookSyncOutcome,
} from "@/lib/plaid/webhook-sync";
import { resumeStaleImports, staleWhere } from "@/jobs/resume-stale-imports";
import type { StampedAdmissionVerdict } from "@/lib/platform/admission/types";
import type { BillableDecision } from "@/lib/entitlements/billable-gate";
import type { RefreshTrigger } from "@/lib/plaid/refresh-execution-types";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});
const quiet = async <T,>(f: () => Promise<T>): Promise<T> => {
  const { log, warn } = console; console.log = () => {}; console.warn = () => {};
  try { return await f(); } finally { console.log = log; console.warn = warn; }
};
const tick = () => new Promise((r) => setTimeout(r, 3));

// Any provider call is a failure: nothing here may reach Plaid.
globalThis.fetch = (async (input: unknown) => { throw new Error(`network call attempted: ${String(input)}`); }) as typeof fetch;

// ── In-memory PlaidItem row ──────────────────────────────────────────────────
type Row = { syncLockedAt: Date | null; syncIncompleteAt: Date | null };
type Cond = { syncLockedAt?: null | { lte: Date }; syncIncompleteAt?: null | { lt: Date } };
function makeRow(initial: Partial<Row> = {}) {
  const row: Row = { syncLockedAt: null, syncIncompleteAt: null, ...initial };
  const holds = (c: Cond): boolean => {
    if ("syncIncompleteAt" in c) {
      const v = c.syncIncompleteAt!; const cur = row.syncIncompleteAt;
      return v === null ? cur === null : cur !== null && cur.getTime() < v.lt.getTime(); // NULL < x is not true
    }
    const v = c.syncLockedAt!; const cur = row.syncLockedAt;
    return v === null ? cur === null : cur !== null && cur.getTime() <= v.lte.getTime();
  };
  const client: PlaidItemSyncLockClient = {
    plaidItem: {
      async updateMany({ where, data }) {
        const w = where as { OR?: Cond[]; syncLockedAt?: Date };
        if (w.OR && !w.OR.some(holds)) return { count: 0 };
        if (w.syncLockedAt instanceof Date && (row.syncLockedAt === null || row.syncLockedAt.getTime() !== w.syncLockedAt.getTime())) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      async count() { return 1; },
    },
  };
  return { row, client };
}

const ALLOW: BillableDecision = { allowed: true };
const admitted = { decision: "ADMIT", reason: null, label: null, evidence: null, authority: "PlatformSetting", evaluatedAt: "2026-11-02T00:00:00.000Z" } as unknown as StampedAdmissionVerdict;

/**
 * A locked run built from the REAL claim/release primitives on the fake row.
 * `during` runs while the lock is held — that is where a webhook "arrives".
 */
function lockedRun(client: PlaidItemSyncLockClient, during: () => Promise<void>, opts: { ok?: boolean; elapsedMs?: number } = {}) {
  return async (): Promise<LockedRunResult> => {
    await tick(); // real runs are milliseconds apart at least (a tie would deliberately keep the marker)
    const claimedAt = await claimPlaidItemSyncLockAt("item", client);
    if (!claimedAt) return { outcome: "skipped-locked", followUp: false, elapsedMs: 0 };
    await during();
    const released = await releasePlaidItemSyncLock("item", opts.ok ?? true, client, claimedAt);
    return { outcome: "ran", followUp: released.pendingSignal, elapsedMs: opts.elapsedMs ?? 15_000 };
  };
}
/** A webhook that arrives now and loses the claim to the holder (it stamps the marker, runs nothing). */
async function webhookArrives(client: PlaidItemSyncLockClient): Promise<boolean> {
  await tick();
  return (await claimPlaidItemSyncLockAt("item", client)) === null;
}

async function main(): Promise<void> {
  console.log("1. the production interleaving: holder acquires → webhook loses the lock → holder succeeds");
  {
    const { row, client } = makeRow();
    const claimedAt = await claimPlaidItemSyncLockAt("item", client);
    check("the holder (RECONNECT) acquires the lock", claimedAt !== null);
    const lost = await quiet(() => webhookArrives(client));
    const stamp = row.syncIncompleteAt;
    check("the HISTORICAL_UPDATE webhook loses the claim and stamps the marker", lost && stamp !== null && stamp.getTime() > claimedAt!.getTime());
    const r = await quiet(() => releasePlaidItemSyncLock("item", true, client, claimedAt!));
    check("the holder's successful release does NOT erase the pending signal", row.syncIncompleteAt?.getTime() === stamp!.getTime(), row);
    check("…it reports it (pendingSignal)", r.pendingSignal === true);
    check("…and the lock itself IS released", row.syncLockedAt === null);
  }

  console.log("2. no contention behaves as before");
  {
    const { row, client } = makeRow();
    const claimedAt = await claimPlaidItemSyncLockAt("item", client);
    const r = await releasePlaidItemSyncLock("item", true, client, claimedAt!);
    check("success with no skip: lock and marker cleared, nothing pending", row.syncLockedAt === null && row.syncIncompleteAt === null && !r.pendingSignal);
  }
  {
    // A marker from BEFORE the claim (the connect stamp / a prior failed run) is this run's to discharge.
    const before = new Date(Date.now() - 60_000);
    const { row, client } = makeRow({ syncIncompleteAt: before });
    const claimedAt = await claimPlaidItemSyncLockAt("item", client);
    const r = await releasePlaidItemSyncLock("item", true, client, claimedAt!);
    check("a pre-claim marker is still cleared on success (b871093 preserved)", row.syncIncompleteAt === null && row.syncLockedAt === null && !r.pendingSignal, row);
  }
  {
    const before = new Date(Date.now() - 60_000);
    const { row, client } = makeRow({ syncIncompleteAt: before });
    const claimedAt = await claimPlaidItemSyncLockAt("item", client);
    await quiet(() => webhookArrives(client));
    const r = await releasePlaidItemSyncLock("item", false, client, claimedAt!);
    check("a FAILED run releases the lock, keeps the marker, and asks for no follow-up", row.syncLockedAt === null && row.syncIncompleteAt !== null && !r.pendingSignal);
  }
  {
    // A tie (same millisecond) errs toward keeping the signal.
    const { row, client } = makeRow();
    const claimedAt = await claimPlaidItemSyncLockAt("item", client);
    row.syncIncompleteAt = new Date(claimedAt!.getTime());
    const r = await quiet(() => releasePlaidItemSyncLock("item", true, client, claimedAt!));
    check("a marker stamped in the claim's own millisecond survives", row.syncIncompleteAt !== null && r.pendingSignal);
  }
  {
    // Lease taken over (IDEMP-005): not a pending signal, and the new holder's lock is intact.
    const { row, client } = makeRow();
    const claimedAt = await claimPlaidItemSyncLockAt("item", client);
    row.syncLockedAt = new Date(claimedAt!.getTime() + 1);
    const r = await quiet(() => releasePlaidItemSyncLock("item", true, client, claimedAt!));
    check("a taken-over lease is left intact and reports no pending signal", row.syncLockedAt !== null && !r.pendingSignal);
  }
  {
    // withPlaidItemSyncLock holders (manual Refresh / Sync, sync-banks) keep the signal too.
    const { row, client } = makeRow();
    const res = await quiet(() => withPlaidItemSyncLock("item", async () => { await webhookArrives(client); return 1; }, client));
    check("withPlaidItemSyncLock: a skip during fn survives the successful release", res.ok && row.syncLockedAt === null && row.syncIncompleteAt !== null);
  }

  console.log("3. syncPlaidItemFromWebhook: exactly one follow-up pull, never a loop");
  const drive = (runOnce: () => Promise<LockedRunResult>, trigger: RefreshTrigger = "RECONNECT") =>
    quiet(() => syncPlaidItemFromWebhook("item", trigger, "RECONNECT", admitted, { billable: ALLOW, runLockedOnce: runOnce }));
  {
    // The production case end to end: RECONNECT holds, one webhook lands mid-run.
    const { row, client } = makeRow();
    let runs = 0; let skipped = 0;
    const once = lockedRun(client, async () => { runs++; if (runs === 1 && await webhookArrives(client)) skipped++; });
    const outcome = await drive(once);
    check("a webhook arriving mid-run ⇒ EXACTLY ONE follow-up pull (two runs in all)", runs === 2 && skipped === 1, { runs, skipped });
    check("…the wrapper reports the first run's outcome", outcome === "ran");
    check("…and the follow-up discharges the marker: the item settles", row.syncIncompleteAt === null && row.syncLockedAt === null, row);
  }
  {
    const { row, client } = makeRow();
    let runs = 0;
    const outcome = await drive(lockedRun(client, async () => { runs++; }));
    check("no contention ⇒ one run, no follow-up (unchanged)", runs === 1 && outcome === "ran" && row.syncIncompleteAt === null);
  }
  {
    // Two skips during ONE run still yield at most one follow-up.
    const { client } = makeRow();
    let runs = 0;
    await drive(lockedRun(client, async () => { runs++; if (runs === 1) { await webhookArrives(client); await webhookArrives(client); } }));
    check("two skips during one run ⇒ still exactly one follow-up", runs === 2, { runs });
  }
  {
    // A skip during the FOLLOW-UP too: bounded — no third run; the marker is kept for resume-stale-imports.
    const { row, client } = makeRow();
    let runs = 0;
    await drive(lockedRun(client, async () => { runs++; await webhookArrives(client); }));
    check("skips during the first AND the follow-up ⇒ two runs, never a third", runs === 2, { runs });
    check("…the follow-up's own skip survives as a resume candidate", row.syncIncompleteAt !== null && row.syncLockedAt === null);
  }
  {
    // A failed first run does not start a follow-up (its marker stands; the existing retry paths own it).
    const { row, client } = makeRow();
    let runs = 0;
    await drive(lockedRun(client, async () => { runs++; await webhookArrives(client); }, { ok: false }));
    check("a failed first run ⇒ no follow-up, marker kept", runs === 1 && row.syncIncompleteAt !== null);
  }
  {
    // The 300 s budget: a long first run leaves the follow-up to the backstop.
    const { row, client } = makeRow();
    let runs = 0;
    await drive(lockedRun(client, async () => { runs++; await webhookArrives(client); }, { elapsedMs: FOLLOW_UP_MAX_FIRST_RUN_MS + 1 }));
    check(`a first run over ${FOLLOW_UP_MAX_FIRST_RUN_MS} ms ⇒ no in-process follow-up, marker kept`, runs === 1 && row.syncIncompleteAt !== null);
  }
  {
    // RESUME (resume-stale-imports batch / resume-sync): no in-process follow-up; the marker carries it.
    const { row, client } = makeRow();
    let runs = 0;
    await drive(lockedRun(client, async () => { runs++; await webhookArrives(client); }), "RESUME");
    check("RESUME ⇒ no in-process follow-up (batch budget), marker kept", runs === 1 && row.syncIncompleteAt !== null);
  }
  {
    // A follow-up that itself loses the claim (someone else took the lock in between) is just a skip.
    const { client } = makeRow();
    let calls = 0;
    const outcome = await drive(async () => {
      calls++;
      if (calls === 1) return { outcome: "ran", followUp: true, elapsedMs: 1_000 };
      return { outcome: "skipped-locked" as WebhookSyncOutcome, followUp: false, elapsedMs: 0 };
    });
    void client;
    check("a follow-up that loses the claim ends there (no retry loop)", calls === 2 && outcome === "ran");
  }
  check("policy: never follow up a follow-up", !shouldRunFollowUp({ followUp: true, elapsedMs: 1 }, "WEBHOOK", true));
  check("policy: WEBHOOK and RECONNECT holders follow up within budget",
    shouldRunFollowUp({ followUp: true, elapsedMs: 1 }, "WEBHOOK", false) && shouldRunFollowUp({ followUp: true, elapsedMs: FOLLOW_UP_MAX_FIRST_RUN_MS }, "RECONNECT", false));

  console.log("4. resume-stale-imports picks up the surviving marker");
  {
    const { row, client } = makeRow();
    const claimedAt = await claimPlaidItemSyncLockAt("item", client);
    await quiet(() => webhookArrives(client));
    await quiet(() => releasePlaidItemSyncLock("item", true, client, claimedAt!));
    const kept = row.syncIncompleteAt!;
    // The real candidate predicate's marker condition, evaluated on the fake row.
    const isCandidate = (cutoff: Date) => {
      const w = staleWhere(cutoff);
      return row.syncIncompleteAt !== null && row.syncIncompleteAt.getTime() < (w.syncIncompleteAt as { lt: Date }).lt.getTime();
    };
    const driven: string[] = [];
    const pass = (now: Date) => quiet(() => resumeStaleImports({
      now: () => now,
      loadCandidates: async (cutoff) => isCandidate(cutoff)
        ? { candidates: 1, items: [{ id: "item", institutionName: "Card", userId: "u1" }] }
        : { candidates: 0, items: [] },
      loadCandidateUsers: async (cutoff) => (isCandidate(cutoff) ? ["u1"] : []),
      admit: async () => admitted,
      billable: async (ids) => new Map(ids.map((id) => [id, ALLOW] as const)),
      drive: async (id) => { driven.push(id); return "ran"; },
      recordAttempt: async () => {}, resetCompleted: async () => {},
    }));
    await pass(new Date(kept.getTime() + 60_000));
    check("inside the 315 s age gate the kept marker is left alone (the follow-up / holder may be live)", driven.length === 0);
    const r = await pass(new Date(kept.getTime() + 316_000));
    check("past the age gate the kept marker IS a candidate and is driven once", driven.join() === "item" && r.ran === 1, { driven, r });
  }

  console.log("5. source pins");
  {
    const src = readFileSync("lib/plaid/webhook-sync.ts", "utf8");
    check("the real locked run threads the release's pendingSignal into the follow-up decision",
      /const released = await releasePlaidItemSyncLock\(plaidItemId, ok, undefined, claimedAt\);\s*followUp = released\.pendingSignal;/.test(src));
    check("two run sites only: the first run and ONE follow-up, outside the first run's RefreshExecution",
      (src.match(/await runOnce\(\);/g) ?? []).length === 2 && /shouldRunFollowUp\(first, trigger, false\)/.test(src));
    const lock = readFileSync("lib/plaid/sync-lock.ts", "utf8");
    check("the success-clear is conditional on the marker being older than the claim",
      lock.includes("OR: [{ syncIncompleteAt: null }, { syncIncompleteAt: { lt: claimedAt } }]"));
    check("LOCK_TTL_MS is unchanged (6 min)", /export const LOCK_TTL_MS = 360_000;/.test(lock));
  }

  console.log("6. clock domains — accepted skew between app instances (P3)");
  {
    // The loser's clock runs BEHIND the holder's by δ: its stamp reads as pre-claim.
    const SKEW_MS = 25;
    const { row, client } = makeRow();
    const claimedAt = await claimPlaidItemSyncLockAt("item", client);
    row.syncIncompleteAt = new Date(claimedAt!.getTime() + 10 - SKEW_MS); // landed 10 ms after the claim, stamped 25 ms slow
    const r = await quiet(() => releasePlaidItemSyncLock("item", true, client, claimedAt!));
    check("loser BEHIND by δ, skip within δ of the claim ⇒ cleared, no follow-up (= pre-P2 behaviour; precedes the holder's first pull)",
      row.syncIncompleteAt === null && !r.pendingSignal);
  }
  {
    // The marker-writer's clock runs AHEAD: a marker written just BEFORE the claim reads as post-claim.
    const SKEW_MS = 25;
    const { row, client } = makeRow();
    const claimedAt = await claimPlaidItemSyncLockAt("item", client);
    row.syncIncompleteAt = new Date(claimedAt!.getTime() - 10 + SKEW_MS); // written 10 ms before the claim, stamped 25 ms fast
    const r = await quiet(() => releasePlaidItemSyncLock("item", true, client, claimedAt!));
    check("writer AHEAD by δ ⇒ a pre-claim marker is kept: one harmless extra pull", row.syncIncompleteAt !== null && r.pendingSignal);
  }
  {
    const lock = readFileSync("lib/plaid/sync-lock.ts", "utf8");
    check("the accepted-skew decision is documented at the fence", lock.includes("CLOCK DOMAINS — ACCEPTED SKEW (P3, 2026-11-02)"));
    check("…and the fence still compares app-clock instants (no DB-clock claim was introduced)",
      /const now = new Date\(\);[\s\S]*data:\s+\{ syncLockedAt: now \}/.test(lock) && !/\$executeRaw|\$queryRaw/.test(lock));
  }

  if (failures > 0) { console.error(`\n❌ webhook skip signal: ${failures} check(s) failed`); process.exit(1); }
  console.log("\n✅ webhook skip signal: all checks passed");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
