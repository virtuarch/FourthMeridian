/**
 * lib/notifications/wave3.test.ts  (OPS-3 S5 Waves 1–3, consolidated)
 *
 * Guards for the notification producer waves. Standalone tsx script (house
 * pattern): npx tsx lib/notifications/wave3.test.ts — exits 0/1.
 *
 * Consolidated file: absorbs wave1.test.ts (OPS-3 S5 Wave 1, account &
 * security producers) and wave2.test.ts (OPS-3 S5 Wave 2, Spaces membership
 * producers) alongside the original Wave 3 financial-producer guards.
 *
 * Layers (deterministic, DB-free — every client injected):
 *   1. BEHAVIOR — the full SYNC_FAILED lifecycle: notify → suppress across
 *      repeated failures from ANY site → retirement on recovery (key release
 *      + archive) → a fresh outage notifies again. Import success/partial-
 *      failure mapping. FINANCIAL preference enforcement. Locked
 *      ACCOUNT_SECURITY semantics (Wave 1) and SPACES membership semantics
 *      (Wave 2) through the same chokepoint.
 *   2. SOURCE-SCAN — every Wave 1/2/3 producer site wired through the
 *      chokepoint (or shared helper pair); no direct row writes; no
 *      email/audit duplication.
 *   3. RULINGS — D2 (SYNC_COMPLETED), DUPLICATE_DETECTED drift, MemberLeft /
 *      ownership rulings, wave discipline for 1b and 4.
 */

import { readFileSync } from "node:fs";
import {
  buildInviteAcceptedInput,
  buildMemberRemovedInput,
  buildRoleChangedInput,
} from "@/lib/events/handlers/space-member-notifications";
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
import { NOTIFICATION_REGISTRY, isNotificationType } from "@/lib/notifications/registry";

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

// ═══ Merged from wave1.test.ts (OPS-3 S5 Wave 1 era): account & security ════
// ── W1-1. Source-scan: every Wave 1 producer site ───────────────────────────

/** site file → notification types it must produce. */
const WAVE1_SITES: Record<string, string[]> = {
  "app/api/user/password/route.ts":              ["PASSWORD_CHANGED"],
  "app/api/auth/reset-password/route.ts":        ["PASSWORD_RESET"],
  "app/api/user/email/request/route.ts":         ["EMAIL_CHANGE_REQUESTED"],
  "app/api/user/email/confirm/route.ts":         ["EMAIL_CHANGE_COMPLETED"],
  "app/api/user/totp/verify/route.ts":           ["TWO_FACTOR_ENABLED"],
  "app/api/user/totp/disable/route.ts":          ["TWO_FACTOR_DISABLED"],
  "app/api/user/sessions/[sessionId]/route.ts":  ["SESSION_REVOKED"],
  "app/api/user/deactivate/route.ts":            ["ACCOUNT_DEACTIVATED"],
  "app/api/user/delete/route.ts":                ["ACCOUNT_DELETION_REQUESTED"],
  "app/api/user/export/route.ts":                ["DATA_EXPORTED"],
  "lib/auth.ts":                                 ["ACCOUNT_REACTIVATED", "ACCOUNT_DELETION_CANCELLED"],
};

console.log("Wave 1 producer sites (source-scan)");
for (const [file, types] of Object.entries(WAVE1_SITES)) {
  const src = readFileSync(file, "utf8");
  for (const type of types) {
    check(`${file} produces ${type}`, new RegExp(`type:\\s*"${type}"`).test(src));
    check(`${type} is a registry id`, type in NOTIFICATION_REGISTRY);
    check(
      `${type} registry entry is WIRED`,
      NOTIFICATION_REGISTRY[type as keyof typeof NOTIFICATION_REGISTRY].status === "WIRED",
    );
  }
  check(`${file} goes through the chokepoint import`, src.includes("@/lib/notifications/create"));
  check(`${file} links the audit fact (auditLogId)`, src.includes("auditLogId:"));
  check(`${file} never writes Notification rows directly`, !src.includes(".notification.create"));
  check(
    `${file} never calls the notification email template directly`,
    !src.includes('sendEmail("notification"'),
  );
}

// Wave discipline: 1b is NOT wired.
for (const deferred of ["EMAIL_VERIFIED", "RECOVERY_CODE_USED", "RECOVERY_CODES_REGENERATED", "TWO_FACTOR_RESET"] as const) {
  check(`${deferred} remains VOCABULARY (Wave 1b, not started)`,
    NOTIFICATION_REGISTRY[deferred].status === "VOCABULARY");
}

// ═══ Merged from wave2.test.ts (OPS-3 S5 Wave 2 era): Spaces membership ═════
// ── W2-1. Pure builders ─────────────────────────────────────────────────────

