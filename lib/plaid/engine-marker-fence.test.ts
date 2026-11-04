/**
 * lib/plaid/engine-marker-fence.test.ts  (P2 follow-up — the residual gap after #233)
 *
 * #233 made the lock holder's RELEASE keep a syncIncompleteAt marker stamped by
 * a losing claim during its run. One overwrite remained, inside the engine:
 * syncTransactionsForItem's final health write set `syncIncompleteAt` to null
 * (or to the value it read at start), so a webhook that lost the claim while
 * the LAST /transactions/sync page was in flight was erased before the release
 * ever looked. This drives the REAL engine (injected fake DB + scripted Plaid,
 * the cursor-safety idiom) and the REAL lock primitives over ONE shared row.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/plaid/engine-marker-fence.test.ts
 */

process.env.ENCRYPTION_KEY ??= "0".repeat(64);

import { readFileSync } from "node:fs";
import { encryptWithPurpose, EncryptionPurpose } from "./encryption";
import { syncTransactionsForItem } from "./syncTransactions";
import {
  claimPlaidItemSyncLockAt, releasePlaidItemSyncLock, settleIncompleteMarker,
  type PlaidItemSyncLockClient,
} from "./sync-lock";

const FAKE_TOKEN = encryptWithPurpose("access-sandbox-test-token", EncryptionPurpose.PLAID_ACCESS_TOKEN);

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
  const { log, warn, error } = console; console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return await f(); } finally { console.log = log; console.warn = warn; console.error = error; }
};
const tick = () => new Promise((r) => setTimeout(r, 3));

// ── ONE PlaidItem row, shared by the engine's fake DB and the lock client ────
type Item = {
  id: string; cursor: string | null; encryptedToken: string; institutionName: string; userId: string;
  status: string; errorCode: string | null; completedSyncCount: number;
  syncLockedAt: Date | null; syncIncompleteAt: Date | null;
} & Record<string, unknown>;

type DateCond = null | { lt?: Date; lte?: Date };
function holdsDate(cur: Date | null, c: DateCond): boolean {
  if (c === null) return cur === null;
  if (cur === null) return false; // SQL: NULL compared to anything is not true
  if (c.lt) return cur.getTime() < c.lt.getTime();
  if (c.lte) return cur.getTime() <= c.lte.getTime();
  return false;
}
/** Evaluates exactly the `where` shapes the lock primitives and the engine's settle write use. */
function matches(item: Item, where: Record<string, unknown>): boolean {
  if ("syncLockedAt" in where) {
    const v = where.syncLockedAt as Date;
    if (item.syncLockedAt === null || item.syncLockedAt.getTime() !== v.getTime()) return false;
  }
  if ("status" in where && (where.status as { not: string }).not === item.status) return false;
  if ("syncIncompleteAt" in where && !holdsDate(item.syncIncompleteAt, where.syncIncompleteAt as DateCond)) return false;
  if (where.OR) {
    const ok = (where.OR as Record<string, DateCond>[]).some((c) =>
      "syncLockedAt" in c ? holdsDate(item.syncLockedAt, c.syncLockedAt) : holdsDate(item.syncIncompleteAt, c.syncIncompleteAt));
    if (!ok) return false;
  }
  return true;
}

