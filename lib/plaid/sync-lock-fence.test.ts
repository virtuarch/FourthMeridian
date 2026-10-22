/**
 * lib/plaid/sync-lock-fence.test.ts  (IDEMP-005 — fence only)
 *
 * A slow run whose lease went stale and was taken over must NOT clear the new
 * holder's lock on release. Fake evaluates `syncLockedAt` equality the way
 * Postgres does. Standalone tsx:
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/plaid/sync-lock-fence.test.ts
 */

import {
  claimPlaidItemSyncLockAt, releasePlaidItemSyncLock, withPlaidItemSyncLock, LOCK_TTL_MS,
  type PlaidItemSyncLockClient,
} from "@/lib/plaid/sync-lock";

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

function makeRow() {
  const row: { syncLockedAt: Date | null; syncIncompleteAt: Date | null } = { syncLockedAt: null, syncIncompleteAt: null };
  const client: PlaidItemSyncLockClient = {
    plaidItem: {
      async updateMany({ where, data }) {
        const w = where as { OR?: Array<{ syncLockedAt: null | { lte: Date } }>; syncLockedAt?: Date };
        if (w.OR && !w.OR.some((c) => (c.syncLockedAt === null ? row.syncLockedAt === null
          : row.syncLockedAt !== null && row.syncLockedAt.getTime() <= c.syncLockedAt.lte.getTime()))) return { count: 0 };
        if (w.syncLockedAt instanceof Date && (row.syncLockedAt === null || row.syncLockedAt.getTime() !== w.syncLockedAt.getTime())) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      async count() { return 1; },
    },
  };
  return { row, client };
}

async function main() {
  console.log("fenced release");
  {
    const { row, client } = makeRow();
    const tokenA = await claimPlaidItemSyncLockAt("i", client);
    check("claim returns the fencing token it wrote", tokenA !== null && row.syncLockedAt?.getTime() === tokenA.getTime());
    // A's run outlives the TTL; B takes the stale lease over.
    row.syncLockedAt = new Date(tokenA!.getTime() - LOCK_TTL_MS - 1);
    const staleA = row.syncLockedAt;
    const tokenB = await claimPlaidItemSyncLockAt("i", client);
    check("B takes over the stale lease", tokenB !== null && row.syncLockedAt?.getTime() === tokenB!.getTime());
    const warn = console.warn; let warned = false; console.warn = () => { warned = true; };
    await releasePlaidItemSyncLock("i", true, client, staleA);
    console.warn = warn;
    check("A's fenced release leaves B's lock intact", row.syncLockedAt?.getTime() === tokenB!.getTime());
    check("…and says so", warned);
    check("a third caller is still refused while B holds the lease", (await claimPlaidItemSyncLockAt("i", client)) === null);
    await releasePlaidItemSyncLock("i", true, client, tokenB!);
    check("B's own release clears it", row.syncLockedAt === null && row.syncIncompleteAt === null);
  }
  {
    const { row, client } = makeRow();
    const r = await withPlaidItemSyncLock("i", async () => {
      row.syncLockedAt = new Date(0); // simulate a takeover mid-run
      return "done";
    }, client);
    check("withPlaidItemSyncLock passes its token: a taken-over lease is not cleared", r.ok && row.syncLockedAt?.getTime() === 0);
  }
  {
    const { row, client } = makeRow();
    await claimPlaidItemSyncLockAt("i", client);
    await releasePlaidItemSyncLock("i", false, client);
    check("an un-fenced release (legacy callers) is unconditional, as before", row.syncLockedAt === null);
  }

  if (failures > 0) { console.error(`\n❌ sync-lock fence: ${failures} check(s) failed`); process.exit(1); }
  console.log("\n✅ sync-lock fence: all checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
