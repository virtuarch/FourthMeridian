/**
 * components/ui/personal-nav-baseline.test.ts  (P-1 — separate Platform navigation shell)
 *
 * PROOF, not assumption, that the Platform shell change leaves the PERSONAL
 * context byte-identical. The baseline (personal-nav-baseline.json) was written
 * from develop 5f383d3 (plus the verbatim BottomNavBar extraction) BEFORE any P-1 edit (UPDATE_PERSONAL_NAV_BASELINE=1), and
 * every render below must still hash to it:
 *   - GlobalMode (the desktop sidebar outside a Space) at personal routes
 *   - SpaceMode inside a PERSONAL Space
 *   - BottomNavBar (the mobile bar, pathname-driven) at personal routes
 * GlobalActions mounts router-bound children (UserMenu, NotificationBell), so it
 * cannot render outside the app router; its personal identity is proven in
 * platform-nav-shell.test.ts (a pure context predicate + the source shape).
 * The baseline was captured after a verbatim, behaviour-identical extraction of
 * BottomNav's JSX into BottomNavBar (its own commit), before any P-1 edit.
 * A change here means Personal navigation changed: re-baselining needs a
 * reason in the commit and a Personal-nav review (Claude 1 / owner).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GlobalMode, SpaceMode } from "@/components/ui/ContextualNavbar";
import { BottomNavBar } from "@/components/ui/BottomNav";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const BASELINE = path.join(process.cwd(), "components/ui/personal-nav-baseline.json");
const sha = (html: string) => createHash("sha256").update(html).digest("hex");

function safeRender(el: Parameters<typeof renderToStaticMarkup>[0]): string {
  try { return renderToStaticMarkup(el); } catch (e) { return `RENDER-ERROR:${e instanceof Error ? e.message : String(e)}`; }
}

const PERSONAL_PATHS = ["/dashboard", "/dashboard/spaces", "/dashboard/brief", "/dashboard/analyze", "/dashboard/connections", "/dashboard/settings/account"];

const renders: Record<string, string> = {};
for (const p of PERSONAL_PATHS) {
  renders[`GlobalMode ${p}`] = safeRender(createElement(GlobalMode, { pathname: p, pendingInvites: 0 }));
  renders[`GlobalMode ${p} (2 invites)`] = safeRender(createElement(GlobalMode, { pathname: p, pendingInvites: 2 }));
}
renders["SpaceMode personal Space /dashboard"] = safeRender(createElement(SpaceMode, {
  pathname: "/dashboard", pendingInvites: 0,
  space: { identity: { name: "Household", subtitle: "Shared · 3 members", shared: true }, onManage: () => {}, onLeaveSpace: () => {} },
  currencyControl: null,
  workspaceNav: {
    items: [
      { id: "networth", label: "Net Worth", href: "/dashboard?tab=overview" },
      { id: "cashFlow", label: "Cash Flow", href: "/dashboard?tab=overview&perspective=cash-flow" },
    ],
    activeId: "networth",
    onSelect: () => {},
  },
  sections: [{ label: "Summary", anchor: "debt-summary" }],
  activeSection: "Summary",
  onSelectSection: () => {},
} as never));
for (const p of PERSONAL_PATHS) renders[`BottomNavBar ${p}`] = safeRender(createElement(BottomNavBar, { pathname: p }));

const current = Object.fromEntries(Object.entries(renders).map(([k, v]) => [k, sha(v)]));

if (process.env.UPDATE_PERSONAL_NAV_BASELINE === "1" || !existsSync(BASELINE)) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 1) + "\n");
  console.log(`  (wrote ${path.relative(process.cwd(), BASELINE)})`);
}
const pins = JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, string>;

console.log("personal navigation is byte-identical to the pre-P-1 baseline");
check("every baseline render is still produced", Object.keys(pins).every((k) => k in current), Object.keys(pins).filter((k) => !(k in current)).join(", "));
for (const [k, h] of Object.entries(current)) {
  check(`${k}: unchanged`, pins[k] === h, renders[k].slice(0, 160));
}
check("no render threw (the baseline is real markup, not an error string)", Object.values(renders).every((h) => !h.startsWith("RENDER-ERROR")),
  Object.entries(renders).filter(([, h]) => h.startsWith("RENDER-ERROR")).map(([k, h]) => `${k}: ${h}`).join(" | "));

if (failures > 0) {
  console.error(`\npersonal-nav-baseline: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\npersonal-nav-baseline: all checks passed.");
