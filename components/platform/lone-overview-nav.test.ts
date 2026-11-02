/**
 * components/platform/lone-overview-nav.test.ts  (PB-3, owner addendum 2026-11-01)
 *
 * Platform Spaces show workspace navigation only where there is more than one
 * destination: no single-pill "Overview" rail (<lg) and no single-row sidebar
 * list (lg+). Multi-workspace areas keep both; customer Spaces keep their rail;
 * routing and deep links are untouched.
 *
 *   npx tsx components/platform/lone-overview-nav.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { getPlatformAreaWorkspaces } from "@/lib/platform/workspaces";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const code = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const DASH = code("components/platform/PlatformSpaceDashboard.tsx");
const SHELL = code("components/space/shell/SpaceShell.tsx");

console.log("which areas are single-destination today");
check("Growth & Revenue and Merchant Ops compose exactly one workspace (Overview)",
  getPlatformAreaWorkspaces("GROWTH_REVENUE").length === 1 && getPlatformAreaWorkspaces("MERCHANT_OPS").length === 1);
check("Platform Ops, Security Ops and Customer Success compose several",
  (["PLATFORM_OPS", "SECURITY_OPS", "CUSTOMER_SUCCESS"] as const).every((a) => getPlatformAreaWorkspaces(a).length > 1));

console.log("the rule is the operator's REACHABLE workspaces, not the area");
check("multiWorkspace = available.length > 1 (the contract's per-operator projection)", /const multiWorkspace = available\.length > 1;/.test(DASH));
check("sidebar: the workspace list is published only when there are several (null otherwise)",
  /publishWorkspaceNav\(multiWorkspace \? \{ items: workspaceItems, activeId: openWorkspaceId, onSelect: setActiveTab \} : null\);/.test(DASH));
check("…and still cleared on unmount", /useEffect\(\(\) => \(\) => publishWorkspaceNav\(null\), \[publishWorkspaceNav\]\);/.test(DASH));
check("rail: the platform shell opts into hideLoneRail", /railVisibility="belowLg"\s*hideLoneRail/.test(DASH));
check("SpaceShell: a lone rail hides for utility OR hideLoneRail; a customer Space frame always keeps its rail",
  /const showRail = isUtility \|\| hideLoneRail \? railOptions\.length > 1 : true;/.test(SHELL) && /hideLoneRail = false,/.test(SHELL));

console.log("nothing else moves");
check("the Overview hero still opens the default view", /active\.workspaceId === "platform-overview" && isDefaultView && !activeViewDef\?\.lead/.test(DASH));
check("the in-workspace view switcher is untouched (views are not workspaces)", /active\.views && active\.views\.length > 1 && activeViewDef && active\.viewControl !== "drilldown"/.test(DASH));
check("the deep-link hrefs are still built for every workspace", /href: platformWorkspaceHref\(area, w\.key\)/.test(DASH));
check("the section anchors (what's inside) still publish regardless", /publishSections\(chromeSections\);/.test(DASH));

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
