/**
 * lib/notifications/read.test.ts  (OPS-3 S2)
 *
 * Pure guards for the Notification Center query layer. Standalone tsx script
 * (house pattern): npx tsx lib/notifications/read.test.ts — exits 0/1.
 *
 * NO LIVE DATABASE: the NotificationReadClient injection seam is exercised
 * with an in-memory fake that applies the same predicates Prisma would, so
 * ordering / filtering / scoping semantics are tested deterministically with
 * an injected clock.
 *
 * Covers: newest-first ordering · expiry + archive exclusion · unread count ·
 * mark read (scoped, idempotent, cross-user no-op) · mark all read · empty
 * state · DTO shape (registry icon, ISO dates, no raw metadata) · source-scan
 * that the S2 API routes read only through this layer.
 */

import { readFileSync } from "node:fs";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  unreadNotificationCount,
  NOTIFICATION_LIST_LIMIT,
  type NotificationReadClient,
  type NotificationRowSelect,
} from "@/lib/notifications/read";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── In-memory fake applying the same predicates Prisma would ─────────────────

interface FakeRow extends NotificationRowSelect {
  userId: string;
  archivedAt: Date | null;
  expiresAt: Date | null;
}

function makeFakeClient(rows: FakeRow[]) {
  function matches(r: FakeRow, where: {
    userId: string;
    archivedAt: null;
    OR: [{ expiresAt: null }, { expiresAt: { gt: Date } }];
    readAt?: null;
    id?: string;
  }): boolean {
    if (r.userId !== where.userId) return false;
    if (r.archivedAt !== null) return false;
    const now = where.OR[1].expiresAt.gt;
    if (!(r.expiresAt === null || r.expiresAt > now)) return false;
    if ("readAt" in where && where.readAt === null && r.readAt !== null) return false;
    if (where.id !== undefined && r.id !== where.id) return false;
    return true;
  }

  const client: NotificationReadClient = {
    notification: {
      async findMany({ where, orderBy, take }) {
        const out = rows.filter((r) => matches(r, where));
        if (orderBy.createdAt === "desc") {
          out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        return out.slice(0, take);
      },
      async count({ where }) {
        return rows.filter((r) => matches(r, where)).length;
      },
      async updateMany({ where, data }) {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) r.readAt = data.readAt;
        return { count: hit.length };
      },
    },
  };
  return client;
}

