/**
 * components/platform/widgets/ops-copy-pins.test.ts  (UI-011)
 *
 * Operator copy that overclaimed or went stale is pinned OUT, and the honest
 * replacement pinned IN.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/ops-copy-pins.test.ts
 */

import { readFileSync } from "node:fs";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const src = (f: string) => readFileSync(f, "utf8");

console.log("UI-011 · stale or overclaiming operator copy");
{
  const alerts = src("components/platform/widgets/OpsAlertsWidget.tsx");
  check("Alerts: 'no write lever … yet' is gone; the AI Cost Controls panel is named", !/no write lever on this surface yet/.test(alerts) && /AI Cost Controls panel/.test(alerts));
  const inv = src("components/platform/widgets/OpsAiInvocationsWidget.tsx");
  check("Invocations: 'a timeout writes no row' is gone; failure rows are acknowledged", !/a timeout writes no row/.test(inv) && /failure rows/.test(inv));
  const brief = src("components/platform/widgets/OpsBriefOpsWidget.tsx");
  check("BriefOps: no 'exact' spend claim; it is an estimate, not a bill", !/Spend \(exact/.test(brief) && !/exact per successful/.test(brief) && /Spend \(estimate, successes\)/.test(brief) && /not a bill/.test(brief));
  const email = src("components/platform/widgets/OpsEmailDeliveryWidget.tsx");
  check("Email: 'All emails delivered' is gone; 'accepted by the provider' is the word", !/All emails delivered/.test(email) && /accepted by the provider/.test(email));
  const api = src("components/platform/widgets/OpsApiUsageWidget.tsx");
  check("ApiUsage: the 7d / 30d labels sit beside their figures", /\{fmt\(p\.calls7d\)\} 7d · \{fmt\(p\.calls30d\)\} 30d calls/.test(api) && !/· 7d \{fmt/.test(api));
  const cost = src("components/platform/widgets/OpsCostWidget.tsx");
  check("Cost: an unknown tier states its provenance, not a permanent 'not observed'", !/"not observed"/.test(cost) && /m\.tier === "unknown" \? m\.provenance/.test(cost));
}

// UI-021 (separate rate-limit bucket for the ai-cost-controls CONTROL route) is
// NOT pinned here: lib/platform/ai/cost-controls.test.ts (Agent D's file) pins
// the route to the shared "platform-policy" bucket, so the change is reported to
// the orchestrator with the exact one-line route edit and the one-line pin edit
// rather than made against a test this slice may not touch.

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
