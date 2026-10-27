/**
 * components/space/compact/compact-v27-visual.test.ts  (v2.7 VISUAL-FIRST cleanup — desktop AND mobile)
 *
 * Principle (owner): Charts > KPIs > Visual analytics > Accounts > Narrative.
 * Redundant explanations / sections / duplicate cards are REMOVED at every
 * width — never replaced by a "Show" / "Details" toggle.
 *
 *   1. section order per view (source level): Total, Assets → All, Cash, Investments;
 *   2. removed items are absent at ALL widths (deleted / not rendered, not CSS-hidden);
 *   3. the five-row compact header card: WealthHero (netWorth, totalAssets, cash,
 *      invested) and DebtHero render exactly 5 rows with IDENTICAL class lists;
 *      R3 present for positive / negative / zero / no comparison; R4 nowrap +
 *      truncate + title; exceptional disclosures render BELOW the card;
 *   4. Real assets only on the Investments slice; the valuation-accuracy chip only
 *      when a position is unvalued;
 *   5. the composition card keeps its as-of caveat in the hint, not a paragraph.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/compact/compact-v27-visual.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { desktopMarkup } from "./desktop-markup";
import { COMPACT_HERO_ROWS } from "./CompactHeroCard";
import { assetsCompactVisibility } from "./compact-sections";
import { WealthHero } from "@/components/space/widgets/wealth/WealthHero";
import { DebtHero } from "@/components/space/widgets/debt/DebtHero";
import { ValuationAccuracyChip } from "@/components/space/widgets/investments/InvestmentsWorkspace";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
/** Indexes of `needles` in `hay`, asserting each is found and strictly increasing. */
function inOrder(hay: string, needles: string[]): { ok: boolean; detail: string } {
  let last = -1;
  for (const n of needles) {
    const at = hay.indexOf(n, last + 1);
    if (at === -1 || at <= last) return { ok: false, detail: `${n} ${at === -1 ? "missing" : "out of order"}` };
    last = at;
  }
  return { ok: true, detail: "" };
}

const WW = code("components/space/widgets/wealth/WealthWorkspace.tsx");
const LIQ = code("components/space/widgets/liquidity/LiquidityWorkspace.tsx");
const INV = code("components/space/widgets/investments/InvestmentsWorkspace.tsx");

