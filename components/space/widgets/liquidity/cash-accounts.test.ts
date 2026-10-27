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
  buildCashAccounts, groupCashAccounts, reconcileTerms, pendingLine, cashTypeLabel, isCashAccount,
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
/** v2.7-P0 — a server claim WITH the adjusted balance (as the Space mount emits it). */
function adj(balance: number, a: { reachable: number | null; unexplained?: number | null; pendingCount?: number; pendingSum?: number; adjusted?: number; basis: "NO_PENDING" | "PENDING_EXCLUDED" | "PENDING_INCLUDED" | "UNPROVEN" }) {
  const adjusted = a.adjusted ?? balance;
  return {
    balance,
    adjustedBalance: adjusted,
    currentState: {
      reachable: a.reachable, unexplained: a.unexplained ?? null, state: "EXACT",
      pendingCount: a.pendingCount ?? 0, pendingSum: a.pendingSum ?? 0, adjusted, basis: a.basis,
    },
  };
}

// The brief's fixture: total 62,589 · accessible 55,560 · restricted 6,009 · not reported 1,000 · held 20
// (two $10 HOLDS — the sandbox evidence; no pending, so adjusted = reported).
const FIXTURE: CashLedgerAccount[] = [
  acct("cm",  { name: "Cash Mgmt",    institution: "Wealthfront", providerSubtype: "cash management", balance: 12060, currentState: cs(12060) }),
  acct("hsa", { name: "HSA",          institution: "Fidelity",    providerSubtype: "hsa",             balance: 6009,  currentState: cs(6009) }),
  acct("chk", { name: "Checking",     institution: "Chase",       providerSubtype: "checking",        balance: 110,   currentState: cs(100, 10) }),
  acct("mm",  { name: "Money Market", institution: "Fidelity",    type: "savings", providerSubtype: "money market", balance: 43200, currentState: cs(43200) }),
  acct("cd",  { name: "12-mo CD",     institution: "Chase",       type: "savings", providerSubtype: "cd",           balance: 1000,  currentState: cs(null) }),
  acct("sav", { name: "Savings",      institution: "Chase",       type: "savings", providerSubtype: "savings",      balance: 210,   currentState: cs(200, 10) }),
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
  check("restricted 6,009 · not reported 1,000 · holds 20 · no pending correction",
    s.restricted === 6009 && s.notReported === 1000 && near(s.holds, 20) && s.pendingCorrection === 0 && s.other === 0 && s.unreconciled === 0);
  check("no adjusted claim ⇒ reported === total cash (prior arithmetic)", s.reported === s.totalCash && pendingLine(s) === null);
  const terms = reconcileTerms(s);
  check("the reconciling line sums exactly to reachableNow().total",
    near(s.totalCash + terms.reduce((t, x) => t + x.amount, 0), reach.total));
  check("only non-zero terms appear (restricted · not reported · holds)", terms.map((t) => t.id).join() === "restricted,not_reported,holds");
}

