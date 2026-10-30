/**
 * lib/platform/security/analytics-core.test.ts  (Platform Spaces 2.0 — Security)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/security/analytics-core.test.ts
 */

import { buildSecurityAnalytics, type SecurityAnalyticsFacts } from "./analytics-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const NOW = new Date("2026-11-20T15:00:00.000Z");
const base = (over: Partial<SecurityAnalyticsFacts> = {}): SecurityAnalyticsFacts => ({
  signIns: [], failures: [], failureHours: [], anomalies: [], refusals: [], operatorByResult: [], operatorByAction: [],
  twoFactor: { customers: { enrolled: 1, total: 8 }, operators: { enrolled: 2, total: 2 }, admins: { enrolled: 1, total: 1 }, enforcement: { allUsers: false, systemAdmins: true, operators: true } },
  activeSessions: 5, floor: false, ...over,
});

console.log("1. day series — credential vs blocked, denials vs detector windows");
{
  const r = buildSecurityAnalytics(base({
    signIns: [{ day: "2026-11-19", key: null, count: 4 }],
    failures: [
      { day: "2026-11-19", key: "invalid_password", count: 3 },
      { day: "2026-11-19", key: "email_unverified", count: 2 },
      { day: "2026-11-19", key: null, count: 1 },
      { day: "2026-01-01", key: "invalid_password", count: 99 },
    ],
    anomalies: [{ day: "2026-11-19", key: "platform_access_denied", count: 2 }, { day: "2026-11-19", key: "failed_login_ip", count: 1 }],
    refusals: [{ day: "2026-11-20", key: null, count: 1 }],
  }), NOW, 30);
  const d = r.days.find((x) => x.day === "2026-11-19")!;
  check("30 UTC days ending today", r.days.length === 30 && r.to === "2026-11-20");
  check("credential guesses and blocked sign-ins are split by the anomalies authority", d.failedCredential === 3 && d.failedBlocked === 3, d);
  check("an access denial is not a detector trip", d.accessDenials === 2 && d.detectorTrips === 1);
  check("rows outside the window are ignored", r.failureReasons.find((x) => x.reason === "invalid_password")?.count === 3);
  check("reasons are labelled in words, ranked, with their kind", r.failureReasons[0].label === "Wrong password" && r.failureReasons[0].kind === "credential");
  check("detector types exclude access denials and are labelled", r.detectorTypes.length === 1 && r.detectorTypes[0].label === "Repeated failures from one network");
  check("refused CONTROL changes land on their day", r.days[29].controlRefusals === 1);
}

console.log("2. operators — result split; a pre-envelope row counts as done");
{
  const r = buildSecurityAnalytics(base({
    operatorByResult: [{ day: "2026-11-20", key: "SUCCESS", count: 2 }, { day: "2026-11-20", key: "REFUSED", count: 1 }, { day: "2026-11-20", key: null, count: 1 }, { day: "2026-11-20", key: "FAILURE", count: 1 }],
    operatorByAction: [{ key: "BETA_ACCESS_APPROVED", count: 1 }, { key: "PLATFORM_JOB_RUN", count: 4 }],
  }), NOW, 30);
  const d = r.operators.days[29];
  check("success / failure / refused", d.success === 3 && d.failure === 1 && d.refused === 1 && r.operators.total === 5);
  check("top actions ranked and labelled", r.operators.topActions[0].action === "PLATFORM_JOB_RUN" && r.operators.topActions[0].label === "Platform job run");
}

console.log("3. time of week + declared unavailable signals");
{
  const r = buildSecurityAnalytics(base({ failureHours: [{ dow: 0, hour: 9, count: 2 }, { dow: 9, hour: 9, count: 5 }] }), NOW, 90);
  check("Monday 09 UTC; an out-of-range row is dropped", r.failedByHour[0][9] === 2 && r.failedByHour.flat().reduce((a, b) => a + b, 0) === 2);
  check("lockouts, rate-limited attempts and verified incidents are declared not recorded", r.unavailable.length === 3 && r.unavailable.some((u) => /lockout/i.test(u)) && r.unavailable.some((u) => /incident/i.test(u)));
  check("90-day window", r.days.length === 90);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
