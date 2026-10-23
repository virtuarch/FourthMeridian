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

console.log("1. the pure rule (P1): a cadence is honourable iff it is at or above the source kind's safety floor");
{
  check("6h on a 4h floor → honourable", assessCadence("6h", 4).honourable);
  check("4h on a 4h floor → honourable (at the floor)", assessCadence("4h", 4).honourable);
  check("8h on a 4h floor → honourable (no slot to be a multiple of since the 15-minute wake)", assessCadence("8h", 4).honourable && assessCadence("8h", 4).effectiveHours === 8);
  const four = assessCadence("4h", 6, "bank");
  check("4h on a 6h floor → not honourable, effective = the floor, reason names the floor",
    !four.honourable && four.effectiveHours === 6 && /floor of 6 hours/.test(four.reason ?? ""), four.reason ?? "");
  const none = assessCadence("6h", null);
  check("no floor (no job refreshes the kind) → nothing is honourable, with a reason", !none.honourable && /No scheduled job/.test(none.reason ?? ""));
  check("honourableCadences(4) is the whole menu", honourableCadences(4).join(",") === "4h,6h,8h,12h,24h");
  check("honourableCadences(6) excludes 4h only", honourableCadences(6).join(",") === "6h,8h,12h,24h");
  check("schedulerCanHonour agrees with assessCadence", schedulerCanHonour("12h", 6) && !schedulerCanHonour("4h", 6));
}

console.log("\n2. the deployed capability, from the real registry (literal expectations)");
{
  const caps = schedulerCapabilities();
  check("WALLET: floor 4 hours; the platform is woken every 15 minutes", caps.WALLET.floorHours === 4 && caps.WALLET.wakeEveryMinutes === 15);
  check("WALLET: every menu cadence is honourable", caps.WALLET.honourable.join(",") === "4h,6h,8h,12h,24h");
  check("WALLET: the continuation is named but never an opportunity",
    caps.WALLET.primaryJobs.join() === "sync-crypto" && caps.WALLET.continuationJobs.join() === "sync-crypto-continuation");
  check("BANK: floor 6 hours (Plaid Item-month economics + webhooks between runs)", caps.BANK.floorHours === 6);
  check("BANK: 4h is unsupported with a reason; 6h–24h honourable",
    caps.BANK.honourable.join(",") === "6h,8h,12h,24h" && (caps.BANK.options.find((o) => o.cadence === "4h")?.reason?.includes("floor") ?? false));
  check("cadenceIsHonourable is the same answer as the capability's options",
    cadenceIsHonourable("BANK", "4h").honourable === false && cadenceIsHonourable("WALLET", "4h").honourable === true
      && cadenceIsHonourable("BANK", "24h").honourable === true);
  check("the menu is complete (every cadence assessed)", schedulerCapability("WALLET").options.length === 5);
  check("a kind no job refreshes has no floor and no honourable cadence", schedulerCapability("BANK", []).floorHours === null && schedulerCapability("BANK", []).honourable.length === 0);
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
