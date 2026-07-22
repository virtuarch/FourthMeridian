/**
 * scripts/set-platform-setting.ts
 *
 * Set a PlatformSetting from the command line — the operator path when the admin
 * console isn't reachable (e.g. no SYSTEM_ADMIN session yet).
 *
 *   npx tsx scripts/set-platform-setting.ts                                  # show current values
 *   npx tsx scripts/set-platform-setting.ts --key registration_mode --value invite_only
 *   npx tsx scripts/set-platform-setting.ts --key registration_mode --value invite_only --apply
 *
 * ── Why this validates instead of just writing ──────────────────────────────
 * getRegistrationMode() falls back to "open" for ANY unrecognized value:
 *
 *     return REGISTRATION_MODES.includes(raw) ? raw : "open";
 *
 * So `invite-only` (hyphen) or `inviteOnly` or a stray space does not fail — it
 * silently leaves registration WIDE OPEN, which is the opposite of what someone
 * running this command intends. getProductStatus() has the same shape, falling
 * back to "beta".
 *
 * Values are therefore checked against the exported constants themselves
 * (REGISTRATION_MODES / PRODUCT_STATUSES), not a copy — a new mode added to the
 * enum is accepted here automatically, and a typo can never be written.
 *
 * Dry run by default. After --apply it READS THE VALUE BACK and resolves it
 * through the same getters the app uses, so the output shows what the running
 * application will actually see rather than what we hoped we wrote.
 */

import { db } from "@/lib/db";
import {
  PlatformSettingKey,
  REGISTRATION_MODES,
  PRODUCT_STATUSES,
  getRegistrationMode,
  getProductStatus,
  type PlatformSettingKeyType,
} from "@/lib/platform-settings";

/** Only keys with a closed value set are settable here — no free-text writes. */
const ALLOWED: Record<string, readonly string[]> = {
  [PlatformSettingKey.REGISTRATION_MODE]: REGISTRATION_MODES,
  [PlatformSettingKey.PRODUCT_STATUS]:    PRODUCT_STATUSES,
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function showCurrent(): Promise<void> {
  const [mode, status] = await Promise.all([getRegistrationMode(), getProductStatus()]);
  const rows = await db.platformSetting.findMany({
    where:  { key: { in: Object.keys(ALLOWED) } },
    select: { key: true, value: true, updatedAt: true },
  });
  const stored = new Map(rows.map((r) => [r.key, r]));

  console.log("\n  Effective (what the app reads):");
  console.log(`    registration_mode  ${mode}`);
  console.log(`    product_status     ${status}`);
  console.log("\n  Stored rows:");
  for (const key of Object.keys(ALLOWED)) {
    const row = stored.get(key);
    console.log(
      row
        ? `    ${key.padEnd(18)} "${row.value}"  (updated ${row.updatedAt.toISOString()})`
        : `    ${key.padEnd(18)} — no row; the app is using its DEFAULT`,
    );
  }
  console.log("");
}

async function main(): Promise<void> {
  const key   = arg("key");
  const value = arg("value");
  const apply = process.argv.includes("--apply");

  if (!key || !value) {
    await showCurrent();
    console.log("  Usage: --key <key> --value <value> [--apply]");
    console.log(`  Settable keys: ${Object.keys(ALLOWED).join(", ")}`);
    for (const [k, v] of Object.entries(ALLOWED)) console.log(`    ${k}: ${v.join(" | ")}`);
    console.log("");
    return;
  }

  const allowedValues = ALLOWED[key];
  if (!allowedValues) {
    console.error(`\n  ✗ "${key}" is not settable here. Allowed: ${Object.keys(ALLOWED).join(", ")}\n`);
    process.exit(1);
  }
  if (!allowedValues.includes(value)) {
    // The whole point of this script — an unrecognized value would be accepted by
    // the database and then silently read back as the permissive default.
    console.error(`\n  ✗ "${value}" is not a valid ${key}.`);
    console.error(`    Valid: ${allowedValues.join(" | ")}`);
    console.error(`    Writing it anyway would fall back to the DEFAULT at read time.\n`);
    process.exit(1);
  }

  await showCurrent();

  if (!apply) {
    console.log(`  → would set ${key} = "${value}"`);
    console.log("  Re-run with --apply to write it.\n");
    return;
  }

  await db.platformSetting.upsert({
    where:  { key: key as PlatformSettingKeyType },
    create: { key, value },
    update: { value },
  });
  console.log(`  ✓ wrote ${key} = "${value}"`);

  // Read back THROUGH the app's own getters — the only proof that the running
  // application will see this value rather than a fallback.
  await showCurrent();
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
