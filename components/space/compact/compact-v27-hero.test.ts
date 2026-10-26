/**
 * components/space/compact/compact-v27-hero.test.ts  (v2.7 — compact hero, owner feedback)
 *
 *   1. the compact Debt hero is the shared five-row CompactHeroCard (v2.7
 *      visual-first — DELIBERATE: replaces the hero-tighten label row + meta
 *      line): title · freshness · trust / figure / change / range / AI entry;
 *      the "across N", interest/utilization stats and verdict prose are
 *      desktop-only; disclosures (withheld, historical) render visibly BELOW
 *      the card, never as extra rows;
 *   2. those stats appear once, in a compact KPI strip under the balance chart,
 *      from the SAME kpis values (debtCompactKpiItems, owned by the hero);
 *   3. the compact card is short (py-4).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/compact/compact-v27-hero.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { desktopMarkup } from "./desktop-markup";
import { COMPACT_HERO } from "./compact-hero";
import { DebtHero, debtCompactKpiItems } from "@/components/space/widgets/debt/DebtHero";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

const KPIS = {
  totalDebt: 3200, estMonthlyInterest: 53.31, accountCount: 1, owingCount: 1, settledCount: 0, creditCount: 0,
  ratedCount: 1, unratedCount: 0, utilizationPct: 32, utilizationLevel: "moderate", estimated: false,
};
const ENVELOPE = { completeness: "complete", warnings: [] };
const render = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(DebtHero, {
  kpis: KPIS, currency: "USD", liabilityCount: 1, asOf: "2026-10-26", today: "2026-10-26", historical: false,
  change: { abs: 61, pct: 2, fromLabel: "Sep 26, 2026" }, envelope: ENVELOPE,
  verdict: "You carry $3,200 of debt across 1 account, accruing an estimated $53/month in interest at known rates.",
  verdictAsOf: "Jun 9, 2026", redactions: 0, freshnessLabel: "Last checked 4 months ago", ...extra,
} as never));

console.log("1. the compact Debt hero is the shared five-row card");
{
  const card = (h: string) => { const f = h.slice(h.lastIndexOf("<", h.indexOf("data-compact-hero-wrap"))); return f.slice(0, f.indexOf('<section class="max-lg:hidden"')); };
  const row = (h: string, n: number) => text((card(h).match(new RegExp(`data-compact-hero-row="${n}"[^>]*>([\\s\\S]*?)</div>(?=<div data-compact-hero-row|</section>)`)) ?? ["", ""])[1]);
  const notes = (h: string) => text((card(h).match(/data-compact-hero-notes="true">([\s\S]*?)<\/div><\/div>$/) ?? ["", ""])[1]);
  const html = render();
  check("R1: Total debt, then the canonical freshness claim", row(html, 1) === "Total debt Last checked 4 months ago", row(html, 1));
  check("R2: the figure, in the negative accent", row(html, 2) === "$3,200.00" && /color:var\(--accent-negative\)/.test(card(html)));
  check("R3 change and R4 range on SEPARATE rows", /61/.test(row(html, 3)) && /2\.0%/.test(row(html, 3)) && row(html, 4) === "Sep 26, 2026 → Oct 26, 2026", `${row(html, 3)} | ${row(html, 4)}`);
  check("R5: the AI entry", /Talk with Fourth Meridian about this/.test(row(html, 5)));
  check("the wordy lines are not in the compact card: across N, stats, verdict", !/across|Est\. interest|Utilization|You carry/.test(text(card(html))));
  const desk = desktopMarkup(html);
  check("DESKTOP keeps across N, Est. interest, Utilization, verdict and the vs-date delta; no compact card",
    /across/.test(text(desk)) && /Est\. interest/.test(text(desk)) && /Utilization/.test(text(desk)) && /You carry/.test(text(desk))
      && /vs Sep 26, 2026/.test(text(desk)) && !/data-compact-hero/.test(desk));
  const redacted = render({ redactions: 2 });
  check("a withheld-details disclosure is a visible note BELOW the card (not a row)",
    notes(redacted) === "2 account details withheld" && !/withheld/.test(row(redacted, 1) + row(redacted, 3) + row(redacted, 4)));
  const hist = render({ historical: true });
  check("historical: no change beside a present-day figure; R4 'Current balances'; the 'balances are current' note below",
    row(hist, 3) === "Change shown in the chart" && row(hist, 4) === "Current balances" && /^Balances are current — the trend reflects Oct 26, 2026\.$/.test(notes(hist)), `${row(hist, 3)} | ${row(hist, 4)} | ${notes(hist)}`);
  const none = render({ change: null });
  check("no comparison ⇒ 'No comparison selected' and 'As of <date>', no invented change", row(none, 3) === "No comparison selected" && row(none, 4) === "As of Oct 26, 2026");
  check("no notes ⇒ no notes block", !/data-compact-hero-notes/.test(html));
}

console.log("\n2. the stats move to a compact KPI strip — same values");
{
  const items = debtCompactKpiItems(KPIS as never, "USD");
  check("Liabilities · Est. interest · Utilization from the same kpis",
    items.map((i) => `${i.label}=${i.value}`).join("|") === "Liabilities=1|Est. interest=$53.31/mo|Utilization=32%", JSON.stringify(items));
  check("estimated ⇒ the hero's ≈ marker", debtCompactKpiItems({ ...KPIS, estimated: true } as never, "USD")[1].value.startsWith("≈ "));
  check("no rate / no limit ⇒ those items are omitted, never zero", debtCompactKpiItems({ ...KPIS, ratedCount: 0, utilizationPct: null } as never, "USD").length === 1);
  const dw = readFileSync(path.join(process.cwd(), "components/space/widgets/debt/DebtWorkspace.tsx"), "utf8");
  check("the workspace renders the strip under the balance chart, compact-only", /<div className="lg:hidden mt-4">\s*<CompactKpiStrip\s+ariaLabel="Debt summary"\s+items=\{debtCompactKpiItems\(kpis, displayCurrency\)\}/.test(dw));
  check("the workspace threads the canonical freshness claim to the hero", /freshnessLabel=\{freshnessLabel\}/.test(dw)
    && /onEnvelopeChange=\{onEnvelopeChange\}\s+timePreset=\{timePreset\}\s+freshnessLabel=\{freshnessLabel\}/.test(readFileSync(path.join(process.cwd(), "components/space/widgets/wealth/WealthWorkspace.tsx"), "utf8")));
}

console.log("\n3. a shorter compact card");
check("compact hero padding py-4 (was py-6), all tokens still max-lg", /max-lg:py-4/.test(COMPACT_HERO) && COMPACT_HERO.split(/\s+/).filter(Boolean).every((t) => t.startsWith("max-lg:")));

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
