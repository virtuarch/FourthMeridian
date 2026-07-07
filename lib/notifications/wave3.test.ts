/**
 * lib/notifications/wave3.test.ts  (OPS-3 S5 Wave 3)
 *
 * Guards for the financial producer wave. Standalone tsx script (house
 * pattern): npx tsx lib/notifications/wave3.test.ts — exits 0/1.
 *
 * Layers (deterministic, DB-free — every client injected):
 *   1. BEHAVIOR — the full SYNC_FAILED lifecycle: notify → suppress across
 *      repeated failures from ANY site → retirement on recovery (key release
 *      + archive) → a fresh outage notifies again. Import success/partial-
 *      failure mapping. FINANCIAL preference enforcement.
 *   2. SOURCE-SCAN — all five failure sites and all three recovery sites are
 *      wired through the shared helper pair; the import route produces both
 *      types; chokepoint-only; no email/audit duplication.
 *   3. RULINGS — D2 (SYNC_COMPLETED: no rows) and the DUPLICATE_DETECTED
 *      drift ruling (no PENDING substrate); Wave 4 untouched.
 */

import { readFileSync } from "node:fs";
import {
  createNotification,
  type NotificationWriteClient,
} from "@/lib/notifications/create";
import {
  retireOpenNotification,
  type NotificationResolveClient,
} from "@/lib/notifications/resolve";
import {
  notifyItemSyncFailed,
  retireItemSyncFailure,
  type PlaidItemReadClient,
} from "@/lib/plaid/sync-notifications";
import type { PreferenceClient } from "@/lib/notifications/preferences";
import { NOTIFICATION_REGISTRY } from "@/lib/notifications/registry";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Environment tolerance (see create.test.ts): PrismaClient engine warm-up
// floating-rejects on platform-mismatched sandboxes; nothing here uses Prisma.
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") {
    return;
  }
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

// ── In-memory notification store shared by chokepoint + resolver fakes ──────

interface StoreRow {
  id: string;
  userId: string;
  type: string;
  dedupeKey: string | null;
  archivedAt: Date | null;
  data: Record<string, unknown>;
}

function makeStore(emails: Record<string, string> = { u1: "u1@example.com" }) {
  const rows: StoreRow[] = [];
  const deliveries: unknown[] = [];
  let nextId = 1;

  const writeClient: NotificationWriteClient = {
    user: {
      async findUnique({ where }) {
        const email = emails[where.id];
        return email ? { email } : null;
      },
    },
    notificationDelivery: {
      async create({ data }) { deliveries.push(data); return { id: "d" }; },
    },
    notification: {
      async create({ data }) {
        if (
          data.dedupeKey !== null &&
          rows.some((r) => r.userId === data.userId && r.dedupeKey === data.dedupeKey)
        ) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row: StoreRow = {
          id: `n${nextId++}`,
          userId: data.userId,
          type: data.type,
          dedupeKey: data.dedupeKey,
          archivedAt: null,
          data: data as unknown as Record<string, unknown>,
        };
        rows.push(row);
        return { id: row.id };
      },
      async findUnique({ where }) {
        const r = rows.find(
          (x) => x.userId === where.userId_dedupeKey.userId && x.dedupeKey === where.userId_dedupeKey.dedupeKey,
        );
        return r ? { id: r.id, archivedAt: r.archivedAt } : null;
      },
      async update({ where, data }) {
        const r = rows.find((x) => x.id === where.id);
        if (!r) throw new Error("not found");
        r.dedupeKey = data.dedupeKey;
        return { id: r.id };
      },
    },
  };

  const resolveClient: NotificationResolveClient = {
    notification: {
      async updateMany({ where, data }) {
        const hit = rows.filter(
          (r) => r.userId === where.userId && r.dedupeKey === where.dedupeKey && r.archivedAt === null,
        );
        for (const r of hit) {
          r.dedupeKey = data.dedupeKey;
          r.archivedAt = data.archivedAt;
        }
        return { count: hit.length };
      },
    },
  };

  return { rows, deliveries, writeClient, resolveClient };
}

