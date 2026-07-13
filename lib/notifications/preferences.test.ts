/**
 * lib/notifications/preferences.test.ts  (OPS-3 S3)
 *
 * Pure guards for the preference layer. Standalone tsx script (house
 * pattern): npx tsx lib/notifications/preferences.test.ts — exits 0/1.
 *
 * NO LIVE DATABASE: the PreferenceClient injection seam is exercised with an
 * in-memory fake. Covers: default-by-absence resolution · locked
 * ACCOUNT_SECURITY · overrides (category/channel enable + disable) · matrix
 * shape · setPreference validation (unknown category/channel, locked
 * rejection, upsert create-then-update) · per-type outliers (SYNC_COMPLETED
 * off-by-default, invite email-on-by-default) · API source-scan.
 */

import { readFileSync } from "node:fs";
import {
  PREFERENCE_CATEGORIES,
  PREFERENCE_CHANNELS,
  categoryDefault,
  getPreferenceMatrix,
  isChannelEnabledForUser,
  isLockedCategory,
  resolveChannelEnabled,
  setNotificationPreference,
  type PreferenceClient,
  type PreferenceOverride,
} from "@/lib/notifications/preferences";
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

// ── In-memory fake honoring the (userId, category, channel) unique ───────────

interface FakeRow extends PreferenceOverride {
  userId: string;
}

function makeFakeClient(seed: FakeRow[] = []) {
  const rows: FakeRow[] = [...seed];
  const client: PreferenceClient = {
    notificationPreference: {
      async findMany({ where }) {
        return rows
          .filter((r) => r.userId === where.userId)
          .map(({ category, channel, enabled }) => ({ category, channel, enabled }));
      },
      async upsert({ where, create, update }) {
        const k = where.userId_category_channel;
        const existing = rows.find(
          (r) => r.userId === k.userId && r.category === k.category && r.channel === k.channel,
        );
        if (existing) {
          existing.enabled = update.enabled;
          return { id: "existing" };
        }
        rows.push({ ...create });
        return { id: "created" };
      },
    },
  };
  return { client, rows };
}

