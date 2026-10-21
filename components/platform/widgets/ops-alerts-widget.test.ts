/**
 * components/platform/widgets/ops-alerts-widget.test.ts  (OBS-003 / UI-011)
 *
 * The Alerts surface renders the LATEST evaluation's delivery outcome — an
 * undelivered breach is loud, an accepted one says "accepted by provider" (never
 * "delivered"), and the retired "no write lever yet" copy is gone.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/ops-alerts-widget.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { PlatformAlertsResponse } from "@/app/api/platform/platform-ops/alerts/route";
import type { AlertLatestEvaluation } from "@/lib/alerts/latest-evaluation";
import { ALERTS_FOOTNOTE, AlertsSurface, deliveryWord } from "./OpsAlertsWidget";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = "2026-10-21T12:00:00.000Z";
function latest(over: Partial<AlertLatestEvaluation>): AlertLatestEvaluation {
  return {
    evaluatedAtISO: NOW, deliveryStatus: "none", undelivered: null, destinationConfigured: true,
    counts: { evaluated: 8, live: 7, enabled: 7, firing: 0, delivered: 0, suppressed: 0 },
    rules: [{ id: "resource-stale", kind: "resource-stale", enabled: true, live: true, firing: false, breaches: 0, severity: null }],
    ...over,
  };
}
function response(l: AlertLatestEvaluation | null, destinationConfigured = true): PlatformAlertsResponse {
  return {
    destinationConfigured, lastEvaluatedAt: l?.evaluatedAtISO ?? null,
    rules: [{ id: "resource-stale", kind: "resource-stale", title: "Resource stale", description: "d", authority: "resource-freshness", live: true, enabled: true, lastTriggeredAtISO: null, lastSeverity: null }],
    history: [], historyRuns: 0, latest: l,
  };
}
const render = (r: PlatformAlertsResponse) => renderToStaticMarkup(createElement(AlertsSurface, { data: r }));

console.log("1. the runtime fixture — captured in memory, one critical due (OBS-003)");
{
  const html = render(response(latest({ deliveryStatus: "skipped", undelivered: { reason: "NO_EMAIL_TRANSPORT", breaches: 1 }, counts: { evaluated: 8, live: 7, enabled: 7, firing: 1, delivered: 0, suppressed: 0 } })));
  check("the delivery line is an alert", /role="alert"/.test(html));
  check("it says Undelivered", /Undelivered/.test(html));
  check("it names the cause (no RESEND_API_KEY) and the count", /1 breach NOT delivered/.test(html) && /RESEND_API_KEY/.test(html));
  check("Recent fires is empty AND the surface does not read as quiet", /No fires recorded/.test(html) && /NOT delivered/.test(html));
}

console.log("2. accepted by the provider is never called delivered");
{
  const w = deliveryWord(latest({ deliveryStatus: "sent", counts: { evaluated: 8, live: 7, enabled: 7, firing: 2, delivered: 2, suppressed: 0 } }));
  check("word: Accepted by provider", w.word === "Accepted by provider" && w.tone === "ok");
  check("detail says acceptance ≠ delivery", /not observed/.test(w.detail) && !/\bdelivered\b/.test(w.detail.replace(/not observed/, "")));
  const html = render(response(latest({ deliveryStatus: "sent" })));
  check("rendered without role=alert", !/role="alert"/.test(html) && /Accepted by provider/.test(html));
}

console.log("3. every status has a word; never-evaluated is muted, not quiet");
{
  check("none", deliveryWord(latest({})).word === "Nothing to send");
  check("captured (dev)", deliveryWord(latest({ deliveryStatus: "captured" })).tone === "warn");
  check("error", deliveryWord(latest({ deliveryStatus: "error" })).tone === "bad");
  check("skipped without a reason is still bad", deliveryWord(latest({ deliveryStatus: "skipped" })).tone === "bad");
  const never = deliveryWord(null);
  check("never evaluated", never.word === "Never evaluated" && never.tone === "muted");
  check("every undelivered reason words differently", new Set((["NO_EMAIL_TRANSPORT", "NO_DESTINATION", "SEND_ERROR", "LEDGER_WRITE_FAILED"] as const).map((reason) => deliveryWord(latest({ undelivered: { reason, breaches: 1 } })).detail)).size === 4);
}

console.log("4. UI-011 copy");
{
  const src = readFileSync("components/platform/widgets/OpsAlertsWidget.tsx", "utf8");
  check("the retired 'no write lever … yet' sentence is gone", !/no write lever on this surface yet/.test(src) && !/read-only\)/.test(src));
  check("the footnote points at the AI Cost Controls panel for the spend rules", /AI Cost Controls panel/.test(ALERTS_FOOTNOTE));
  const html = render(response(latest({}), false));
  check("an unconfigured destination is worded, not blanked", /not configured — deliveries have nowhere to go/.test(html));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
