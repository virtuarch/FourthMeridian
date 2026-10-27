/**
 * components/platform/platform-area-pulse.test.ts  (Platform redesign §4.1)
 *
 * The cross-area Overview pulse: one existing route per area, under the
 * viewer's own grant; no cross-area authority; honest first frame.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlatformAreaPulse, PULSE_AREAS, severitySegments } from "./PlatformAreaPulse";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const src = readFileSync(path.join(ROOT, "components/platform/PlatformAreaPulse.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("pure segments");
{
  const segs = severitySegments({ critical: 1, error: 0, warning: 3, info: 2 });
  check("zero segments dropped, severity order kept, word beside every count",
    segs.map((s) => `${s.word}:${s.count}`).join(",") === "critical:1,warning:3,info:2");
  check("tones come from the severity vocabulary (critical/error bad, warning warn, info muted)",
    segs.map((s) => s.tone).join(",") === "bad,warn,muted");
  check("absent counts ⇒ no segments (never an invented zero bar)", severitySegments(null).length === 0);
}

console.log("one existing route per area, under the area's own grant");
{
  const urls = [...src.matchAll(/useWidgetFetch<[\s\S]*?>\("([^"]+)"\)/g)].map((m) => m[1]);
  check("exactly four static reads", urls.length === 4 && (src.match(/useWidgetFetch</g) ?? []).length === 4, urls.join(","));
  const expected: Record<string, string> = {
    "/api/platform/platform-ops/attention": "platform-ops",
    "/api/platform/customer-success/sync-issues": "customer-success",
    "/api/platform/growth-revenue/signups": "growth-revenue",
    "/api/platform/security-ops/anomalies": "security-ops",
  };
  check("each read is one of the declared existing routes", urls.every((u) => u in expected) && new Set(urls).size === 4);
  check("each declared route exists", Object.keys(expected).every((u) => existsSync(path.join(ROOT, "app", u, "route.ts"))));
  check("no new cross-area route was introduced", !existsSync(path.join(ROOT, "app/api/platform/overview")) && !existsSync(path.join(ROOT, "app/api/platform/pulse")));
  check("pulse areas are the four with a count route", PULSE_AREAS.join(",") === "PLATFORM_OPS,CUSTOMER_SUCCESS,GROWTH_REVENUE,SECURITY_OPS");
}

console.log("honest first frame");
{
  for (const area of PULSE_AREAS) {
    const html = renderToStaticMarkup(createElement(PlatformAreaPulse, { area }));
    check(`${area}: first frame is a status, no figure`, /role="status"/.test(html) && !/\d/.test(html.replace(/<[^>]+>/g, "")), html);
  }
  check("MERCHANT_OPS renders nothing (no count route — the card stays a doorway)",
    renderToStaticMarkup(createElement(PlatformAreaPulse, { area: "MERCHANT_OPS" })) === "");
  check("a refusal or failure reads 'Unavailable', never a zero", /Unavailable/.test(src) && !/\?\?\s*0\b[^;]*Fact/.test(src));
  check("no score, no health verdict word", !/\b(healthy|score|all clear|secure)\b/i.test(src.replace(/import[^;]+;/g, "")));
}

if (failures > 0) {
  console.error(`\nplatform-area-pulse: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nplatform-area-pulse: all checks passed.");
