/**
 * components/space/widgets/debt/debt-experience.render.test.ts
 *
 * RENDER-PATH + SOURCE proof for the consolidated debt experience (house
 * pattern: standalone tsx + renderToStaticMarkup, DB-free):
 *
 *   npx tsx components/space/widgets/debt/debt-experience.render.test.ts
 *
 * The pure suites prove the math (lib/debt/payoff.test.ts) and the write path
 * (lib/debt/user-terms.test.ts). This proves what a user SEES and what no
 * longer exists:
 *
 *   A. Interest cost lists every debt's APR, offers an edit on each, shows an
 *      unknown rate as UNKNOWN (never $0 of interest), and re-renders a
 *      different cost when the APR prop changes.
 *   B. Payoff Strategy opens at 50, has no weekly toggle, no minimum payment,
 *      prints the engine's precise horizon + final payment, and refuses a
 *      timeline when an APR is unknown.
 *   C. Credit health exposes the user's inputs for edit and the derived values
 *      as read-only text.
 *   D. The redundant interest / APR / minimum-payment surfaces are gone — from
 *      the markup AND from the source.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DebtPayoffSection } from "@/components/space/sections/DebtPayoffSection";
import { InterestCostWidget } from "./InterestCostWidget";
import { CreditScoreInput, CreditLimitInputs } from "./CreditHealthInputs";
import { LiabilitiesLedger } from "./LiabilitiesLedger";
import { DebtHero } from "./DebtHero";
import { computeDebtKpis } from "./debt-kpis";
import { renderDebtByAccount, type DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";
import { renderDebtBreakdownChart } from "@/components/space/widgets/debt-adapters";
import { resolvePerspectiveEnvelope } from "@/lib/perspectives/envelope";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const acct = (id: string, name: string, balance: number, over: Partial<DebtPerspectiveAccount> = {}): DebtPerspectiveAccount => ({
  id, name, type: "debt", institution: "Bank", balance, currency: "USD", debtSubtype: "credit_card", ...over,
});
const ROOT = process.cwd();
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
/** Source with comments removed — a retired name may be EXPLAINED in a comment, never used. */
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const TODAY = "2026-01-01";

// ── A. Interest cost ─────────────────────────────────────────────────────────
console.log("A. INTEREST COST — the one APR surface");
{
  const accounts = [
    acct("a", "Card A", 1200, { interestRate: 24, minimumPayment: 35 }),
    acct("b", "Card B", 600),                                  // APR UNKNOWN
    acct("c", "Paid Off", 0, { interestRate: 19.99 }),
  ];
  const html = renderToStaticMarkup(createElement(InterestCostWidget, { accounts }));
  const t = text(html);
  check("views the APR of each rated account", t.includes("24.00% APR") && t.includes("19.99% APR"), t);
  check("each rated APR is an EDIT control", html.includes('aria-label="Edit APR for Card A"') && html.includes('aria-label="Edit APR for Paid Off"'));
  check("an unknown APR offers 'Add APR'", t.includes("Add APR"));
  check("unknown APR reads as UNKNOWN interest — never a 0 figure", t.includes("Card B Interest unknown — no APR on file"), t);
  check("known cost: 1200 × 24% / 12 = 24/mo", t.includes("24/mo est. interest"), t);
  check("the total excludes the unknown row and says so", t.includes("1 debt without an APR not counted"));
  check("no minimum payment anywhere", !/min/i.test(t.replace(/Estimated/g, "")), t);

  // The APR prop changes (what the host re-read delivers after a save) ⇒ the cost changes.
  const after = text(renderToStaticMarkup(createElement(InterestCostWidget, {
    accounts: [accounts[0], { ...accounts[1], interestRate: 18 }, accounts[2]],
  })));
  check("after Card B gains an APR: its row now costs 9/mo", after.includes("9/mo est. interest") && !after.includes("Interest unknown"), after);
  check("…and the total moved 24 → 33/mo", t.includes("Estimated interest 24/mo") && after.includes("Estimated interest 33/mo"), after);

  // A privacy-aggregated row has no single liability behind its synthetic id.
  const agg = renderToStaticMarkup(createElement(InterestCostWidget, {
    accounts: [acct("agg", "2 shared cards", 900, { aggregate: { memberAccountIds: ["x", "y"], memberCount: 2 } })],
  }));
  check("an aggregated row offers no APR edit", !agg.includes("Add APR") && text(agg).includes("APR unknown"));

  const widget = code("components/space/widgets/debt/InterestCostWidget.tsx");
  check("writes through saveAccountApr (the debt-profile authority), not a fetch of its own",
    widget.includes("saveAccountApr(") && !widget.includes("fetch("));
  check("holds no APR in state — only the draft string", !/useState<number/.test(widget) && !/setApr\b/.test(widget));
  check("does no interest arithmetic of its own", !/\/\s*12\b/.test(widget) && !/\/\s*100\b/.test(widget));
  check("after a save it broadcasts the accounts re-read", widget.includes("SPACE_ACCOUNTS_CHANGED_EVENT"));
}

