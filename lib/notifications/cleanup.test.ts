/**
 * lib/notifications/cleanup.test.ts  (OPS-3 S6)
 *
 * Pure guards for the notification retention job. Standalone tsx script
 * (house pattern): npx tsx lib/notifications/cleanup.test.ts — exits 0/1.
 *
 * NO LIVE DATABASE: an in-memory fake applies the same predicates Prisma
 * would, with an injected clock. Covers: read-age auto-archive · unread
 * immunity · archive-age deletion · expiry reaping (any state) · the
 * deregistered-type fallback · idempotency · phase isolation (one failing
 * phase never blocks the rest) · source-scan of the cron-fold (no new cron
 * slot, no scheduler/dispatcher/digest/retry infrastructure).
 */

import { readFileSync } from "node:fs";
import {
  cleanupNotifications,
  type NotificationCleanupClient,
} from "@/lib/notifications/cleanup";
import { DEFAULT_RETENTION } from "@/lib/notifications/registry";

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

// ── In-memory fake applying the same predicates Prisma would ─────────────────

interface Row {
  id: string;
  type: string;
  readAt: Date | null;
  archivedAt: Date | null;
  expiresAt: Date | null;
}

function makeFake(rows: Row[]) {
  const store = [...rows];
  function typeMatch(t: string, f: { in: string[] } | { notIn: string[] }): boolean {
    return "in" in f ? f.in.includes(t) : !f.notIn.includes(t);
  }
  const client: NotificationCleanupClient = {
    notification: {
      async updateMany({ where, data }) {
        const hit = store.filter(
          (r) =>
            typeMatch(r.type, where.type) &&
            r.archivedAt === null &&
            r.readAt !== null &&
            r.readAt < where.readAt.lt,
        );
        for (const r of hit) r.archivedAt = data.archivedAt;
        return { count: hit.length };
      },
      async deleteMany({ where }) {
        let hit: Row[];
        if ("expiresAt" in where) {
          hit = store.filter((r) => r.expiresAt !== null && r.expiresAt <= where.expiresAt.lte);
        } else {
          hit = store.filter(
            (r) => typeMatch(r.type, where.type) && r.archivedAt !== null && r.archivedAt < where.archivedAt.lt,
          );
        }
        for (const r of hit) store.splice(store.indexOf(r), 1);
        return { count: hit.length };
      },
    },
  };
  return { client, store };
}

