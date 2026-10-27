/**
 * components/space/compact/mobile-desktop-parity.test.ts  (v2.7 — Workstream 3)
 *
 * OWNER REQUIREMENT: mobile and desktop provide 1:1 financial capabilities, data
 * and economic meaning — layouts may differ, feature sets may not. For each gap
 * the parity audit found, this pins that the capability is no longer gated
 * behind `lg:hidden` (compact only) or `max-lg:hidden` (desktop only), and —
 * where the component renders statically — that it renders in BOTH: once in the
 * raw markup (what <1024px can show) and once through `desktopMarkup` (what
 * ≥1024px can show: lg:hidden subtrees and max-lg:* utilities removed).
 *
 *   1. Debt — All · Credit · Loans, the per-class donuts ("By loan type"), the
 *      class account lists and the category hiding, at every width;
 *   2. Assets — ONE slice control, reachable in every Assets state;
 *   3. Cash accounts — the same row facts in both layouts;
 *   4. Holdings — one list, one searchable panel;
 *   5. Freshness — "Last checked" on the compact Cash Flow / Spending heroes,
 *      the stale-accounts warning (and Markets' claim) on compact;
 *   6. Cash Flow / Spending — the comparison window and the explanation on
 *      compact, outside the fixed-height card;
 *   7. "Talk with Fourth Meridian about this" on every desktop hero that has a
 *      TalkSection; Spending has none at either width;
 *   8. utilization level in words at both widths; no Markets sub-views while
 *      Markets is a placeholder.
 *
 *   node_modules/.bin/tsx --require ./scripts/lib/server-only-preload.cjs components/space/compact/mobile-desktop-parity.test.ts
 */

import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { desktopMarkup } from "./desktop-markup";
import { CompactSectionTabs, compactHidden, sectionHidden } from "./CompactSectionTabs";
import { CompactHeroCard } from "./CompactHeroCard";
import { debtCompactVisibility } from "./compact-sections";
import { LiabilitiesLedger } from "@/components/space/widgets/debt/LiabilitiesLedger";
import { DebtCompositionCard } from "@/components/space/widgets/debt/DebtCompositionCard";
import { DebtHero, UTILIZATION_LEVEL_LABEL, debtCompactKpiItems } from "@/components/space/widgets/debt/DebtHero";
import { debtSections } from "@/components/space/widgets/debt/DebtWorkspace";
import type { DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";
import { CashAccountsLedger, cashRowFields } from "@/components/space/widgets/liquidity/CashAccountsLedger";
import { buildCashAccounts, type CashLedgerAccount } from "@/components/space/widgets/liquidity/cash-accounts";
import { accountDetailFallbackRows } from "@/components/space/widgets/accounts/AccountsLedger";
import { HoldingsLedger, HOLDINGS_TOP_N } from "@/components/space/widgets/investments/HoldingsLedger";
import { CashFlowHero, CASH_FLOW_HERO_SUB } from "@/components/space/widgets/cashflow/CashFlowHero";
import { SpendingHero, SPENDING_HERO_SUB } from "@/components/space/widgets/cashflow/SpendingSections";
import { WealthHero } from "@/components/space/widgets/wealth/WealthHero";
import { TALK_ABOUT_THIS_LABEL } from "@/components/ai/TalkAboutThis";
import { TALK_SECTIONS } from "@/components/ai/talk-about-this";
import {
  MARKETS_LENS_ID, NET_WORTH_LENS_ID, publishedWorkspaceChildren, workspaceChildren,
} from "@/lib/space/use-space-navigation";
import { PERSPECTIVE_LIBRARY } from "@/lib/perspectives";
import { identityContext } from "@/lib/money/convert";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
/** What <1024px can show: everything except max-lg:hidden subtrees (a crude but sufficient cut for these fixtures). */
const compactMarkup = (html: string) => {
  // Remove max-lg:hidden elements (desktop-only) by mirroring desktopMarkup's walk.
  const out: string[] = []; const stack: boolean[] = []; let skip = 0;
  const VOID = new Set(["img", "br", "hr", "input", "meta", "link"]);
  for (const m of html.matchAll(/<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>|[^<]+/g)) {
    const [whole, close, open, attrs = "", self] = m;
    if (close) { const c = stack.pop() ?? false; if (c) { skip--; continue; } if (skip === 0) out.push(whole); continue; }
    if (open) {
      const cls = (/\sclass="([^"]*)"/.exec(attrs)?.[1] ?? "").split(/\s+/);
      const deskOnly = cls.includes("max-lg:hidden");
      const isVoid = self === "/" || VOID.has(open.toLowerCase());
      if (skip > 0 || deskOnly) { if (!isVoid) { stack.push(true); skip++; } continue; }
      if (!isVoid) stack.push(false);
      out.push(whole); continue;
    }
    if (skip === 0) out.push(whole);
  }
  return out.join("");
};
const both = (html: string, needle: string | RegExp) => {
  const has = (h: string) => (typeof needle === "string" ? text(h).includes(needle) : needle.test(text(h)));
  return has(compactMarkup(html)) && has(desktopMarkup(html));
};

