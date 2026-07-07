/**
 * lib/notifications/registry.test.ts  (OPS-3 S0)
 *
 * Pure guards for the notification registry. Standalone tsx script (house
 * pattern):
 *
 *     npx tsx lib/notifications/registry.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network, no side effects — the
 * registry is pure config and these tests keep it lawful:
 *   1. exhaustiveness / structural integrity (key === id, valid vocab values)
 *   2. grammar (F2: DOMAIN_OBJECT_EVENT SCREAMING_SNAKE, ≥ 2 segments)
 *   3. locked-category rules (F11: ACCOUNT_SECURITY locked, email on,
 *      CRITICAL; lock uniform per category)
 *   4. dedupe consistency (F3: template iff strategy ≠ none; templates
 *      reference declared contract keys or userId)
 *   5. every entry declares a metadata pointer contract (F6)
 *   6. retention sanity + render totality (title present even for {} data)
 *   7. S0 state: every entry is VOCABULARY (no producer exists yet)
 */

import {
  DEFAULT_RETENTION,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_REGISTRY,
  NOTIFICATION_TYPE_IDS,
  getNotificationDefinition,
  isNotificationType,
} from "@/lib/notifications/registry";
import type { NotificationTypeDefinition } from "@/lib/notifications/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const entries: [string, NotificationTypeDefinition][] =
  Object.entries(NOTIFICATION_REGISTRY);

console.log("notification registry (OPS-3 S0)");

// ── 1. Exhaustiveness / structural integrity ─────────────────────────────────

check("registry is non-empty", entries.length > 0);
check(
  "NOTIFICATION_TYPE_IDS matches the registry keys exactly",
  NOTIFICATION_TYPE_IDS.length === entries.length &&
    NOTIFICATION_TYPE_IDS.every((id) => id in NOTIFICATION_REGISTRY),
);

const VALID_CATEGORIES = new Set([
  "ACCOUNT_SECURITY", "SPACES", "FINANCIAL", "AI", "PLATFORM", "DIGEST",
]);
const VALID_CHANNELS = new Set(["IN_APP", "EMAIL", "PUSH", "SMS", "WEBHOOK"]);
const VALID_PRIORITIES = new Set(NOTIFICATION_PRIORITIES);
const VALID_DEDUPE = new Set(["none", "suppress", "refresh"]);

for (const [key, e] of entries) {
  check(`${key}: id equals its registry key`, e.id === key, `id="${e.id}"`);
  check(`${key}: valid category`, VALID_CATEGORIES.has(e.category), e.category);
  check(`${key}: valid priority`, VALID_PRIORITIES.has(e.priority), e.priority);
  check(
    `${key}: valid channels`,
    e.defaultChannels.every((c) => VALID_CHANNELS.has(c)),
    e.defaultChannels.join(","),
  );
  check(`${key}: valid dedupe strategy`, VALID_DEDUPE.has(e.dedupe), e.dedupe);
  check(`${key}: has an icon key`, typeof e.icon === "string" && e.icon.length > 0);
}

// Seeded coverage: the frozen plan's inventory anchors (one per category).
for (const mustExist of [
  "PASSWORD_CHANGED",        // ACCOUNT_SECURITY (Wave 1)
  "SPACE_INVITE_RECEIVED",   // SPACES (S1 first producer)
  "SYNC_FAILED",             // FINANCIAL (Wave 3)
  "DAILY_BRIEF_READY",       // AI (v2.6b vocabulary)
  "MAINTENANCE_SCHEDULED",   // PLATFORM
  "DIGEST_SENT",             // DIGEST (F13)
]) {
  check(`seeded: ${mustExist} exists`, isNotificationType(mustExist));
}
check(
  "ACCOUNT_DELETED is deliberately absent (post-purge bypass — no User row)",
  !isNotificationType("ACCOUNT_DELETED"),
);
check(
  "every category vocabulary value is represented in the registry",
  NOTIFICATION_CATEGORIES.length === VALID_CATEGORIES.size,
  NOTIFICATION_CATEGORIES.join(","),
);

// ── 2. Grammar (F2 — PO1 P0: DOMAIN_OBJECT_EVENT SCREAMING_SNAKE) ────────────

const GRAMMAR = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;
for (const [key] of entries) {
  check(`${key}: SCREAMING_SNAKE with ≥ 2 segments`, GRAMMAR.test(key));
}

// ── 3. Locked-category rules (F11) ───────────────────────────────────────────