const NOW = new Date("2026-07-07T12:00:00Z");
function row(overrides: Partial<FakeRow> & { id: string; createdAt: Date }): FakeRow {
  return {
    userId: "u1",
    spaceId: null,
    category: "SPACES",
    type: "SPACE_INVITE_RECEIVED",
    priority: "NORMAL",
    title: "t",
    body: null,
    href: null,
    readAt: null,
    archivedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

async function run(): Promise<void> {
  console.log("notification read layer (OPS-3 S2)");

  // ── Ordering + visibility predicate ─────────────────────────────────────────
  {
    const rows: FakeRow[] = [
      row({ id: "old", createdAt: new Date("2026-07-05T10:00:00Z") }),
      row({ id: "new", createdAt: new Date("2026-07-07T10:00:00Z") }),
      row({ id: "mid", createdAt: new Date("2026-07-06T10:00:00Z") }),
      // Excluded: expired, archived, foreign user.
      row({ id: "expired", createdAt: new Date("2026-07-07T11:00:00Z"), expiresAt: new Date("2026-07-07T11:30:00Z") }),
      row({ id: "archived", createdAt: new Date("2026-07-07T11:00:00Z"), archivedAt: new Date() }),
      row({ id: "foreign", createdAt: new Date("2026-07-07T11:00:00Z"), userId: "u2" }),
      // Included: future expiry.
      row({ id: "future-exp", createdAt: new Date("2026-07-04T10:00:00Z"), expiresAt: new Date("2026-08-01T00:00:00Z") }),
    ];
    const items = await listNotifications("u1", { client: makeFakeClient(rows), now: NOW });
    check(
      "newest first",
      items.map((i) => i.id).join(",") === "new,mid,old,future-exp",
      items.map((i) => i.id).join(","),
    );
    check("expired rows excluded", !items.some((i) => i.id === "expired"));
    check("archived rows excluded", !items.some((i) => i.id === "archived"));
    check("foreign user's rows excluded", !items.some((i) => i.id === "foreign"));
    check("unexpired future-expiry rows included", items.some((i) => i.id === "future-exp"));
  }

  // ── DTO shape ───────────────────────────────────────────────────────────────
  {
    const rows = [row({ id: "a", createdAt: NOW, readAt: new Date(NOW) })];
    const [item] = await listNotifications("u1", { client: makeFakeClient(rows), now: NOW });
    check("icon resolved from the registry (single definition site)", item.icon === "mail-plus");
    check("createdAt serialised as ISO string", item.createdAt === NOW.toISOString());
    check("read state derived from readAt", item.read === true);
    check("no raw metadata on the DTO", !("metadata" in item));
  }
  {
    const rows = [row({ id: "a", createdAt: NOW, type: "TYPE_REMOVED_FROM_REGISTRY" })];
    const [item] = await listNotifications("u1", { client: makeFakeClient(rows), now: NOW });
    check("unknown (deregistered) type falls back to the bell icon", item.icon === "bell");
  }

  // ── Unread count ────────────────────────────────────────────────────────────
  {
    const rows: FakeRow[] = [
      row({ id: "u", createdAt: NOW }),
      row({ id: "r", createdAt: NOW, readAt: new Date() }),
      row({ id: "e", createdAt: NOW, expiresAt: new Date("2026-01-01T00:00:00Z") }),
      row({ id: "arch", createdAt: NOW, archivedAt: new Date() }),
      row({ id: "f", createdAt: NOW, userId: "u2" }),
    ];
    const count = await unreadNotificationCount("u1", { client: makeFakeClient(rows), now: NOW });
    check("unread count = unread ∧ active ∧ mine only", count === 1, String(count));
  }

  // ── Empty state ─────────────────────────────────────────────────────────────
  {
    const client = makeFakeClient([]);
    const items = await listNotifications("u1", { client, now: NOW });
    const count = await unreadNotificationCount("u1", { client, now: NOW });
    check("empty store → empty list + zero count", items.length === 0 && count === 0);
  }

  // ── Mark read ───────────────────────────────────────────────────────────────
  {
    const rows: FakeRow[] = [
      row({ id: "a", createdAt: NOW }),
      row({ id: "b", createdAt: NOW }),
      row({ id: "theirs", createdAt: NOW, userId: "u2" }),
    ];
    const client = makeFakeClient(rows);
    const n1 = await markNotificationRead("u1", "a", { client, now: NOW });
    check("mark read transitions exactly one row", n1 === 1);
    check("row is now read", rows[0].readAt !== null);
    const n2 = await markNotificationRead("u1", "a", { client, now: NOW });
    check("mark read is idempotent (already-read → 0)", n2 === 0);
    const n3 = await markNotificationRead("u1", "theirs", { client, now: NOW });
    check("cross-user id probe updates zero rows", n3 === 0 && rows[2].readAt === null);
    check("unrelated rows untouched", rows[1].readAt === null);
  }

  // ── Mark all read ───────────────────────────────────────────────────────────
  {
    const rows: FakeRow[] = [
      row({ id: "a", createdAt: NOW }),
      row({ id: "b", createdAt: NOW }),
      row({ id: "read", createdAt: NOW, readAt: new Date() }),
      row({ id: "theirs", createdAt: NOW, userId: "u2" }),
      row({ id: "arch", createdAt: NOW, archivedAt: new Date() }),
    ];
    const client = makeFakeClient(rows);
    const n = await markAllNotificationsRead("u1", { client, now: NOW });
    check("mark all read transitions only my unread active rows", n === 2, String(n));
    check("foreign rows untouched", rows[3].readAt === null);
    const after = await unreadNotificationCount("u1", { client, now: NOW });
    check("unread count is zero afterwards", after === 0);
  }

  // ── Cap ─────────────────────────────────────────────────────────────────────
  {
    const rows = Array.from({ length: NOTIFICATION_LIST_LIMIT + 10 }, (_, i) =>
      row({ id: `n${i}`, createdAt: new Date(NOW.getTime() - i * 1000) }),
    );
    const items = await listNotifications("u1", { client: makeFakeClient(rows), now: NOW });
    check(`list capped at ${NOTIFICATION_LIST_LIMIT}`, items.length === NOTIFICATION_LIST_LIMIT);
  }

  // ── Source-scan: the API reads only through this layer ─────────────────────
  {
    const routes = [
      "app/api/notifications/route.ts",
      "app/api/notifications/unread-count/route.ts",
      "app/api/notifications/[id]/read/route.ts",
      "app/api/notifications/read-all/route.ts",
    ];
    for (const p of routes) {
      const src = readFileSync(p, "utf8");
      check(
        `${p}: reads via lib/notifications/read (no direct db / AuditLog)`,
        src.includes("@/lib/notifications/read") &&
          !src.includes("auditLog") &&
          !src.includes('from "@/lib/db"'),
      );
    }
  }

  if (failures > 0) {
    console.error(`\nread tests: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nread tests: all passed");
  process.exit(0);
}

run().catch((err) => {
  console.error("read tests: unexpected error", err);
  process.exit(1);
});