const noPrefs: PreferenceClient = {
  notificationPreference: {
    async findMany() { return []; },
    async upsert() { throw new Error("unused"); },
  },
};
function prefsWith(rows: { category: string; channel: string; enabled: boolean }[]): PreferenceClient {
  return {
    notificationPreference: {
      async findMany() { return rows; },
      async upsert() { throw new Error("unused"); },
    },
  };
}
const itemClient: PlaidItemReadClient = {
  plaidItem: {
    async findUnique({ where }) {
      return where.id === "item_1"
        ? { userId: "u1", institutionName: "Chase" }
        : null;
    },
  },
};

async function run(): Promise<void> {
  // ── 1a. SYNC_FAILED lifecycle: notify → suppress → retire → re-notify ──────
  console.log("SYNC_FAILED lifecycle");
  {
    const store = makeStore();
    const createFn: typeof createNotification = (input) =>
      createNotification(input, { client: store.writeClient, prefClient: noPrefs });
    const retireFn: typeof retireOpenNotification = (userId, type, data) =>
      retireOpenNotification(userId, type, data, { client: store.resolveClient });

    // Failure observed by the cron…
    await notifyItemSyncFailed("item_1", { itemClient, createFn });
    check("first failure creates the notification", store.rows.length === 1);
    check(
      "condition key + owner + institution from the item row",
      store.rows[0].dedupeKey === "SYNC_FAILED:item:item_1:open" &&
        store.rows[0].userId === "u1" &&
        (store.rows[0].data.title as string).includes("Chase"),
    );

    // …then by the manual refresh route, then by tomorrow's cron: suppressed.
    await notifyItemSyncFailed("item_1", { itemClient, createFn });
    await notifyItemSyncFailed("item_1", { itemClient, createFn });
    check("repeat failures from any site are suppressed (one live row)", store.rows.length === 1);

    // Recovery (completed sync / relink): key retired + row archived.
    await retireItemSyncFailure("item_1", { itemClient, retireFn });
    check(
      "retirement releases the key and archives the stale row",
      store.rows[0].dedupeKey === null && store.rows[0].archivedAt !== null,
    );

    // A NEW outage notifies afresh.
    await notifyItemSyncFailed("item_1", { itemClient, createFn });
    check("a fresh outage after recovery notifies again", store.rows.length === 2 && store.rows[1].archivedAt === null);

    // Retirement with nothing open is a quiet no-op.
    const retired = await retireOpenNotification("u1", "SYNC_FAILED", { plaidItemId: "nope" }, { client: store.resolveClient });
    check("retiring a non-open condition is a no-op (0)", retired === 0);

    // Unknown item → no-op, never throws.
    await notifyItemSyncFailed("missing_item", { itemClient, createFn });
    check("unknown item is a silent no-op", store.rows.length === 2);
  }

  // ── 1b. Import completion mapping ───────────────────────────────────────────
  console.log("import completion");
  {
    const store = makeStore();
    const ok = await createNotification(
      { type: "IMPORT_COMPLETED", userId: "u1", data: { batchId: "b1", rowCount: 42 } },
      { client: store.writeClient, prefClient: noPrefs },
    );
    const bad = await createNotification(
      { type: "IMPORT_COMPLETED_WITH_ERRORS", userId: "u1", data: { batchId: "b2", errorCount: 3, rowCount: 39 } },
      { client: store.writeClient, prefClient: noPrefs },
    );
    check("success batch → IMPORT_COMPLETED (NORMAL)", ok.status === "created" && store.rows[0].data.priority === "NORMAL");
    check("partial failure → IMPORT_COMPLETED_WITH_ERRORS (HIGH)", bad.status === "created" && store.rows[1].data.priority === "HIGH");
    check("batches are distinct facts — no dedupe keys", store.rows.every((r) => r.dedupeKey === null));
    check("in-app only by default — no delivery rows", store.deliveries.length === 0);
  }

  // ── 1c. Preference enforcement ──────────────────────────────────────────────
  console.log("preference enforcement");
  {
    const store = makeStore();
    const res = await createNotification(
      { type: "SYNC_FAILED", userId: "u1", data: { plaidItemId: "item_1", institutionName: "Chase" } },
      { client: store.writeClient, prefClient: prefsWith([{ category: "FINANCIAL", channel: "IN_APP", enabled: false }]) },
    );
    check("FINANCIAL in-app override suppresses sync pings", res.status === "skipped" && store.rows.length === 0);
  }
  {
    // SYNC_FAILED defaults email ON (actionable) — delivery row via fake adapter.
    const store = makeStore();
    const res = await createNotification(
      { type: "SYNC_FAILED", userId: "u1", data: { plaidItemId: "item_1", institutionName: "Chase" } },
      {
        client: store.writeClient,
        prefClient: noPrefs,
        emailAdapter: { channel: "EMAIL", name: "fake", async deliver() { return { status: "sent", provider: "fake" }; } },
      },
    );
    check("SYNC_FAILED ships email by default (actionable)", res.status === "created" && store.deliveries.length === 1);
  }

  // ── 2. Source-scan: all sites wired through the shared helpers ─────────────
  console.log("wiring (source-scan)");
  const FAILURE_SITES = [
    "jobs/sync-banks.ts",
    "lib/plaid/refresh.ts",
    "app/api/plaid/refresh/route.ts",
    "app/api/plaid/sync/route.ts",
    "lib/plaid/backgroundHistorySync.ts",
  ];
  for (const f of FAILURE_SITES) {
    const src = readFileSync(f, "utf8");
    check(`${f}: notifies on health-classified failure`, src.includes("notifyItemSyncFailed("));
    check(`${f}: no direct Notification writes`, !src.includes(".notification.create"));
  }
  const RECOVERY_SITES = ["lib/plaid/syncTransactions.ts", "lib/plaid/exchangeToken.ts"];
  for (const f of RECOVERY_SITES) {
    const src = readFileSync(f, "utf8");
    check(`${f}: retires the open condition on recovery`, src.includes("retireItemSyncFailure("));
  }
  {
    const helper = readFileSync("lib/plaid/sync-notifications.ts", "utf8");
    check(
      "helpers flow through the chokepoint/resolve primitives only",
      helper.includes("createNotification") && helper.includes("retireOpenNotification") &&
        !helper.includes(".notification.create") && !helper.includes("sendEmail") && !helper.includes("auditLog"),
    );
    const importSrc = readFileSync("app/api/accounts/[id]/import/route.ts", "utf8");
    check(
      "import route produces both completion types via the chokepoint",
      /type: "IMPORT_COMPLETED_WITH_ERRORS"/.test(importSrc) &&
        /type: "IMPORT_COMPLETED"/.test(importSrc) &&
        importSrc.includes("@/lib/notifications/create") &&
        !importSrc.includes(".notification.create"),
    );
  }

  // ── 3. Rulings + wave discipline ────────────────────────────────────────────
  console.log("rulings");
  check("SYNC_FAILED / IMPORT_COMPLETED(_WITH_ERRORS) are WIRED",
    NOTIFICATION_REGISTRY.SYNC_FAILED.status === "WIRED" &&
      NOTIFICATION_REGISTRY.IMPORT_COMPLETED.status === "WIRED" &&
      NOTIFICATION_REGISTRY.IMPORT_COMPLETED_WITH_ERRORS.status === "WIRED");
  check(
    "D2 resolved: SYNC_COMPLETED stays VOCABULARY with no producer and all-off defaults",
    NOTIFICATION_REGISTRY.SYNC_COMPLETED.status === "VOCABULARY" &&
      NOTIFICATION_REGISTRY.SYNC_COMPLETED.defaultChannels.length === 0,
  );
  check(
    "drift ruling: DUPLICATE_DETECTED stays VOCABULARY (no PENDING substrate exists)",
    NOTIFICATION_REGISTRY.DUPLICATE_DETECTED.status === "VOCABULARY",
  );
  for (const wave4 of ["DAILY_BRIEF_READY", "OPPORTUNITY_FOUND", "UNUSUAL_SPENDING", "GOAL_RISK", "DEBT_ALERT",
                       "MAINTENANCE_SCHEDULED", "FEATURE_RELEASED", "POLICY_UPDATED", "DIGEST_SENT"] as const) {
    check(`${wave4} remains VOCABULARY (Wave 4 / platform not started)`,
      NOTIFICATION_REGISTRY[wave4].status === "VOCABULARY");
  }

  if (failures > 0) {
    console.error(`\nwave3 tests: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nwave3 tests: all passed");
  process.exit(0);
}

run().catch((err) => {
  console.error("wave3 tests: unexpected error", err);
  process.exit(1);
});
