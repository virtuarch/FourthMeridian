/**
 * components/platform/widgets/security-posture-denials.test.ts  (OBS-009)
 *
 * The Security posture Detections column carries a reading of recorded
 * platform-access refusals, counted over the anomalies route's newest page and
 * labelled as a floor; a refusal trip renders in the trips group with an opaque
 * key, never an id.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/security-posture-denials.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AnomaliesResponse, AnomalyTrip } from "@/app/api/platform/security-ops/anomalies/route";
import { ACCESS_DENIED_TRIP_TYPE, SecurityPostureSurface, accessDenialsReading, type SecurityPostureSources } from "./SecurityPostureWidget";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const trip = (type: string, over: Partial<AnomalyTrip> = {}): AnomalyTrip => ({
  id: `t-${type}`, type, keyKind: "unknown", keyRef: "…a1b2c3", count: 1, threshold: 1, windowMinutes: 60, at: new Date(NOW - 5 * 60_000).toISOString(), ...over,
});
const anomalies = (trips: AnomalyTrip[]): AnomaliesResponse => ({ trips, summary: { failedLoginsWindow: 0, windowMinutes: 15, tripsLast24h: trips.length } });
const ok = <T,>(data: T) => ({ data, loading: false, error: null });
const pending = { data: null, loading: true, error: null };
const sources = (a: AnomaliesResponse): SecurityPostureSources => ({ anomalies: ok(a), posture: pending, sessions: pending });
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

console.log("1. the reading");
{
  const none = accessDenialsReading([trip("failed_login_ip")]);
  check("no refusal trips → 0, worded as none in the newest page", none.value === "0" && /no refusal/.test(none.qualifier ?? ""));
  const two = accessDenialsReading([trip(ACCESS_DENIED_TRIP_TYPE, { id: "x" }), trip("failed_login_ip"), trip(ACCESS_DENIED_TRIP_TYPE, { id: "y" })]);
  check("counts only platform_access_denied trips", two.value === "2");
  check("labelled as a floor over the newest page, never a total", /newest page/.test(two.label) && /floor/.test(two.qualifier ?? "") && /newest page/.test(two.derivation));
}

console.log("2. rendered in the Detections column, with the trip's opaque key");
{
  const html = renderToStaticMarkup(createElement(SecurityPostureSurface, { sources: sources(anomalies([trip(ACCESS_DENIED_TRIP_TYPE, { keyRef: "…9f9f9f" })])), nowMs: NOW }));
  const t = text(html);
  check("the reading appears", /Platform access refused · newest page 1/.test(t), t.slice(0, 400));
  check("the trip row words the type and shows the opaque digest only", /platform access denied/.test(t) && /…9f9f9f/.test(t) && !/ckuser|platform-denied:/.test(t));
  const empty = text(renderToStaticMarkup(createElement(SecurityPostureSurface, { sources: sources(anomalies([])), nowMs: NOW })));
  check("with no trips the reading is 0, not absent", /Platform access refused · newest page 0/.test(empty));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
