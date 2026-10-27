/**
 * components/space/compact/compact-v27-r4.test.ts  (v2.7 R4 — compact Net Worth / Assets cockpit,
 * rewritten for the v2.7 VISUAL-FIRST contract)
 *
 *   1. the compact KPI strip under the Net Worth chart states the hero's OWN
 *      secondary rows (Assets · Liabilities · Liquid NW; All: Cash ·
 *      Investments; Cash / Investments slices: none) off result.asOfState, with
 *      the hero's change formatting; compact-only (lg:hidden);
 *   2. SUPERSEDED R4 D-3: the Explanation card (one-liners + "Details") is
 *      deleted at every width; its evidence doorway (later on the "What moved"
 *      header) was removed in the v2.7 final UX pass (no customer EvidenceDrawer);
 *   3. the remaining compact disclosure (Holdings "Show all N") is an
 *      accessible button; NO section is collapsed behind a toggle any more
 *      (Resilience, What changed, Activity) and uncertainty notes are visible;
 *   4. Holdings: top 5 + "Show all N" on compact (owner D-E keep); desktop keeps
 *      its top 4 + panel;
 *   5. SUPERSEDED R4: Liquidity "What changed" shows EVERY driver at every
 *      width (no top-3 cut, no Show all);
 *   6. desktop markup of the statically renderable pieces.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/compact/compact-v27-r4.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { desktopMarkup } from "./desktop-markup";
import { CompactKpiStrip } from "./CompactKpiStrip";
import { CompactDisclosureButton } from "./CompactDisclosure";
import { existsSync } from "node:fs";
import { wealthSecondaryRows, SecondaryChange } from "@/components/space/widgets/wealth/WealthHero";
import { LiquidityWhatChangedCard } from "@/components/space/widgets/liquidity/LiquidityWhatChangedCard";
import { HoldingsLedger, COMPACT_HOLDINGS_TOP_N } from "@/components/space/widgets/investments/HoldingsLedger";
import { formatCurrency } from "@/lib/currency";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
/** The subtree of the first element carrying `marker` (balanced on its tag name). */
function subtree(html: string, marker: string): string {
  const at = html.indexOf(marker);
  if (at === -1) return "";
  const start = html.lastIndexOf("<", at);
  const tag = /^<([a-zA-Z0-9]+)/.exec(html.slice(start))![1];
  const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, "g");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return html.slice(start);
}

const STATE = { found: true, date: "2026-10-16", netWorth: -77164.15, totalAssets: 86541.74, totalLiabilities: 163705.89, liquidNetWorth: -101116.89, cash: 62589, invested: 23952.74, composition: { investments: 23952.74, crypto: 0 } };
const RESULT = {
  hasHistory: true, asOf: "2026-10-16",
  asOfState: STATE,
  compareState: { ...STATE, date: "2026-09-26", netWorth: -88685.03 },
  deltas: { netWorth: { abs: 11521.88, pct: 13 }, totalAssets: { abs: 11521.88, pct: 15.4 }, totalLiabilities: { abs: 0, pct: 0 }, liquidNetWorth: { abs: -85.18, pct: 0.1 }, cash: { abs: -85.18, pct: 0.1 }, invested: { abs: 11607.06, pct: 94 } },
  explanation: "Your net worth increased by $11,522 since Sep 26, 2026. Assets increased by $11,522 and liabilities decreased by $0.",
  drivers: [{ id: "investments", label: "Investments", delta: 11607.06 }, { id: "cash", label: "Cash", delta: -85.18 }],
  chart: { points: [], asOfDate: "2026-10-16", compareDate: "2026-09-26" },
} as unknown as WealthResult;

