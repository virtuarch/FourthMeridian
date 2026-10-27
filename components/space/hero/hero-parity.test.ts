/**
 * components/space/hero/hero-parity.test.ts  (v2.7 — one header skeleton)
 *
 * Owner: Net Worth, Assets and Debt must feel like ONE page skeleton. Measured on
 * Preview in a past As-Of, the Debt desktop hero was 158px vs 130px: a
 * "Balances are current…" paragraph under the as-of line, and the "Estimated"
 * trust pill (≈22px) in a content-sized label row. On compact, disclosures sat
 * BELOW the card and pushed the page down on one perspective only.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/hero/hero-parity.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { HeroEyebrow, HeroNotes } from "./HeroParts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const code = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

console.log("1. the shared label row has a FIXED height — the trust pill can't grow it");
{
  const bare = renderToStaticMarkup(createElement(HeroEyebrow, { label: "Total debt" }));
  const chip = renderToStaticMarkup(createElement(HeroEyebrow, { label: "Total debt", trust: createElement("span", { className: "px-2 py-0.5" }, "Estimated") }));
  check("fixed h-6 row (with or without a chip)", /class="flex h-6 items-center justify-between gap-3"/.test(bare) && /class="flex h-6 items-center justify-between gap-3"/.test(chip));
  check("the chip still renders (confidence disclosure preserved)", /Estimated/.test(chip));
  check("WealthHero (Net Worth / Assets) uses it", /const eyebrow = <HeroEyebrow label=\{metricLabel\} trust=\{confidenceChip\} \/>;/.test(code("components/space/widgets/wealth/WealthHero.tsx")));
  check("DebtHero uses it", /<HeroEyebrow label="Total debt" trust=\{<TrustIndicator variant="compact" envelope=\{envelope\} \/>\} \/>/.test(code("components/space/widgets/debt/DebtHero.tsx")));
  check("no hero hand-rolls its own label row any more",
    !/<div className="flex items-center justify-between gap-3">\s*<p className="text-\[10px\]/.test(code("components/space/widgets/wealth/WealthHero.tsx") + code("components/space/widgets/debt/DebtHero.tsx")));
}

console.log("\n2. disclosures live under the chart, never in / below the header");
{
  check("CompactHeroCard has no notes slot", !/notes/.test(code("components/space/compact/CompactHeroCard.tsx")));
  check("DebtHero desktop has no extra historical paragraph", !/Balances are current/.test(code("components/space/widgets/debt/DebtHero.tsx")));
  const ww = code("components/space/widgets/wealth/WealthWorkspace.tsx");
  check("Net Worth / Assets: the crypto note is a compact HeroNotes line inside the trend section",
    ww.indexOf('id="wealth-trend"') < ww.indexOf('<HeroNotes notes={[cryptoPriceNote]} className="lg:hidden" />')
      && ww.indexOf('<HeroNotes notes={[cryptoPriceNote]}') < ww.indexOf("<CompactKpiStrip"));
  check("Debt: debtHeroNotes under the balance-history chart", /<HeroNotes notes=\{debtHeroNotes\(\{ historical, asOf, redactions \}\)\} \/>/.test(code("components/space/widgets/debt/DebtWorkspace.tsx")));
  check("HeroNotes renders nothing when there is nothing to say", renderToStaticMarkup(createElement(HeroNotes, { notes: [null, false, undefined] })) === "");
  check("HeroNotes renders each note", (renderToStaticMarkup(createElement(HeroNotes, { notes: ["a", null, "b"] })).match(/<p>/g) ?? []).length === 2);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
