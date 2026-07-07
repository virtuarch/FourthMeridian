/**
 * lib/notifications/create.test.ts  (OPS-3 S1)
 *
 * Pure guards for the createNotification chokepoint. Standalone tsx script
 * (house pattern): npx tsx lib/notifications/create.test.ts — exits 0/1.
 *
 * NO LIVE DATABASE (the run-tests scope rule): the chokepoint's injection
 * seam (NotificationWriteClient) is exercised with an in-memory fake that
 * simulates the (userId, dedupeKey) unique constraint, so dedupe semantics —
 * including the race path — are tested deterministically.
 *
 * Covers: invalid-type rejection · row shape (render, metadata-as-supplied,
 * auditLogId, expiresAt) · dedupe none/suppress · suppress-while-open ·
 * archived-holder key release + re-notify · missing template placeholder ·
 * runtime DB error → non-throwing "error" result · invite producer mapping
 * (exactly one notification per invite) · source-scan of the EV-1 wiring.
 */

import { readFileSync } from "node:fs";
import {
  createNotification,
  type NotificationWriteClient,
} from "@/lib/notifications/create";
import { buildSpaceInviteNotificationInput } from "@/lib/events/handlers/space-invite-notification";
import type { NotificationTypeId } from "@/lib/notifications/registry";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── In-memory fake client simulating the unique constraint ──────────────────

interface FakeRow {
  id: string;
  userId: string;
  dedupeKey: string | null;
  archivedAt: Date | null;
  data: Record<string, unknown>;
}

