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
import type {
  PreferenceClient,
  PreferenceOverride,
} from "@/lib/notifications/preferences";
import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelResult,
} from "@/lib/notifications/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Environment tolerance, NOT test logic: importing lib/db.ts constructs the
// shared PrismaClient, whose library engine warms up in the background. On a
// machine whose generated engine doesn't match the platform (e.g. a Linux
// sandbox with a darwin-generated client), that warm-up floating-rejects with
// PrismaClientInitializationError — a pre-existing artifact every db-importing
// test carries (they normally exit before it surfaces; this file awaits long
// enough for it to fire). NOTHING in this file uses Prisma — every client is
// injected — so that one rejection class is ignored; anything else still fails
// the run. Inert on a correctly generated machine.
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") {
    return;
  }
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

// ── In-memory fake client simulating the unique constraint ──────────────────

interface FakeRow {
  id: string;
  userId: string;
  dedupeKey: string | null;
  archivedAt: Date | null;
  data: Record<string, unknown>;
}

interface FakeDelivery {
  notificationId: string;
  channel: string;
  status: string;
  provider: string | null;
  providerMessageId: string | null;
  error: string | null;
  attempts: number;
  deliveredAt: Date | null;
}

function makeFakeClient(seed: FakeRow[] = [], emails: Record<string, string> = { u1: "u1@example.com" }) {
  const rows: FakeRow[] = [...seed];
  const deliveries: FakeDelivery[] = [];
  let nextId = 1;
  const calls = { create: 0, findUnique: 0, update: 0 };

  const client: NotificationWriteClient = {
    user: {
      async findUnique({ where }) {
        const email = emails[where.id];
        return email ? { email } : null;
      },
    },
    notificationDelivery: {
      async create({ data }) {
        deliveries.push({ ...data });
        return { id: `d${deliveries.length}` };
      },
    },
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
  return { client, rows, deliveries, calls };
}

// Fake EMAIL adapter (OPS-3 S4): scripted ChannelResult + message capture, so
// delivery bookkeeping is asserted without touching the real email chokepoint.
function makeFakeAdapter(result: ChannelResult) {
  const messages: ChannelMessage[] = [];
  const adapter: ChannelAdapter = {
    channel: "EMAIL",
    name: "fake-email",
    async deliver(message) {
      messages.push(message);
      return result;
    },
  };
  return { adapter, messages };
}
// Silent adapter for tests that aren't about email: skip, no assertions.
const silentAdapter = makeFakeAdapter({ status: "skipped", provider: "fake-email" }).adapter;

// Fake preference client (OPS-3 S3): the chokepoint now resolves the IN_APP
// preference before inserting, so every call injects one (no live DB in unit
// tests). Empty rows = pure registry defaults.
function makePrefClient(rows: PreferenceOverride[] = []): PreferenceClient {
  return {
    notificationPreference: {
      async findMany() {
        return rows;
      },
      async upsert() {
        throw new Error("not used by the chokepoint");
      },
    },
  };
}
const defaultPrefs = makePrefClient();

async function run(): Promise<void> {
  console.log("createNotification chokepoint (OPS-3 S1)");

  // ── 1. Registry gate ────────────────────────────────────────────────────────
  {
    let threw = false;
    try {
      await createNotification(
        { type: "NOT_A_REAL_TYPE" as NotificationTypeId, userId: "u1" },
        { client: makeFakeClient().client, prefClient: defaultPrefs, emailAdapter: silentAdapter },
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
      { client: fake.client, prefClient: defaultPrefs, emailAdapter: silentAdapter },
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
      { client: fake.client, prefClient: defaultPrefs, emailAdapter: silentAdapter },
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
    const first = await createNotification(input, { client: fake.client, prefClient: defaultPrefs, emailAdapter: silentAdapter });
    const second = await createNotification(input, { client: fake.client, prefClient: defaultPrefs, emailAdapter: silentAdapter });
    const third = await createNotification(input, { client: fake.client, prefClient: defaultPrefs, emailAdapter: silentAdapter });
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
    const fourth = await createNotification(input, { client: fake.client, prefClient: defaultPrefs, emailAdapter: silentAdapter });
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
      { client: fake.client, prefClient: defaultPrefs, emailAdapter: silentAdapter },
    );
    const b = await createNotification(
      { type: "SYNC_FAILED", userId: "u1", data: { plaidItemId: "item_B" } },
      { client: fake.client, prefClient: defaultPrefs, emailAdapter: silentAdapter },
    );
    check("distinct conditions are not cross-suppressed", a.status === "created" && b.status === "created");
  }

  // ── 4. Template placeholder validation ─────────────────────────────────────
  {
    let threw = false;
    try {
      await createNotification(
        { type: "SYNC_FAILED", userId: "u1", data: {} }, // missing plaidItemId
        { client: makeFakeClient().client, prefClient: defaultPrefs, emailAdapter: silentAdapter },
      );
    } catch {
      threw = true;
    }
    check("missing dedupe placeholder value throws (producer bug)", threw);
  }

  // ── 5. Runtime DB failure → non-throwing error result ──────────────────────
  {
    const broken: NotificationWriteClient = {
      user: {
        async findUnique() {
          return null;
        },
      },
      notificationDelivery: {
        async create() {
          return { id: "d" };
        },
      },
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
      { client: broken, prefClient: defaultPrefs, emailAdapter: silentAdapter },
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
    const res = await createNotification(input, { client: fake.client, prefClient: defaultPrefs, emailAdapter: silentAdapter });
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

  // ── 8. Preference enforcement (OPS-3 S3, frozen F11) ────────────────────────
  {
    // Category disabled for IN_APP → no row, "skipped" (mirrors EmailResult).
    const fake = makeFakeClient();
    const offSpaces = makePrefClient([
      { category: "SPACES", channel: "IN_APP", enabled: false },
    ]);
    const res = await createNotification(
      { type: "SPACE_INVITE_RECEIVED", userId: "u1", data: { inviteId: "i", spaceName: "S", inviterName: "@x" } },
      { client: fake.client, prefClient: offSpaces, emailAdapter: silentAdapter },
    );
    check("in-app-disabled category is skipped", res.status === "skipped");
    check("skipped creates no row", fake.rows.length === 0 && fake.calls.create === 0);
  }
  {
    // Locked ACCOUNT_SECURITY ignores hostile override rows — always created.
    const fake = makeFakeClient();
    const hostile = makePrefClient([
      { category: "ACCOUNT_SECURITY", channel: "IN_APP", enabled: false },
    ]);
    const res = await createNotification(
      { type: "PASSWORD_CHANGED", userId: "u1" },
      { client: fake.client, prefClient: hostile, emailAdapter: silentAdapter },
    );
    check("locked category cannot be muted at the chokepoint", res.status === "created" && fake.rows.length === 1);
  }
  {
    // SYNC_COMPLETED is now IN_APP default-ON (D2 reopened) → a row is created
    // with no override rows (dedupe key resolves from data.plaidItemId).
    const fake = makeFakeClient();
    const res = await createNotification(
      { type: "SYNC_COMPLETED", userId: "u1", data: { plaidItemId: "p", institutionName: "Chase" } },
      { client: fake.client, prefClient: defaultPrefs, emailAdapter: silentAdapter },
    );
    check("default-ON type (SYNC_COMPLETED) creates a row with no override rows", res.status === "created" && fake.rows.length === 1);
  }
  {
    // A preference-read failure is a non-throwing error result.
    const broken: PreferenceClient = {
      notificationPreference: {
        async findMany() {
          throw new Error("pref store down");
        },
        async upsert() {
          throw new Error("unused");
        },
      },
    };
    const fake = makeFakeClient();
    const res = await createNotification(
      { type: "SPACE_INVITE_RECEIVED", userId: "u1", data: { inviteId: "i", spaceName: "S", inviterName: "@x" } },
      { client: fake.client, prefClient: broken, emailAdapter: silentAdapter },
    );
    check(
      "preference-read failure resolves to error, never throws",
      res.status === "error" && (res.error ?? "").includes("pref store down"),
    );
  }

  // ── 9. Email delivery + NotificationDelivery bookkeeping (OPS-3 S4) ─────────
  const inviteInput = {
    type: "SPACE_INVITE_RECEIVED" as NotificationTypeId, // default: IN_APP + EMAIL
    userId: "u1",
    data: { inviteId: "i1", spaceName: "Hogan Family", inviterName: "@chris" },
  };
  {
    // Successful send → one row, EmailResult mapped field-for-field.
    const fake = makeFakeClient();
    const { adapter, messages } = makeFakeAdapter({ status: "sent", id: "msg_123", provider: "resend" });
    const res = await createNotification(inviteInput, { client: fake.client, prefClient: defaultPrefs, emailAdapter: adapter });
    check("created with email default-on", res.status === "created");
    check("exactly one delivery row per attempt", fake.deliveries.length === 1);
    const d = fake.deliveries[0];
    check("delivery row: EMAIL channel, sent, verbatim provider fields",
      d.channel === "EMAIL" && d.status === "sent" && d.provider === "resend" && d.providerMessageId === "msg_123" && d.error === null);
    check("deliveredAt set on sent", d.deliveredAt !== null);
    check("attempts starts at 1 (retries are OPS-4)", d.attempts === 1);
    check("delivery row anchored to the created notification", d.notificationId === res.id);
    check("adapter got the recipient email + rendered copy",
      messages[0]?.email === "u1@example.com" && messages[0]?.title === "You're invited to Hogan Family");
  }
  {
    // Failed send → row records the failure; deliveredAt stays null.
    const fake = makeFakeClient();
    const { adapter } = makeFakeAdapter({ status: "error", provider: "resend", error: "550 mailbox unavailable" });
    const res = await createNotification(inviteInput, { client: fake.client, prefClient: defaultPrefs, emailAdapter: adapter });
    const d = fake.deliveries[0];
    check("failed send still creates the notification", res.status === "created");
    check("failure recorded verbatim", d?.status === "error" && d.error === "550 mailbox unavailable" && d.deliveredAt === null);
  }
  {
    // EMAIL preference off → created, NO delivery row, adapter never called.
    const fake = makeFakeClient();
    const { adapter, messages } = makeFakeAdapter({ status: "sent", provider: "resend" });
    const emailOff = makePrefClient([{ category: "SPACES", channel: "EMAIL", enabled: false }]);
    const res = await createNotification(inviteInput, { client: fake.client, prefClient: emailOff, emailAdapter: adapter });
    check("EMAIL-disabled: notification created, no delivery row, adapter untouched",
      res.status === "created" && fake.deliveries.length === 0 && messages.length === 0);
  }
  {
    // Locked ACCOUNT_SECURITY (S5 semantics): registry defaults authoritative
    // — IN_APP only. No notification email ships (the security EMAIL guarantee
    // is the OPS-2 security-alert flow), even against hostile ENABLE rows.
    const fake = makeFakeClient();
    const { adapter, messages } = makeFakeAdapter({ status: "sent", id: "m", provider: "resend" });
    const hostileOn = makePrefClient([{ category: "ACCOUNT_SECURITY", channel: "EMAIL", enabled: true }]);
    const res = await createNotification({ type: "PASSWORD_CHANGED", userId: "u1" },
      { client: fake.client, prefClient: hostileOn, emailAdapter: adapter });
    check("locked category never ships a notification email (security-alert owns email)",
      res.status === "created" && fake.deliveries.length === 0 && messages.length === 0);
  }
  {
    // Default IN_APP-only type → created, no email attempt.
    const fake = makeFakeClient();
    const { adapter, messages } = makeFakeAdapter({ status: "sent", provider: "resend" });
    const res = await createNotification(
      { type: "MEMBER_REMOVED", userId: "u1", data: { spaceName: "S" } },
      { client: fake.client, prefClient: defaultPrefs, emailAdapter: adapter },
    );
    check("in-app-only default sends no email", res.status === "created" && fake.deliveries.length === 0 && messages.length === 0);
  }
  {
    // Duplicate suppression → no second email, no second delivery row.
    const fake = makeFakeClient();
    const { adapter, messages } = makeFakeAdapter({ status: "sent", provider: "resend" });
    const emailOnFinancial = makePrefClient([{ category: "FINANCIAL", channel: "EMAIL", enabled: true }]);
    const syncInput = { type: "SYNC_FAILED" as NotificationTypeId, userId: "u1", data: { plaidItemId: "p1", institutionName: "Chase" } };
    const first = await createNotification(syncInput, { client: fake.client, prefClient: emailOnFinancial, emailAdapter: adapter });
    const second = await createNotification(syncInput, { client: fake.client, prefClient: emailOnFinancial, emailAdapter: adapter });
    check("suppressed duplicate ships no second email",
      first.status === "created" && second.status === "suppressed" && fake.deliveries.length === 1 && messages.length === 1);
  }
  {
    // Recipient row missing → adapter reports skipped; the skip is recorded.
    const fake = makeFakeClient([], {} /* no emails */);
    const { adapter } = makeFakeAdapter({ status: "skipped", provider: "fake-email" });
    await createNotification(inviteInput, { client: fake.client, prefClient: defaultPrefs, emailAdapter: adapter });
    check("skipped attempt still leaves a delivery row (bookkeeping invariant)",
      fake.deliveries[0]?.status === "skipped" && fake.deliveries[0].deliveredAt === null);
  }
  {
    // Adapter integration: the DEFAULT adapter rides the OPS-1 chokepoint;
    // NODE_ENV=test forces the capture transport (never a real send — the
    // send.ts contract), and the captured outcome lands in the delivery row.
    (process.env as Record<string, string>).NODE_ENV = "test";
    const fake = makeFakeClient();
    const res = await createNotification(inviteInput, { client: fake.client, prefClient: defaultPrefs });
    const d = fake.deliveries[0];
    check("default adapter delivers through OPS-1 sendEmail (capture transport)",
      res.status === "created" && d?.channel === "EMAIL" && d.status === "captured" && d.provider === "capture");
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
