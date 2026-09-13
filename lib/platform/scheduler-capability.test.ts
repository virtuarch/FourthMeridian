/**
 * lib/platform/scheduler-capability.test.ts  (PLATFORM OPS POLICIES — Slice 1)
 *
 * ONE AUTHORITY FOR "CAN THE DEPLOYED SCHEDULER HONOUR THIS CADENCE?"
 *
 *   npx tsx lib/platform/scheduler-capability.test.ts
 *
 * Expectations are LITERALS pinned from the deployed schedule — never read back
 * from the module under test. The 8h row is the correction this slice ships:
 * the old floor rule accepted it, and 6-hourly slots deliver it as 12h.
 */

import { readFileSync } from "node:fs";
import { assessCadence, honourableCadences, schedulerCanHonour } from "./refresh-policy.core";
import { cadenceIsHonourable, schedulerCapabilities, schedulerCapability } from "./scheduler-capability";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("1. the pure rule: a cadence is honourable iff it is a whole multiple of the attempt period");
{
  check("6h on 6-hourly attempts → honourable", assessCadence("6h", 6).honourable);
  check("12h on 6-hourly attempts → honourable", assessCadence("12h", 6).honourable);
  check("24h on 6-hourly attempts → honourable", assessCadence("24h", 6).honourable);
  const four = assessCadence("4h", 6, "wallet");
  check("4h on 6-hourly attempts → not honourable, effective 6h",
    !four.honourable && four.effectiveHours === 6 && /every 6 hours/.test(four.reason ?? ""), four.reason ?? "");
  const eight = assessCadence("8h", 6, "wallet");
  check("8h on 6-hourly attempts → NOT honourable (the correction): effective execution would be 12 hours",
    !eight.honourable && eight.effectiveHours === 12 && /12 hours/.test(eight.reason ?? ""), eight.reason ?? "");
  check("24h on daily attempts → honourable; 12h is not", assessCadence("24h", 24).honourable && !assessCadence("12h", 24).honourable);
  const none = assessCadence("6h", null);
  check("no attempt period → nothing is honourable, with a reason", !none.honourable && /No scheduled job/.test(none.reason ?? ""));
  check("honourableCadences(6) is exactly 6h, 12h, 24h", honourableCadences(6).join(",") === "6h,12h,24h");
  check("honourableCadences(24) is exactly 24h", honourableCadences(24).join(",") === "24h");
  check("schedulerCanHonour agrees with assessCadence", schedulerCanHonour("12h", 6) && !schedulerCanHonour("8h", 6));
}

console.log("\n2. the deployed capability, from the real registry (literal expectations)");
{
  const caps = schedulerCapabilities();
  check("WALLET: attempted every 6 hours at 00:00, 06:00, 12:00, 18:00 UTC",
    caps.WALLET.attemptPeriodHours === 6 && caps.WALLET.attemptSlotsUTC.join(",") === "00:00,06:00,12:00,18:00");
  check("WALLET: honourable cadences are 6h, 12h, 24h", caps.WALLET.honourable.join(",") === "6h,12h,24h");
  check("WALLET: 4h and 8h are unsupported, each with a reason",
    caps.WALLET.options.filter((o) => !o.honourable).map((o) => o.cadence).join(",") === "4h,8h"
      && caps.WALLET.options.filter((o) => !o.honourable).every((o) => !!o.reason));
  check("WALLET: the continuation is named but never an opportunity",
    caps.WALLET.primaryJobs.join() === "sync-crypto" && caps.WALLET.continuationJobs.join() === "sync-crypto-continuation");
  check("BANK: attempted every 24 hours at 06:00 UTC",
    caps.BANK.attemptPeriodHours === 24 && caps.BANK.attemptSlotsUTC.join(",") === "06:00");
  check("BANK: honourable cadence is 24h only", caps.BANK.honourable.join(",") === "24h");
  check("BANK: 4h, 6h, 8h, 12h are unsupported",
    caps.BANK.options.filter((o) => !o.honourable).map((o) => o.cadence).join(",") === "4h,6h,8h,12h");
  check("cadenceIsHonourable is the same answer as the capability's options",
    cadenceIsHonourable("WALLET", "8h").honourable === false && cadenceIsHonourable("WALLET", "12h").honourable === true
      && cadenceIsHonourable("BANK", "24h").honourable === true);
  check("the menu is complete (every cadence assessed)", schedulerCapability("WALLET").options.length === 5);
}

console.log("\n3. no second list of honourable cadences exists");
{
  const code = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  const suspects = [
    "app/api/platform/platform-ops/policies/route.ts",
    "components/platform/widgets/OpsPoliciesWidget.tsx",
    "components/platform/widgets/policies-view.ts",
    "lib/platform/policies/refresh-policies.core.ts",
    "lib/platform/policies/refresh-policies.ts",
    "lib/platform-settings.ts",
  ];
  const listed = suspects.filter((p) => /\[\s*["']6h["']\s*,\s*["']12h["']/.test(code(p)) || /SCHEDULER_FLOOR_HOURS/.test(code(p)));
  check("no route, widget, read model or descriptor hardcodes the honourable set or a floor", listed.length === 0, listed.join(", "));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
