/**
 * components/platform/widgets/ai-budget.test.ts  (AI COST CONTROLS — budget utilization · Economics)
 *
 * THE "AI BUDGET" SURFACE, RENDERED through its prop-driven surface and the
 * pure view: utilization words and bars, Unavailable on every null (never a
 * fake $0), the unpriced warning, past deliveries never shown as open, opaque
 * refs only (no "@", no full ids), the ESTIMATE_NOT_BILLING footnote. No DB,
 * no network.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/ai-budget.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { AI_BUDGET_URL, ESTIMATE_NOT_BILLING, type AiBudgetUtilization } from "@/lib/platform/ai/cost-controls.types";
import { AiBudgetSurface } from "./OpsAiBudgetWidget";
import { formatUtc } from "./policies-view";
import {
  controlsText, customerRowText, deliveryText, fleetReading, overheadText, pctText, surfaceRowText, thresholdText, unpricedWarning, utilizationFill, utilizationTone,
} from "./ai-budget-view";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = "2026-10-15T12:00:00.000Z";
const section = { id: "s", key: "ops_ai_budget", label: "AI Budget" };

function budget(mutate: (b: AiBudgetUtilization) => void = () => {}): AiBudgetUtilization {
  const b: AiBudgetUtilization = {
    checkedAt: NOW, windowHours: 24,
    fleet: { estimatedUsd: 4.2, thresholdUsd: 10, alertEnabled: true, utilizationPct: 42, invocations: 120, customers: 3 },
    overhead: { estimatedUsd: 1.9, invocations: 372 },
    customers: [
      { ref: "user …abc123", rolling24hUsd: 2.1, todayUsd: 1.2, allowanceUsd: 5, allowanceSource: "POLICY", allowanceUtilizationPct: 24, alertUtilizationPct: 70 },
      { ref: "user …def456", rolling24hUsd: 3.6, todayUsd: 6.5, allowanceUsd: 5, allowanceSource: "PLATFORM_SETTING", allowanceUtilizationPct: 130, alertUtilizationPct: 120 },
    ],
    bySurface: [
      { surface: "chat", customer: true, estimatedUsd: 3.9, invocations: 100, unpricedInvocations: 0 },
      { surface: "brief", customer: true, estimatedUsd: 0.3, invocations: 20, unpricedInvocations: 0 },
      { surface: "harness", customer: false, estimatedUsd: 1.9, invocations: 370, unpricedInvocations: 0 },
      { surface: "other", customer: false, estimatedUsd: null, invocations: 2, unpricedInvocations: 2 },
    ],
    unpriced: { invocations: 2, models: ["OPENAI:gpt-7"] },
    recentAlerts: [
      { at: NOW, severity: "warning", summary: "Customer user …def456 estimated spend $3.60 over 24 h exceeds $3", dedupeKey: "ai-spend-user-high:user:2026-10-15" },
      { at: "2026-10-14T09:00:00.000Z", severity: "critical", summary: "Fleet estimated spend $12.40 over 24 h exceeds $10", dedupeKey: "ai-spend-fleet-high:fleet:2026-10-14" },
    ],
    controls: { allowanceEnforced: true, allowanceDefaultUsd: 5, userAlertEnabled: true, userAlertThresholdUsd: 3, paused: false },
    estimateNote: ESTIMATE_NOT_BILLING,
  };
  mutate(b);
  return b;
}

const render = (b: AiBudgetUtilization) => renderToStaticMarkup(createElement(AiBudgetSurface, { section, data: b }));

console.log("1. the view: utilization words, tones and readings");
{
  check("pctText rounds and names the unknown", pctText(42.4) === "42%" && pctText(130) === "130%" && pctText(null) === "—");
  check("tone: <80 ok · 80–99 warn · ≥100 bad · null muted", utilizationTone(42) === "ok" && utilizationTone(80) === "warn" && utilizationTone(99.9) === "warn" && utilizationTone(100) === "bad" && utilizationTone(null) === "muted");
  check("fill caps at 100 and floors at 0", utilizationFill(130) === 100 && utilizationFill(42) === 42 && utilizationFill(null) === 0 && utilizationFill(-5) === 0);
  const r = fleetReading(budget());
  check("fleet figure with its utilization of the threshold, scope, window and the estimate caption",
    r.kind === "figure" && r.value === "$4.20" && /42% of the \$10 fleet alert threshold/.test(r.qualifier) && /3 customers · 120 invocations · rolling 24 h/.test(r.qualifier) && /estimate, not a bill/.test(r.qualifier));
  const none = fleetReading(budget((b) => { b.fleet = { ...b.fleet, estimatedUsd: null, utilizationPct: null, invocations: 0, customers: 0 }; }));
  check("no customer invocations ⇒ unavailable with THAT reason", none.kind === "unavailable" && none.reason === "no customer invocations in the window");
  const unpriced = fleetReading(budget((b) => { b.fleet = { ...b.fleet, estimatedUsd: null, utilizationPct: null }; }));
  check("invocations but nothing priced ⇒ unavailable with the pricing reason, never $0", unpriced.kind === "unavailable" && /could be priced/.test(unpriced.reason));
  check("threshold line", thresholdText(budget().fleet, 24) === "Threshold $10 / 24 h · alert enabled" && /alert disabled/.test(thresholdText({ thresholdUsd: 10, alertEnabled: false }, 24)));
  check("overhead line names harness/unattributed as never fleet; null is said", /Overhead \$1\.90 \(372 invocations\) — harness and unattributed, never fleet/.test(overheadText(budget().overhead)) && /none priced/.test(overheadText({ estimatedUsd: null, invocations: 4 })) && /none in the window/.test(overheadText({ estimatedUsd: null, invocations: 0 })));
  check("controls line", controlsText(budget().controls, 24) === "Allowance enforced · default $5 per UTC day · per-customer alert enabled at $3 / 24 h");
  const c = customerRowText(budget().customers[1], 3);
  check("customer row: today vs allowance with pct and source; rolling vs alert threshold with pct", c.today === "$6.50 of $5 (130%, platform setting)" && c.rolling === "$3.60 vs $3 (120%)" && c.todayPct === 130);
  const s = surfaceRowText(budget().bySurface[3]);
  check("a surface with no priced figure is unavailable with its reason, its unpriced count named", s.label === "other · overhead" && s.value === null && s.unavailable === "none priced" && /2 invocations · 2 unpriced not counted/.test(s.meta));
  check("unpriced warning names the count and models and refuses $0; null when every invocation priced", /2 unpriced invocations \(OPENAI:gpt-7\)/.test(unpricedWarning(budget().unpriced) ?? "") && /not \$0/.test(unpricedWarning(budget().unpriced) ?? "") && unpricedWarning({ invocations: 0, models: [] }) === null);
  check("delivery text is past tense with the UTC date", deliveryText({ at: NOW }, formatUtc) === "delivered 15 Oct 2026, 12:00 UTC");
}

console.log("\n2. the surface");
{
  const html = render(budget());
  check("one SectionSurface titled by the section, provenance chip with the window and checked time", (html.match(/<section/g) ?? []).length === 1 && /AI Budget/.test(html) && /invocation ledger · rate card/.test(html) && /checked 15 Oct 2026, 12:00 UTC · rolling 24 h/.test(html));
  check("fleet BigStat: $4.20, 42% of the $10 threshold, estimate caption, threshold line", /\$4\.20/.test(html) && /42% of the \$10 fleet alert threshold/.test(html) && /estimate, not a bill/.test(html) && /Threshold \$10 \/ 24 h · alert enabled/.test(html));
  check("the utilization bar is an image whose label states the percentage (word + colour, never colour alone)", /role="img" aria-label="Fleet utilization of the alert threshold: 42%"/.test(html) && /width:42%/.test(html));
  check("state words: Admitting and Enforced", /Admitting/.test(html) && /Enforced/.test(html) && /Allowance enforced · default \$5 per UTC day/.test(html));
  check("customers as opaque refs with both readings and bars", /user …abc123/.test(html) && /\$1\.20 of \$5 \(24%, policy group\)/.test(html) && /\$2\.10 vs \$3 \(70%\)/.test(html) && /aria-label="user …def456 today vs allowance: 130%"/.test(html));
  check("an over-allowance customer reads 130% with a full bar", /130%/.test(html) && /width:100%/.test(html));
  check("by surface: customer vs overhead stated on every row; the unpriced surface is Unavailable with its reason", /chat · customer/.test(html) && /harness · overhead/.test(html) && /other · overhead/.test(html) && /none priced/.test(html) && /2 unpriced not counted/.test(html));
  check("the unpriced warning is an alert and never $0", /role="alert"[^>]*>2 unpriced invocations \(OPENAI:gpt-7\)/.test(html) && !/\$0\.00/.test(html));
  check("recent alerts newest first, labelled as deliveries, severity as a word", html.indexOf("exceeds $3") < html.indexOf("exceeds $10") && /delivered 15 Oct 2026, 12:00 UTC/.test(html) && /delivered 14 Oct 2026, 09:00 UTC/.test(html) && /warning/.test(html) && /critical/.test(html));
  check("deliveries are history, never open", /never an open incident/.test(html) && !/\bopen\b(?! incident)/i.test(html.replace(/never an open incident/g, "")));
  check("the footnote is the ESTIMATE_NOT_BILLING sentence", html.includes(ESTIMATE_NOT_BILLING.replace(/'/g, "&#x27;")) || html.includes(ESTIMATE_NOT_BILLING));
  check("the fleet rule is on the surface (hint)", /harness and unattributed traffic is overhead/.test(html));
  check("identity minimisation: no @, no full id (nothing id-shaped beyond the opaque tails)", !/@/.test(html) && !/[a-z0-9]{20,}/.test(html.replace(/[a-z]+-[a-z-]+/g, "")));
  check("read-only: no button, select, input, form or link", !/<button|<select|<input|<form|<a /.test(html));
  check("no hex colour", !/#[0-9a-f]{6}\b/i.test(html));
}

console.log("\n3. null figures render through Unavailable, never a fake 0; empties are sentences");
{
  const html = render(budget((b) => {
    b.fleet = { estimatedUsd: null, thresholdUsd: 10, alertEnabled: false, utilizationPct: null, invocations: 0, customers: 0 };
    b.overhead = { estimatedUsd: null, invocations: 0 };
    b.customers = []; b.bySurface = []; b.unpriced = { invocations: 0, models: [] }; b.recentAlerts = [];
    b.controls = { ...b.controls, paused: true, allowanceEnforced: false };
  }));
  check("fleet Unavailable with the reason; no $0 anywhere", /no customer invocations in the window/.test(html) && !/\$0/.test(html));
  check("the bar states an unknown reading", /aria-label="Fleet utilization of the alert threshold: —"/.test(html));
  check("Paused and Not enforced as words", />Paused</.test(html) && /Not enforced/.test(html));
  check("empty customers / surfaces / alerts are status sentences", /No customer spend in the window/.test(html) && /No invocations in the window/.test(html) && /No spending alert delivered/.test(html) && (html.match(/role="status"/g) ?? []).length === 3);
  check("no unpriced alert when everything was priced", !/unpriced invocation/.test(html));
}

console.log("\n4. source: the widget reads the one url through the house hook; the view is pure");
{
  const strip = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const w = strip("components/platform/widgets/OpsAiBudgetWidget.tsx");
  check("use client, exactly one SectionSurface, the house hook with the literal ai-budget url, no bare fetch, no router, no hex",
    /^"use client"/.test(readFileSync("components/platform/widgets/OpsAiBudgetWidget.tsx", "utf8")) && (w.match(/<SectionSurface/g) ?? []).length === 1
      && /useWidgetFetch<AiBudgetUtilization>\("\/api\/platform\/platform-ops\/ai-budget"\)/.test(w) && !/fetch\(/.test(w.replace(/useWidgetFetch/g, "")) && !/useRouter|next\/link/.test(w) && !/#[0-9a-f]{3,6}\b/i.test(w));
  check("the footnote is ESTIMATE_NOT_BILLING from the types file; the literal url equals AI_BUDGET_URL", /ESTIMATE_NOT_BILLING/.test(w) && AI_BUDGET_URL === "/api/platform/platform-ops/ai-budget");
  const v = strip("components/platform/widgets/ai-budget-view.ts");
  check("the view-model is pure (no React, no clock, no fetch)", !/from "react"|Date\.now\(\)|new Date\(\)|fetch\(/.test(v));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
