/**
 * components/space/widgets/liquidity/cash-accounts.test.ts   (v2.7 — Cash accounts)
 *
 * The Cash distribution + Cash accounts ledger: totals, inclusion, grouping,
 * currency, the reconciliation to reachableNow(), markup (desktop vs compact),
 * detail navigation, accessibility, no double counting.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/widgets/liquidity/cash-accounts.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { classifyAccounts } from "@/lib/account-classifier";
import type { ConversionContext } from "@/lib/money/types";
import { reachableNow } from "@/components/space/widgets/liquidity-adapters";
import { desktopMarkup } from "@/components/space/compact/desktop-markup";
import {
  buildCashAccounts, groupCashAccounts, reconcileTerms, cashTypeLabel, isCashAccount,
  type CashLedgerAccount,
} from "./cash-accounts";
import { CashDistribution } from "./CashDistribution";
import { CashAccountsLedger } from "./CashAccountsLedger";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

const NOW = new Date().toISOString();
function acct(id: string, over: Partial<CashLedgerAccount>): CashLedgerAccount {
  return { id, name: id, type: "checking", institution: "Bank", balance: 0, currency: "USD", lastUpdated: NOW, ...over };
}
function cs(reachable: number | null, unexplained: number | null = null, pendingCount = 0) {
  return { reachable, unexplained, state: "EXACT", pendingCount };
}

// The brief's fixture: total 62,589 · accessible 55,560 · restricted 6,009 · not reported 1,000 · held 20.
const FIXTURE: CashLedgerAccount[] = [
  acct("cm",  { name: "Cash Mgmt",    institution: "Wealthfront", providerSubtype: "cash management", balance: 12060, currentState: cs(12060) }),
  acct("hsa", { name: "HSA",          institution: "Fidelity",    providerSubtype: "hsa",             balance: 6009,  currentState: cs(6009) }),
  acct("chk", { name: "Checking",     institution: "Chase",       providerSubtype: "checking",        balance: 110,   currentState: cs(100, 0, 1) }),
  acct("mm",  { name: "Money Market", institution: "Fidelity",    type: "savings", providerSubtype: "money market", balance: 43200, currentState: cs(43200) }),
  acct("cd",  { name: "12-mo CD",     institution: "Chase",       type: "savings", providerSubtype: "cd",           balance: 1000,  currentState: cs(null) }),
  acct("sav", { name: "Savings",      institution: "Chase",       type: "savings", providerSubtype: "savings",      balance: 210,   currentState: cs(200, 0, 2) }),
  // Not cash — must never appear.
  acct("inv", { name: "Brokerage", type: "investment", providerSubtype: "brokerage", balance: 90000 }),
  acct("btc", { name: "Wallet",    type: "crypto",     balance: 5000 }),
  acct("card",{ name: "Card",      type: "debt",       balance: -700 }),
  acct("home",{ name: "Home",      type: "other",      balance: 400000 }),
];

console.log("1. totals — donut + ledger = classifyAccounts total cash; Available = reachableNow");
{
  const s = buildCashAccounts(FIXTURE);
  const c = classifyAccounts(FIXTURE);
  const rowsSum = s.rows.reduce((t, r) => t + r.value, 0);
  check("Σ ledger rows === classifyAccounts totalLiquid + totalRestrictedCash", rowsSum === c.totalLiquid + c.totalRestrictedCash, `${rowsSum} vs ${c.totalLiquid + c.totalRestrictedCash}`);
  check("total cash = 62,589", s.totalCash === 62589);
  for (const by of ["institution", "account", "type"] as const) {
    const g = groupCashAccounts(s, by);
    check(`donut groups (${by}) sum to total cash`, near(g.reduce((t, x) => t + x.value, 0), s.totalCash));
    check(`donut group shares (${by}) sum to 1`, near(g.reduce((t, x) => t + x.share, 0), 1));
  }
  const reach = reachableNow(FIXTURE);
  check("accessible = reachableNow().total = 55,560", s.accessible === reach.total && s.accessible === 55560, `${s.accessible} / ${reach.total}`);
  check("restricted 6,009 · not reported 1,000 · held (pending) 20 · holds 0",
    s.restricted === 6009 && s.notReported === 1000 && near(s.pending, 20) && s.holds === 0 && s.other === 0);
  const terms = reconcileTerms(s);
  check("the reconciling line sums exactly to reachableNow().total",
    near(s.totalCash + terms.reduce((t, x) => t + x.amount, 0), reach.total));
  check("only non-zero terms appear (restricted · not reported · pending)", terms.map((t) => t.id).join() === "restricted,not_reported,pending");
}

console.log("\n2. production reconciliation — pending outflows vs unexplained holds (coordinator correction)");
{
  const PROD: CashLedgerAccount[] = [
    acct("chase", { name: "Chase checking", institution: "Chase",  balance: 5251.68, currentState: cs(929.01, 0, 6) }),
    acct("schwab",{ name: "Schwab checking", institution: "Schwab", balance: 1500,    currentState: cs(0, 1500, 0) }),
    acct("amex",  { name: "Amex savings",   institution: "Amex",   type: "savings", balance: 17000, currentState: cs(15374.59, 1625.41, 0) }),
    acct("a3",    { name: "A3", balance: 1000,    currentState: cs(1000) }),
    acct("a4",    { name: "A4", balance: 5000.08, currentState: cs(5000.08) }),
  ];
  const s = buildCashAccounts(PROD);
  const reach = reachableNow(PROD);
  const c = classifyAccounts(PROD);
  check("total cash 29,751.76 (unchanged definition)", near(s.totalCash, 29751.76) && near(s.totalCash, c.totalLiquid + c.totalRestrictedCash));
  check("accessible 22,303.68 = reachableNow().total", near(s.accessible, 22303.68) && near(s.accessible, reach.total));
  check("pending outflows not yet deducted 4,322.67", near(s.pending, 4322.67), String(s.pending));
  check("unexplained holds 3,125.41", near(s.holds, 3125.41), String(s.holds));
  check("holds agree with reachableNow().unexplainedTotal", near(s.holds, reach.unexplainedTotal));
  const terms = reconcileTerms(s);
  check("line: total − pending − holds = accessible (exact)", terms.map((t) => t.id).join() === "pending,holds"
    && near(s.totalCash + terms.reduce((t, x) => t + x.amount, 0), reach.total));
  const chase = s.rows.find((r) => r.account.id === "chase")!;
  check("Chase row: Available 929.01, pending 4,322.67, no hold",
    chase.available.kind === "amount" && near(chase.available.value, 929.01) && near(chase.available.pending, 4322.67) && chase.available.hold === 0);
  const html = renderToStaticMarkup(createElement(CashAccountsLedger, { spaceId: "s1", accounts: PROD, summary: s, currency: "USD" }));
  check("Available cell sublines: '$4,322.67 pending' and '$1,500.00 on hold'", html.includes("$4,322.67 pending") && html.includes("$1,500.00 on hold"));
  check("footer reconciling line renders both terms",
    html.includes("$29,751.76 total") && html.includes("− $4,322.67 pending outflows not yet deducted") && html.includes("− $3,125.41 on hold") && html.includes("= $22,303.68 accessible"));
  check("pending note shown", html.includes("Total cash uses bank-reported balances, which include pending outflows not yet deducted."));
  const noPending = renderToStaticMarkup(createElement(CashAccountsLedger, { spaceId: "s1", accounts: PROD.slice(1), summary: buildCashAccounts(PROD.slice(1)), currency: "USD" }));
  check("no pending ⇒ no pending note", !noPending.includes("data-cash-pending-note"));
}

console.log("\n3. inclusion — checking + savings incl. HSA; nothing else; each account once");
{
  const s = buildCashAccounts(FIXTURE);
  const ids = s.rows.map((r) => r.account.id).sort().join();
  check("rows are exactly the six cash accounts", ids === "cd,chk,cm,hsa,mm,sav", ids);
  check("investments / crypto / debt / other excluded", !["inv", "btc", "card", "home"].some((id) => s.rows.some((r) => r.account.id === id)));
  check("isCashAccount: HSA (restricted) is cash; investment is not", isCashAccount({ type: "checking", providerSubtype: "hsa" }) && !isCashAccount({ type: "investment" }));
  check("no account appears twice", new Set(s.rows.map((r) => r.account.id)).size === s.rows.length);
  check("rows sorted largest first", s.rows[0].account.id === "mm");
  const hsa = s.rows.find((r) => r.account.id === "hsa")!;
  const cd = s.rows.find((r) => r.account.id === "cd")!;
  check("HSA Available = Restricted", hsa.available.kind === "restricted");
  check("CD with null reachable = Not reported", cd.available.kind === "not_reported");
}

console.log("\n4. grouping — institution · account · type (provider subtype labels)");
{
  const s = buildCashAccounts(FIXTURE);
  const inst = groupCashAccounts(s, "institution");
  check("by institution: Fidelity = MM + HSA (49,209), 2 accounts",
    inst.find((g) => g.label === "Fidelity")?.value === 49209 && inst.find((g) => g.label === "Fidelity")?.count === 2);
  check("by institution: Chase = 1,320 (3 accounts)", inst.find((g) => g.label === "Chase")?.value === 1320 && inst.find((g) => g.label === "Chase")?.count === 3);
  check("by account: one group per account", groupCashAccounts(s, "account").length === 6);
  const types = groupCashAccounts(s, "type").map((g) => g.label).sort().join();
  check("by type: Plaid subtype labels", types === "CD,Cash management,Checking,HSA,Money market,Savings", types);
  check("cashTypeLabel falls back to the broad type", cashTypeLabel({ type: "savings" }) === "Savings" && cashTypeLabel({ type: "checking", providerSubtype: "  " }) === "Checking");
  const colors = inst.map((g) => g.color);
  check("each group has a palette colour, distinct for ≤ 8 groups", colors.every((c) => /^#[0-9a-f]{6}$/i.test(c)) && new Set(colors).size === colors.length);
  check("colours are stable (same set ⇒ same colour)", groupCashAccounts(s, "institution").map((g) => g.color).join() === colors.join());
}

console.log("\n5. currency — EUR display over USD accounts; native subline");
{
  const eur: ConversionContext = Object.freeze({
    target: "EUR",
    resolve(from: string, dateISO: string) {
      return { kind: "rate" as const, rate: from === "EUR" ? 1 : 0.5, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" as const };
    },
  });
  const accts = [...FIXTURE, acct("eur", { name: "Euro acct", institution: "N26", currency: "EUR", balance: 300, currentState: cs(300) })];
  const s = buildCashAccounts(accts, eur);
  const c = classifyAccounts(accts, eur);
  check("EUR: Σ rows === classifyAccounts total cash (same ctx)", near(s.totalCash, c.totalLiquid + c.totalRestrictedCash), `${s.totalCash} vs ${c.totalLiquid + c.totalRestrictedCash}`);
  check("EUR: accessible === reachableNow(ctx).total", near(s.accessible, reachableNow(accts, eur).total));
  check("EUR: USD row converted at 0.5", s.rows.find((r) => r.account.id === "mm")?.value === 21600);
  check("EUR: USD row carries the native amount; EUR row none",
    s.rows.find((r) => r.account.id === "mm")?.native?.currency === "USD" && s.rows.find((r) => r.account.id === "eur")?.native === null);
  const html = renderToStaticMarkup(createElement(CashAccountsLedger, { spaceId: "s1", accounts: accts, summary: s, ctx: eur, currency: "EUR" }));
  check("ledger renders € figures and the native $ subline", html.includes("€21,600.00") && html.includes("$43,200.00"));
  const donut = renderToStaticMarkup(createElement(CashDistribution, { summary: s, currency: "EUR" }));
  check("donut centre states Total cash in €", donut.includes("Total cash") && donut.includes(`€${s.totalCash.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`));
  check("no $ figure in the donut", !donut.includes("$"));
}

console.log("\n6. empty + partially connected");
{
  const empty = buildCashAccounts([acct("inv", { type: "investment", balance: 10 })]);
  const d = renderToStaticMarkup(createElement(CashDistribution, { summary: empty, currency: "USD" }));
  check("empty: honest empty state, no donut svg", d.includes("No cash accounts yet") && !d.includes("<svg"));
  const l = renderToStaticMarkup(createElement(CashAccountsLedger, { spaceId: "s1", accounts: [], summary: empty, currency: "USD" }));
  check("empty: ledger says so", l.includes("No cash accounts in this Space yet."));
  const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const partial = [acct("stale", { name: "Old Bank", balance: 50, lastUpdated: old }), acct("never", { name: "No clock", balance: 20, lastUpdated: undefined })];
  const html = renderToStaticMarkup(createElement(CashAccountsLedger, { spaceId: "s1", accounts: partial, summary: buildCashAccounts(partial), currency: "USD" }));
  check("stale account shows the freshness authority's wording + stale marker", html.includes("Balance checked 20 days ago") && html.includes("· stale"));
  check("no clock ⇒ 'Freshness unknown' (never invented)", html.includes("Freshness unknown"));
  const detailRows = [{
    id: "stale", spaceAccountLinkId: "l", visibility: "FULL", name: "Old Bank", institution: "Bank", type: "checking", mask: "1234",
    balance: 50, currency: "USD", isManual: false, isUserEstimate: false, canManage: false, connectionState: "needs_reauth", importBatchCount: 0,
    freshness: { accountId: "stale", balance: { observedAt: old, basis: "INGESTION", ageDays: 20, band: "STALE", providerClockUnknown: true, ingestedAt: old, providerAttestedAt: null, contradictory: false }, ledger: { kind: "UNKNOWN" }, absValue: 50 },
    balances: {} as never, reconciliation: {} as never,
  }];
  const withChip = renderToStaticMarkup(createElement(CashAccountsLedger, { spaceId: "s1", accounts: partial.slice(0, 1), summary: buildCashAccounts(partial.slice(0, 1)), currency: "USD", detailRows: detailRows as never }));
  check("connection chip from the existing Accounts read (healthChip)", withChip.includes("Needs reconnection") && withChip.includes("••••1234"));
}

console.log("\n7. aggregate privacy rows — as-is, no detail, counted by members, never doubled");
{
  const accts = [
    acct("agg", { name: "Shared checking (2)", institution: "", balance: 900, aggregate: { memberAccountIds: ["m1", "m2"], memberCount: 2, owedTotal: 0, creditTotal: 0 } }),
    acct("own", { name: "Mine", balance: 100 }),
  ];
  const s = buildCashAccounts(accts);
  check("aggregate counted once in total (900 + 100)", s.totalCash === 1000 && s.rows.length === 2);
  check("account count is member-aware (3)", s.accountCount === 3);
  const html = renderToStaticMarkup(createElement(CashAccountsLedger, { spaceId: "s1", accounts: accts, summary: s, currency: "USD" }));
  check("aggregate row has no detail button", !html.includes("Open details for Shared checking (2)") && html.includes("Open details for Mine"));
  check("aggregate row states it is combined", html.includes("2 accounts combined") && html.includes("Shared (institution withheld)"));
}

console.log("\n8. markup — desktop table vs compact rows; a11y; detail navigation");
{
  const s = buildCashAccounts(FIXTURE);
  const html = renderToStaticMarkup(createElement(CashAccountsLedger, { spaceId: "s1", accounts: FIXTURE, summary: s, currency: "USD" }));
  const desk = desktopMarkup(html);
  check("desktop: a real table with caption + column headers (scope=col)", desk.includes("<table") && desk.includes("<caption") && (desk.match(/scope="col"/g) ?? []).length === 7);
  check("desktop: row headers (scope=row) per account", (desk.match(/scope="row"/g) ?? []).length === 6);
  check("desktop: the compact list does not render", !desk.includes("data-compact-cash-accounts"));
  check("desktop columns: Institution · Account · Type · Balance · % of cash · Available · Status",
    ["Institution", "Account", "Type", "Balance", "% of cash", "Available", "Status"].every((h) => desk.includes(`>${h}</th>`)));
  check("compact: list present and NOT behind a disclosure", html.includes('class="lg:hidden divide-y') && !html.includes("aria-expanded"));
  check("compact: every account visible (6 rows)", (html.match(/<li>/g) ?? []).length === 6);
  check("desktop table hidden only below lg (max-lg:hidden)", html.includes("max-lg:hidden overflow-x-auto"));
  check("rows open detail via real buttons (keyboard reachable) with labels",
    (html.match(/<button type="button"[^>]*aria-label="Open details for /g) ?? []).length === 12);
  check("Available states: Restricted · Not reported · amounts", html.includes(">Restricted<") && html.includes(">Not reported<") && html.includes("$43,200.00"));
  check("footer: Total cash and Accessible now, labelled distinctly", html.includes("Total cash") && html.includes("Accessible now") && !html.includes("Accessible cash"));
  check("footer line (brief fixture)", html.includes("$62,589.00 total") && html.includes("− $6,009.00 restricted") && html.includes("− $1,000.00 no available balance reported") && html.includes("− $20.00 pending outflows not yet deducted") && html.includes("= $55,560.00 accessible"));
  const donut = renderToStaticMarkup(createElement(CashDistribution, { summary: s, currency: "USD" }));
  check("donut: grouping control is a labelled radiogroup", donut.includes('role="radiogroup" aria-label="Group total cash"') && donut.includes("By institution") && donut.includes("By account type"));
  check("donut: labelled group with the total", donut.includes('aria-label="Total cash by institution: $62,589.00"'));
  check("donut: each group shows name, balance and % (legend)", donut.includes("Fidelity") && donut.includes("$49,209.00") && donut.includes("78.6%"));
}

console.log("\n9. source guards — reuse, no new authority");
{
  const src = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  const helper = src("components/space/widgets/liquidity/cash-accounts.ts");
  const ledger = src("components/space/widgets/liquidity/CashAccountsLedger.tsx");
  check("helper reads Available through reachableForAccount (no re-derived rule)", helper.includes("reachableForAccount(a, ctx)"));
  check("helper classifies through liquidityAccess", helper.includes("liquidityAccess(a)"));
  check("no USD literal in the new components", !/"USD"/.test(ledger) && !/"USD"/.test(src("components/space/widgets/liquidity/CashDistribution.tsx")));
  check("ledger uses only the existing detail route (no new API)", (ledger.match(/fetch\(/g) ?? []).length === 1 && ledger.includes("/accounts/detail"));
  const ws = src("components/space/widgets/liquidity/LiquidityWorkspace.tsx");
  check("Accessible cash tile renders the existing reachableDisclosure()", ws.includes("reachableDisclosure(reach") && ws.includes("data-reach-disclosure"));
}

if (failures > 0) { console.error(`\n${failures} cash-accounts check(s) failed`); process.exit(1); }
console.log("\nAll cash-accounts checks passed");