console.log("Wave 2 builders");
{
  const invite = {
    id: "inv_1",
    status: "ACCEPTED",
    invitedById: "u_inviter",
    space: { name: "Hogan Family" },
    invitedUser: { name: "New Member", username: "newbie" },
  };
  const input = buildInviteAcceptedInput("space_1", "u_joiner", invite);
  check("accepted: maps to SPACE_INVITE_ACCEPTED", input?.type === "SPACE_INVITE_ACCEPTED");
  check("accepted: recipient is the INVITER", input?.userId === "u_inviter");
  check(
    "accepted: pointer contract honored (inviteId, spaceName, memberName)",
    input?.data?.inviteId === "inv_1" &&
      input?.data?.spaceName === "Hogan Family" &&
      input?.data?.memberName === "@newbie",
  );
  check(
    "accepted: display handle falls back to name without username",
    buildInviteAcceptedInput("s", "u", { ...invite, invitedUser: { name: "Anon", username: null } })
      ?.data?.memberName === "Anon",
  );
  check("accepted: missing invite → guard declines", buildInviteAcceptedInput("s", "u", null) === null);
  check(
    "accepted: non-ACCEPTED (raced re-invite) → guard declines",
    buildInviteAcceptedInput("s", "u", { ...invite, status: "PENDING" }) === null,
  );
  check(
    "accepted: degenerate self-invite → guard declines",
    buildInviteAcceptedInput("s", "u_inviter", invite) === null,
  );
}
{
  const input = buildMemberRemovedInput("space_1", "u_removed", "u_admin", "Hogan Family");
  check("removed: maps to MEMBER_REMOVED", input?.type === "MEMBER_REMOVED");
  check("removed: recipient is the REMOVED user", input?.userId === "u_removed");
  check("removed: carries the Space name", input?.data?.spaceName === "Hogan Family");
  check(
    "removed: self-removal → guard declines (MemberLeft territory)",
    buildMemberRemovedInput("space_1", "u_x", "u_x", "S") === null,
  );
}
{
  const payload = { targetUserId: "u_target", oldRole: "MEMBER", newRole: "ADMIN" };
  const input = buildRoleChangedInput("space_1", payload, "u_owner", "Hogan Family");
  check("roleChanged: maps to MEMBER_ROLE_CHANGED", input?.type === "MEMBER_ROLE_CHANGED");
  check("roleChanged: recipient is the TARGET user", input?.userId === "u_target");
  check(
    "roleChanged: pointer contract honored (spaceName, oldRole, newRole)",
    input?.data?.spaceName === "Hogan Family" && input?.data?.oldRole === "MEMBER" && input?.data?.newRole === "ADMIN",
  );
  check(
    "roleChanged: self-directed change → guard declines",
    buildRoleChangedInput("s", payload, "u_target", "S") === null,
  );
}

// ── W2-2. Source-scan: wiring + rulings ─────────────────────────────────────

console.log("Wave 2 wiring (source-scan)");
{
  const emitSrc = readFileSync("lib/events/emit.ts", "utf8");
  check(
    "MemberJoined registers notifySpaceInviteAccepted",
    /MemberJoined:\s*\[notifySpaceInviteAccepted\]/.test(emitSrc),
  );
  check(
    "MemberRemoved keeps the snapshot handler AND gains the notifier",
    /MemberRemoved:\s*\[regenerateSnapshotOnShareChange,\s*notifyMemberRemoved\]/.test(emitSrc),
  );
  check(
    "MemberRoleChanged registers notifyMemberRoleChanged",
    /MemberRoleChanged:\s*\[notifyMemberRoleChanged\]/.test(emitSrc),
  );
  check(
    "MemberLeft has NO notification handler (wave-entry ruling; snapshot only)",
    /MemberLeft:\s*\[regenerateSnapshotOnShareChange\]/.test(emitSrc),
  );

  const handlerSrc = readFileSync("lib/events/handlers/space-member-notifications.ts", "utf8");
  check(
    "producers flow through createNotification (no direct row writes)",
    handlerSrc.includes("createNotification(") && !handlerSrc.includes(".notification.create"),
  );
  check(
    "no email logic duplicated in the handlers",
    !handlerSrc.includes("sendEmail"),
  );
  check(
    "no audit logic duplicated in the handlers",
    !handlerSrc.includes("auditLog.create"),
  );
}