// ── B. Payoff strategy ───────────────────────────────────────────────────────
console.log("B. PAYOFF STRATEGY — $50 default, monthly only, precise timing");
{
  // 124 @ 0%, 50/mo from 2026-01-01: two full payments leave 24; March has 31 days,
  // first d with 50·d/31 ≥ 24 is 15 ⇒ 2 months, 2 weeks, 1 day; final payment 24.00.
  const html = renderToStaticMarkup(createElement(DebtPayoffSection, {
    accounts: [acct("a", "Card A", 124, { interestRate: 0, minimumPayment: 35 })], today: TODAY,
  }));
  const t = text(html);
  check("opens at a 50 payment", html.includes('value="50"'), t);
  check("does NOT open at 500", !html.includes('value="500"'));
  check("precise horizon, not a rounded month count", t.includes("Debt-free in 2 months, 2 weeks, 1 day"), t);
  check("exact final payment, to the cent", t.includes("$24.00 final payment after 2 of $50"), t);
  check("dated to the day", t.includes("Mar 16, 2026"), t);
  check("no weekly toggle rendered", !/>\s*Wk\s*</.test(html) && !/>\s*Mo\s*</.test(html) && !/week(ly)? payment/i.test(t));
  check("cadence stated once: Monthly payment", t.includes("Monthly payment"));
  check("no minimum payment shown, though the account carries one", !/\bmin\b|minimum/i.test(t), t);
  check("'pay a little more' presets sit over the chosen payment", t.includes("+$50/mo") && t.includes("+$250/mo") && !t.includes("Minimums"));

  const unknown = text(renderToStaticMarkup(createElement(DebtPayoffSection, {
    accounts: [acct("a", "Card A", 124, { interestRate: 0 }), acct("b", "Card B", 600)], today: TODAY,
  })));
  check("UNKNOWN APR ⇒ no timeline", unknown.includes("Debt-free in APR needed") && !/\d+ months?/.test(unknown.replace(/\/mo/g, "")), unknown);
  check("…names the account and where to add it", unknown.includes("No timeline without an APR for Card B — add it in Interest cost."));
  check("…and no fabricated payoff date or total", !unknown.includes("final payment") && !unknown.includes("Total paid"));

  const rated = text(renderToStaticMarkup(createElement(DebtPayoffSection, {
    accounts: [acct("a", "Card A", 124, { interestRate: 30 })], today: TODAY,
  })));
  check("an APR change moves the schedule: 30% ⇒ a larger final payment than 0%'s $24.00",
    /\$2[5-9]\.\d\d final payment/.test(rated), rated);

  const tooLow = text(renderToStaticMarkup(createElement(DebtPayoffSection, {
    accounts: [acct("a", "Card A", 10000, { interestRate: 24 })], today: TODAY,
  })));
  check("50/mo against ~$200/mo of interest ⇒ says it never falls, no date",
    tooLow.includes("Payment doesn't cover interest") && tooLow.includes("$203.84 in the first month") && !tooLow.includes("final payment"), tooLow);

  const planner = code("components/space/sections/DebtPayoffSection.tsx");
  check("no weekly/yearly mode left in state or types", !/PayFreq|setFreq|freqToggle|"week"|"year"/.test(planner));
  check("the default is a useState INITIALISER (never re-applied over a choice)",
    planner.includes("useState(DEFAULT_PAYOFF_PAYMENT)") && !/useEffect\([^)]*setAmount/.test(planner) && !/setAmount\(DEFAULT_PAYOFF_PAYMENT\)/.test(planner));
  check("the schedule comes from planPayoff — no local amortization", planner.includes("planPayoff(") && !planner.includes("simulatePayoff") && !/Math\.ceil\(\s*balance/.test(planner) && !/30\.44/.test(planner));
  check("minimum payments are not read", !/\.minimumPayment\b/.test(planner) && !/minPayment/.test(planner));
}

// ── C. Credit health ─────────────────────────────────────────────────────────
console.log("C. CREDIT HEALTH — user inputs editable, derived values read-only");
{
  const score = renderToStaticMarkup(createElement(CreditScoreInput, { score: 712, updatedAt: "2026-09-01T00:00:00.000Z" }));
  check("shows the score + its DERIVED band", text(score).includes("712 Good"));
  check("the score is editable in place (button, not a link away)", text(score).includes("Update score") && !score.includes('href="/dashboard/credit"'));
  check("says whose number it is", text(score).includes("Entered by you"));
  const none = renderToStaticMarkup(createElement(CreditScoreInput, { score: null }));
  check("no score ⇒ 'Add credit score' is an in-place button", /<button[^>]*>[\s\S]*Add credit score/.test(none) && !none.includes('href="/dashboard/credit"'));
  const shared = text(renderToStaticMarkup(createElement(CreditScoreInput, { score: undefined })));
  check("a host that does not carry the user's score offers no editor", shared.includes("kept — and edited — in My Space") && !shared.includes("Add credit score"));

  const accounts = [
    acct("a", "Card A", 120, { creditLimit: 1000 }),
    acct("b", "Card B", 600),
    acct("l", "Auto Loan", 9000, { debtSubtype: "auto_loan" }),
  ];
  const limits = renderToStaticMarkup(createElement(CreditLimitInputs, { accounts }));
  const lt = text(limits);
  check("an existing limit is an EDIT control", limits.includes('aria-label="Edit credit limit for Card A"') && lt.includes("$1,000 limit"));
  check("a missing limit offers 'Add limit'", lt.includes("Card B") && lt.includes("Add limit"));
  check("utilization is shown as CALCULATED text, with no edit control", lt.includes("12% used · calculated from balance ÷ limit") && !/aria-label="Edit util/i.test(limits));
  check("a loan is not offered a credit limit (not a revolving line)", !lt.includes("Auto Loan"));
  check("discloses that a provider-reported limit wins at refresh", lt.includes("replaces yours at the next refresh"));
  // The prop changes (the host's re-read after a save) ⇒ the derived figure recomputes.
  const after = text(renderToStaticMarkup(createElement(CreditLimitInputs, { accounts: [{ ...accounts[0], creditLimit: 2000 }, accounts[1]] })));
  check("limit 1000 → 2000 ⇒ utilization 12% → 6%", after.includes("6% used") && !after.includes("12% used"), after);

  const ch = code("components/space/widgets/debt/CreditHealthInputs.tsx");
  check("writes through the user-terms authorities only", ch.includes("saveCreditScore(") && ch.includes("saveAccountCreditLimit(") && !ch.includes("fetch("));
  check("utilization comes from the utilization authority, not local division", ch.includes("creditUtilization(") && !/balance\s*\/\s*/.test(ch));
}

// ── D. Removed surfaces ──────────────────────────────────────────────────────
console.log("D. REDUNDANT INTEREST / APR / MINIMUM-PAYMENT SURFACES REMOVED");
{
  const adapters = code("components/space/widgets/debt-perspective-adapters.tsx");
  check("renderDebtCost (read-only interest bars) is gone", !adapters.includes("renderDebtCost"));
  check("renderDebtCompleteInfo (2nd APR/minimum editor) is gone", !adapters.includes("renderDebtCompleteInfo") && !adapters.includes("KnowledgeAcquisitionCard"));
  check("renderCreditScore (score card that linked away) is gone", !adapters.includes("renderCreditScore"));

  const ws = code("components/space/widgets/debt/DebtWorkspace.tsx");
  check("the workspace mounts exactly ONE interest surface", (ws.match(/<InterestCostWidget/g) ?? []).length === 1 && !ws.includes("renderDebtCost"));
  check("no 'Complete debt details' panel", !src("components/space/widgets/debt/DebtWorkspace.tsx").includes("Complete debt details"));
  check("the minimums-based scenario strip is no longer mounted by the workspace", !ws.includes("PayoffScenarioStrip") && !ws.includes("computePayoffAggregate"));

  const legacy = code("components/dashboard/DebtClient.tsx");
  check("legacy credit page: no APR input", !legacy.includes("debtForm.apr") && !legacy.includes(">APR %<"));
  check("legacy credit page: no minimum-payment input or display", !/minimumPayment/.test(legacy) && !legacy.includes("Min Payment"));
  check("legacy credit page: its profile save cannot write an APR",
    /JSON\.stringify\(\{ dueDay, statementCloseDay, promoAprEndDate, notes \}\)/.test(legacy));

  // No other client file writes an APR: the debt-profile route has exactly the
  // callers below (the AI knowledge-gap card answers a question the MODEL asked;
  // it is not a management widget and writes the same authority).
  const planner = code("components/space/sections/DebtPayoffSection.tsx");
  check("the planner has no APR input of its own", !/apr.*<input|<input[^>]*apr/i.test(planner));

  // Rendered markup of the surviving debt surfaces carries no minimum payment.
  const accounts = [acct("a", "Card A", 1200, { interestRate: 24, minimumPayment: 35, creditLimit: 5000 })];
  const kpis = computeDebtKpis(accounts);
  const hero = text(renderToStaticMarkup(createElement(DebtHero, {
    kpis, currency: "USD", liabilityCount: 1, asOf: TODAY, today: TODAY, historical: false, change: null,
    envelope: resolvePerspectiveEnvelope({ perspectiveId: "debt", lensResult: null }),
    verdict: null, verdictAsOf: null, redactions: 0,
  })));
  check("hero: no 'Min. payments' stat", !/min\.? payments/i.test(hero), hero);
  const ledger = text(renderToStaticMarkup(createElement(LiabilitiesLedger, { accounts, currency: "USD" })));
  check("ledger: no minimum", !/minimum|\/mo min/i.test(ledger), ledger);
  check("by-account bars: no minimum",
    !/\bmin\b|minimum/i.test(text(renderToStaticMarkup(renderDebtByAccount(accounts)))));
  check("by-account bars: the row meta no longer builds a '/mo min' string",
    !code("components/space/widgets/debt-perspective-adapters.tsx").includes("/mo min")
    && !code("components/space/widgets/debt-adapters.tsx").includes("/mo min"));
  check("shared breakdown chart: no 'Minimum monthly payments' footer",
    !/minimum/i.test(text(renderToStaticMarkup(renderDebtBreakdownChart(accounts, "bar")))));
  check("account detail: no minimum-payment row", !code("components/space/widgets/debt/DebtAccountDetail.tsx").includes("Minimum payment"));
}

console.log(failures === 0 ? "\n✅ debt experience: all checks passed" : `\n❌ debt experience: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