function makeWorld(initial: Partial<Item> = {}) {
  const item: Item = {
    id: "item_1", cursor: "C0", encryptedToken: FAKE_TOKEN, institutionName: "Amex", userId: "u1",
    status: "ACTIVE", errorCode: null, completedSyncCount: 3, syncLockedAt: null, syncIncompleteAt: null, ...initial,
  };
  const updateMany = async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    if (!matches(item, where)) return { count: 0 };
    Object.assign(item, data);
    return { count: 1 };
  };
  const lock: PlaidItemSyncLockClient = { plaidItem: { updateMany: updateMany as never, count: async () => 1 } };
  const fdb = {
    syncIssue: {
      create: async () => ({ id: "si1" }), findFirst: async () => null, update: async () => ({ id: "si1" }),
      findMany: async () => [], updateMany: async () => ({ count: 0 }),
    },
    syncIssueOccurrence: { create: async () => ({ id: "so1" }) },
    $transaction: async () => { throw new Error("the incident lifecycle must not open transactions"); },
    plaidItem: {
      findUnique: async () => ({ ...item }),
      update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(item, data); return { ...item }; },
      updateMany,
    },
    providerAccountIdentity: { findFirst: async () => null },
    financialAccount: { findUnique: async () => null },
    transaction: {
      findUnique: async () => null, findMany: async () => [], create: async () => ({}), update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
    },
    auditLog:      { create: async () => ({ id: "al1" }) },
    notification:  { findFirst: async () => null, updateMany: async () => ({ count: 0 }) },
    merchant:      { upsert: async () => ({ id: "m1" }) },
    merchantAlias: { upsert: async () => ({ id: "a1" }), findUnique: async () => null },
    merchantRule:  { findMany: async () => [] },
  };
  return { item, lock, fdb };
}

/** Scripted Plaid: `pages` empty pages; `onLastPage` runs while the LAST page request is in flight. */
function makePlaid(pages: number, onLastPage?: () => Promise<void>) {
  let i = 0;
  return {
    transactionsSync: async () => {
      i++;
      const last = i >= pages;
      if (last && onLastPage) await onLastPage();
      return { data: { added: [], modified: [], removed: [], has_more: !last, next_cursor: `C${i}` } };
    },
  };
}