function makeFakeClient(seed: FakeRow[] = []) {
  const rows: FakeRow[] = [...seed];
  let nextId = 1;
  const calls = { create: 0, findUnique: 0, update: 0 };

  const client: NotificationWriteClient = {
    notification: {
      async create({ data }) {
        calls.create++;
        if (
          data.dedupeKey !== null &&
          rows.some((r) => r.userId === data.userId && r.dedupeKey === data.dedupeKey)
        ) {
          // Simulate Prisma P2002 on Notification_userId_dedupeKey_key.
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row: FakeRow = {
          id: `n${nextId++}`,
          userId: data.userId,
          dedupeKey: data.dedupeKey,
          archivedAt: null,
          data: data as unknown as Record<string, unknown>,
        };
        rows.push(row);
        return { id: row.id };
      },
      async findUnique({ where }) {
        calls.findUnique++;
        const r = rows.find(
          (x) =>
            x.userId === where.userId_dedupeKey.userId &&
            x.dedupeKey === where.userId_dedupeKey.dedupeKey,
        );
        return r ? { id: r.id, archivedAt: r.archivedAt } : null;
      },
      async update({ where, data }) {
        calls.update++;
        const r = rows.find((x) => x.id === where.id);
        if (!r) throw new Error("not found");
        r.dedupeKey = data.dedupeKey;
        return { id: r.id };
      },
    },
  };
  return { client, rows, calls };
}

async function run(): Promise<void> {
  console.log("createNotification chokepoint (OPS-3 S1)");

  // ── 1. Registry gate ────────────────────────────────────────────────────────
  {
    let threw = false;
    try {
      await createNotification(
        { type: "NOT_A_REAL_TYPE" as NotificationTypeId, userId: "u1" },
        { client: makeFakeClient().client },
      );
    } catch {
      threw = true;
    }
    check("unknown registry id throws at the producer", threw);
  }

  // ── 2. Row shape: render, metadata exactly as supplied, links ──────────────
  {
    const fake = makeFakeClient();
    const metadata = { pendingEmail: "n***@example.com" };
    const res = await createNotification(
      {
        type: "EMAIL_CHANGE_REQUESTED",
        userId: "u1",
        data: metadata,
        auditLogId: "audit_123",
      },
      { client: fake.client },
    );
    const row = fake.rows[0]?.data as Record<string, unknown>;
    check("creates a row and reports created", res.status === "created" && res.id === "n1");
    check("category/type/priority come from the registry", row.category === "ACCOUNT_SECURITY" && row.type === "EMAIL_CHANGE_REQUESTED" && row.priority === "CRITICAL");
    check("title rendered from registry render()", row.title === "Email change requested");
    check("render interpolates supplied data", typeof row.body === "string" && (row.body as string).includes("n***@example.com"));
    check("metadata persisted exactly as supplied", row.metadata === metadata);
    check("auditLogId soft ref persisted", row.auditLogId === "audit_123");
    check("no dedupe key for dedupe=none types", row.dedupeKey === null);
  }
  {
    const fake = makeFakeClient();
    await createNotification(
      { type: "PASSWORD_CHANGED", userId: "u1" },
      { client: fake.client },
    );
    const row = fake.rows[0]?.data as Record<string, unknown>;
    check("metadata omitted entirely when no data supplied", !("metadata" in row));
    check("auditLogId defaults to null", row.auditLogId === null);
  }

  // ── 3. Dedupe: suppress-while-open ──────────────────────────────────────────
  {
    const fake = makeFakeClient();
    const input = {
      type: "SYNC_FAILED" as NotificationTypeId,
      userId: "u1",
      data: { plaidItemId: "item_1", institutionName: "Chase" },
    };
    const first = await createNotification(input, { client: fake.client });
    const second = await createNotification(input, { client: fake.client });
    const third = await createNotification(input, { client: fake.client });
    check("first occurrence creates", first.status === "created");
    check(
      "dedupe key filled from registry template",
      fake.rows[0]?.dedupeKey === "SYNC_FAILED:item:item_1:open",
    );
    check("second occurrence suppressed while open", second.status === "suppressed");
    check("third occurrence still suppressed (daily-cron case)", third.status === "suppressed");
    check("exactly one row exists after three attempts", fake.rows.length === 1);

    // Archived holder → key released, new outage notifies again.
    fake.rows[0].archivedAt = new Date();
    const fourth = await createNotification(input, { client: fake.client });
    check("archived holder releases its key and re-notifies", fourth.status === "created");
    check("old row's key was released", fake.rows[0].dedupeKey === null);
    check("new open row holds the key", fake.rows[1]?.dedupeKey === "SYNC_FAILED:item:item_1:open");
    check("two rows total (history preserved)", fake.rows.length === 2);
  }

  // Different condition → different key → both notify.
  {
    const fake = makeFakeClient();
    const a = await createNotification(
      { type: "SYNC_FAILED", userId: "u1", data: { plaidItemId: "item_A" } },
      { client: fake.client },
    );
    const b = await createNotification(
      { type: "SYNC_FAILED", userId: "u1", data: { plaidItemId: "item_B" } },
      { client: fake.client },
    );
    check("distinct conditions are not cross-suppressed", a.status === "created" && b.status === "created");
  }

  // ── 4. Template placeholder validation ─────────────────────────────────────
  {
    let threw = false;
    try {
      await createNotification(
        { type: "SYNC_FAILED", userId: "u1", data: {} }, // missing plaidItemId
        { client: makeFakeClient().client },
      );
    } catch {
      threw = true;
    }
    check("missing dedupe placeholder value throws (producer bug)", threw);
  }

  // ── 5. Runtime DB failure → non-throwing error result ──────────────────────
  {
    const broken: NotificationWriteClient = {
      notification: {
        async create() {
          throw new Error("connection lost");
        },
        async findUnique() {
          return null;
        },
        async update() {
          return { id: "x" };
        },
      },
    };
    const res = await createNotification(
      { type: "PASSWORD_CHANGED", userId: "u1" },
      { client: broken },
    );
    check(
      "runtime DB error resolves to an error result, never throws",
      res.status === "error" && (res.error ?? "").includes("connection lost"),
    );
  }

  // ── 6. Invite producer (pure mapping + exactly one row) ────────────────────
  {
    const invite = {
      id: "inv_1",
      status: "PENDING",
      expiresAt: new Date("2026-08-01T00:00:00Z"),
      space: { name: "Hogan Family" },
      invitedBy: { name: "Chris Hogan", username: "chris" },
    };
    const input = buildSpaceInviteNotificationInput("space_1", "u_invitee", invite);
    check("invite maps to SPACE_INVITE_RECEIVED", input.type === "SPACE_INVITE_RECEIVED");
    check("recipient is the INVITED user", input.userId === "u_invitee");
    check(
      "metadata honors the pointer contract (inviteId, spaceName, inviterName)",
      input.data?.inviteId === "inv_1" &&
        input.data?.spaceName === "Hogan Family" &&
        input.data?.inviterName === "@chris",
    );
    check("expiry mirrors SpaceInvite.expiresAt", input.expiresAt === invite.expiresAt);

    const fake = makeFakeClient();
    const res = await createNotification(input, { client: fake.client });
    const row = fake.rows[0]?.data as Record<string, unknown>;
    check("invite producer creates exactly one notification", res.status === "created" && fake.rows.length === 1);
    check("invite title renders with the Space name", row.title === "You're invited to Hogan Family");
    check("invite notification carries the Space context", row.spaceId === "space_1");
  }
  {
    const invite = {
      id: "inv_2",
      status: "PENDING",
      expiresAt: null,
      space: null,
      invitedBy: { name: "Anon", username: null },
    };
    const input = buildSpaceInviteNotificationInput("space_2", "u2", invite);
    check(
      "inviter identity falls back to name when no username (route convention)",
      input.data?.inviterName === "Anon",
    );
  }

  // ── 7. Source-scan: wiring + chokepoint exclusivity ─────────────────────────
  {
    const emitSrc = readFileSync("lib/events/emit.ts", "utf8");
    check(
      "emit.ts registers notifySpaceInviteReceived on MemberInvited",
      /MemberInvited:\s*\[notifySpaceInviteReceived\]/.test(emitSrc),
    );
    const handlerSrc = readFileSync(
      "lib/events/handlers/space-invite-notification.ts",
      "utf8",
    );
    check(
      "the producer goes through createNotification (no direct row write)",
      handlerSrc.includes("createNotification(") &&
        !handlerSrc.includes(".notification.create"),
    );
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  if (failures > 0) {
    console.error(`\ncreate tests: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\ncreate tests: all passed");
  process.exit(0);
}

run().catch((err) => {
  console.error("create tests: unexpected error", err);
  process.exit(1);
});