console.log("1. section order per view");
{
  const main = WW.slice(WW.indexOf('<div id="wealth-summary"'));
  const total = inOrder(main, ["<WealthHero", 'id="wealth-trend"', "<CompactKpiStrip", 'id="wealth-composition"', 'id="wealth-ledger"', "{assetsSectionsBody}"]);
  check("Total / All: hero → chart → KPI strip → Where it sits → What moved (→ the slice's sections)", total.ok, total.detail);
  check("Where it sits + What moved render on Total and Assets → All only",
    /\{\(mode !== "assets" \|\| show\.composition\) && \(/.test(WW) && assetsCompactVisibility("all").composition && !assetsCompactVisibility("cash").composition && !assetsCompactVisibility("investments").composition);
  const body = WW.slice(WW.indexOf("const assetsSectionsBody"));
  const assets = inOrder(body, ['{show.cash && (', 'id="wealth-cash"', '{show.investments && (', 'id="wealth-investments"', '{show.realAssets && (', 'id="wealth-real-assets"']);
  check("Assets sections: Cash · Investments · Real assets, each gated by its slice", assets.ok, assets.detail);
  // DELIBERATE (owner, v2.7 Cash layout): Cash distribution is ONE section
  // directly under the chart — Dropdown → donut → accounts ledger (+ its
  // reconciliation footer) — then Resilience, then What changed.
  const cash = inOrder(LIQ, ['id="liquidity-history"', 'id="liquidity-sources"', 'id="liquidity-distribution"', 'ariaLabel="Cash distribution grouping"', "<CashDistribution", 'id="liquidity-accounts"', "<CashAccountsLedger", 'id="liquidity-resilience"', "Emergency coverage", "Cash concentration", "Reachability", "data-accessible-cash", 'id="liquidity-activity"', "<TransactionCoverageNote", "<LiquidityWhatChangedCard"]);
  // v2.7 Cash accounts — DELIBERATE (owner): the Sources ledger is replaced by
  // Cash distribution → Cash accounts. DELIBERATE (owner, v2.7-P0 PR): the
  // reconstructed as-of tiers section is REMOVED — a historical As-Of shows the
  // same sections, with the per-account ones labelled "Current balances".
  check("Cash: chart → Cash distribution (Dropdown → donut → accounts ledger) → Resilience → What changed (+ coverage note)", cash.ok, cash.detail);
  const between = LIQ.slice(LIQ.indexOf("<CashDistribution"), LIQ.indexOf("<CashAccountsLedger"));
  check("Cash: nothing between the donut and the ledger (no Block / Surface / banner)", !/<Block|<Surface|<TrustIndicator|Notice/.test(between), between);
  check("Cash: no reconstructed-tiers section", !LIQ.includes('id="liquidity-reconstructed"') && !LIQ.includes("renderHistoricalTiers"));
  check("Cash: the resilience grid is 2-up on compact, 4-up on desktop when embedded",
    /grid grid-cols-2 gap-3 sm:gap-4 items-stretch min-w-0 \$\{embedded \? "lg:grid-cols-4" : "lg:grid-cols-3"\}/.test(LIQ));
  const ret = INV.slice(INV.lastIndexOf("  return (\n    <div className=\"space-y-8 sm:space-y-10"));
  const inv = inOrder(ret, ["{statusRow}", "{scopeDivergence && (", 'id="investments-holdings"', 'id="investments-allocation"', 'id="investments-concentration"', "{accountsLedger}", 'id="investments-period"']);
  check("Investments: accuracy status → scope note → Holdings → Allocation → Concentration → Accounts → This period", inv.ok, inv.detail);
  check("Investments → Real assets comes after the Investments section", WW.indexOf('id="wealth-investments"') < WW.indexOf('id="wealth-real-assets"'));
}

console.log("\n2. removed items are absent at ALL widths");
{
  check("Explanation: component + R4 helpers deleted; no anchor, no render",
    !existsSync(path.join(process.cwd(), "components/space/widgets/wealth/WealthExplanationCard.tsx"))
      && !existsSync(path.join(process.cwd(), "components/space/compact/CompactInsights.tsx"))
      && !/WealthExplanationCard|wealth-explanation|CompactInsights/.test(WW));
  check("ATTRIBUTION_NOTE: constant and render gone", !/ATTRIBUTION_NOTE|historical valuation/.test(code("components/space/widgets/wealth/WealthChangeLedger.tsx")));
  check("All slice: Cash / Investments / Real assets are not rendered (truth table is the render rule)",
    JSON.stringify(assetsCompactVisibility("all")) === JSON.stringify({ composition: true, cash: false, investments: false, realAssets: false })
      && !/compactHidden/.test(WW));
  check("Cash: no embedded LiquidityHero card, no disclosure toggles, no top-3 cut",
    /\{!embedded && \(\s*<div id="liquidity-summary"/.test(LIQ) && !/CompactDisclosureButton|compactHidden/.test(LIQ)
      && !/COMPACT_DRIVER_COUNT|data-compact-drivers|Show all/.test(code("components/space/widgets/liquidity/LiquidityWhatChangedCard.tsx")));
  check("Cash: the restating helper sentences are gone",
    !/set a monthly expense target to see months of coverage|your only cash account/.test(LIQ) && /Set a monthly expense target/.test(LIQ));
  check("Investments: no embedded InvestmentsHero, no Excluded banner, no Activity section, no toggles",
    /\{!embedded && \(\s*<div id="investments-summary"/.test(INV) && !/ExcludedDisclosure|InvestmentsActivityCard|investments-activity|CompactDisclosureButton|compactHidden/.test(INV));
  check("Cash / Investments slices: no secondary stats (desktop stat line) and so no KPI strip",
    /cash: \[\],\s*invested: \[\],/.test(code("components/space/widgets/wealth/WealthHero.tsx")));
  check("the old per-hero compact meta blocks are gone",
    !/data-compact-hero-meta|data-compact-talk/.test(read("components/space/widgets/wealth/WealthHero.tsx") + read("components/space/widgets/debt/DebtHero.tsx")));
}

console.log("\n3. the five-row compact header card");
const STATE = { found: true, date: "2026-10-16", netWorth: -77164.15, totalAssets: 86541.74, totalLiabilities: 163705.89, liquidNetWorth: -101116.89, cash: 62589, invested: 23952.74, composition: { investments: 23952.74, crypto: 0 } };
const D = (abs: number, pct: number) => ({ abs, pct });
const RESULT = (k: number) => ({
  hasHistory: true,
  asOfState: STATE,
  compareState: { ...STATE, date: "2026-09-26" },
  deltas: { netWorth: D(11521.88 * k, 13 * k), totalAssets: D(11521.88 * k, 15.4 * k), totalLiabilities: D(0, 0), liquidNetWorth: D(-85.18 * k, 0.1 * k), cash: D(-85.18 * k, 0.1 * k), invested: D(11607.06 * k, 94 * k) },
});
const NO_COMPARE = { ...RESULT(1), deltas: null, compareState: null };
const ENVELOPE = { completeness: "complete", warnings: [] };
const wealth = (metric: string, result: unknown, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(WealthHero, { result, currency: "USD", envelope: ENVELOPE, metric, freshnessLabel: "Last checked 2 hr ago", ...extra } as never));
const KPIS = { totalDebt: 3200, estMonthlyInterest: 53.31, accountCount: 1, owingCount: 1, settledCount: 0, creditCount: 0, ratedCount: 1, unratedCount: 0, utilizationPct: 32, utilizationLevel: "moderate", estimated: false };
const debt = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(DebtHero, {
  kpis: KPIS, currency: "USD", liabilityCount: 1, asOf: "2026-10-26", today: "2026-10-26", historical: false,
  change: { abs: 61, pct: 2, fromLabel: "Sep 26, 2026" }, envelope: ENVELOPE, verdict: null, verdictAsOf: null, redactions: 0,
  freshnessLabel: "Last checked 2 hr ago", ...extra,
} as never));

function cardOf(h: string): string {
  const at = h.indexOf("data-compact-hero-wrap");
  const from = h.slice(h.lastIndexOf("<", at));
  return from.slice(0, from.indexOf('<section class="max-lg:hidden"'));
}
function rowsOf(h: string): { cls: string; html: string }[] {
  const card = cardOf(h);
  return [...card.matchAll(/<div data-compact-hero-row="(\d)" class="([^"]*)">([\s\S]*?)<\/div>(?=<div data-compact-hero-row|<\/section>)/g)].map((m) => ({ cls: m[2], html: m[3] }));
}
const notesOf = (h: string) => text((cardOf(h).match(/data-compact-hero-notes="true">([\s\S]*?)<\/div><\/div>$/) ?? ["", ""])[1]);

{
  const fixtures: Record<string, string> = {
    "Net worth (+)": wealth("netWorth", RESULT(1)),
    "Net worth (−)": wealth("netWorth", RESULT(-1)),
    "Net worth (0)": wealth("netWorth", RESULT(0)),
    "Net worth (no comparison)": wealth("netWorth", NO_COMPARE),
    "Total assets (+)": wealth("totalAssets", RESULT(1)),
    "Cash (−)": wealth("cash", RESULT(-1)),
    "Investments (+)": wealth("invested", RESULT(1)),
    "Debt (+)": debt(),
    "Debt (−)": debt({ change: { abs: -61, pct: -2, fromLabel: "Sep 26, 2026" } }),
    "Debt (0)": debt({ change: { abs: 0, pct: 0, fromLabel: "Sep 26, 2026" } }),
    "Debt (no comparison)": debt({ change: null }),
    "Debt (historical)": debt({ historical: true, asOf: "2026-09-01" }),
  };
  const classSig = (h: string) => rowsOf(h).map((r) => r.cls).join("|");
  const want = COMPACT_HERO_ROWS.join("|");
  for (const [name, h] of Object.entries(fixtures)) {
    const rows = rowsOf(h);
    check(`${name}: exactly 5 rows, class lists identical to the shared contract`, rows.length === 5 && classSig(h) === want, `${rows.length} rows: ${classSig(h)}`);
    check(`${name}: R3 present (change or a muted one-liner)`, text(rows[2]?.html ?? "").length > 0, text(rows[2]?.html ?? ""));
    const r4 = /<p class="([^"]*)" title="([^"]+)">([^<]*)<\/p>/.exec(rows[3]?.html ?? "");
    check(`${name}: R4 alone, nowrap + truncate, full text in title`,
      !!r4 && r4[1].split(" ").includes("whitespace-nowrap") && r4[1].split(" ").includes("truncate") && r4[2] === r4[3] && r4[3].length > 0, rows[3]?.html);
    check(`${name}: R2 single-line fluid figure`, /class="[^"]*whitespace-nowrap[^"]*text-\[clamp\(28px,9vw,40px\)\][^"]*leading-tight/.test(rows[1]?.html ?? ""));
    check(`${name}: R5 the AI entry`, /Talk with Fourth Meridian about this/.test(rows[4]?.html ?? ""));
    check(`${name}: the card never renders at ≥1024px`, desktopMarkup(cardOf(h)) === "");
  }
  check("one card shell for every caller (identical section classes)",
    new Set(Object.values(fixtures).map((h) => /<section data-compact-hero="true" class="([^"]*)"/.exec(h)?.[1])).size === 1);
  check("R3 states +, −, 0 and none distinctly",
    /↑/.test(rowsOf(fixtures["Net worth (+)"])[2].html) && /↓/.test(rowsOf(fixtures["Net worth (−)"])[2].html)
      && text(rowsOf(fixtures["Net worth (0)"])[2].html) === "No change" && text(rowsOf(fixtures["Net worth (no comparison)"])[2].html) === "No comparison selected");
  check("R4: range with a comparison, \"As of <date>\" without",
    text(rowsOf(fixtures["Net worth (+)"])[3].html) === "Sep 26, 2026 → Oct 16, 2026" && text(rowsOf(fixtures["Net worth (no comparison)"])[3].html) === "As of Oct 16, 2026");
  check("R1 truncates the freshness claim beside the title", /<span class="ml-auto min-w-0 truncate[^"]*" title="Last checked 2 hr ago" data-compact-hero-freshness="true">Last checked 2 hr ago<\/span>/.test(rowsOf(fixtures["Debt (+)"])[0].html));

  // DELIBERATE (owner, v2.7 header parity): exceptional disclosures are no
  // longer below the card — they render under each page's chart (HeroNotes),
  // so the card AND the skeleton beneath it are identical across perspectives.
  const crypto = wealth("netWorth", RESULT(1), { cryptoPriceNote: "Crypto at 2:00 PM prices" });
  check("crypto price note: not in / below the compact card, 5 rows kept", notesOf(crypto) === "" && !/Crypto at 2:00 PM/.test(cardOf(crypto)) && rowsOf(crypto).length === 5);
  const withheld = debt({ redactions: 3, historical: true, asOf: "2026-09-01" });
  check("Debt withheld + historical: no notes in / below the card, 5 rows kept",
    notesOf(withheld) === "" && !/withheld|Balances are current/.test(cardOf(withheld)) && rowsOf(withheld).length === 5);
  check("no disclosure ⇒ no notes block", !/data-compact-hero-notes/.test(fixtures["Net worth (+)"]));
  check("no per-card heights or spacer hacks in the callers",
    !/\bh-\[|min-h-\[|style=\{\{\s*height/.test(read("components/space/widgets/wealth/WealthHero.tsx") + read("components/space/widgets/debt/DebtHero.tsx")));
}

console.log("\n4. Real assets on Investments only; valuation accuracy chip");
{
  check("Real assets render only on the Investments slice", assetsCompactVisibility("investments").realAssets && !assetsCompactVisibility("all").realAssets && !assetsCompactVisibility("cash").realAssets);
  check("Real assets: own section + title + the pinned component, with the short label", /<SectionTitle>Real assets<\/SectionTitle>\s*<span[^>]*data-real-assets-note>Not counted in Investments<\/span>\s*<\/div>\s*<RealAssetsSection /.test(WW));
  const chip = renderToStaticMarkup(createElement(ValuationAccuracyChip, { valued: 3, total: 5, reason: "no price for this date" }));
  check("partial ⇒ visible chip \"Partial · 3 of 5 valued\"", /data-valuation-accuracy="true"[^>]*>Partial · 3 of 5 valued<\/span>/.test(chip), chip);
  const id = /aria-describedby="([^"]+)"/.exec(chip)?.[1];
  check("the reason is the chip's title AND accessible description (no prose banner)",
    !!id && new RegExp(`<span id="${id}" class="sr-only">2 positions couldn't be valued for this date — no price for this date — not counted in the figures\\.</span>`).test(chip.replace(/&#x27;/g, "'"))
      && /title="2 positions couldn&#x27;t be valued/.test(chip));
  check("the chip renders only when a position is unvalued (unvalued > 0 gate)", /\{unvalued > 0 && \(\s*<ValuationAccuracyChip/.test(INV));
  check("the status row collapses when empty (no chip, clean trust tier)", /className="flex flex-wrap items-center gap-2 empty:hidden" data-investments-status/.test(INV));
}

console.log("\n5. the composition card's as-of caveat is a hint, not a paragraph");
{
  const wc = read("components/space/widgets/wealth/WealthCompositionCard.tsx");
  check("no 'Current classification —' paragraphs", !/<p className="text-\[11px\] text-\[var\(--text-muted\)\] mb-3 leading-relaxed">\s*Current classification/.test(wc));
  check("the hint says 'Current · today's accounts' and keeps the full caveat as title + sr-only text",
    /<CurrentHint label="Current · today's accounts" detail="Current classification — reflects today's connected accounts, not the selected As Of date\." \/>/.test(wc)
      && /title=\{detail\}/.test(wc) && /<span className="sr-only"> — \{detail\}<\/span>/.test(wc));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
