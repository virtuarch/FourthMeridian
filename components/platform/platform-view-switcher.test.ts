/**
 * components/platform/platform-view-switcher.test.ts
 *
 * The workspace VIEW switcher at narrow widths (P3, Preview 375px): the
 * Economics strip (Overview · AI & Costs · Providers · Entitlements) overflowed
 * by 42px and hid "Entitlements". Below sm the segments tighten their
 * horizontal padding so all four fit; lg+ is unchanged.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/platform-view-switcher.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlatformViewSwitcher, PLATFORM_VIEW_SWITCHER_CLASS } from "./PlatformSpaceDashboard";
import { getPlatformWorkspaceComposition } from "@/lib/platform/workspaces";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const economics = getPlatformWorkspaceComposition("PLATFORM_OPS", "platform-economics");
const views = economics?.views ?? [];
check("Economics declares its four views", views.map((v) => v.label).join("|") === "Overview|AI & Costs|Providers|Entitlements", views.map((v) => v.label).join("|"));

const html = renderToStaticMarkup(createElement(PlatformViewSwitcher, {
  views, activeView: "overview", onSelect: () => {}, workspaceLabel: "Economics",
}));

check("renders one tablist named for the workspace", (html.match(/role="tablist"/g) ?? []).length === 1 && html.includes('aria-label="Economics views"'));
check("renders all four tabs", (html.match(/role="tab"/g) ?? []).length === 4);
for (const label of ["Overview", "AI &amp; Costs", "Providers", "Entitlements"]) {
  check(`tab "${label}" is rendered`, html.includes(`>${label}</button>`));
}
check("narrow-width padding class is on the track", PLATFORM_VIEW_SWITCHER_CLASS.split(" ").includes("max-sm:[&>button]:px-2.5") && html.includes("max-sm:[&amp;&gt;button]:px-2.5"));
check("touch-target class is kept below lg", PLATFORM_VIEW_SWITCHER_CLASS.split(" ").includes("max-lg:[&>button]:min-h-11"));
check("desktop padding is untouched (segments keep px-4)", html.includes(" px-4 "));

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nplatform-view-switcher: all checks passed");
