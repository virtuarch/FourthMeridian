/**
 * lib/jobs/notification-retry.test.ts  (OPS-4 S4)
 *
 * Pure guards for the notification retry consumer. Standalone tsx script
 * (house pattern): npx tsx lib/jobs/notification-retry.test.ts — exits 0/1.
 *
 * NO LIVE DATABASE, NO REAL EMAIL: an in-memory fake implements the narrow
 * NotificationRetryClient seam (applying the same predicates Prisma would,
 * including the conditional-claim race) and a scripted fake adapter stands
 * in for the email channel. Covers: eligibility (only error rows under the
 * cap; sent/captured/skipped and at-cap rows never selected) · retry
 * success (status/deliveredAt/provider metadata verbatim; deliveredAt only
 * on "sent") · retry failure (stays error, retried until cap) · attempt
 * increment (claim-first, BEFORE the send) · max-attempt stop · obsolete
 * closure (archived/expired/read/no-email → "skipped", NO increment, no
 * send) · duplicate-send prevention (lost claim → zero sends) · idempotent
 * re-run (immediately re-running after success/exhaustion sends nothing) ·
 * dispatcher registration (name/slot/ordering after cleanup) · source scans
 * (single consumer, same adapter as create.ts, no queue/backoff).
 */

import { readFileSync } from "node:fs";
import {
  MAX_DELIVERY_ATTEMPTS,
  retryNotifications,
  type NotificationRetryClient,
  type RetryableDeliveryRow,
} from "@/jobs/retry-notifications";
import { SCHEDULED_JOBS } from "@/lib/jobs/registry";
import type { ChannelAdapter, ChannelResult } from "@/lib/notifications/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") {
    return;
  }
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

// ── In-memory fake store ──────────────────────────────────────────────────────

interface Row {
  id: string;
  channel: string;
  status: string;
  attempts: number;
  provider: string | null;
  providerMessageId: string | null;
  error: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
  notification: RetryableDeliveryRow["notification"];
}

const NOW = new Date("2026-07-08T07:30:00Z");

function liveNotification(over: Partial<NonNullable<RetryableDeliveryRow["notification"]>> = {}) {
  return {
    userId: "u1",
    type: "SPACE_INVITE_RECEIVED",
    category: "SPACES",
    priority: "NORMAL",
    title: "You were invited",
    body: "body text",
    href: "/dashboard",
    readAt: null,
    archivedAt: null,
    expiresAt: null,
    user: { email: "u1@example.com" },
    ...over,
  };
}

function errorRow(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    channel: "EMAIL",
    status: "error",
    attempts: 1,
    provider: "resend",
    providerMessageId: null,
    error: "boom",
    deliveredAt: null,
    createdAt: new Date("2026-07-07T10:00:00Z"),
    notification: liveNotification(),
    ...over,
  };
}

function makeStore(rows: Row[]) {
  const store = rows.map((r) => ({ ...r }));
  const client: NotificationRetryClient = {
    notificationDelivery: {
      async findMany({ where, take }) {
        return store
          .filter(
            (r) =>
              r.channel === where.channel &&
              r.status === where.status &&
              r.attempts < where.attempts.lt,
          )
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, take)
          .map((r) => ({ id: r.id, attempts: r.attempts, notification: r.notification }));
      },
      async updateMany({ where, data }) {
        const target = store.find(
          (r) => r.id === where.id && r.status === where.status && r.attempts === where.attempts,
        );
        if (!target) return { count: 0 };
        target.attempts += data.attempts.increment;
        return { count: 1 };
      },
      async update({ where, data }) {
        const target = store.find((r) => r.id === where.id);
        if (!target) throw new Error(`no row ${where.id}`);
        Object.assign(target, data);
        return target;
      },
    },
  };
  return { client, store };
}

function makeAdapter(script: ChannelResult[]) {
  const sends: string[] = [];
  const adapter: ChannelAdapter = {
    channel: "EMAIL",
    name: "fake",
    async deliver(message) {
      sends.push(message.email ?? "<none>");
      return script[Math.min(sends.length - 1, script.length - 1)];
    },
  };
  return { adapter, sends };
}

const mute = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const orig = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = orig; }
};