// Registry state: Wave 2 wired; MemberLeft has no type.
for (const wired of ["SPACE_INVITE_ACCEPTED", "MEMBER_REMOVED", "MEMBER_ROLE_CHANGED"] as const) {
  check(`${wired} registry entry is WIRED`, NOTIFICATION_REGISTRY[wired].status === "WIRED");
}
check("MEMBER_LEFT never entered the vocabulary (ruling)", !isNotificationType("MEMBER_LEFT"));
check(
  "SPACE_OWNERSHIP_TRANSFERRED remains VOCABULARY (feature absent)",
  NOTIFICATION_REGISTRY.SPACE_OWNERSHIP_TRANSFERRED.status === "VOCABULARY",
);
// (Wave 4 DAILY_BRIEF_READY / OPPORTUNITY_FOUND VOCABULARY checks are covered
// by the Wave 3 wave-discipline loop below — byte-duplicate assertions elided.)

async function run(): Promise<void> {
  // ═══ Merged behavior sections (wave1/wave2 eras); makeClient() from those
  // files was a strict subset of makeStore(), so the store fakes serve both. ══

  // ── W1-2. Behavior: the locked semantics Wave 1 rides on ──────────────────
  console.log("Wave 1 behavior (locked ACCOUNT_SECURITY)");
  for (const type of ["PASSWORD_CHANGED", "TWO_FACTOR_DISABLED", "DATA_EXPORTED"] as const) {
    const { writeClient, rows, deliveries } = makeStore();
    const res = await createNotification(
      { type, userId: "u1", auditLogId: "audit_1" },
      { client: writeClient, prefClient: noPrefs },
    );
    check(`${type}: bell row created`, res.status === "created" && rows.length === 1);
    check(`${type}: audit soft ref persisted`, rows[0]?.data.auditLogId === "audit_1");
    check(`${type}: CRITICAL priority from the registry`, rows[0]?.data.priority === "CRITICAL");
    check(`${type}: no notification email (security-alert flow owns email)`, deliveries.length === 0);
  }

  // ── W2-3. Behavior through the chokepoint ─────────────────────────────────
  console.log("Wave 2 behavior");
  {
    // Defaults: SPACES in-app on, email off → row, no delivery.
    const { writeClient, rows, deliveries } = makeStore({ u_removed: "u@example.com" });
    const input = buildMemberRemovedInput("space_1", "u_removed", "u_admin", "Hogan Family");
    const res = await createNotification(input!, { client: writeClient, prefClient: prefsWith([]) });
    check("chokepoint creates the row from a builder input", res.status === "created" && rows.length === 1);
    check("registry drives category/priority", rows[0]?.data.category === "SPACES" && rows[0]?.data.priority === "NORMAL");
    check("no dedupe key (SPACES dedupe=none)", rows[0]?.data.dedupeKey === null);
    check("no email by default for membership events", deliveries.length === 0);
  }
  {
    // Preference enforcement: SPACES in-app off → skipped, no row.
    const { writeClient, rows } = makeStore({ u_t: "u@example.com" });
    const input = buildRoleChangedInput(
      "space_1",
      { targetUserId: "u_t", oldRole: "MEMBER", newRole: "ADMIN" },
      "u_owner",
      "S",
    );
    const res = await createNotification(input!, {
      client: writeClient,
      prefClient: prefsWith([{ category: "SPACES", channel: "IN_APP", enabled: false }]),
    });
    check("SPACES in-app override suppresses membership pings", res.status === "skipped" && rows.length === 0);
  }

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
        // No DIRECT Notification / email / AuditLog WRITES — everything flows via
        // the chokepoint. (Passing an auditLogId VALUE to createNotification is the
        // sanctioned link mechanism, so guard the write `auditLog.create`, not the
        // substring "auditLog".)
        !helper.includes(".notification.create") && !helper.includes("sendEmail") && !helper.includes("auditLog.create"),
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
    "SYNC_COMPLETED WIRED (D2 reopened): produced by notifyItemSyncComplete on full-pipeline finish, IN_APP + suppress-while-open",
    NOTIFICATION_REGISTRY.SYNC_COMPLETED.status === "WIRED" &&
      NOTIFICATION_REGISTRY.SYNC_COMPLETED.defaultChannels.length === 1 &&
      NOTIFICATION_REGISTRY.SYNC_COMPLETED.defaultChannels[0] === "IN_APP" &&
      NOTIFICATION_REGISTRY.SYNC_COMPLETED.dedupe === "suppress",
  );
  check(
    "drift ruling: DUPLICATE_DETECTED stays VOCABULARY (no PENDING substrate exists)",
    NOTIFICATION_REGISTRY.DUPLICATE_DETECTED.status === "VOCABULARY",
  );
  // W2 — GOAL_RISK removed from this list with its registry entry (Goals
  // retired; the partial registry simply no longer carries the type).
  for (const wave4 of ["DAILY_BRIEF_READY", "OPPORTUNITY_FOUND", "UNUSUAL_SPENDING", "DEBT_ALERT",
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
