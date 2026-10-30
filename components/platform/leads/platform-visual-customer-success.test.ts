/**
 * components/platform/leads/platform-visual-customer-success.test.ts  (Platform Spaces 2.0 — Customer Success)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/leads/platform-visual-customer-success.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CustomerSuccessLeadSurface } from "./CustomerSuccessLead";
import { attentionBars, connectedCount, csKpis } from "./customer-success-model";
import type { CsOverviewResponse } from "@/lib/platform/customer/overview-types";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const strip = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const zero = { HEALTHY: 3, STALE: 1, DEGRADED: 0, NEEDS_REAUTH: 1, ERROR: 0, REVOKED: 0 };
const O: CsOverviewResponse = {
  checkedAt: "2026-11-20T15:00:00.000Z", windowDays: 30, customers: { active: 8, deactivated: 1 },
  stages: [{ key: "registered", label: "Registered", count: 0 }, { key: "verified", label: "Verified", count: 1 }, { key: "firstSession", label: "First session", count: 2 },
    { key: "firstConnection", label: "First connection", count: 3 }, { key: "firstAiTurn", label: "First AI turn", count: 1 }, { key: "firstBriefViewed", label: "First Brief viewed", count: 0 }, { key: "returned", label: "Returned", count: 1 }],
  attention: { customers: 3, reasons: [{ key: "reconnect", label: "A connection needs reconnecting", count: 1 }, { key: "incident", label: "An unresolved sync issue", count: 1 }, { key: "policy", label: "Policy group missing or invalid", count: 0 }, { key: "stalled", label: "Not connected 7+ days after registering", count: 2 }] },
  connections: { total: 5, counts: zero, retired: { revoked: 2, ownerInactive: 0 } },
  incidents: { days: [{ day: "2026-11-20", opened: 1, resolved: 2 }], floor: false, openByKind: [{ kind: "MISSING_ACCOUNT", label: "Missing account", count: 1 }], open: 1 },
  onboarding: { stages: [{ key: "verified", label: "Verified" }, { key: "firstSession", label: "First session" }, { key: "firstConnection", label: "First connection" }, { key: "firstAiTurn", label: "First AI turn" }, { key: "firstBriefViewed", label: "First Brief viewed" }],
    rows: [{ weekStart: "2026-11-16", size: 2, cells: [{ state: "value", num: 2, den: 2 }, { state: "value", num: 1, den: 2 }, { state: "value", num: 0, den: 2 }, { state: "value", num: 0, den: 2 }, { state: "value", num: 0, den: 2 }] }] },
  notes: ["Not available: support tickets (no ticketing system) and customer health scores (no authoritative model)."],
};
const ok = { data: O, loading: false, error: null };
const failed = { data: null, loading: false, error: "Request failed (500)" };
const render = (f: typeof ok | typeof failed) => renderToStaticMarkup(createElement(CustomerSuccessLeadSurface, {
  f, period: "30", onPeriod: () => {}, onOpenWorkspace: () => {}, customerList: createElement("div", null, "CUSTOMER LIST"),
}));

console.log("1. order and charts");
{
  const html = render(ok);
  const at = (s: string) => html.indexOf(s);
  check("hero → needs help → the customer list → onboarding → sync issues", at("data-health-hero") < at('id="cs-attention"') && at('id="cs-attention"') < at("CUSTOMER LIST") && at("CUSTOMER LIST") < at('id="cs-stages"') && at('id="cs-stages"') < at('id="cs-incidents"'));
  check("real charts: share bars, a heat grid, day bars", html.includes("data-share-bars") && html.includes("data-heat-grid") && html.includes("data-day-bars"));
  check("hero says how many need help", html.includes("3 need help"));
}
console.log("2. figures and honesty");
{
  check("connected = through first connection or beyond (3 + 1 + 0 + 1)", connectedCount(O) === 5);
  check("reasons are shares of ACTIVE customers", attentionBars(O)[3].share === 2 / 8);
  check("no support tickets or health score invented", !/ticket/i.test(render(ok).replace(/support tickets \(no ticketing system\)/, "")) && !/health score/i.test(strip("components/platform/leads/CustomerSuccessLead.tsx").replace(/health scores\./, "")));
  check("failed read → '—' KPIs and unavailable", csKpis(failed).every((k) => k.value === "—") && render(failed).includes("unavailable — Request failed (500)"));
}
console.log("3. lead source rules");
{
  for (const f of ["components/platform/leads/CustomerSuccessLead.tsx", "components/platform/leads/customer-success-model.ts"]) {
    check(`${f}: no CONTROL / canControl / canWrite / matchMedia / raw fetch`, !/\bCONTROL\b|canControl|canWrite|matchMedia|innerWidth|\bfetch\(/.test(strip(f)));
  }
  check("the customer list is hosted through the registry, not imported", !/CsCustomersWidget/.test(strip("components/platform/leads/CustomerSuccessLead.tsx")));
}
if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