console.log("1. the compact KPI strip (Net Worth Total)");
{
  const ww = code("components/space/widgets/wealth/WealthWorkspace.tsx");
  const rows = wealthSecondaryRows(RESULT, "netWorth");
  check("the rows are the hero's Total stat line: Assets · Liabilities · Liquid NW", rows.map((r) => r.label).join(" · ") === "Assets · Liabilities · Liquid NW");
  check("Assets → All keeps the hero's Cash · Investments rows (invested named for the classes held)",
    wealthSecondaryRows(RESULT, "totalAssets").map((r) => r.label).join(" · ") === "Cash · Investments");
  // v2.7 visual-first — DELIBERATE: the Cash / Investments slices state no cross-slice stats.
  check("Cash and Investments slices: no secondary rows ⇒ no KPI strip and no desktop stat line",
    wealthSecondaryRows(RESULT, "cash").length === 0 && wealthSecondaryRows(RESULT, "invested").length === 0
      && renderToStaticMarkup(createElement(CompactKpiStrip, { items: [], ariaLabel: "x" })) === "");
  check("the hero itself reads the SAME exported rows and change formatter",
    /const secondaryRows = wealthSecondaryRows\(result, metric\);/.test(code("components/space/widgets/wealth/WealthHero.tsx"))
      && /<SecondaryChange delta=\{deltas\?\.\[row\.key\]\} goodDirection=\{row\.goodDirection\} currency=\{currency\} \/>/.test(code("components/space/widgets/wealth/WealthHero.tsx")));
  check("the workspace builds the strip from result.asOfState with the hero's rows (no new sums)",
    /wealthSecondaryRows\(result, metric\)\.map\(\(row\) => \(\{[\s\S]{0,120}value: formatCurrency\(result\.asOfState\[row\.key\], displayCurrency\),[\s\S]{0,80}change: <SecondaryChange delta=\{result\.deltas\?\.\[row\.key\]\}/.test(ww));
  check("placed ONCE, under the chart and above composition + change ledger",
    (ww.match(/<CompactKpiStrip/g) ?? []).length === 1
      && ww.indexOf('id="wealth-trend"') < ww.indexOf("<CompactKpiStrip") && ww.indexOf("<CompactKpiStrip") < ww.indexOf('id="wealth-composition"'));
  check("only when the as-of snapshot exists (no zeros-as-facts)", /const kpiItems = result\.asOfState\.found\s*\?/.test(ww));

  const items = rows.map((row) => ({
    key: row.key, label: row.label,
    value: formatCurrency(RESULT.asOfState[row.key], "USD"),
    change: createElement(SecondaryChange, { delta: RESULT.deltas?.[row.key], goodDirection: row.goodDirection, currency: "USD", className: "" }),
  }));
  const html = renderToStaticMarkup(createElement(CompactKpiStrip, { items, ariaLabel: "Net worth breakdown" }));
  check("compact-only root (lg:hidden) — never rendered at ≥1024px", /^<dl aria-label="Net worth breakdown" data-compact-kpi-strip="true" class="lg:hidden /.test(html) && desktopMarkup(html) === "");
  const tile = (k: string) => text(subtree(html, `data-compact-kpi="${k}"`));
  check("Assets = asOfState.totalAssets, with its change", tile("totalAssets") === `Assets ${formatCurrency(STATE.totalAssets, "USD")} +${formatCurrency(11521.88, "USD")}`, tile("totalAssets"));
  check("Liabilities = asOfState.totalLiabilities (a zero change is not shown, as on desktop)", tile("totalLiabilities") === `Liabilities ${formatCurrency(STATE.totalLiabilities, "USD")}`, tile("totalLiabilities"));
  check("Liquid NW = asOfState.liquidNetWorth, with its signed change", tile("liquidNetWorth") === `Liquid NW ${formatCurrency(STATE.liquidNetWorth, "USD")} −${formatCurrency(85.18, "USD")}`, tile("liquidNetWorth"));
  check("no fixed widths: equal minmax(0,1fr) columns, figures wrap", /repeat\(3, minmax\(0, 1fr\)\)/.test(html) && /\[overflow-wrap:anywhere\]/.test(html) && !/\bw-\[\d/.test(html));
  check("tighter compact rhythm (max-lg only) and a compact chart legend",
    /className="space-y-8 sm:space-y-10 min-w-0 max-lg:space-y-6!"/.test(ww)
      && /id="wealth-trend" className="scroll-mt-20 (max-lg:\[[^\]]+\]:[^\s"]+ ?)+"/.test(ww));
}

console.log("\n2. the Explanation card is gone; no customer-facing Evidence doorway (v2.7 final UX pass)");
{
  const ww = code("components/space/widgets/wealth/WealthWorkspace.tsx");
  check("WealthExplanationCard and CompactInsights are deleted",
    !existsSync(path.join(process.cwd(), "components/space/widgets/wealth/WealthExplanationCard.tsx"))
      && !existsSync(path.join(process.cwd(), "components/space/compact/CompactInsights.tsx")) && !/Explanation/.test(ww));
  check("the ledger header carries no Evidence doorway and the workspace mounts no EvidenceDrawer",
    !/onViewEvidence|canViewEvidence|setEvidenceOpen|<EvidenceDrawer/.test(ww)
      && !existsSync(path.join(process.cwd(), "components/space/shell/EvidenceDrawer.tsx")));
}

console.log("\n3. one accessible disclosure left; nothing collapsed; notes visible");
{
  const html = renderToStaticMarkup(createElement(CompactDisclosureButton, { open: false, onToggle: () => {}, controls: "x", label: "Show" }));
  check("a real button: type, aria-expanded, aria-controls", /^<button type="button" aria-expanded="false" aria-controls="x"/.test(html));
  check("compact-only, ≥40px touch target, visible focus ring", /class="lg:hidden [^"]*min-h-10 min-w-10[^"]*focus-visible:ring-2/.test(html) && desktopMarkup(html) === "");
  check("expanded state reads Hide", /aria-expanded="true"[\s\S]*>Hide/.test(renderToStaticMarkup(createElement(CompactDisclosureButton, { open: true, onToggle: () => {}, controls: "x", label: "Show" }))));

  const liq = code("components/space/widgets/liquidity/LiquidityWorkspace.tsx");
  const inv = code("components/space/widgets/investments/InvestmentsWorkspace.tsx");
  const ww = code("components/space/widgets/wealth/WealthWorkspace.tsx");
  check("Cash: no disclosure toggles and no compact hiding (Resilience and What changed always visible)",
    !/CompactDisclosureButton|compactHidden|resilienceOpen|activityOpen/.test(liq));
  check("Cash: ONE transaction-coverage note, visible at every width",
    (liq.match(/<TransactionCoverageNote /g) ?? []).length === 1 && /<TransactionCoverageNote coverage=\{transactionsMeta\} variant="history" className="mb-3" \/>/.test(liq));
  check("Investments: no disclosure toggles; the Activity section is removed", !/CompactDisclosureButton|compactHidden|activityOpen|InvestmentsActivityCard|investments-activity/.test(inv));
  check("Investments: the shared-scope disclosure stays visible", /\{scopeDivergence && \(\s*<div className="flex items-start gap-2 rounded-lg px-3 py-2 text-xs"/.test(inv));
  check("Net Worth: stale-snapshot and backfill notices unchanged and uncollapsed; Real-assets label visible",
    /\{staleSnapshotsNotice\}/.test(ww) && /Creating your 30-day snapshot history/.test(ww) && /data-real-assets-note/.test(ww) && !/CompactDisclosureButton/.test(ww));
  check("compact rhythm in the embedded sections too (max-lg only)",
    /className="space-y-8 sm:space-y-10 min-w-0 max-lg:space-y-6!"/.test(liq) && /className="space-y-8 sm:space-y-10 min-w-0 max-lg:space-y-6!"/.test(inv));
}

console.log("\n4. Holdings: top 5 + Show all on compact");
{
  const H = (i: number) => ({ instrumentId: `i${i}`, accountId: "a1", symbol: `SYM${i}`, name: `Name ${i}`, quantity: i, reportingValue: 1000 - i * 50, share: 0.1, overallTier: "observed", staleDays: 0, conflicted: false, assetClass: "equity", sector: null, isCash: false });
  const render = (count: number) => renderToStaticMarkup(createElement(HoldingsLedger, { holdings: Array.from({ length: count }, (_, i) => H(i)), reportingCurrency: "USD", accounts: [{ id: "a1", name: "Brokerage" }] } as never));
  const html = render(9);
  const compact = subtree(html, "data-compact-holdings");
  check("compact-only list shows the top 5 rows, in DTO order", COMPACT_HOLDINGS_TOP_N === 5
    && [...compact.matchAll(/>SYM(\d)</g)].map((m) => m[1]).join("") === "01234");
  const btn = /<button type="button" aria-expanded="false" aria-controls="([^"]+)"[^>]*class="lg:hidden[^"]*"[^>]*>Show all 9/.exec(compact);
  check("\"Show all 9\" — a compact disclosure controlling the list", !!btn && compact.includes(`id="${btn[1]}"`));
  check("≤5 holdings ⇒ no compact Show all", !/Show all/.test(subtree(render(5), "data-compact-holdings")));
  const desk = desktopMarkup(html);
  check("DESKTOP: the top 4 and the \"View all 9 holdings\" panel doorway, no compact list",
    [...desk.matchAll(/>SYM(\d)</g)].map((m) => m[1]).join("") === "0123" && /View all 9 holdings/.test(desk) && !/data-compact|Show all/.test(desk));
  check("on compact the desktop list and its doorway are max-lg:hidden",
    /<div class="rounded-\[var\(--radius-lg\)\] border border-\[var\(--border-hairline\)\] divide-y divide-\[var\(--border-hairline\)\] overflow-hidden max-lg:hidden"/.test(html) && /hover:underline max-lg:hidden">View all 9 holdings/.test(html));
}

console.log("\n5. Cash: What changed — every driver, every width");
{
  let n = 0;
  const tx = (o: Record<string, unknown>) => ({ id: `t${n++}`, accountId: "chk", financialAccountId: "chk", merchant: "m", category: "Groceries", pending: false, currency: "USD", flowType: "SPENDING", counterpartyAccountId: null, transferDisposition: null, ...o });
  const TXS = [
    tx({ amount: 5000, date: "2026-05-04", category: "Income", flowType: "INCOME", incomeClass: "EARNED_INCOME" }),
    tx({ amount: 700, date: "2026-05-05", category: "Interest", flowType: "INCOME", incomeClass: "PASSIVE_INCOME" }),
    tx({ amount: -200, date: "2026-05-12", category: "Groceries" }),
    tx({ amount: -900, date: "2026-05-21", flowType: "DEBT_PAYMENT", category: "Payment", counterpartyAccountId: "card" }),
    tx({ amount: -1500, date: "2026-05-22", flowType: "TRANSFER", category: "Transfer", counterpartyAccountId: "brk" }),
    tx({ amount: -50, date: "2026-05-23", flowType: "FEE", category: "Fees" }),
  ];
  const props = { transactions: TXS, accounts: [{ id: "chk", type: "checking" }, { id: "card", type: "debt" }, { id: "brk", type: "investment" }], period: { kind: "month", year: 2026, month: 5 }, asOf: "2026-06-15", onOpenCashFlow: () => {} };
  const html = renderToStaticMarkup(createElement(LiquidityWhatChangedCard, props as never));
  const rows = [...html.matchAll(/truncate">([^<]+)</g)].map((m) => m[1]);
  check("all five drivers, builder order, one grid — no compact list, no Show all, nothing hidden",
    rows.join(" · ") === "Earned income · Other income · Asset deployment · Debt payments · Direct cash spending"
      && !/data-compact|Show all|class="hidden"|max-lg:hidden|lg:hidden/.test(html), rows.join(" · "));
  check("DESKTOP: identical to compact (one markup for every width)", desktopMarkup(html) === html
    && html.startsWith('<div class="space-y-3"><div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5"><div class="flex items-center justify-between gap-2">'));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
