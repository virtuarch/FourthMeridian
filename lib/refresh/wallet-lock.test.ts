/**
 * lib/refresh/wallet-lock.test.ts — the wallet sync claim: claim, contention,
 * stale recovery, release, and the manual clock. Run: npx tsx lib/refresh/wallet-lock.test.ts
 */
import { WALLET_LOCK_TTL_MS, claimWalletSyncLock, markWalletManualRefreshed, releaseWalletSyncLock } from "./wallet-lock";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** A one-row fake that evaluates the conditional update the way Postgres would. */
function fakeConnection(initial: { syncLockedAt: Date | null; lastManualRefreshAt: Date | null }) {
  const row = { id: "c1", ...initial };
  const calls: unknown[] = [];
  const client = {
    connection: {
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) {
        calls.push({ where, data });
        if (where.id !== row.id) return { count: 0 };
        const or = where.OR as Array<Record<string, unknown>> | undefined;
        if (or) {
          const unlocked = row.syncLockedAt === null;
          const lte = (or[1]?.syncLockedAt as { lte?: Date } | undefined)?.lte;
          const stale = row.syncLockedAt !== null && lte !== undefined && row.syncLockedAt.getTime() <= lte.getTime();
          if (!unlocked && !stale) return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  };
  return { row, calls, client };
}

const T0 = new Date("2026-10-08T10:00:00Z");

(async () => {
  console.log("claim");
  {
    const f = fakeConnection({ syncLockedAt: null, lastManualRefreshAt: null });
    check("an unlocked connection is claimed", await claimWalletSyncLock("c1", f.client, T0) === true);
    check("the claim stamps syncLockedAt", f.row.syncLockedAt?.getTime() === T0.getTime());
    check("a second claim while live is refused", await claimWalletSyncLock("c1", f.client, new Date(T0.getTime() + 1000)) === false);
    const later = new Date(T0.getTime() + WALLET_LOCK_TTL_MS + 1);
    check("a stale claim is re-claimable after the TTL", await claimWalletSyncLock("c1", f.client, later) === true);
    check("TTL exceeds the measured longest wallet sync (157 s)", WALLET_LOCK_TTL_MS > 157_000);
  }
  console.log("release + clock");
  {
    const f = fakeConnection({ syncLockedAt: T0, lastManualRefreshAt: null });
    await releaseWalletSyncLock("c1", f.client);
    check("release clears the lock", f.row.syncLockedAt === null);
    await markWalletManualRefreshed("c1", f.client, T0);
    check("the manual clock is stamped", f.row.lastManualRefreshAt?.getTime() === T0.getTime());
    const throwing = { connection: { updateMany: async () => { throw new Error("boom"); } } };
    let threw = false;
    try { await releaseWalletSyncLock("c1", throwing); } catch { threw = true; }
    check("release never throws", !threw);
  }
  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
})();