const NOW = new Date("2026-07-07T07:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
function row(overrides: Partial<Row> & { id: string }): Row {
  return { type: "SPACE_INVITE_RECEIVED", readAt: null, archivedAt: null, expiresAt: null, ...overrides };
}

async function run(): Promise<void> {
  console.log("notification cleanup (OPS-3 S6)");
  check("default retention drives the sweeps (30/90)", DEFAULT_RETENTION.autoArchiveDays === 30 && DEFAULT_RETENTION.deleteDays === 90);

  // ── Auto-archive: read-age only ─────────────────────────────────────────────
  {
    const { client, store } = makeFake([
      row({ id: "old-read", readAt: daysAgo(31) }),
      row({ id: "fresh-read", readAt: daysAgo(29) }),
      row({ id: "old-UNREAD" }), // readAt null — never auto-archived
      row({ id: "already-archived", readAt: daysAgo(40), archivedAt: daysAgo(5) }),
    ]);
    const res = await cleanupNotifications({ client, now: NOW });
    check("read row past autoArchiveDays is archived", store.find((r) => r.id === "old-read")?.archivedAt !== null);
    check("recently-read row untouched", store.find((r) => r.id === "fresh-read")?.archivedAt === null);
    check("UNREAD rows are never auto-archived (un-missable doctrine)", store.find((r) => r.id === "old-UNREAD")?.archivedAt === null);
    check("exactly one row archived", res.archived === 1, String(res.archived));
    check("recently-archived row not deleted", store.some((r) => r.id === "already-archived"));
  }

  // ── Delete: archive-age ─────────────────────────────────────────────────────
  {
    const { client, store } = makeFake([
      row({ id: "long-archived", readAt: daysAgo(200), archivedAt: daysAgo(91) }),
      row({ id: "recently-archived", readAt: daysAgo(60), archivedAt: daysAgo(89) }),
      row({ id: "live" }),
    ]);
    const res = await cleanupNotifications({ client, now: NOW });
    check("row archived past deleteDays is deleted", !store.some((r) => r.id === "long-archived") && res.deleted === 1);
    check("row inside the delete window is kept", store.some((r) => r.id === "recently-archived"));
    check("live rows untouched by deletion", store.some((r) => r.id === "live"));
  }

  // ── Reap: expiry beats every state ──────────────────────────────────────────
  {
    const { client, store } = makeFake([
      row({ id: "expired-unread", expiresAt: daysAgo(1) }),
      row({ id: "expired-read", readAt: daysAgo(2), expiresAt: daysAgo(1) }),
      row({ id: "future-expiry", expiresAt: daysAgo(-10) }),
      row({ id: "no-expiry" }),
    ]);
    const res = await cleanupNotifications({ client, now: NOW });
    check("expired rows reaped regardless of read state", res.reaped === 2 && !store.some((r) => r.id.startsWith("expired")));
    check("future-expiry and non-expiring rows kept", store.some((r) => r.id === "future-expiry") && store.some((r) => r.id === "no-expiry"));
  }

  // ── Deregistered-type fallback ──────────────────────────────────────────────
  {
    const { client, store } = makeFake([
      row({ id: "ghost-old", type: "TYPE_REMOVED_FROM_REGISTRY", readAt: daysAgo(31) }),
      row({ id: "ghost-archived", type: "TYPE_REMOVED_FROM_REGISTRY", readAt: daysAgo(200), archivedAt: daysAgo(91) }),
    ]);
    const res = await cleanupNotifications({ client, now: NOW });
    check(
      "deregistered types age out under the defaults (nothing orphans)",
      store.find((r) => r.id === "ghost-old")?.archivedAt !== null &&
        !store.some((r) => r.id === "ghost-archived") &&
        res.archived === 1 && res.deleted === 1,
    );
  }

  // ── Idempotency ─────────────────────────────────────────────────────────────
  {
    const { client } = makeFake([
      row({ id: "old-read", readAt: daysAgo(31) }),
      row({ id: "long-archived", readAt: daysAgo(200), archivedAt: daysAgo(91) }),
      row({ id: "expired", expiresAt: daysAgo(1) }),
    ]);
    const first = await cleanupNotifications({ client, now: NOW });
    const second = await cleanupNotifications({ client, now: NOW });
    check("first run does the work", first.archived === 1 && first.deleted === 1 && first.reaped === 1);
    check(
      "second run at the same instant is a no-op (idempotent)",
      second.archived === 0 && second.deleted === 0 && second.reaped === 0,
      JSON.stringify(second),
    );
  }

  // ── Phase isolation ─────────────────────────────────────────────────────────
  {
    const broken: NotificationCleanupClient = {
      notification: {
        async updateMany() {
          throw new Error("archive phase down");
        },
        async deleteMany({ where }) {
          return { count: "expiresAt" in where ? 5 : 0 };
        },
      },
    };
    const res = await cleanupNotifications({ client: broken, now: NOW });
    check("a failing phase never blocks the others (reap still ran)", res.archived === 0 && res.reaped === 5);
  }

  // ── Source-scan: scheduling discipline ──────────────────────────────────────
  {
    // Since OPS-4 S2 the schedule is the single dispatcher cron; cleanup
    // still consumes NO cron slot of its own (the F7 intent, unchanged). On the
    // current Vercel Hobby (free) tier that single entry runs once per day
    // ("0 6 * * *"); the count-of-one invariant below is unchanged either way.
    const vercel = readFileSync("vercel.json", "utf8");
    const crons = (vercel.match(/"path"/g) ?? []).length;
    check(
      "no cron slot consumed by cleanup (single dispatcher entry)",
      crons === 1 && vercel.includes("/api/jobs/dispatch") && !vercel.includes("notification"),
    );

    // Since OPS-4 S3, cleanup is its OWN dispatcher registration (the move
    // the header promised) and process-deletions is single-purpose again.
    // Isolation is structural: dispatcher per-job try/catch + own JobRun.
    const registry = readFileSync("lib/jobs/registry.ts", "utf8");
    check(
      "cleanup registered as its own dispatcher job",
      registry.includes('"notification-cleanup"') && registry.includes("cleanupNotifications("),
    );
    const deletionsRoute = readFileSync("app/api/jobs/process-deletions/route.ts", "utf8");
    check(
      "process-deletions no longer owns the cleanup tail (single-purpose)",
      !deletionsRoute.includes("cleanupNotifications"),
    );

    // Strip comments so doctrine text (which legitimately NAMES the forbidden
    // things) doesn't trip the scan — only executable constructs count.
    const cleanupCode = readFileSync("lib/notifications/cleanup.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    check(
      "no scheduler/dispatcher/queue/retry/digest infrastructure in cleanup (code-level)",
      !/setInterval|setTimeout|node-cron|BullMQ|new Queue|cron\.schedule|digestFrequency/i.test(cleanupCode),
    );
  }

  if (failures > 0) {
    console.error(`\ncleanup tests: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\ncleanup tests: all passed");
  process.exit(0);
}

run().catch((err) => {
  console.error("cleanup tests: unexpected error", err);
  process.exit(1);
});