// ─────────────────────────────────────────────────────────────────────────────
console.log("1. Debt — All · Credit · Loans at every width");
{
  const debt = (id: string, name: string, balance: number, over: Partial<DebtPerspectiveAccount> = {}): DebtPerspectiveAccount =>
    ({ id, name, type: "debt", institution: "Bank", balance, currency: "USD", ...over });
  // Positive balance = owed (lib/debt/balance-semantics amountOwed).
  const ACCTS: DebtPerspectiveAccount[] = [
    debt("c1", "Sapphire", 1200, { debtSubtype: "credit_card", creditLimit: 10000 }),
    debt("l1", "Auto loan", 14000, { debtSubtype: "auto_loan" }),
    debt("l2", "Mortgage", 280000, { debtSubtype: "mortgage" }),
  ];
  const tabs = (widths?: "compact" | "all") => renderToStaticMarkup(createElement(CompactSectionTabs, {
    ariaLabel: "Debt category", value: "all", onChange: () => {}, widths,
    tabs: [{ id: "all", label: "All", controls: [] }, { id: "credit", label: "Credit", controls: [] }, { id: "loans", label: "Loans", controls: [] }],
  } as never));
  check("an all-widths selector renders at ≥1024px (no lg:hidden) with every tab", !/lg:hidden/.test(tabs("all")) && both(tabs("all"), "All Credit Loans"));
  check("…the default stays compact-only (Net Worth's Total · Assets · Debt — the sidebar has them at ≥lg)", /class="lg:hidden /.test(tabs()) && desktopMarkup(tabs()) === "");
  check("sectionHidden hides at every width (important: a Block is flex); compactHidden is unchanged",
    sectionHidden(true) === "hidden!" && sectionHidden(false) === "" && compactHidden(true) === "max-lg:hidden");

  const dw = code("components/space/widgets/debt/DebtWorkspace.tsx");
  check("Debt tabs are all-widths and every category hide is sectionHidden — no compactHidden left",
    /ariaLabel="Debt category"[\s\S]{0,120}widths="all"/.test(dw) && !/compactHidden/.test(dw) && (dw.match(/sectionHidden\(/g) ?? []).length >= 9);
  check("the per-class donut and the shared-analytics note are not lg:hidden",
    /<div data-debt-class-donut=\{cv\.ledgerClass\}>/.test(dw) && /className="-mt-4 space-y-1 px-1 text-\[12px\][^"]*" data-debt-shared-note>/.test(dw));
  check("the ONLY lg:hidden left in Debt is the compact KPI strip (the desktop hero states those stats inline)",
    (dw.match(/lg:hidden/g) ?? []).length === 1 && /<div className="lg:hidden mt-4">\s*<CompactKpiStrip/.test(dw));

  const ledger = renderToStaticMarkup(createElement(LiabilitiesLedger, { accounts: ACCTS, currency: "USD", compactClass: "loans" }));
  const classPart = (h: string) => h.slice(h.indexOf('data-debt-class-ledger="loans"'));
  check("Loans: the class account list renders in both layouts", both(classPart(ledger), "Auto loan") && both(classPart(ledger), "Mortgage")
    && !/Sapphire/.test(text(classPart(ledger))));
  check("…and the combined list is hidden in both (hidden, not max-lg:hidden)", /overflow-hidden hidden"/.test(ledger) && !/max-lg:hidden|lg:hidden/.test(ledger));

  const loans = renderToStaticMarkup(createElement(DebtCompositionCard, { accounts: ACCTS, ctx: identityContext("USD"), currency: "USD", scope: "loans" }));
  check("Loans donut: 'Where your loans are owed', by loan type, centre = loans owed — both layouts",
    both(loans, "Where your loans are owed") && both(loans, "By loan type") && both(loans, "loans owed"));

  const credit = debtSections({ hasLiabilities: true, hasDebt: true, view: debtCompactVisibility("credit") }).map((s) => s.label).join(" · ");
  const all = debtSections({ hasLiabilities: true, hasDebt: true }).map((s) => s.label).join(" · ");
  check("the sidebar lists only what the selected category shows (Credit)", credit === "Summary · Where your credit is owed · Liabilities · Cost & risk · Credit health", credit);
  check("…and All is unchanged", all === "Summary · Balance history · Where it's owed · Liabilities · Cost & risk · Payoff · Credit health", all);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n2. Assets — one slice control, every state");
{
  const ww = code("components/space/widgets/wealth/WealthWorkspace.tsx");
  check("the Assets tabs render at every width", /ariaLabel="Assets category"[\s\S]{0,120}widths="all"/.test(ww));
  check("…in all four Assets states (history, backfill, read failure, no history)", (ww.match(/\{assetsTabs\}/g) ?? []).length === 4);
  check("no desktop-only chart-header chips duplicate them", !/ariaLabel="Assets series"/.test(ww) && !/headerRight=/.test(ww));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n3. Cash accounts — one row model");
{
  const NOW = new Date().toISOString();
  const state = (reachable: number, pendingSum: number, adjusted: number, basis: string) =>
    ({ reachable, unexplained: null, state: "EXACT", pendingCount: pendingSum ? 1 : 0, pendingSum, adjusted, basis });
  const ACCTS: CashLedgerAccount[] = [
    { id: "chk", name: "Checking", type: "checking", institution: "Chase", balance: 5000, adjustedBalance: 4900, currency: "USD", lastUpdated: NOW,
      currentState: state(4900, -100, 4900, "PENDING_EXCLUDED") } as CashLedgerAccount,
    { id: "unp", name: "No avail", type: "checking", institution: "Ally", balance: 1000, adjustedBalance: 1000, currency: "USD", lastUpdated: NOW,
      currentState: state(950, -50, 1000, "UNPROVEN") } as CashLedgerAccount,
    { id: "agg", name: "Shared accounts", type: "savings", institution: "", balance: 3000, currency: "USD", lastUpdated: NOW,
      aggregate: { memberAccountIds: ["x", "y", "z"], memberCount: 3, owedTotal: 0, creditTotal: 0 } } as CashLedgerAccount,
  ];
  const summary = buildCashAccounts(ACCTS);
  const detailRows = accountDetailFallbackRows(ACCTS, new Date()).map((d) => ({ ...d, mask: d.id === "chk" ? "4321" : null }));
  const html = renderToStaticMarkup(createElement(CashAccountsLedger, { spaceId: "s1", accounts: ACCTS, summary, currency: "USD", detailRows, transitLegs: [] }));
  const desk = desktopMarkup(html).slice(desktopMarkup(html).indexOf("<table"), desktopMarkup(html).indexOf("</table>"));
  const compact = html.slice(html.indexOf("data-compact-cash-accounts"), html.indexOf("</ul>"));
  for (const [what, needle] of [
    ["card mask", "••••4321"],
    ["combined-account note", "3 accounts combined · details withheld"],
    ["pending treatment note", "deducted here"],
    ["per-row unreconciled amount", "$50.00 pending not reconciled"],
  ] as const) {
    check(`${what}: in the desktop table AND the compact rows`, text(desk).includes(needle) && text(compact).includes(needle),
      `desktop=${text(desk).includes(needle)} compact=${text(compact).includes(needle)}`);
  }
  check("the shared row model states them once", cashRowFields(summary.rows.find((r) => r.isAggregate)!).combinedNote === "3 accounts combined · details withheld"
    && cashRowFields(summary.rows.find((r) => r.account.id === "chk")!).pendingNote === "deducted here");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n4. Holdings — search at every width");
{
  const H = (i: number) => ({ instrumentId: `i${i}`, accountId: "a1", symbol: `SYM${i}`, name: `Name ${i}`, quantity: i, reportingValue: 1000 - i * 50, share: 0.1, overallTier: "observed", staleDays: 0, conflicted: false });
  const html = renderToStaticMarkup(createElement(HoldingsLedger, { holdings: Array.from({ length: 8 }, (_, i) => H(i)), reportingCurrency: "USD", accounts: [{ id: "a1", name: "Brokerage" }] } as never));
  check("the doorway into the SEARCHABLE panel renders in both layouts", both(html, "View all 8 holdings"));
  check("the same top rows in both", HOLDINGS_TOP_N === 5 && both(html, "SYM4") && !both(html, "SYM5"));
  check("the panel it opens carries the search field", /aria-label="Search holdings"/.test(read("components/space/widgets/investments/HoldingsLedger.tsx")));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n5. Freshness on compact");
{
  const card = renderToStaticMarkup(createElement(CompactHeroCard, { title: "Net cash flow", freshness: "Last checked 2 hr ago", trust: null, value: "+$1", change: null, range: "As of Oct 27, 2026", currency: "USD" }));
  check("the compact card's R1 carries the freshness claim it is given", /data-compact-hero-freshness="true">Last checked 2 hr ago</.test(card));
  for (const f of ["components/space/widgets/cashflow/CashFlowHero.tsx", "components/space/widgets/cashflow/SpendingSections.tsx"]) {
    const src = code(f);
    check(`${path.basename(f)}: the compact card reads the canonical claim (the sidebar's), never null`,
      /const freshness = useSpaceChrome\(\)\.space\?\.identity\.updatedLabel \?\? null;/.test(src) && /freshness=\{freshness\}/.test(src) && !/freshness=\{null\}/.test(src));
  }
  const host = code("components/dashboard/SpaceDashboard.tsx");
  check("compact: the stale-accounts note under the controls row, amber when stale/unverified (the sidebar's strings)",
    /\{\(chromeFreshnessNote \|\| \(activePerspectiveId === "markets" && chromeUpdated\)\) && \(\s*<p className="lg:hidden mt-2 px-1/.test(host)
      && /color: chromeFreshnessWarn \? "var\(--accent-warning\)" : "var\(--text-faint\)"/.test(host)
      && /\{chromeFreshnessNote\}/.test(host));
  check("…and Markets (no hero card) states the Last checked claim there", /activePerspectiveId === "markets" && chromeUpdated && \(/.test(host));
  check("the sidebar keeps its own (desktop unchanged)", /identity\.freshnessNote/.test(code("components/ui/ContextualNavbar.tsx")));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n6. Cash Flow / Spending meaning on compact — the card height stays fixed");
{
  const change = { abs: 120, pct: 4, fromLabel: "Sep 1, 2026 – Sep 30, 2026" };
  const cf = renderToStaticMarkup(createElement(CashFlowHero as ComponentType<Record<string, unknown>>, {
    facts: { cashIn: 5000, cashOut: 3200 }, currency: "USD", period: "PAST_MONTH", windowLabel: "as of Oct 27, 2026", change,
  }));
  const sp = renderToStaticMarkup(createElement(SpendingHero, { total: 3200, currency: "USD", period: "PAST_MONTH", windowLabel: "as of Oct 27, 2026", change }));
  for (const [name, html, sub] of [["Cash Flow", cf, CASH_FLOW_HERO_SUB], ["Spending", sp, SPENDING_HERO_SUB]] as const) {
    const note = text((html.match(/data-compact-hero-note="true">([\s\S]*?)<\/p>/) ?? ["", ""])[1]);
    check(`${name}: the compact note names the comparison window and the explanation`,
      note === `Change vs ${change.fromLabel} · ${sub.charAt(0).toUpperCase()}${sub.slice(1)}`, note);
    check(`${name}: the note is OUTSIDE the fixed five-row card section`,
      html.indexOf("data-compact-hero-note") > html.indexOf("</section>") && html.indexOf("data-compact-hero-note") < html.indexOf('<section class="max-lg:hidden"'));
    check(`${name}: desktop keeps the same comparison and explanation`, text(desktopMarkup(html)).includes(`vs ${change.fromLabel}`) && text(desktopMarkup(html)).includes(sub));
  }
  const none = renderToStaticMarkup(createElement(SpendingHero, { total: 3200, currency: "USD", period: "PAST_MONTH", windowLabel: "as of Oct 27, 2026", change: null }));
  check("no comparison ⇒ the explanation alone (never an invented window)",
    text((none.match(/data-compact-hero-note="true">([\s\S]*?)<\/p>/) ?? ["", ""])[1]).startsWith("Purchases across cards"));
  check("the card's row heights are untouched (five fixed rows)", /"flex h-6 min-w-0 items-center gap-2",\s*"flex h-12 min-w-0 items-center",\s*"flex h-6 min-w-0 items-center",\s*"flex h-5 min-w-0 items-center",\s*"flex h-10 min-w-0 items-center",/.test(read("components/space/compact/CompactHeroCard.tsx")));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n7. Talk with Fourth Meridian about this — both layouts");
{
  const STATE = { found: true, date: "2026-10-16", netWorth: 1000, totalAssets: 2000, totalLiabilities: 1000, liquidNetWorth: 500, cash: 800, invested: 1200, composition: { investments: 1200, crypto: 0 } };
  const RESULT = { hasHistory: true, asOfState: STATE, compareState: null, deltas: null };
  const ENVELOPE = { completeness: "complete", warnings: [] };
  const wealth = (metric: string) => renderToStaticMarkup(createElement(WealthHero, { result: RESULT, currency: "USD", envelope: ENVELOPE, metric, timePreset: "PAST_MONTH" } as never));
  const KPIS = { totalDebt: 3200, estMonthlyInterest: 53.31, accountCount: 1, owingCount: 1, settledCount: 0, creditCount: 0, ratedCount: 1, unratedCount: 0, utilizationPct: 32, utilizationLevel: "moderate", estimated: false };
  const debtHero = renderToStaticMarkup(createElement(DebtHero, { kpis: KPIS, currency: "USD", liabilityCount: 1, asOf: "2026-10-26", today: "2026-10-26", historical: false, change: null, envelope: ENVELOPE, verdict: null, verdictAsOf: null, redactions: 0 } as never));
  const cf = renderToStaticMarkup(createElement(CashFlowHero as ComponentType<Record<string, unknown>>, { facts: { cashIn: 1, cashOut: 0 }, currency: "USD", period: "PAST_MONTH", windowLabel: "as of Oct 27, 2026", change: null }));
  const count = (h: string) => text(h).split(TALK_ABOUT_THIS_LABEL).length - 1;
  const heroes: [string, string, string][] = [
    ["net-worth", wealth("netWorth"), "about=net-worth"], ["assets", wealth("totalAssets"), "about=assets"],
    ["cash", wealth("cash"), "about=cash"], ["investments", wealth("invested"), "about=investments"],
    ["debt", debtHero, "about=debt"], ["cash-flow", cf, "about=cash-flow"],
  ];
  check("every TalkSection is covered", heroes.map(([s]) => s).join() === TALK_SECTIONS.join());
  for (const [section, html, href] of heroes) {
    const desk = desktopMarkup(html);
    check(`${section}: the link on compact (card row 5) AND on desktop, same topic`,
      count(desk) === 1 && count(html) === 2 && (desk.match(new RegExp(href, "g")) ?? []).length === 1);
  }
  check("the desktop link carries the allowlisted period like the compact one", /about=net-worth&amp;period=PAST_MONTH/.test(desktopMarkup(wealth("netWorth"))));
  const sp = renderToStaticMarkup(createElement(SpendingHero, { total: 1, currency: "USD", period: "PAST_MONTH", windowLabel: "x", change: null }));
  check("Spending has none at either width (no TalkSection — parity, AI templates unchanged)", count(sp) === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n8. Utilization in words · Markets sub-views");
{
  const KPIS = { totalDebt: 3200, estMonthlyInterest: 0, accountCount: 1, owingCount: 1, settledCount: 0, creditCount: 0, ratedCount: 0, unratedCount: 1, utilizationPct: 82, utilizationLevel: "high", estimated: false };
  const html = renderToStaticMarkup(createElement(DebtHero, { kpis: KPIS, currency: "USD", liabilityCount: 1, asOf: "2026-10-26", today: "2026-10-26", historical: false, change: null, envelope: { completeness: "complete", warnings: [] }, verdict: null, verdictAsOf: null, redactions: 0 } as never));
  check("desktop: the level is a word beside the colour", text(desktopMarkup(html)).includes("82% · High"));
  check("compact KPI strip: the same word", debtCompactKpiItems(KPIS as never, "USD").find((i) => i.key === "utilization")?.value === "82% · High");
  check("every level has a word", Object.values(UTILIZATION_LEVEL_LABEL).join() === "Low,Moderate,High,Over limit");

  check("Markets is a placeholder (comingSoon) ⇒ the host publishes no Markets sub-views",
    PERSPECTIVE_LIBRARY[MARKETS_LENS_ID].status === "comingSoon" && publishedWorkspaceChildren(MARKETS_LENS_ID) === undefined);
  check("…while the views stay wired (flip the registry back and they return)", workspaceChildren(MARKETS_LENS_ID)?.length === 5);
  check("Net Worth's children are unchanged", JSON.stringify(publishedWorkspaceChildren(NET_WORTH_LENS_ID)) === JSON.stringify(workspaceChildren(NET_WORTH_LENS_ID)));
}

// Browser finding (local build, 375–430px): the flow note gained "Change vs …"
// once a heatmap period was pinned and wrapped one line longer, moving the
// Activity controls down 15px. The note box is now a fixed three-line height.
{
  const card = readFileSync(path.join(process.cwd(), "components/space/compact/CompactHeroCard.tsx"), "utf8");
  check("compact hero note box has a fixed height (h-[45px] + line-clamp-3), so a comparison label can't shift the page",
    /className="[^"]*\bh-\[45px\][^"]*line-clamp-3[^"]*"[\s\S]{0,120}data-compact-hero-note/.test(card));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
