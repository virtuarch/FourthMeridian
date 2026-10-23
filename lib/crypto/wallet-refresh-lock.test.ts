/**
 * lib/crypto/wallet-refresh-lock.test.ts  (IDEMP-004)
 *
 * The scheduled wallet sweep takes the per-wallet lease the manual route and
 * Refresh All take; the manual route keeps every post-claim step inside
 * try/finally. Standalone tsx:
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/crypto/wallet-refresh-lock.test.ts
 */

import { readFileSync } from "node:fs";
import { resolveRefreshPolicy } from "@/lib/platform/refresh-policy.core";
import { refreshScheduledWallets, type ScheduledWalletCandidate, type WalletRefreshDeps } from "@/lib/crypto/wallet-refresh";
import type { WalletSyncOutcome } from "@/lib/crypto/wallet-sync-dispatch";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = new Date("2026-10-22T12:00:00Z");
const ok = (accountId: string, chain: string): WalletSyncOutcome =>
  ({ accountId, chain, support: "HISTORY_SUPPORTED", ok: true, syncStatus: "synced", netWorthParticipation: "NONE", valuationModel: "READ_TIME_VALUED" });

function harness(wallets: ScheduledWalletCandidate[], held: Set<string>, opts: { throwOn?: string } = {}) {
  let t = NOW.getTime();
  const log: string[] = [];
  const deps: WalletRefreshDeps = {
    listWallets: async () => wallets,
    sync: async (id, chain) => {
      log.push(`sync:${id}:${[...held].includes(`conn-${id}`) ? "held" : "free"}`);
      t += 100;
      if (opts.throwOn === id) throw new Error("adapter blew up");
      return ok(id, chain);
    },
    policy: async () => resolveRefreshPolicy({ sourceKind: "WALLET" }, null),
    admit: async () => ({ decision: "ADMIT" as const }),
    clock: () => t,
    lock: {
      claim: async (c) => { if (held.has(c)) { log.push(`refused:${c}`); return false; } held.add(c); log.push(`claim:${c}`); return true; },
      release: async (c) => { held.delete(c); log.push(`release:${c}`); },
    },
  };
  return { run: () => refreshScheduledWallets({ now: NOW, deps }), log, held };
}

async function main() {
  const quiet = console.log; console.log = () => {};
  try {
    {
      const h = harness([
        { accountId: "a", chain: "BTC", lastSuccessAt: null, connectionId: "conn-a" },
        { accountId: "b", chain: "ETH", lastSuccessAt: null, connectionId: "conn-b" },
        { accountId: "c", chain: "SOL", lastSuccessAt: null, connectionId: null },
      ], new Set(["conn-b"]));
      const r = await h.run();
      console.log = quiet;
      check("a free wallet is claimed, synced UNDER the lease, then released",
        h.log.indexOf("claim:conn-a") < h.log.indexOf("sync:a:held") && h.log.indexOf("sync:a:held") < h.log.indexOf("release:conn-a"), h.log.join());
      check("a wallet whose lease another path holds is SKIPPED, not synced", !h.log.some((l) => l.startsWith("sync:b")) && h.log.includes("refused:conn-b"));
      check("…and counted, not failed", r.skippedLocked === 1 && r.failed === 0 && r.attempted === 2);
      check("a wallet with no Connection has nothing to lock and still syncs", h.log.includes("sync:c:free"));
      check("the sweep never releases a lease it did not take", !h.log.includes("release:conn-b") && h.held.has("conn-b"));
      console.log = () => {};
    }
    {
      const h = harness([{ accountId: "x", chain: "BTC", lastSuccessAt: null, connectionId: "conn-x" }], new Set(), { throwOn: "x" });
      const r = await h.run();
      console.log = quiet;
      check("a throwing sync still releases the lease (finally)", h.log.includes("release:conn-x") && !h.held.has("conn-x") && r.failed === 1);
    }
  } finally { console.log = quiet; }

  console.log("\nsource");
  {
    const strip = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const refresh = strip("lib/crypto/wallet-refresh.ts");
    check("production deps supply the shared wallet lease", /claimWalletSyncLock\(connectionId, db, at\)/.test(refresh) && /releaseWalletSyncLock\(connectionId, db\)/.test(refresh));
    const route = strip("app/api/accounts/[id]/sync/route.ts");
    const iTry = route.indexOf("try {"), iMark = route.indexOf("markWalletAttempt("), iSync = route.indexOf("syncWalletByChain(id"), iFin = route.indexOf("} finally {");
    check("manual route: the attempt stamp and the sync both sit inside the try whose finally releases",
      iTry > 0 && iMark > iTry && iSync > iTry && iFin > iSync && /releaseWallet\(connection\.id\)/.test(route.slice(iFin)), `${iTry} ${iMark} ${iSync} ${iFin}`);
  }

  if (failures > 0) { console.error(`\n❌ wallet sweep lock: ${failures} check(s) failed`); process.exit(1); }
  console.log("\n✅ wallet sweep lock: all checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
