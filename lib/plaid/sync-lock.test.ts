/**
 * lib/plaid/sync-lock.test.ts
 *
 * F1 (2026-07-14) — regression coverage for the shared PlaidItem
 * sync-concurrency guard extracted in lib/plaid/sync-lock.ts (see
 * docs/investigations/FOURTH_MERIDIAN_CONNECTIONS_WEIRDNESS_INVESTIGATION_2026-07-14.md).
 * Standalone tsx script (house pattern): npx tsx lib/plaid/sync-lock.test.ts
 *
 * NO LIVE DATABASE: an injected in-memory fake implements the narrow
 * PlaidItemSyncLockClient seam (same idiom as lib/jobs/run.test.ts's
 * JobRunWriteClient).
 *
 * Covers:
 *  1. claimPlaidItemSyncLock — succeeds when unlocked, fails (and stamps
 *     syncIncompleteAt) when a fresh lock is held, succeeds again once the
 *     held lock goes stale (LOCK_TTL_MS).
 *  2. releasePlaidItemSyncLock — clears both fields on success, clears only
 *     the lock (preserves syncIncompleteAt) on failure.
 *  3. withPlaidItemSyncLock — fn never called when the lock is held (does not
 *     race); fn's return value passed through on success; fn's thrown error
 *     propagates AND leaves syncIncompleteAt untouched (the failure path must
 *     never look like the success path).
 *  4. Source scan — every live caller of the sync engine outside the engine's
 *     own internals goes through the lock, and runDeferredHistorySync is only
 *     ever invoked from its sanctioned guarded wrapper. This is the exact gap
 *     F1 found (5 of 7 trigger paths were unlocked); regressing any one of
 *     these back to a bare call reproduces the "Amex 363 UPSERT_ERROR" race.
 */

import { readFileSync } from "node:fs";
import {
  claimPlaidItemSyncLock,
  releasePlaidItemSyncLock,
  withPlaidItemSyncLock,
  LOCK_TTL_MS,
  type PlaidItemSyncLockClient,
} from "@/lib/plaid/sync-lock";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Environment tolerance (see lib/jobs/run.test.ts / lib/notifications/create.test.ts).
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") {
    return;
  }
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

// ── In-memory fake implementing the narrow seam ──────────────────────────────

interface FakeState {
  syncLockedAt: Date | null;
  syncIncompleteAt: Date | null;
}

function makeFake(initial: Partial<FakeState> = {}) {
  const state: FakeState = { syncLockedAt: null, syncIncompleteAt: null, ...initial };
  const calls: Array<{ where: unknown; data: unknown }> = [];

  function whereMatches(where: { OR?: unknown }): boolean {
    if (!where.OR) return true; // release calls have no OR — always apply.
    return (where.OR as Array<Record<string, unknown>>).some((cond) => {
      const v = cond.syncLockedAt as null | { lte: Date };
      if (v === null) return state.syncLockedAt === null;
      if (v && typeof v === "object" && "lte" in v) {
        return state.syncLockedAt !== null && state.syncLockedAt.getTime() <= v.lte.getTime();
      }
      return false;
    });
  }

  const client: PlaidItemSyncLockClient = {
    plaidItem: {
      async updateMany({ where, data }) {
        calls.push({ where, data });
        if (!whereMatches(where as { OR?: unknown })) return { count: 0 };
        Object.assign(state, data);
        return { count: 1 };
      },
    },
  };
  return { client, state, calls };
}

