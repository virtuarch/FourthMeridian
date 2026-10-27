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
import { PlatformAreaPulse, PULSE_AREAS, TREND_DAYS, severitySegments, trailingPoints } from "./PlatformAreaPulse";

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
  const days = Array.from({ length: 20 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, "0")}`, n: i }));
  const pts = trailingPoints(days, (d) => d.n, "bad");
  check(`trend = the trailing ${TREND_DAYS} UTC days, ascending, value + tone carried`,
    pts.length === TREND_DAYS && pts[0].key === "2026-10-07" && pts[TREND_DAYS - 1].key === "2026-10-20" && pts.every((p) => p.tone === "bad") && pts[0].value === 6);
  check("a short series stays short (no padded days); no series ⇒ no points", trailingPoints(days.slice(0, 3), (d) => d.n).length === 3 && trailingPoints(undefined, () => 0).length === 0);
  check("a null value stays a GAP, never zero", trailingPoints([{ day: "2026-10-01" }], () => null)[0].value === null);
}

console.log("one existing route per area, under the area's own grant");
{
  const urls = [...src.matchAll(/useWidgetFetch<[\s\S]*?>\("([^"]+)"\)/g)].map((m) => m[1]);
  check("exactly five static reads", urls.length === 5 && (src.match(/useWidgetFetch</g) ?? []).length === 5, urls.join(","));
  const expected: Record<string, string> = {
    "/api/platform/platform-ops/attention": "platform-ops",
    "/api/platform/platform-ops/refresh/daily": "platform-ops",
    "/api/platform/customer-success/sync-issues": "customer-success",
    "/api/platform/growth-revenue/product-analytics": "growth-revenue",
    "/api/platform/security-ops/anomalies": "security-ops",
  };
  check("each read is one of the declared existing routes", urls.every((u) => u in expected) && new Set(urls).size === 5);
  // Each pulse component reads only its OWN area's routes.
  const blocks: Record<string, string> = { OpsPulse: "platform-ops", CustomersPulse: "customer-success", GrowthPulse: "growth-revenue", SecurityPulse: "security-ops" };
  for (const [fn, area] of Object.entries(blocks)) {
    const body = src.slice(src.indexOf(`function ${fn}(`), src.indexOf("\nfunction ", src.indexOf(`function ${fn}(`) + 1) > 0 ? src.indexOf("\nfunction ", src.indexOf(`function ${fn}(`) + 1) : undefined);
    const reads = [...body.matchAll(/useWidgetFetch<[\s\S]*?>\("([^"]+)"\)/g)].map((m) => m[1]);
    check(`${fn} reads only /api/platform/${area}/*`, reads.length > 0 && reads.every((u) => u.startsWith(`/api/platform/${area}/`)), reads.join(","));
  }
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
