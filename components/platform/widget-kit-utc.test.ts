/**
 * components/platform/widget-kit-utc.test.ts  (UI-009)
 *
 * Platform widgets compute relative ages once and never tick, so an open tab
 * says "3m" for hours. The shared kit now states the ABSOLUTE UTC instant:
 *   1. fmtUtc — pure, second precision, explicit "UTC", "—" on bad input
 *   2. PlatformWidgetCard renders "Checked <UTC>" from a payload checkedAt, and
 *      renders NO stamp during SSR without one (the mount instant is client-only,
 *      so server and client markup agree)
 *   3. UtcStamp / AgeWithUtc render a <time dateTime> beside the relative age
 *   4. useWidgetFetch exposes fetchedAt; Growth + CS pass their load instant
 *
 *   npx tsx components/platform/widget-kit-utc.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Activity } from "lucide-react";
import { AgeWithUtc, PlatformWidgetCard, UtcStamp, fmtUtc } from "./widget-kit";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

const ISO = "2026-10-22T14:03:12.345Z";

console.log("1. fmtUtc");
check("absolute, second precision, says UTC", fmtUtc(ISO) === "2026-10-22 14:03:12 UTC", fmtUtc(ISO));
check("offset input is normalised to UTC", fmtUtc("2026-10-22T16:03:12+02:00") === "2026-10-22 14:03:12 UTC");
check("null / garbage ⇒ —", fmtUtc(null) === "—" && fmtUtc("nope") === "—");

console.log("2. PlatformWidgetCard");
{
  const withChecked = renderToStaticMarkup(createElement(PlatformWidgetCard, { label: "Scheduler", icon: Activity, checkedAt: ISO, children: "body" }));
  check("payload checkedAt ⇒ 'Checked <UTC>' in the header", withChecked.includes("Checked") && withChecked.includes("2026-10-22 14:03:12 UTC"));
  check("rendered as <time dateTime>", withChecked.includes(`<time dateTime="${ISO}">`));
  const ssr = renderToStaticMarkup(createElement(PlatformWidgetCard, { label: "Scheduler", icon: Activity, children: "body" }));
  check("no checkedAt during SSR ⇒ no stamp (no hydration mismatch)", !ssr.includes("data-utc-stamp"));
  const src = read("components/platform/widget-kit.tsx");
  check("mount instant is set client-side after mount (rAF in an effect)", /requestAnimationFrame\(\(\) => setMountedAt\(new Date\(\)\.toISOString\(\)\)\)/.test(src));
  check("mount-instant stamp is labelled 'Loaded', payload stamp 'Checked'", src.includes('label={checkedAt ? "Checked" : "Loaded"}'));
}

console.log("3. UtcStamp / AgeWithUtc");
{
  const stamp = renderToStaticMarkup(createElement(UtcStamp, { iso: ISO, label: "Synced" }));
  check("UtcStamp: label + absolute", stamp.includes("Synced") && stamp.includes("2026-10-22 14:03:12 UTC"));
  check("UtcStamp: nothing for a bad instant", renderToStaticMarkup(createElement(UtcStamp, { iso: "x" })) === "");
  const age = renderToStaticMarkup(createElement(AgeWithUtc, { iso: ISO }));
  check("AgeWithUtc: relative age AND absolute instant together", / ago /.test(age) && age.includes("2026-10-22 14:03:12 UTC"));
}

console.log("4. Producers");
{
  const kit = read("components/platform/widget-kit.tsx");
  check("useWidgetFetch returns fetchedAt", kit.includes("return { data, loading, error, fetchedAt };") && kit.includes("setFetchedAt(new Date().toISOString())"));
  const g = read("components/platform/widgets/GrowthBetaRequestsWidget.tsx");
  check("Growth passes its load instant to the card", g.includes("checkedAt={loadedAt}") && g.includes("setLoadedAt(new Date().toISOString())"));
  const cs = read("components/platform/widgets/CsCustomersWidget.tsx");
  check("CS passes its list load instant and shows the detail checkedAt", cs.includes("checkedAt={loadedAt}") && cs.includes("fmtUtc(detail.checkedAt)"));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll UI-009 checks passed.");
