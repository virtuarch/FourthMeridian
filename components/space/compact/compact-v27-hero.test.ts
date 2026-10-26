/**
 * components/space/compact/compact-v27-hero.test.ts  (v2.7 — compact hero tightening, owner feedback)
 *
 *   1. the compact Debt hero follows the Net Worth pattern: label row with the
 *      canonical freshness claim, figure, change + range on ONE line, AI entry;
 *      the "across N", interest/utilization stats and verdict prose are
 *      compact-hidden (desktop keeps them); disclosures stay visible;
 *   2. those stats reappear once, in a compact KPI strip under the balance
 *      chart, from the SAME kpis values (debtCompactKpiItems, owned by the hero);
 *   3. the compact card is shorter (py-4).
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

console.log("1. the compact Debt hero follows the Net Worth pattern");
{
  const html = render();
  const meta = html.slice(html.indexOf("data-compact-hero-meta"));
  check("label row: Total debt, then the canonical freshness claim (lg:hidden)",
    /Total debt<\/p><span class="lg:hidden ml-auto[^"]*" data-compact-hero-freshness="true">Last checked 4 months ago<\/span>/.test(html));
  check("change + range on one compact line", /data-compact-hero-meta/.test(html) && /Sep 26, 2026 → Oct 26, 2026/.test(text(meta)) && /class="lg:hidden mt-2\.5 flex flex-wrap/.test(html));
  check("the wordy lines are compact-hidden: across N, stats row, verdict",
    /<p class="mt-2\.5 text-sm text-\[var\(--text-secondary\)\] max-lg:hidden">\s*across/.test(html)
      && /text-\[var\(--text-muted\)\] max-lg:hidden"><span class="inline-flex items-baseline gap-1\.5 tabular-nums"><span[^>]*>Est\. interest/.test(html)
      && /leading-snug text-\[var\(--text-secondary\)\] max-lg:hidden">You carry/.test(html));
  const desk = desktopMarkup(html);
  check("DESKTOP keeps across N, Est. interest, Utilization, verdict and the vs-date delta; no compact meta/freshness",
    /across/.test(text(desk)) && /Est\. interest/.test(text(desk)) && /Utilization/.test(text(desk)) && /You carry/.test(text(desk))
      && /vs Sep 26, 2026/.test(text(desk)) && !/data-compact-hero-meta|data-compact-hero-freshness/.test(desk));
  const redacted = render({ redactions: 2 });
  check("a withheld-details disclosure stays visible on compact", /<p class="lg:hidden basis-full[^"]*">2 account details withheld<\/p>/.test(redacted));
  const hist = render({ historical: true });
  check("historical: the 'balances are current' disclosure stays visible (not compact-hidden)",
    /<p class="mt-1 text-\[11px\] text-\[var\(--text-faint\)\]">\s*Balances are current/.test(hist));
  check("no comparison ⇒ the date-menu hint, no invented change", /Choose a comparison in the date menu/.test(text(render({ change: null }).slice(render({ change: null }).indexOf("data-compact-hero-meta")))));
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
