/**
 * lib/notifications/wave1.test.ts  (OPS-3 S5 Wave 1)
 *
 * Guards for the account & security producer wave. Standalone tsx script
 * (house pattern): npx tsx lib/notifications/wave1.test.ts — exits 0/1.
 *
 * Two layers, both deterministic and DB-free:
 *   1. SOURCE-SCAN (the run-tests "source-scan tests" idiom): every Wave 1
 *      site calls createNotification() with its registry type, links
 *      auditLogId, and never writes Notification rows directly or duplicates
 *      email logic. This pins the producer inventory — a site can't silently
 *      lose its wiring or gain a bypass.
 *   2. BEHAVIOR (injected fakes): the locked ACCOUNT_SECURITY semantics the
 *      wave depends on — bell cannot be muted, notification email never ships
 *      (the OPS-2 security-alert flow owns email), auditLogId persisted.
 */

import { readFileSync } from "node:fs";
import {
  createNotification,
  type NotificationWriteClient,
} from "@/lib/notifications/create";
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

// Environment tolerance (see create.test.ts): the shared PrismaClient's
// background engine warm-up floating-rejects on platform-mismatched sandboxes.
// Nothing here uses Prisma — all clients are injected.
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") {
    return;
  }
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

// ── 1. Source-scan: every Wave 1 producer site ───────────────────────────────

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

// Wave discipline: 1b and later waves are NOT wired.
for (const deferred of ["EMAIL_VERIFIED", "RECOVERY_CODE_USED", "RECOVERY_CODES_REGENERATED", "TWO_FACTOR_RESET",
                        "SPACE_INVITE_ACCEPTED", "MEMBER_REMOVED", "MEMBER_ROLE_CHANGED", "SYNC_FAILED",
                        "DUPLICATE_DETECTED", "IMPORT_COMPLETED"] as const) {
  check(`${deferred} remains VOCABULARY (later wave, not started)`,
    NOTIFICATION_REGISTRY[deferred].status === "VOCABULARY");
}

// ── 2. Behavior: the locked semantics Wave 1 rides on ───────────────────────

function makeClient() {
  const rows: { data: Record<string, unknown> }[] = [];
  const deliveries: unknown[] = [];
  const client: NotificationWriteClient = {
    user: { async findUnique() { return { email: "u1@example.com" }; } },
    notificationDelivery: { async create({ data }) { deliveries.push(data); return { id: "d" }; } },
    notification: {
      async create({ data }) { rows.push({ data: data as never }); return { id: `n${rows.length}` }; },
      async findUnique() { return null; },
      async update() { return { id: "x" }; },
    },
  };
  return { client, rows, deliveries };
}
const noPrefs: PreferenceClient = {
  notificationPreference: {
    async findMany() { return []; },
    async upsert() { throw new Error("unused"); },
  },
};

async function run(): Promise<void> {
  console.log("Wave 1 behavior (locked ACCOUNT_SECURITY)");
  for (const type of ["PASSWORD_CHANGED", "TWO_FACTOR_DISABLED", "DATA_EXPORTED"] as const) {
    const { client, rows, deliveries } = makeClient();
    const res = await createNotification(
      { type, userId: "u1", auditLogId: "audit_1" },
      { client, prefClient: noPrefs },
    );
    check(`${type}: bell row created`, res.status === "created" && rows.length === 1);
    check(`${type}: audit soft ref persisted`, rows[0]?.data.auditLogId === "audit_1");
    check(`${type}: CRITICAL priority from the registry`, rows[0]?.data.priority === "CRITICAL");
    check(`${type}: no notification email (security-alert flow owns email)`, deliveries.length === 0);
  }

  if (failures > 0) {
    console.error(`\nwave1 tests: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nwave1 tests: all passed");
  process.exit(0);
}

run().catch((err) => {
  console.error("wave1 tests: unexpected error", err);
  process.exit(1);
});