console.log("\n2. production 10-26 — adjusted total cash (owner-approved P0 contract)");
{
  // Anonymized Production 10-26 claims, exactly as the Space mount emits them
  // (the end-to-end derivation from C/A/P lives in lib/balances/adjusted-balance.test.ts).
  const PROD: CashLedgerAccount[] = [
    acct("a1", { name: "A1 checking", institution: "Bank 1", ...adj(5251.68, { reachable: 929.01, unexplained: 0, pendingCount: 6, pendingSum: -4322.67, adjusted: 929.01, basis: "PENDING_EXCLUDED" }) }),
    acct("a2", { name: "A2 checking", institution: "Bank 2", ...adj(1500, { reachable: 0, unexplained: 1500, basis: "NO_PENDING" }) }),
    acct("a3", { name: "A3 checking", institution: "Bank 3", ...adj(1000, { reachable: 1000, unexplained: 0, basis: "NO_PENDING" }) }),
    acct("a4", { name: "A4 savings",  institution: "Bank 1", type: "savings", ...adj(5000.08, { reachable: 5000.08, unexplained: 0, basis: "NO_PENDING" }) }),
    acct("a5", { name: "A5 savings",  institution: "Bank 3", type: "savings", ...adj(17000, { reachable: 15374.59, unexplained: 1625.41, basis: "NO_PENDING" }) }),
  ];
  const s = buildCashAccounts(PROD);
  const reach = reachableNow(PROD);
  const c = classifyAccounts(PROD);
  check("reported 29,751.76", near(s.reported, 29751.76), String(s.reported));
  check("pending correction −4,322.67 (PENDING_EXCLUDED only)", near(s.pendingCorrection, -4322.67), String(s.pendingCorrection));
  check("total cash 25,429.09 = classifyAccounts cash (adjusted)", near(s.totalCash, 25429.09) && near(s.totalCash, c.totalLiquid + c.totalRestrictedCash));
  check("reported + correction = total cash (exact)", near(s.reported + s.pendingCorrection, s.totalCash));
  check("accessible 22,303.68 = reachableNow().total (unchanged)", near(s.accessible, 22303.68) && near(s.accessible, reach.total));
  check("holds 3,125.41 = reachableNow().unexplainedTotal", near(s.holds, 3125.41) && near(s.holds, reach.unexplainedTotal));
  const terms = reconcileTerms(s);
  check("line: total cash − holds = accessible (exact; pending is NOT a term)", terms.map((t) => t.id).join() === "holds"
    && near(s.totalCash + terms.reduce((t, x) => t + x.amount, 0), reach.total));
  const a1 = s.rows.find((r) => r.account.id === "a1")!;
  check("A1 row: reported 5,251.68 · total cash 929.01 · Available 929.01 · no hold",
    near(a1.reported, 5251.68) && near(a1.value, 929.01) && a1.basis === "PENDING_EXCLUDED"
    && a1.available.kind === "amount" && near(a1.available.value, 929.01) && a1.available.hold === 0);
  const html = renderToStaticMarkup(createElement(CashAccountsLedger, { spaceId: "s1", accounts: PROD, summary: s, currency: "USD" }));
  check("footer: Reported $29,751.76 − pending not yet deducted $4,322.67 = Total cash $25,429.09",
    html.includes("Reported $29,751.76 − pending not yet deducted $4,322.67 = Total cash $25,429.09"));
  check("footer: $25,429.09 total cash − $3,125.41 on hold = $22,303.68 accessible",
    html.includes("$25,429.09 total cash") && html.includes("− $3,125.41 on hold") && html.includes("= $22,303.68 accessible"));
  check("A1 pending cell: −$4,322.67, deducted here", html.includes("−$4,322.67") && html.includes("deducted here"));
  check("no UNPROVEN account ⇒ no badge, no note", !html.includes("data-cash-unproven"));
  const noPending = renderToStaticMarkup(createElement(CashAccountsLedger, { spaceId: "s1", accounts: PROD.slice(1), summary: buildCashAccounts(PROD.slice(1)), currency: "USD" }));
  check("no pending ⇒ no reported → total cash line", !noPending.includes("data-cash-pending-line"));

  // UNPROVEN: pending exists, no available figure ⇒ reported counted, flagged.
  const UNP: CashLedgerAccount[] = [
    acct("u", { name: "No avail", ...adj(1000, { reachable: 950, unexplained: null, pendingCount: 1, pendingSum: -50, basis: "UNPROVEN" }) }),
  ];
  const su = buildCashAccounts(UNP);
  check("UNPROVEN: total cash = reported 1,000 (never 950)", su.totalCash === 1000 && su.pendingCorrection === 0);
  check("UNPROVEN: the 50 is an 'unreconciled' term, line exact", near(su.unreconciled, 50)
    && near(su.totalCash + reconcileTerms(su).reduce((t, x) => t + x.amount, 0), su.accessible));
  const hu = renderToStaticMarkup(createElement(CashAccountsLedger, { spaceId: "s1", accounts: UNP, summary: su, currency: "USD" }));
  check("UNPROVEN: badge + footer note rendered", hu.includes("Pending not reconciled") && hu.includes("data-cash-unproven-note") && hu.includes("− $50.00 pending not reconciled"));
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
  check("desktop: a real table with caption + column headers (scope=col)", desk.includes("<table") && desk.includes("<caption") && (desk.match(/scope="col"/g) ?? []).length === 10);
  check("desktop: row headers (scope=row) per account", (desk.match(/scope="row"/g) ?? []).length === 6);
  check("desktop: the compact list does not render", !desk.includes("data-compact-cash-accounts"));
  check("desktop columns: Institution · Account · Type · Reported · Pending · Total cash · % of cash · Available · Holds · Status",
    ["Institution", "Account", "Type", "Reported", "Pending", "Total cash", "% of cash", "Available", "Holds", "Status"].every((h) => desk.includes(`>${h}</th>`)));
  check("compact: list present and NOT behind a disclosure", html.includes('class="lg:hidden divide-y') && !html.includes("aria-expanded"));
  check("compact: every account visible (6 rows)", (html.match(/<li>/g) ?? []).length === 6);
  check("desktop table hidden only below lg (max-lg:hidden)", html.includes("max-lg:hidden overflow-x-auto"));
  check("rows open detail via real buttons (keyboard reachable) with labels",
    (html.match(/<button type="button"[^>]*aria-label="Open details for /g) ?? []).length === 12);
  check("Available states: Restricted · Not reported · amounts", html.includes(">Restricted<") && html.includes(">Not reported<") && html.includes("$43,200.00"));
  check("footer: Total cash and Accessible now, labelled distinctly", html.includes("Total cash") && html.includes("Accessible now") && !html.includes("Accessible cash"));
  check("footer line (brief fixture)", html.includes("$62,589.00 total cash") && html.includes("− $6,009.00 restricted") && html.includes("− $1,000.00 no available balance reported") && html.includes("− $20.00 on hold") && html.includes("= $55,560.00 accessible"));
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
