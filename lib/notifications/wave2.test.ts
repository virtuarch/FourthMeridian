/**
 * lib/notifications/wave2.test.ts  (OPS-3 S5 Wave 2)
 *
 * Guards for the Spaces membership producer wave. Standalone tsx script
 * (house pattern): npx tsx lib/notifications/wave2.test.ts — exits 0/1.
 *
 * Layers (deterministic, DB-free):
 *   1. Pure builders — recipient targeting, display-handle convention,
 *      guards (raced invite, self-directed changes).
 *   2. SOURCE-SCAN — the EV-1 registrations in lib/events/emit.ts, the
 *      chokepoint-only rule, and the MemberLeft / ownership rulings.
 *   3. BEHAVIOR (injected fakes) — registry usage, SPACES preference
 *      enforcement, no email by default, dedupe none.
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

// Environment tolerance (see create.test.ts): the shared PrismaClient's
// background engine warm-up floating-rejects on platform-mismatched sandboxes;
// nothing here uses Prisma — all clients are injected.
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") {
    return;
  }
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

// ── 1. Pure builders ──────────────────────────────────────────────────────────

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

// ── 2. Source-scan: wiring + rulings ─────────────────────────────────────────

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

// Registry state: Wave 2 wired; MemberLeft has no type; Wave 3/4 untouched.
for (const wired of ["SPACE_INVITE_ACCEPTED", "MEMBER_REMOVED", "MEMBER_ROLE_CHANGED"] as const) {
  check(`${wired} registry entry is WIRED`, NOTIFICATION_REGISTRY[wired].status === "WIRED");
}
check("MEMBER_LEFT never entered the vocabulary (ruling)", !isNotificationType("MEMBER_LEFT"));
check(
  "SPACE_OWNERSHIP_TRANSFERRED remains VOCABULARY (feature absent)",
  NOTIFICATION_REGISTRY.SPACE_OWNERSHIP_TRANSFERRED.status === "VOCABULARY",
);
// (Wave 3 state is owned by wave3.test.ts; Wave 4 stays with this wave's scan.)
for (const later of ["DAILY_BRIEF_READY", "OPPORTUNITY_FOUND"] as const) {
  check(`${later} remains VOCABULARY (Wave 4 not started)`, NOTIFICATION_REGISTRY[later].status === "VOCABULARY");
}

// ── 3. Behavior through the chokepoint ───────────────────────────────────────

function makeClient() {
  const rows: { data: Record<string, unknown> }[] = [];
  const deliveries: unknown[] = [];
  const client: NotificationWriteClient = {
    user: { async findUnique() { return { email: "u@example.com" }; } },
    notificationDelivery: { async create({ data }) { deliveries.push(data); return { id: "d" }; } },
    notification: {
      async create({ data }) { rows.push({ data: data as never }); return { id: `n${rows.length}` }; },
      async findUnique() { return null; },
      async update() { return { id: "x" }; },
    },
  };
  return { client, rows, deliveries };
}
function prefsWith(rows: { category: string; channel: string; enabled: boolean }[]): PreferenceClient {
  return {
    notificationPreference: {
      async findMany() { return rows; },
      async upsert() { throw new Error("unused"); },
    },
  };
}

async function run(): Promise<void> {
  console.log("Wave 2 behavior");
  {
    // Defaults: SPACES in-app on, email off → row, no delivery.
    const { client, rows, deliveries } = makeClient();
    const input = buildMemberRemovedInput("space_1", "u_removed", "u_admin", "Hogan Family");
    const res = await createNotification(input!, { client, prefClient: prefsWith([]) });
    check("chokepoint creates the row from a builder input", res.status === "created" && rows.length === 1);
    check("registry drives category/priority", rows[0]?.data.category === "SPACES" && rows[0]?.data.priority === "NORMAL");
    check("no dedupe key (SPACES dedupe=none)", rows[0]?.data.dedupeKey === null);
    check("no email by default for membership events", deliveries.length === 0);
  }
  {
    // Preference enforcement: SPACES in-app off → skipped, no row.
    const { client, rows } = makeClient();
    const input = buildRoleChangedInput(
      "space_1",
      { targetUserId: "u_t", oldRole: "MEMBER", newRole: "ADMIN" },
      "u_owner",
      "S",
    );
    const res = await createNotification(input!, {
      client,
      prefClient: prefsWith([{ category: "SPACES", channel: "IN_APP", enabled: false }]),
    });
    check("SPACES in-app override suppresses membership pings", res.status === "skipped" && rows.length === 0);
  }

  if (failures > 0) {
    console.error(`\nwave2 tests: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nwave2 tests: all passed");
  process.exit(0);
}

run().catch((err) => {
  console.error("wave2 tests: unexpected error", err);
  process.exit(1);
});