async function main(): Promise<void> {
  console.log("1. THE RESIDUAL INTERLEAVING: holder claims → engine pulls → webhook loses the claim during the LAST page → engine settles → holder releases");
  {
    const { item, lock, fdb } = makeWorld();
    const claimedAt = await claimPlaidItemSyncLockAt("item_1", lock);
    let stamp: Date | null = null;
    const plaid = makePlaid(2, async () => {
      await tick();
      const lost = (await quiet(() => claimPlaidItemSyncLockAt("item_1", lock))) === null;
      if (lost) stamp = item.syncIncompleteAt;
    });
    await quiet(() => syncTransactionsForItem("item_1", { db: fdb as never, plaid: plaid as never }));
    check("the webhook lost the claim and stamped the marker during the last page", stamp !== null);
    check("the engine's final write did NOT erase it", item.syncIncompleteAt !== null && item.syncIncompleteAt.getTime() === (stamp as Date | null)?.getTime(), item.syncIncompleteAt);
    check("…while still recording the run as complete (cursor advanced, count bumped, ACTIVE)",
      item.cursor === "C2" && item.completedSyncCount === 4 && item.status === "ACTIVE", item);
    const r = await quiet(() => releasePlaidItemSyncLock("item_1", true, lock, claimedAt!));
    check("the holder's release then sees the pending signal (⇒ the one follow-up)", r.pendingSignal === true && item.syncLockedAt === null);
  }

  console.log("2. unchanged where nothing raced");
  {
    // Locked, no skip, a pre-claim marker (prior failed run): cleared exactly as before.
    const { item, lock, fdb } = makeWorld({ syncIncompleteAt: new Date(Date.now() - 60_000) });
    const claimedAt = await claimPlaidItemSyncLockAt("item_1", lock);
    await quiet(() => syncTransactionsForItem("item_1", { db: fdb as never, plaid: makePlaid(1) as never }));
    check("a locked run with no skip clears a pre-claim marker", item.syncIncompleteAt === null, item.syncIncompleteAt);
    const r = await releasePlaidItemSyncLock("item_1", true, lock, claimedAt!);
    check("…and the release asks for no follow-up", !r.pendingSignal && item.syncLockedAt === null);
  }
  {
    // Unlocked caller (script / exchangeToken inline): the prior inline write, unchanged.
    const { item, fdb } = makeWorld({ syncIncompleteAt: new Date() });
    await quiet(() => syncTransactionsForItem("item_1", { db: fdb as never, plaid: makePlaid(1) as never }));
    check("an unlocked run clears the marker inline, as before", item.syncIncompleteAt === null);
  }
  {
    // First-run hold (completedSyncCount 0 → 1) under the lock: the marker stays.
    const connect = new Date(Date.now() - 5_000);
    const { item, lock, fdb } = makeWorld({ completedSyncCount: 0, syncIncompleteAt: connect });
    await claimPlaidItemSyncLockAt("item_1", lock);
    await quiet(() => syncTransactionsForItem("item_1", { db: fdb as never, plaid: makePlaid(1) as never }));
    check("a locked first run still holds its marker for the second pass", item.syncIncompleteAt?.getTime() === connect.getTime() && item.completedSyncCount === 1);
  }
  {
    // First run + a skip during it: the NEWER stamp survives (not rolled back to the older value).
    const connect = new Date(Date.now() - 5_000);
    const { item, lock, fdb } = makeWorld({ completedSyncCount: 0, syncIncompleteAt: connect });
    await claimPlaidItemSyncLockAt("item_1", lock);
    const plaid = makePlaid(1, async () => { await tick(); await quiet(() => claimPlaidItemSyncLockAt("item_1", lock)); });
    await quiet(() => syncTransactionsForItem("item_1", { db: fdb as never, plaid: plaid as never }));
    check("a first-run hold does not roll a newer skip stamp back to the connect stamp", (item.syncIncompleteAt?.getTime() ?? 0) > connect.getTime());
  }
  {
    // REVOKED mid-run: setPlaidItemHealth drops the success write; the settle clear is dropped with it.
    const { item, lock, fdb } = makeWorld({ syncIncompleteAt: new Date(Date.now() - 60_000) });
    await claimPlaidItemSyncLockAt("item_1", lock);
    const plaid = makePlaid(1, async () => { item.status = "REVOKED"; });
    await quiet(() => syncTransactionsForItem("item_1", { db: fdb as never, plaid: plaid as never }));
    check("a REVOKED item's marker is not touched by the settle (parity with setPlaidItemHealth)", item.syncIncompleteAt !== null && item.status === "REVOKED");
  }

  console.log("3. the settle policy (pure)");
  {
    const a = new Date(1_000);
    check("no lock ⇒ inline, settled → null", JSON.stringify(settleIncompleteMarker({ syncIncompleteAt: new Date(5), syncLockedAt: null }, 3)) === JSON.stringify({ mode: "inline", value: null }));
    check("no lock, first run ⇒ inline, the read value", (settleIncompleteMarker({ syncIncompleteAt: new Date(5), syncLockedAt: null }, 1) as { value: Date }).value.getTime() === 5);
    check("lock ⇒ clear-if-older anchored on the lock token", JSON.stringify(settleIncompleteMarker({ syncIncompleteAt: null, syncLockedAt: a }, 3)) === JSON.stringify({ mode: "clear-if-older", anchor: a }));
    check("lock, first run ⇒ keep", settleIncompleteMarker({ syncIncompleteAt: new Date(5), syncLockedAt: a }, 1).mode === "keep");
  }

  console.log("4. source pins");
  {
    const src = readFileSync("lib/plaid/syncTransactions.ts", "utf8");
    check("the engine settles through settleIncompleteMarker", /const markerSettle = settleIncompleteMarker\(item, nextCompletedSyncCount\);/.test(src));
    check("the marker rides the health write ONLY when unlocked",
      src.includes(`...(markerSettle.mode === "inline" ? { syncIncompleteAt: markerSettle.value } : {}),`));
    check("the locked clear is conditional on the marker being older than the lock token",
      src.includes("syncIncompleteAt: { lt: markerSettle.anchor } },"));
  }

  if (failures > 0) { console.error(`\n❌ engine marker fence: ${failures} check(s) failed`); process.exit(1); }
  console.log("\n✅ engine marker fence: all checks passed");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