for (const [key, e] of entries) {
  if (e.category === "ACCOUNT_SECURITY") {
    check(`${key}: ACCOUNT_SECURITY is locked`, e.locked === true);
    // S5 amendment: security types are IN_APP-only in the notification system —
    // the EMAIL guarantee lives in the OPS-2 security-alert flow (unconditional,
    // outside this system). Routing email here too would double-email events.
    check(
      `${key}: locked type is in-app only (email guarantee = security-alert flow)`,
      e.defaultChannels.includes("IN_APP") && !e.defaultChannels.includes("EMAIL"),
    );
    check(`${key}: ACCOUNT_SECURITY is CRITICAL`, e.priority === "CRITICAL");
  } else {
    check(`${key}: only ACCOUNT_SECURITY is locked`, e.locked === false);
  }
}
// Lock uniformity per category (the preference matrix is per category).
const lockByCategory = new Map<string, Set<boolean>>();
for (const [, e] of entries) {
  const s = lockByCategory.get(e.category) ?? new Set<boolean>();
  s.add(e.locked);
  lockByCategory.set(e.category, s);
}
for (const [cat, locks] of lockByCategory) {
  check(`category ${cat}: locked is uniform`, locks.size === 1);
}

// ── 4. Dedupe consistency (F3) ───────────────────────────────────────────────

for (const [key, e] of entries) {
  if (e.dedupe === "none") {
    check(`${key}: no key template when dedupe=none`, e.dedupeKeyTemplate === null);
  } else {
    check(
      `${key}: key template present when dedupe=${e.dedupe}`,
      typeof e.dedupeKeyTemplate === "string" && e.dedupeKeyTemplate.length > 0,
    );
    // Template placeholders must be declared contract keys (or userId, which
    // every notification carries as a column).
    const placeholders = [...(e.dedupeKeyTemplate ?? "").matchAll(/\{([^}]+)\}/g)]
      .map((m) => m[1]);
    check(
      `${key}: template placeholders are contract keys or userId`,
      placeholders.every((p) => p === "userId" || e.pointerContract.includes(p)),
      placeholders.join(","),
    );
    check(
      `${key}: condition key carries an :open-style resolution suffix`,
      (e.dedupeKeyTemplate ?? "").endsWith(":open"),
    );
  }
}

// ── 5. Pointer contracts (F6) ────────────────────────────────────────────────

for (const [key, e] of entries) {
  check(
    `${key}: declares a metadata pointer contract (array, possibly empty)`,
    Array.isArray(e.pointerContract) &&
      e.pointerContract.every((k) => typeof k === "string" && k.length > 0),
  );
}

// ── 6. Retention sanity + render totality ────────────────────────────────────

check(
  "default retention is 30/90 (F9)",
  DEFAULT_RETENTION.autoArchiveDays === 30 && DEFAULT_RETENTION.deleteDays === 90,
);
for (const [key, e] of entries) {
  check(
    `${key}: retention sane (0 < autoArchive ≤ delete)`,
    e.retention.autoArchiveDays > 0 &&
      e.retention.deleteDays >= e.retention.autoArchiveDays,
  );
  // Render must be total: non-empty title even with no data (pure, no I/O).
  let rendered: { title: string } | null = null;
  try {
    rendered = e.render({});
  } catch {
    rendered = null;
  }
  check(
    `${key}: render({}) yields a non-empty title without throwing`,
    rendered !== null && typeof rendered.title === "string" && rendered.title.length > 0,
  );
}

// ── 7. Slice state — which types have a wired producer ───────────────────────
// Grows one id per producer slice (S1: the invite producer; S5 waves follow).

const WIRED = new Set<string>([
  "SPACE_INVITE_RECEIVED", // OPS-3 S1 — EV-1 handler on MemberInvited
  // OPS-3 S5 Wave 1 — account & security, inline beside audit + security-alert:
  "PASSWORD_CHANGED",
  "PASSWORD_RESET",
  "EMAIL_CHANGE_REQUESTED",
  "EMAIL_CHANGE_COMPLETED",
  "TWO_FACTOR_ENABLED",
  "TWO_FACTOR_DISABLED",
  "SESSION_REVOKED",
  "ACCOUNT_DEACTIVATED",
  "ACCOUNT_REACTIVATED",
  "ACCOUNT_DELETION_REQUESTED",
  "ACCOUNT_DELETION_CANCELLED",
  "DATA_EXPORTED",
]);
for (const [key, e] of entries) {
  if (WIRED.has(key)) {
    check(`${key}: status is WIRED (producer landed)`, e.status === "WIRED");
  } else {
    check(`${key}: status is VOCABULARY (no producer yet)`, e.status === "VOCABULARY");
  }
}

// ── Helper behavior ──────────────────────────────────────────────────────────

check("isNotificationType rejects unknown ids", !isNotificationType("NOT_A_REAL_TYPE"));
check(
  "getNotificationDefinition returns undefined for unknown ids",
  getNotificationDefinition("NOT_A_REAL_TYPE") === undefined,
);
check(
  "getNotificationDefinition resolves a known id",
  getNotificationDefinition("SYNC_FAILED")?.dedupe === "suppress",
);

// ── Summary ──────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\nregistry tests: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nregistry tests: all passed");
process.exit(0);
