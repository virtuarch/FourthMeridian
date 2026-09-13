/**
 * lib/platform-settings.test.ts  (PLATFORM OPS POLICIES — Slice 1)
 *
 * THE CANONICAL SETTING AUTHORITY REFUSES MALFORMED WRITES — and the admin
 * security console can no longer write operational policy.
 *
 *   npx tsx lib/platform-settings.test.ts
 *
 * No live database: every refused write throws BEFORE the setter reaches
 * Prisma, and accepted values are checked through the pure validator.
 */

import { readFileSync } from "node:fs";
import {
  PlatformSettingKey, PlatformSettingValidationError, SETTING_DESCRIPTORS,
  isPlatformSettingKey, listSettingDescriptors, setSetting, settingKeysForSurface, validateSetting,
} from "@/lib/platform-settings";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const refused = (key: Parameters<typeof validateSetting>[0], raw: unknown) => {
  const v = validateSetting(key, raw);
  return v.ok ? null : v.reason;
};
const accepted = (key: Parameters<typeof validateSetting>[0], raw: unknown) => {
  const v = validateSetting(key, raw);
  return v.ok ? v.value : null;
};

async function main(): Promise<void> {
  console.log("1. malformed admission facts are refused (an INVALID row would deny all work)");
  {
    check('maintenance_mode "yes" refused', refused("maintenance_mode", "yes") !== null);
    check('maintenance_mode "1" refused', refused("maintenance_mode", "1") !== null);
    check('maintenance_mode "" refused', refused("maintenance_mode", "") !== null);
    check('ingestion_paused "on" refused', refused("ingestion_paused", "on") !== null);
    check('maintenance_mode "TRUE " normalises to "true"', accepted("maintenance_mode", "TRUE ") === "true");
    check('ingestion_paused "false" accepted', accepted("ingestion_paused", "false") === "false");
    let thrown: unknown = null;
    try { await setSetting("maintenance_mode", "yes"); } catch (e) { thrown = e; }
    check("setSetting throws PlatformSettingValidationError before any database call",
      thrown instanceof PlatformSettingValidationError && thrown.key === "maintenance_mode");
  }

  console.log("\n2. refresh cadences: the menu, the parser, and the scheduler-honourability constraint");
  {
    check("wallet 6h accepted", accepted("refresh_cadence_wallet", "6h") === "6h");
    check("wallet ' 12H ' normalises to 12h", accepted("refresh_cadence_wallet", " 12H ") === "12h");
    check("wallet 24h accepted", accepted("refresh_cadence_wallet", "24h") === "24h");
    check("wallet 4h refused (faster than the 6-hourly attempts)", /every 6 hours/.test(refused("refresh_cadence_wallet", "4h") ?? ""));
    check("wallet 8h refused (would execute as 12h)", /12 hours/.test(refused("refresh_cadence_wallet", "8h") ?? ""));
    check("wallet '5h' refused (not in the menu)", /one of/.test(refused("refresh_cadence_wallet", "5h") ?? ""));
    check("wallet 'every 5 minutes' refused", refused("refresh_cadence_wallet", "every 5 minutes") !== null);
    check("bank 24h accepted", accepted("refresh_cadence_bank", "24h") === "24h");
    check("bank 12h refused (banks are attempted daily)", /every 24 hours/.test(refused("refresh_cadence_bank", "12h") ?? ""));
    check("bank 6h refused", refused("refresh_cadence_bank", "6h") !== null);
    let thrown: unknown = null;
    try { await setSetting("refresh_cadence_wallet", "4h"); } catch (e) { thrown = e; }
    check("setSetting refuses an unhonourable cadence with the scheduler's reason",
      thrown instanceof PlatformSettingValidationError && /every 6 hours/.test(thrown.reason));
  }

  console.log("\n3. existing security settings keep working");
  {
    check("require_totp_all_users true/false accepted", accepted("require_totp_all_users", "true") === "true" && accepted("require_totp_all_users", "false") === "false");
    check("require_totp_all_users 'maybe' refused", refused("require_totp_all_users", "maybe") !== null);
    check("recovery_codes_enabled false accepted", accepted("recovery_codes_enabled", "false") === "false");
    check("min_password_length 12 accepted", accepted("min_password_length", "12") === "12");
    check("min_password_length 7 refused (below the floor)", /at least 8/.test(refused("min_password_length", "7") ?? ""));
    check("min_password_length 'ten' refused", refused("min_password_length", "ten") !== null);
    check("registration_mode invite_only accepted", accepted("registration_mode", "invite_only") === "invite_only");
    check("registration_mode 'invite-only' refused (the typo that used to fail open)", refused("registration_mode", "invite-only") !== null);
    check("product_status live accepted", accepted("product_status", "live") === "live");
    check("require_totp_system_admin cannot be disabled", /cannot be disabled/.test(refused("require_totp_system_admin", "false") ?? ""));
    check("require_totp_system_admin true accepted", accepted("require_totp_system_admin", "true") === "true");
    check("a non-string value is refused", refused("min_password_length", 12) !== null);
  }

  console.log("\n4. the descriptor table is complete and classifies every key");
  {
    const keys = Object.values(PlatformSettingKey);
    check("every registered key has a descriptor", keys.every((k) => SETTING_DESCRIPTORS[k]?.key === k));
    check(`the table has exactly the registered keys (${keys.length})`, listSettingDescriptors().length === keys.length);
    check("unregistered keys are not platform setting keys", !isPlatformSettingKey("alert_rule_enabled:job-failing") && isPlatformSettingKey("maintenance_mode"));
    const forbidden = listSettingDescriptors().filter((d) =>
      (d.class === "SECURITY_SENSITIVE" || d.class === "FINANCIAL_SEMANTIC_NOT_EDITABLE") && d.writeSurfaces.includes("PLATFORM_OPS"));
    check("no security-sensitive or financial-semantic key can become a Platform Ops control", forbidden.length === 0, forbidden.map((d) => d.key).join(", "));
    const ops = settingKeysForSurface("PLATFORM_OPS");
    check("Platform Ops owns exactly the operational policies",
      [...ops].sort().join(",") === ["ingestion_paused", "maintenance_mode", "refresh_cadence_bank", "refresh_cadence_wallet"].join(","), ops.join(","));
    check("every Platform Ops key is operator-configurable, resettable, and gated at the reserved capability",
      ops.every((k) => SETTING_DESCRIPTORS[k].operatorConfigurable && SETTING_DESCRIPTORS[k].resettable && SETTING_DESCRIPTORS[k].writeCapability === "CONTROL"));
    check("security keys are not operator-configurable and not resettable",
      settingKeysForSurface("ADMIN_SECURITY").filter((k) => k !== "registration_mode").every((k) => !SETTING_DESCRIPTORS[k].operatorConfigurable && !SETTING_DESCRIPTORS[k].resettable));
    check("admission facts declare absence-means-off; cadences fall back to a default",
      SETTING_DESCRIPTORS.maintenance_mode.missingRow === "ABSENT_MEANS_OFF" && SETTING_DESCRIPTORS.refresh_cadence_wallet.missingRow === "FALLBACK_TO_DEFAULT");
    check("every descriptor carries a label and a description", listSettingDescriptors().every((d) => d.label.length > 0 && d.description.length > 0));
  }

  console.log("\n5. the admin security console is no longer an unrestricted PlatformSetting writer");
  {
    const route = readFileSync("app/api/admin/security/settings/route.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    check("its allow-list is derived from the descriptors' ADMIN_SECURITY surface", /settingKeysForSurface\("ADMIN_SECURITY"\)/.test(route));
    check("it no longer allows every registered key", !/Object\.values\(PlatformSettingKey\)/.test(route));
    check("it validates the whole batch before the first write", route.indexOf("validateSetting(") < route.indexOf("await setSetting("));
    check("it writes only through the canonical setter", !/platformSetting\.(upsert|update|create)/.test(route) && /await setSetting\(/.test(route));
    check("it records what each key held before", /previous:/.test(route));
    check("it still requires FRESH SYSTEM_ADMIN auth", /requireFreshSystemAdmin\(/.test(route));
    const adminKeys = settingKeysForSurface("ADMIN_SECURITY");
    check("the security surface cannot reach operational policy",
      !adminKeys.includes("refresh_cadence_wallet") && !adminKeys.includes("refresh_cadence_bank")
        && !adminKeys.includes("maintenance_mode") && !adminKeys.includes("ingestion_paused") && !adminKeys.includes("product_status"));
    check("the security surface keeps its legitimate keys",
      ["require_totp_system_admin", "require_totp_admins", "require_totp_all_users", "recovery_codes_enabled", "min_password_length", "registration_mode"]
        .every((k) => adminKeys.includes(k as never)));
    const settings = readFileSync("lib/platform-settings.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    check("setSetting validates before it upserts", settings.indexOf("validateSetting(key, value)") < settings.indexOf("platformSetting.upsert"));
    check("reset is a DELETE of the override row, never a write of the default", /deleteSetting[\s\S]*platformSetting\.deleteMany/.test(settings));
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
