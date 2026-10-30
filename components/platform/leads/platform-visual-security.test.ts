/**
 * components/platform/leads/platform-visual-security.test.ts  (Platform Spaces 2.0 — Security)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/leads/platform-visual-security.test.ts
 *
 * Structure and honesty only — visual acceptance is the Preview screenshot review.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SecurityLeadSurface } from "./SecurityLead";
import { coverageRows, securityKpis, totals } from "./security-model";
import { buildSecurityAnalytics } from "@/lib/platform/security/analytics-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const strip = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const NOW = new Date("2026-11-20T15:00:00.000Z");
const S = buildSecurityAnalytics({
  signIns: [{ day: "2026-11-19", key: null, count: 12 }],
  failures: [{ day: "2026-11-19", key: "invalid_password", count: 8 }, { day: "2026-11-18", key: "email_unverified", count: 4 }],
  failureHours: [{ dow: 2, hour: 10, count: 12 }],
  anomalies: [{ day: "2026-11-19", key: "platform_access_denied", count: 1 }],
  refusals: [], operatorByResult: [{ day: "2026-11-20", key: "SUCCESS", count: 3 }], operatorByAction: [{ key: "PLATFORM_JOB_RUN", count: 3 }],
  twoFactor: { customers: { enrolled: 1, total: 8 }, operators: { enrolled: 1, total: 2 }, admins: { enrolled: 1, total: 1 }, enforcement: { allUsers: false, systemAdmins: true, operators: true } },
  activeSessions: 4, floor: false,
}, NOW, 30);
const ok = { data: S, loading: false, error: null };
const failed = { data: null, loading: false, error: "Request failed (500)" };
const render = (f: typeof ok | typeof failed) => renderToStaticMarkup(createElement(SecurityLeadSurface, {
  f, period: "30", onPeriod: () => {}, hasHosted: () => true, onOpenDrawer: () => {}, onOpenWorkspace: () => {},
}));

console.log("1. real analytics, ordered: hero → activity + 2FA → failures → events → operators");
{
  const html = render(ok);
  const at = (s: string) => html.indexOf(s);
  check("order", at("data-health-hero") < at('id="sec-activity"') && at('id="sec-activity"') < at('id="sec-failure-hours"') && at('id="sec-failure-hours"') < at('id="sec-calendar"') && at('id="sec-calendar"') < at('id="sec-operators"'));
  check("charts: day bars, two heat grids, share bars, coverage meters", html.includes("data-day-bars") && (html.match(/data-heat-grid/g) ?? []).length === 2 && html.includes("data-share-bars") && (html.match(/data-coverage=/g) ?? []).length === 3);
  check("hero states failed sign-ins as a count, never a verdict word", html.includes("12 failed sign-ins") && !/Healthy|Secure|Under attack|Breach/i.test(html));
}

console.log("2. honesty — not recorded, not incidents, failed reads");
{
  const html = render(ok);
  check("lockouts, rate-limited attempts and verified incidents are shown as NOT recorded", html.includes("data-not-recorded") && /lockout/i.test(html) && /verified incidents/i.test(html));
  check("detector windows are labelled not incidents", html.includes("not incidents"));
  check("no 'attack' wording anywhere", !/attack/i.test(html));
  check("failed read: unavailable with the reason, KPIs '—'", render(failed).includes("Sign-in activity unavailable — Request failed (500)") && securityKpis(failed).every((k) => k.value === "—"));
}

console.log("3. figures");
{
  const t = totals(S);
  check("credential 8 · blocked 4 · denials 1", t.credential === 8 && t.blocked === 4 && t.denials === 1);
  const rows = coverageRows(S);
  check("operator 2FA 1 of 2 while ENFORCED reads bad (someone cannot enter); customers optional reads neutral",
    rows[0].tone === "bad" && rows[0].enforcement.startsWith("Enforced") && rows[2].enforcement === "Optional");
  check("KPI 2FA reads 'x of y'", securityKpis(ok).find((k) => k.key === "operators2fa")?.value === "1 of 2");
}

console.log("4. lead source rules");
{
  for (const f of ["components/platform/leads/SecurityLead.tsx", "components/platform/leads/security-model.ts", "components/platform/charts/heat-readouts.ts"]) {
    check(`${f}: no CONTROL token / canControl / canWrite / matchMedia / raw fetch`, !/\bCONTROL\b|canControl|canWrite|matchMedia|innerWidth|\bfetch\(/.test(strip(f).replace(/"[^"\n]*"|`[^`]*`/g, "")));
  }
  check("the posture widget is hosted through the registry, not imported", !/SecurityPostureWidget/.test(strip("components/platform/leads/SecurityLead.tsx")));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
