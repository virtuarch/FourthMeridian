/**
 * components/space/compact/compact-assets.test.ts  (COMPACT DASHBOARD — P2)
 *
 *   1. Assets tabs are exactly All · Cash · Investments and ARE the existing slice
 *      (?slice=, replace-written) — the chart series and the content agree;
 *   2. the truth table — v2.7 visual-first: the RENDER RULE at every width (a
 *      section outside the slice is not rendered, not CSS-hidden): All =
 *      composition + what moved; Cash = the Cash section; Investments =
 *      Investments + Real assets as a distinct section;
 *   3. Real assets are never reclassified: their own section/title/component,
 *      not in the Investments figures or chart (the invested series is stocks +
 *      crypto only), and a short label says so;
 *   4. accessible tabs (tablist/tab, aria-selected, roving tabindex, aria-controls,
 *      arrow keys); the desktop slice chips stay the ≥lg slice navigation;
 *   5. the compact hierarchy (hero → Total·Assets·Debt → tabs → content), with
 *      desktop unchanged.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/compact/compact-assets.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assetsCompactVisibility } from "./compact-sections";
import { CompactSectionTabs, compactHidden } from "./CompactSectionTabs";
import { ASSETS_SLICES, ASSETS_SLICE_LABELS, wealthSeriesKey } from "@/lib/wealth/wealth-mode";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const ww = code("components/space/widgets/wealth/WealthWorkspace.tsx");

console.log("1. exactly three tabs, and they are the existing slice");
check("All · Cash · Investments, in that order", ASSETS_SLICES.map((s) => ASSETS_SLICE_LABELS[s]).join(" · ") === "All · Cash · Investments");
check("the tabs are bound to the slice value and the slice handler (replace-written by the host)",
  /<CompactSectionTabs\s+ariaLabel="Assets category"\s+value=\{slice\}\s+onChange=\{\(s\) => onSliceChange\?\.\(s\)\}/.test(ww));
check("the chart follows the tab: cash ⇒ cash series, investments ⇒ invested, all ⇒ total assets",
  wealthSeriesKey("assets", "cash") === "cash" && wealthSeriesKey("assets", "investments") === "invested" && wealthSeriesKey("assets", "all") === "totalAssets");
check("no new series was invented (no real-assets series key)", !/realAssets|real_assets/.test(read("lib/wealth/wealth-mode.ts")));
check("on compact the chart-header slice chips give way to the tabs (max-lg:hidden only)",
  /ariaLabel="Assets series"\s+className="max-lg:hidden"/.test(ww));

console.log("\n2. the truth table");
{
  const t = (s: "all" | "cash" | "investments") => JSON.stringify(assetsCompactVisibility(s));
  // v2.7 visual-first — DELIBERATE: All no longer embeds Cash, Investments or
  // Real assets (owner D-B); each lives on its own slice.
  check("All shows composition + what moved only", t("all") === JSON.stringify({ composition: true, cash: false, investments: false, realAssets: false }));
  check("Cash shows the Cash section only", t("cash") === JSON.stringify({ composition: false, cash: true, investments: false, realAssets: false }));
  check("Investments shows Investments + Real assets", t("investments") === JSON.stringify({ composition: false, cash: false, investments: true, realAssets: true }));
  check("each section is RENDERED by its rule (conditional rendering, no CSS hiding)",
    /\{show\.cash && \(\s*<section id="wealth-cash" className="scroll-mt-20">/.test(ww)
      && /\{show\.investments && \(\s*<section id="wealth-investments" className="scroll-mt-20">/.test(ww)
      && /\{show\.realAssets && \(\s*<section id="wealth-real-assets" className="scroll-mt-20 border-t/.test(ww)
      && /\{\(mode !== "assets" \|\| show\.composition\) && \(/.test(ww)
      && !/compactHidden/.test(ww));
  check("compactHidden itself is unchanged (still a compact-only utility for Debt)", compactHidden(true) === "max-lg:hidden" && compactHidden(false) === "");
}

console.log("\n3. Real assets keep their own identity");
{
  check("their own section, title and component — unchanged",
    /<section id="wealth-real-assets"[\s\S]{0,200}<SectionTitle>Real assets<\/SectionTitle>[\s\S]{0,400}<RealAssetsSection spaceId=\{spaceId\} spaceType=\{spaceType\} active=\{active\} \/>/.test(ww));
  check("the Investments figure/chart is stocks + crypto only (no real assets)", /SpaceSnapshot stocks \+ crypto/.test(read("lib/wealth/invested-label.ts")));
  // v2.7 visual-first — DELIBERATE: the sentence is a short label beside the title, every width.
  check("beside the title, a short label says they are not counted in Investments",
    /<SectionTitle>Real assets<\/SectionTitle>\s*<span className="text-\[11px\] text-\[var\(--text-muted\)\]" data-real-assets-note>Not counted in Investments<\/span>/.test(ww)
      && !/Grouped here for navigation/.test(ww));
  check("RealAssetsSection itself is untouched (no compact or tab logic inside it)", !/compact|slice/i.test(code("components/space/widgets/wealth/RealAssetsSection.tsx")));
}

console.log("\n4. accessible, compact-only tabs");
{
  const html = renderToStaticMarkup(createElement(CompactSectionTabs, {
    ariaLabel: "Assets category", value: "cash", onChange: () => {},
    tabs: [{ id: "all", label: "All", controls: ["a", "b"] }, { id: "cash", label: "Cash", controls: ["a"] }, { id: "investments", label: "Investments", controls: ["b"] }],
  } as never));
  check("compact-only root (lg:hidden), a labelled tablist", /^<div role="tablist" aria-label="Assets category"/.test(html) && /class="lg:hidden grid/.test(html));
  check("tabs with aria-selected, and only the selected one in the Tab order",
    (html.match(/role="tab"/g) ?? []).length === 3 && /aria-selected="true" aria-controls="a" tabindex="0"[^>]*>Cash</.test(html) && (html.match(/tabindex="-1"/g) ?? []).length === 2);
  check("each tab names the sections it reveals (aria-controls)", /aria-controls="a b"/.test(html));
  check("touch-sized segments", /min-h-10/.test(html));
  const src = code("components/space/compact/CompactSectionTabs.tsx");
  check("ArrowLeft/Right and Home/End move and select", ["ArrowRight", "ArrowLeft", "Home", "End"].every((k) => src.includes(`"${k}"`)));
}

console.log("\n5. hierarchy and desktop");
{
  const main = ww.slice(ww.indexOf('<div id="wealth-summary"'));
  check("compact order: hero → Total·Assets·Debt → Assets tabs → chart",
    main.indexOf("<WealthHero") < main.indexOf('modeSelectorVisibility === "belowLg" && modeSelector')
      && main.indexOf('modeSelectorVisibility === "belowLg" && modeSelector') < main.indexOf("{assetsTabs}")
      && main.indexOf("{assetsTabs}") < main.indexOf("<WealthTrendChart"));
  check("a host that shows the mode selector on desktop keeps it above the hero", /\{modeSelectorVisibility !== "belowLg" && modeSelector\}/.test(ww));
  check("the selector being moved is compact-only for this host", /wealthModeSelectorVisibility: "belowLg"/.test(read("components/dashboard/SpaceDashboard.tsx")));
  check("legacy deep links still land: the one-shot section scroll is intact", /document\.getElementById\(`wealth-\$\{focusSection\}`\)\?\.scrollIntoView/.test(ww));
  check("…and a legacy link selects the slice whose section it scrolls to (so the target is rendered)",
    /liquidity:\s+\{ mode: "assets", slice: "cash",\s+focus: "cash" \}/.test(read("lib/wealth/wealth-mode.ts"))
      && /investments: \{ mode: "assets", slice: "investments", focus: "investments" \}/.test(read("lib/wealth/wealth-mode.ts")));
  check("only the selected tab names controlled sections (the others are not in the DOM)", /controls: s !== slice \? \[\]/.test(ww));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