async function run(): Promise<void> {
  console.log("notification preferences (OPS-3 S3)");

  // ── Vocabulary surface ──────────────────────────────────────────────────────
  check(
    "matrix categories exclude DIGEST (doctrine: frequency setting, not a row)",
    !PREFERENCE_CATEGORIES.includes("DIGEST") && PREFERENCE_CATEGORIES.length === 5,
    PREFERENCE_CATEGORIES.join(","),
  );
  check(
    "preference channels are the OPS-3 pair only",
    PREFERENCE_CHANNELS.join(",") === "IN_APP,EMAIL",
  );
  check("ACCOUNT_SECURITY is the locked category", isLockedCategory("ACCOUNT_SECURITY"));
  check(
    "no other matrix category is locked",
    PREFERENCE_CATEGORIES.filter(isLockedCategory).join(",") === "ACCOUNT_SECURITY",
  );

  // ── Pure resolution: default-by-absence ─────────────────────────────────────
  const invite = NOTIFICATION_REGISTRY.SPACE_INVITE_RECEIVED;
  const syncFailed = NOTIFICATION_REGISTRY.SYNC_FAILED;
  const syncCompleted = NOTIFICATION_REGISTRY.SYNC_COMPLETED;
  const password = NOTIFICATION_REGISTRY.PASSWORD_CHANGED;

  check("no rows → registry default (invite in-app ON)", resolveChannelEnabled(invite, "IN_APP", []));
  check("no rows → registry default (invite email ON — the per-type outlier)", resolveChannelEnabled(invite, "EMAIL", []));
  check(
    "no rows → SYNC_COMPLETED IN_APP default-ON (D2 reopened), EMAIL still OFF",
    resolveChannelEnabled(syncCompleted, "IN_APP", []) && !resolveChannelEnabled(syncCompleted, "EMAIL", []),
  );

  // ── Pure resolution: overrides win ──────────────────────────────────────────
  const offSpacesInApp: PreferenceOverride[] = [{ category: "SPACES", channel: "IN_APP", enabled: false }];
  check("override row wins over the default (disable)", !resolveChannelEnabled(invite, "IN_APP", offSpacesInApp));
  check(
    "override is channel-scoped (email untouched by the in-app row)",
    resolveChannelEnabled(invite, "EMAIL", offSpacesInApp),
  );
  const onFinancialEmail: PreferenceOverride[] = [{ category: "FINANCIAL", channel: "EMAIL", enabled: true }];
  check(
    "override can also enable beyond a default",
    resolveChannelEnabled(syncCompleted, "EMAIL", []) === false &&
      // SYNC_COMPLETED rides the FINANCIAL category row like its siblings:
      resolveChannelEnabled(syncCompleted, "EMAIL", onFinancialEmail) === true,
  );
  check(
    "category override applies to every type in the category",
    !resolveChannelEnabled(syncFailed, "IN_APP", [{ category: "FINANCIAL", channel: "IN_APP", enabled: false }]),
  );

  // ── Pure resolution: locked = registry defaults authoritative (S5) ─────────
  // Overrides are IGNORED in both directions: hostile disables can't mute the
  // bell, and hostile enables can't switch on the notification email (the
  // security EMAIL guarantee lives in the OPS-2 security-alert flow).
  const hostileOff: PreferenceOverride[] = [
    { category: "ACCOUNT_SECURITY", channel: "IN_APP", enabled: false },
    { category: "ACCOUNT_SECURITY", channel: "EMAIL", enabled: false },
  ];
  const hostileOn: PreferenceOverride[] = [
    { category: "ACCOUNT_SECURITY", channel: "EMAIL", enabled: true },
  ];
  check(
    "locked: in-app stays ON against hostile disable rows",
    resolveChannelEnabled(password, "IN_APP", hostileOff),
  );
  check(
    "locked: notification email stays OFF (default) — even against enable rows",
    !resolveChannelEnabled(password, "EMAIL", hostileOff) &&
      !resolveChannelEnabled(password, "EMAIL", hostileOn),
  );

  // ── Matrix ──────────────────────────────────────────────────────────────────
  {
    const { client } = makeFakeClient([
      { userId: "u1", category: "SPACES", channel: "IN_APP", enabled: false },
    ]);
    const matrix = await getPreferenceMatrix("u1", { client });
    check("matrix has one row per non-DIGEST category", matrix.length === PREFERENCE_CATEGORIES.length);
    const security = matrix.find((r) => r.category === "ACCOUNT_SECURITY");
    check(
      "matrix: locked row shows the authoritative defaults (in-app on, email off)",
      security?.locked === true && security.channels.IN_APP && !security.channels.EMAIL,
    );
    const spaces = matrix.find((r) => r.category === "SPACES");
    check(
      "matrix: override reflected (SPACES in-app off, email still default-on)",
      spaces?.channels.IN_APP === false && spaces.channels.EMAIL === true,
    );
    const platform = matrix.find((r) => r.category === "PLATFORM");
    check(
      "matrix: pure defaults where no rows exist (PLATFORM in-app on, email off)",
      platform?.channels.IN_APP === true && platform.channels.EMAIL === false &&
        categoryDefault("PLATFORM", "EMAIL") === false,
    );
    const foreign = await getPreferenceMatrix("u2", { client });
    check(
      "matrix: another user is unaffected by u1's overrides (default-by-absence)",
      foreign.find((r) => r.category === "SPACES")?.channels.IN_APP === true,
    );
  }

  // ── Per-type effective check (the chokepoint's read) ────────────────────────
  {
    const { client } = makeFakeClient([
      { userId: "u1", category: "FINANCIAL", channel: "IN_APP", enabled: false },
    ]);
    check(
      "isChannelEnabledForUser applies the override",
      (await isChannelEnabledForUser("u1", "SYNC_FAILED", "IN_APP", { client })) === false,
    );
    check(
      "isChannelEnabledForUser: locked types resolve from registry defaults, no read",
      (await isChannelEnabledForUser("u1", "PASSWORD_CHANGED", "IN_APP", { client })) === true &&
        (await isChannelEnabledForUser("u1", "PASSWORD_CHANGED", "EMAIL", { client })) === false,
    );
  }

  // ── Writes ──────────────────────────────────────────────────────────────────
  {
    const { client, rows } = makeFakeClient();
    const r1 = await setNotificationPreference("u1", "SPACES", "IN_APP", false, { client });
    check("setPreference upserts an override row", r1.ok && rows.length === 1 && rows[0].enabled === false);
    const r2 = await setNotificationPreference("u1", "SPACES", "IN_APP", true, { client });
    check("second write updates in place (unique respected)", r2.ok && rows.length === 1 && rows[0].enabled === true);

    const locked = await setNotificationPreference("u1", "ACCOUNT_SECURITY", "EMAIL", false, { client });
    check("locked category write rejected", !locked.ok);
    check("locked rejection leaves no row behind", rows.length === 1);

    const badCat = await setNotificationPreference("u1", "NOT_A_CATEGORY", "IN_APP", false, { client });
    check("unknown category rejected", !badCat.ok);
    const badCh = await setNotificationPreference("u1", "SPACES", "CARRIER_PIGEON", false, { client });
    check("unknown channel rejected", !badCh.ok);
    const digest = await setNotificationPreference("u1", "DIGEST", "EMAIL", false, { client });
    check("DIGEST rejected from the matrix surface", !digest.ok);
  }

  // ── API source-scan ─────────────────────────────────────────────────────────
  {
    const src = readFileSync("app/api/user/notification-preferences/route.ts", "utf8");
    check(
      "preference API goes only through lib/notifications/preferences",
      src.includes("@/lib/notifications/preferences") && !src.includes('from "@/lib/db"'),
    );
    const page = readFileSync("app/(shell)/dashboard/settings/page.tsx", "utf8");
    check(
      "settings directory gained the Notifications line",
      page.includes("/dashboard/settings/notifications"),
    );
  }

  if (failures > 0) {
    console.error(`\npreference tests: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\npreference tests: all passed");
  process.exit(0);
}

run().catch((err) => {
  console.error("preference tests: unexpected error", err);
  process.exit(1);
});