async function main(): Promise<void> {
  console.log("notification retry consumer (OPS-4 S4)");

  // ── 1. Eligibility ─────────────────────────────────────────────────────────
  {
    const { client, store } = makeStore([
      errorRow("d-err"),
      errorRow("d-sent", { status: "sent", deliveredAt: new Date() }),
      errorRow("d-captured", { status: "captured" }),
      errorRow("d-skipped", { status: "skipped" }),
      errorRow("d-maxed", { attempts: MAX_DELIVERY_ATTEMPTS }),
      errorRow("d-inapp", { channel: "IN_APP" }),
    ]);
    const { adapter, sends } = makeAdapter([{ status: "sent", id: "m1", provider: "resend" }]);
    const res = await mute(() => retryNotifications(client, adapter, NOW));
    check("only recoverable error rows under the cap are examined", res.examined === 1);
    check("sent rows ignored", store.find((r) => r.id === "d-sent")!.attempts === 1);
    check("captured/skipped rows ignored",
      store.find((r) => r.id === "d-captured")!.attempts === 1 &&
        store.find((r) => r.id === "d-skipped")!.attempts === 1);
    check("at-cap rows ignored (terminal dead-letter state)",
      store.find((r) => r.id === "d-maxed")!.attempts === MAX_DELIVERY_ATTEMPTS);
    check("exactly one send went out", sends.length === 1 && sends[0] === "u1@example.com");
  }

  // ── 2. Retry success ───────────────────────────────────────────────────────
  {
    const { client, store } = makeStore([errorRow("d1")]);
    const { adapter } = makeAdapter([{ status: "sent", id: "msg-9", provider: "resend" }]);
    const res = await mute(() => retryNotifications(client, adapter, NOW));
    const row = store[0];
    check("success: attempts incremented before send", row.attempts === 2);
    check("success: status/provider metadata updated verbatim",
      row.status === "sent" && row.provider === "resend" && row.providerMessageId === "msg-9" && row.error === null);
    check("success: deliveredAt set on sent", row.deliveredAt instanceof Date);
    check("success: counted as delivered", res.retried === 1 && res.delivered === 1 && res.stillFailing === 0);
  }

  // ── 3. Retry failure ───────────────────────────────────────────────────────
  {
    const { client, store } = makeStore([errorRow("d1")]);
    const { adapter } = makeAdapter([{ status: "error", provider: "resend", error: "still down" }]);
    const res = await mute(() => retryNotifications(client, adapter, NOW));
    const row = store[0];
    check("failure: stays error with new error text, attempts advanced",
      row.status === "error" && row.error === "still down" && row.attempts === 2 && row.deliveredAt === null);
    check("failure: counted as still failing", res.stillFailing === 1 && res.delivered === 0);
  }

  // ── 4. Max-attempt stop across runs ────────────────────────────────────────
  {
    const { client, store } = makeStore([errorRow("d1")]);
    const { adapter, sends } = makeAdapter([{ status: "error", provider: "resend", error: "down" }]);
    await mute(() => retryNotifications(client, adapter, NOW)); // attempts 1→2
    await mute(() => retryNotifications(client, adapter, NOW)); // attempts 2→3 (cap)
    const third = await mute(() => retryNotifications(client, adapter, NOW)); // no-op
    check("attempts stop exactly at the cap", store[0].attempts === MAX_DELIVERY_ATTEMPTS);
    check("total sends = retries allowed (2 after the create-time attempt)", sends.length === 2);
    check("idempotent re-run after exhaustion examines nothing", third.examined === 0);
  }

  // ── 5. Obsolete closure (no send, no increment) ───────────────────────────
  {
    const cases: Array<[string, Partial<NonNullable<RetryableDeliveryRow["notification"]>>]> = [
      ["archived", { archivedAt: new Date() }],
      ["read in-app", { readAt: new Date() }],
      ["expired", { expiresAt: new Date(NOW.getTime() - 1000) }],
      ["no recipient email", { user: null }],
    ];
    for (const [label, over] of cases) {
      const { client, store } = makeStore([errorRow("d1", { notification: liveNotification(over) })]);
      const { adapter, sends } = makeAdapter([{ status: "sent", provider: "resend" }]);
      const res = await mute(() => retryNotifications(client, adapter, NOW));
      check(`obsolete (${label}): closed as skipped, no send, no increment`,
        store[0].status === "skipped" && store[0].attempts === 1 && sends.length === 0 &&
          res.skippedObsolete === 1 && res.retried === 0);
    }
  }

  // ── 6. Duplicate-send prevention (claim race) ──────────────────────────────
  {
    // The store mutates attempts between findMany and the claim — simulating
    // a concurrent pass having already claimed the row.
    const { client, store } = makeStore([errorRow("d1")]);
    const raced: NotificationRetryClient = {
      notificationDelivery: {
        findMany: (args) => client.notificationDelivery.findMany(args),
        updateMany: async (args) => {
          store[0].attempts = 2; // concurrent claim lands first
          return client.notificationDelivery.updateMany(args);
        },
        update: (args) => client.notificationDelivery.update(args),
      },
    };
    const { adapter, sends } = makeAdapter([{ status: "sent", provider: "resend" }]);
    const res = await mute(() => retryNotifications(raced, adapter, NOW));
    check("lost claim → zero sends (duplicate-send prevention)",
      sends.length === 0 && res.claimLost === 1 && res.retried === 0);
  }

  // ── 7. Idempotent re-run after success ─────────────────────────────────────
  {
    const { client } = makeStore([errorRow("d1")]);
    const { adapter, sends } = makeAdapter([{ status: "sent", id: "m", provider: "resend" }]);
    await mute(() => retryNotifications(client, adapter, NOW));
    const rerun = await mute(() => retryNotifications(client, adapter, NOW));
    check("re-run after success sends nothing (never duplicate successful deliveries)",
      sends.length === 1 && rerun.examined === 0);
  }

  // ── 8. Dispatcher registration + source scans ──────────────────────────────
  {
    const retry = SCHEDULED_JOBS.find((j) => j.name === "notification-retry");
    check("registered on the dispatcher (07:30 slot, no new cron)",
      retry?.hourUTC === 7 && retry?.minuteUTC === 30);
    check("sequenced after notification-cleanup",
      SCHEDULED_JOBS.findIndex((j) => j.name === "notification-retry") >
        SCHEDULED_JOBS.findIndex((j) => j.name === "notification-cleanup"));

    const src = readFileSync("jobs/retry-notifications.ts", "utf8");
    check("re-uses the create.ts email adapter (no second email path)",
      src.includes("emailNotificationAdapter"));
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("no queue / backoff / timer constructs in the consumer",
      !/BullMQ|new Queue|SQS|EventBridge|setInterval|setTimeout|backoff/i.test(code));
    check("NotificationDelivery is the only retry substrate (no new tables/models referenced)",
      !/prisma\.|\.jobRun\.|telemetry/i.test(code));
  }

  if (failures > 0) {
    console.error(`\nnotification-retry tests: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nnotification-retry tests: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error("  ✗ test harness error:", err);
  process.exit(1);
});