async function main(): Promise<void> {
  console.log("PlaidItem sync-lock (F1, connections-weirdness 2026-07-14)");

  // ── 1. claim: unlocked → succeeds ───────────────────────────────────────────
  {
    const { client, state } = makeFake();
    const claimed = await claimPlaidItemSyncLock("item-1", client);
    check("claim succeeds when unlocked", claimed === true);
    check("claim stamps syncLockedAt", state.syncLockedAt !== null);
  }

  // ── 2. claim: fresh lock held → fails, stamps syncIncompleteAt ──────────────
  {
    const { client, state, calls } = makeFake({ syncLockedAt: new Date() });
    const claimed = await claimPlaidItemSyncLock("item-2", client);
    check("claim fails when a fresh lock is held", claimed === false);
    check("failed claim stamps syncIncompleteAt (records pending work)", state.syncIncompleteAt !== null);
    check("failed claim does NOT touch syncLockedAt", state.syncLockedAt !== null);
    check("exactly two DB calls (claim attempt + incomplete stamp)", calls.length === 2);
  }

  // ── 3. claim: stale lock → reclaimable ──────────────────────────────────────
  {
    const staleLock = new Date(Date.now() - LOCK_TTL_MS - 1_000);
    const { client, state } = makeFake({ syncLockedAt: staleLock });
    const claimed = await claimPlaidItemSyncLock("item-3", client);
    check("claim succeeds when the held lock is past LOCK_TTL_MS", claimed === true);
    check("reclaim overwrites syncLockedAt with a fresh timestamp", state.syncLockedAt!.getTime() > staleLock.getTime());
  }

  // ── 4. release: success clears both fields ──────────────────────────────────
  {
    const { client, state } = makeFake({ syncLockedAt: new Date(), syncIncompleteAt: new Date() });
    await releasePlaidItemSyncLock("item-4", true, client);
    check("release(clearIncomplete=true) clears syncLockedAt", state.syncLockedAt === null);
    check("release(clearIncomplete=true) clears syncIncompleteAt", state.syncIncompleteAt === null);
  }

  // ── 5. release: failure clears only the lock ────────────────────────────────
  {
    const marker = new Date();
    const { client, state } = makeFake({ syncLockedAt: new Date(), syncIncompleteAt: marker });
    await releasePlaidItemSyncLock("item-5", false, client);
    check("release(clearIncomplete=false) clears syncLockedAt", state.syncLockedAt === null);
    check(
      "release(clearIncomplete=false) preserves syncIncompleteAt (history genuinely incomplete)",
      state.syncIncompleteAt === marker,
    );
  }

  // ── 6. withPlaidItemSyncLock: lock held → fn never called, in-flight result ─
  {
    const { client, state } = makeFake({ syncLockedAt: new Date() });
    let fnCalled = false;
    const result = await withPlaidItemSyncLock(
      "item-6",
      async () => {
        fnCalled = true;
        return "should never happen";
      },
      client,
    );
    check("fn is never invoked when another sync holds the lock", fnCalled === false);
    check("result is ok:false, reason in-flight", result.ok === false && (result as { reason: string }).reason === "in-flight");
    check("skip still stamps syncIncompleteAt", state.syncIncompleteAt !== null);
  }

  // ── 7. withPlaidItemSyncLock: success — result passthrough, full clear ─────
  {
    const { client, state } = makeFake();
    const result = await withPlaidItemSyncLock("item-7", async () => ({ added: 5 }), client);
    check("success: ok true, result passed through verbatim", result.ok === true && (result as { result: { added: number } }).result.added === 5);
    check("success: lock released", state.syncLockedAt === null);
    check("success: syncIncompleteAt cleared", state.syncIncompleteAt === null);
  }

  // ── 8. withPlaidItemSyncLock: fn throws — propagates, does NOT clear marker ─
  {
    const { client, state } = makeFake({ syncIncompleteAt: new Date() }); // e.g. a prior failed run's marker
    const boom = new Error("ITEM_LOGIN_REQUIRED");
    let thrown: unknown = null;
    try {
      await withPlaidItemSyncLock(
        "item-8",
        async () => {
          throw boom;
        },
        client,
      );
    } catch (e) {
      thrown = e;
    }
    check("failure: original error rethrown unchanged", thrown === boom);
    check("failure: lock still released", state.syncLockedAt === null);
    check(
      "failure: syncIncompleteAt left untouched (NOT cleared like a success would)",
      state.syncIncompleteAt !== null,
    );
  }

  // ── 9. Source scan — every live sync-engine caller goes through the lock ───
  {
    function stripComments(src: string): string {
      return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    }

    const lockedCallers = [
      "app/api/plaid/resume-sync/route.ts",
      "app/api/plaid/sync/route.ts",
      "app/api/plaid/refresh/route.ts",
      "app/api/plaid/investments/enable/route.ts",
      "jobs/sync-banks.ts",
      "lib/plaid/refresh.ts", // refreshAllActiveItemsForUser's internal loop
    ];
    for (const p of lockedCallers) {
      const src = stripComments(readFileSync(p, "utf8"));
      check(`${p} calls the sync engine through withPlaidItemSyncLock`, src.includes("withPlaidItemSyncLock("));
    }

    // webhook-sync.ts uses the low-level primitives directly (its success
    // signal is runDeferredHistorySync's RETURN VALUE, not a thrown error —
    // see the module header) rather than the withPlaidItemSyncLock wrapper.
    const webhookSrc = stripComments(readFileSync("lib/plaid/webhook-sync.ts", "utf8"));
    check(
      "webhook-sync.ts uses the shared claim/release primitives from sync-lock.ts",
      webhookSrc.includes("claimPlaidItemSyncLock(") && webhookSrc.includes("releasePlaidItemSyncLock("),
    );

    // Guard against reintroducing the e70e9f8 bug: runDeferredHistorySync must
    // only ever be called from its one sanctioned lock-holding wrapper.
    const scanned = [
      ...lockedCallers,
      "lib/plaid/webhook-sync.ts",
      "app/api/plaid/exchange-token/route.ts",
      "app/api/plaid/webhook/route.ts",
    ];
    const callers = scanned.filter((f) => stripComments(readFileSync(f, "utf8")).includes("runDeferredHistorySync("));
    check(
      "runDeferredHistorySync is only ever called from the guarded webhook-sync wrapper",
      callers.length === 1 && callers[0] === "lib/plaid/webhook-sync.ts",
      `found in: ${callers.join(", ") || "(none)"}`,
    );
  }

  if (failures > 0) {
    console.error(`\nsync-lock tests: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nsync-lock tests: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error("  ✗ test harness error:", err);
  process.exit(1);
});
