/**
 * components/space/compact/compact-debt.test.ts  (COMPACT DASHBOARD — P3)
 *
 *   1. exactly three tabs, All · Credit · Loans; Credit/Loans = the EXISTING
 *      liability classes (classifyDebt), nothing reclassified;
 *   2. the truth table — shared analytics (history, interest cost, payoff, the
 *      derived credit signals) are NEVER on a category tab, and each tab says so;
 *   3. the ledger: a category shows ALL its accounts on compact (not the top-five
 *      inline list), with the same rows/shares/detail; desktop markup unchanged;
 *   4. ?section= — parsed with an allowlist, written only in Debt (replace), and
 *      cleared on any mode change or workspace re-open;
 *   5. the compact hierarchy inside Debt and compact-only hiding.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/compact/compact-debt.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { desktopMarkup } from "./desktop-markup";
import { DEBT_SHARED_NOTE, debtClassCounts, debtCompactVisibility } from "./compact-sections";
import { LiabilitiesLedger } from "@/components/space/widgets/debt/LiabilitiesLedger";
import { classifyDebt } from "@/components/space/widgets/debt/debt-ledger-util";
import type { DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";
import {
  DEBT_SECTIONS, DEBT_SECTION_LABELS, DEBT_SECTION_PARAM, parseDebtSection, serializeDebtSection,
} from "@/lib/wealth/wealth-mode";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const dw = code("components/space/widgets/debt/DebtWorkspace.tsx");
const nav = code("lib/space/use-space-navigation.ts");

const debt = (id: string, name: string, balance: number, over: Partial<DebtPerspectiveAccount> = {}): DebtPerspectiveAccount =>
  ({ id, name, type: "debt", institution: "Bank", balance, currency: "USD", ...over });
// The P0 baseline fixture (cards, loans, other) …
const BASE: DebtPerspectiveAccount[] = [
  debt("c1", "Sapphire", -1200, { debtSubtype: "credit_card", creditLimit: 10000, interestRate: 24.99 }),
  debt("c2", "Freedom", -300, { debtSubtype: "credit_card", creditLimit: 5000 }),
  debt("l1", "Auto loan", -14000, { debtSubtype: "auto_loan", interestRate: 6.5 }),
  debt("l2", "Mortgage", -280000, { debtSubtype: "mortgage", interestRate: 5.1 }),
  debt("o1", "IOU", -500),
];
// … and a Space with more cards than the inline list holds.
const MANY_CARDS = [...BASE, ...[3, 4, 5, 6, 7].map((i) => debt(`c${i}`, `Card ${i}`, -50 * i, { debtSubtype: "credit_card", creditLimit: 2000 }))];

console.log("1. three tabs over the existing classification");
check("All · Credit · Loans, in that order", DEBT_SECTIONS.map((s) => DEBT_SECTION_LABELS[s]).join(" · ") === "All · Credit · Loans");
check("Credit = classifyDebt 'cards', Loans = classifyDebt 'loans', 'other' only under All",
  classifyDebt(BASE[0]) === "cards" && classifyDebt(BASE[2]) === "loans" && classifyDebt(BASE[3]) === "loans" && classifyDebt(BASE[4]) === "other");
check("the class counts come from that same rule", JSON.stringify(debtClassCounts(BASE)) === JSON.stringify({ cards: 2, loans: 2, other: 1 }));
check("no new classification was introduced (compact code only calls classifyDebt)",
  /counts\[classifyDebt\(a\)\]\+\+/.test(read("components/space/compact/compact-sections.ts")) && !/debtSubtype ===/.test(read("components/space/compact/compact-sections.ts")));

console.log("\n2. the truth table — shared analytics stay in All");
{
  const all = debtCompactVisibility("all"), credit = debtCompactVisibility("credit"), loans = debtCompactVisibility("loans");
  check("All shows everything and needs no note",
    Object.entries(all).every(([k, v]) => k === "ledgerClass" ? v === null : k === "sharedNote" ? v === false : v === true));
  for (const [name, v] of [["Credit", credit], ["Loans", loans]] as const) {
    check(`${name}: no debt history (it is the total-liabilities series)`, !v.history);
    check(`${name}: no interest cost (every debt's APR together)`, !v.interestCost);
    check(`${name}: no payoff planner (every balance together)`, !v.payoff);
    check(`${name}: no derived credit signals (they include all-debt facts)`, !v.creditSignals);
    check(`${name}: says where the shared analytics are`, v.sharedNote);
  }
  check("Credit shows its accounts, utilization, score and limits (credit by nature, listed by account)",
    credit.ledgerClass === "cards" && credit.utilization && credit.costRisk && credit.creditHealth);
  check("Loans shows its accounts only", loans.ledgerClass === "loans" && !loans.costRisk && !loans.utilization && !loans.creditHealth);
  check("the note names the shared analytics and points to All", /history, interest cost, payoff planning and credit signals cover all your debts together — see All\./.test(DEBT_SHARED_NOTE));
  check("…and mentions liabilities that are neither credit nor loans", /other \{otherCount === 1 \? "liability is" : "liabilities are"\} listed under All/.test(dw));
}

console.log("\n3. the ledger per category");
{
  const ledger = (accounts: DebtPerspectiveAccount[], compactClass: "cards" | "loans" | null) =>
    renderToStaticMarkup(createElement(LiabilitiesLedger, { accounts, currency: "USD", compactClass }));
  const html = ledger(MANY_CARDS, "cards");
  const compactPart = html.slice(html.indexOf('data-compact-ledger="cards"'));
  check("Credit lists EVERY card on compact (7 here — more than the 5-row inline list)",
    ["Sapphire", "Freedom", "Card 3", "Card 4", "Card 5", "Card 6", "Card 7"].every((n) => compactPart.includes(`>${n}<`)) && !compactPart.includes(">Mortgage<"));
  check("…and nothing that is not a card (closed panels render nothing, so the compact block runs to the end)",
    !/>Auto loan<|>Mortgage<|>IOU</.test(compactPart));
  const loansHtml = ledger(BASE, "loans");
  const loansPart = loansHtml.slice(loansHtml.indexOf('data-compact-ledger="loans"'));
  check("Loans lists the loans", loansPart.includes(">Auto loan<") && loansPart.includes(">Mortgage<"));
  const shareOf = (h: string, name: string) => (new RegExp(`width:([0-9.]+)%[^>]*></span>[\\s\\S]{0,600}?>${name}<`).exec(h) ?? [])[1];
  check("shares are still of TOTAL debt (the same rows, not re-based to the category)",
    shareOf(loansPart, "Mortgage") !== undefined && shareOf(loansPart, "Mortgage") === shareOf(ledger(BASE, null), "Mortgage"));
  check("an empty category says so", /No loans in this Space\./.test(ledger([BASE[0]], "loans")));
  const baseline = JSON.parse(read("components/space/compact/desktop-baseline.json")) as { renders: Record<string, string> };
  check("DESKTOP: with a category set, the ≥1024px ledger markup equals the P0 baseline",
    desktopMarkup(ledger(BASE, "cards")) === baseline.renders["LiabilitiesLedger (cards, loans, other)"]);
}

console.log("\n4. ?section= in the URL");
check("allowlisted: unknown or absent ⇒ All", parseDebtSection(null) === "all" && parseDebtSection("bogus") === "all" && parseDebtSection("LOANS") === "loans");
check("All writes no param; the others write their name", serializeDebtSection("all") === null && serializeDebtSection("credit") === "credit" && DEBT_SECTION_PARAM === "section");
check("written by the ONE URL writer, only in Debt (any other mode clears it)",
  /\[DEBT_SECTION_PARAM\]: wealthMode === "debt" \? serializeDebtSection\(debtSection\) : null/.test(nav));
check("a category change is a view change: no push declared (REPLACE)",
  /const handleDebtSectionChange = useCallback\(\(sec: DebtSection\) => setDebtSection\(sec\), \[\]\);/.test(nav));
check("leaving Debt never leaves a stale category", /if \(m !== "debt"\) setDebtSection\(DEFAULT_DEBT_SECTION\);/.test(nav));
check("re-opening Net Worth and legacy links reset it",
  (nav.match(/setDebtSection\(DEFAULT_DEBT_SECTION\);/g) ?? []).length >= 3);
check("read back on load and Back/Forward — only in Debt, and only while the tabs are enabled",
  /setDebtSection\(DEBT_CATEGORY_TABS_ENABLED && mode === "debt" \? parseDebtSection\(readSpaceParam\(search, DEBT_SECTION_PARAM\)\) : DEFAULT_DEBT_SECTION\);/.test(nav));

console.log("\n5. hierarchy and compact-only hiding");
{
  const body = dw.slice(dw.indexOf('<div id="debt-summary"'));
  check("compact order: Debt hero → Total·Assets·Debt → All·Credit·Loans → note → history",
    body.indexOf("<DebtHero") < body.indexOf("{compactModeSelector}") && body.indexOf("{compactModeSelector}") < body.indexOf("{debtTabs}")
      && body.indexOf("{debtTabs}") < body.indexOf("data-compact-debt-note") && body.indexOf("data-compact-debt-note") < body.indexOf('id="debt-history"'));
  check("the tabs bind the compact section and its handler", /<CompactSectionTabs\s+ariaLabel="Debt category"\s+value=\{compactSection\}\s+onChange=\{onCompactSectionChange\}/.test(dw));
  check("every hide is compact-only",
    /id="debt-history" className=\{`scroll-mt-20 \$\{compactHidden\(!cv\.history\)\}`/.test(dw)
      && /id="debt-costrisk" label="Cost & risk" className=\{compactHidden\(!cv\.costRisk\)\}/.test(dw)
      && /\$\{compactHidden\(!cv\.interestCost\)\}/.test(dw)
      && /id="debt-payoff" label="Payoff strategy" className=\{compactHidden\(!cv\.payoff\)\}/.test(dw)
      && /id="debt-credit" label="Credit health" className=\{compactHidden\(!cv\.creditHealth\)\}/.test(dw)
      && /\$\{compactHidden\(!cv\.creditSignals\)\}/.test(dw));
  check("the Liabilities header counts the category on compact, all liabilities on desktop",
    /\{DEBT_CLASS_LABEL\[cv\.ledgerClass\]\} · \{classCount\}/.test(dw) && /\$\{compactHidden\(!!cv\.ledgerClass\)\}/.test(dw));
  check("no figure authority changed: the same kpis/signals/interest/payoff calls", /computeDebtKpis\(accounts, ctx\)/.test(dw) && /buildDebtSignals\(\{ accounts, ctx, lensResult: lens \}\)/.test(dw) && /renderDebtPayoffCalculator\(accounts, false, undefined, ctx, today, handleAddApr\)/.test(dw));
}

console.log("\n6. Credit / Loans are ENABLED (v2.7 R3) on the display-only classifier");
{
  const wm = read("lib/wealth/wealth-mode.ts");
  // v2.7 R3 — DELIBERATE PIN CHANGE: the tabs were withheld while no reliable
  // subtype existed; R2's presentationDebtClass (owner D-4/D-5) is that basis.
  check("the flag is on, with the basis recorded where it lives",
    /export const DEBT_CATEGORY_TABS_ENABLED = true;/.test(wm) && /presentationDebtClass/.test(wm) && /never a\s*\*\s*credit-limit inference/.test(wm));
  check("the flag still gates the tabs and the compact visibility (a single switch)",
    /const debtTabs = DEBT_CATEGORY_TABS_ENABLED && liabilityCount > 0 && onCompactSectionChange \?/.test(dw)
      && /const cv = debtCompactVisibility\(DEBT_CATEGORY_TABS_ENABLED \? compactSection : "all"\);/.test(dw));
  check("…and ?section= is read only in Debt while enabled", /DEBT_CATEGORY_TABS_ENABLED && mode === "debt"/.test(nav));
  // v2.7 R2 — DELIBERATE PIN CHANGE. This pinned that no providerSubtype mapping
  // existed. R2 adds the owner-approved DISPLAY-ONLY mapping (presentationDebtClass)
  // while the tabs stay withheld; the pin now asserts the flag is still the gate
  // and that the classifier no longer infers a card from a credit limit (owner D-5).
  check("R2: the classifier maps providerSubtype for display only and never infers a card from a limit",
    /export function presentationDebtClass\(/.test(code("components/space/widgets/debt/debt-ledger-util.ts"))
      && !/creditLimit/.test(code("components/space/widgets/debt/debt-ledger-util.ts").split("export function accountUtilization")[0]));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
