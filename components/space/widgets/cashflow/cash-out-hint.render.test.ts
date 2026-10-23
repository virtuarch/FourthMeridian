/**
 * components/space/widgets/cashflow/cash-out-hint.render.test.ts   (CF-TIER-NET)
 *
 * Cash Out is a CASH measure, not spending. A user reading Cash Out beside Total
 * spending sees two different figures for one period, and the reason is timing:
 * a card purchase moves no cash until the card is paid, so it lands in Cash Out
 * later — possibly in another period — as a debt payment.
 *
 * This renders the real widget and pins that ONE line: present under Cash Out,
 * subordinate to the figure, and careful about what it claims — it explains the
 * timing, it does not call Cash Out spending and does not claim any payment
 * matches any purchase.
 *
 *   npx tsx components/space/widgets/cashflow/cash-out-hint.render.test.ts
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CashFlowSummaryWidget, CASH_OUT_HINT } from "@/components/space/widgets/CashFlowSummaryWidget";

let failures = 0, passed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? `  — ${detail}` : ""}`); }
}
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

let n = 0;
const tx = (over: Record<string, unknown>) => ({
  id: `t${n++}`, accountId: "chk", financialAccountId: "chk", merchant: "m", category: "Shopping",
  pending: false, currency: "USD", flowType: "SPENDING", counterpartyAccountId: null, transferDisposition: null,
  date: "2026-07-05", amount: -10, ...over,
});
// A card purchase (no cash moves), its later payment (cash moves), a direct debit.
const ROWS = [
  tx({ amount: -400, date: "2026-07-03", accountId: "card", financialAccountId: "card" }),
  tx({ amount: -300, date: "2026-07-20", flowType: "DEBT_PAYMENT", category: "Payment", counterpartyAccountId: "card" }),
  tx({ amount: -60,  date: "2026-07-04", category: "Groceries" }),
];
const ACCOUNTS = [{ id: "chk", type: "checking" }, { id: "card", type: "debt" }];
const render = (perspective: "liquidity" | "economic") =>
  renderToStaticMarkup(createElement(CashFlowSummaryWidget, {
    transactions: ROWS, period: { kind: "month", year: 2026, month: 7 }, accounts: ACCOUNTS,
    perspective, asOf: "2026-07-31", hideHeadline: true,
  } as never));

const liquidity = render("liquidity");
const spending = render("economic");

console.log("1. the hint is on the Cash Out tile");
check("the exact copy renders", text(liquidity).includes(CASH_OUT_HINT), CASH_OUT_HINT);
check("it says what it means: card purchases count when the card is paid",
  /card purchases? count here when you pay the card\./i.test(CASH_OUT_HINT));
check("it is attached to a tile hint slot, not the figure", liquidity.includes("data-tile-hint"));
check("…and there is exactly one of them", (liquidity.match(/data-tile-hint/g) ?? []).length === 1);
check("it sits AFTER the Cash Out figure in the markup (subordinate)",
  liquidity.indexOf("Cash Out") < liquidity.indexOf("data-tile-hint"));

console.log("2. what it must not claim");
check("it never calls Cash Out spending", !/spend/i.test(CASH_OUT_HINT));
check("it claims no matching between a payment and the purchases in this period",
  !/(match|corresponds|for those|of these|the same)/i.test(CASH_OUT_HINT));
check("it is one short line, not a paragraph", CASH_OUT_HINT.length <= 70 && CASH_OUT_HINT.split(". ").length === 1);

console.log("3. it belongs to the cash view only");
check("the Spending view does not carry it", !text(spending).includes(CASH_OUT_HINT));
check("…and the Spending view still shows the Spending tile", text(spending).includes("Spending"));

console.log("4. the figures it explains are the honest ones");
// Cash Out = the 300 card payment + the 60 direct debit = 360. Spending = 400 + 60 = 460.
// No ConversionContext is passed, so the figures carry no currency symbol (the
// display-money doctrine: never relabel an unknown denomination as dollars).
check("Cash Out is 360 — the card purchase is not in it", /Cash Out −360\b/.test(text(liquidity)), text(liquidity).slice(0, 80));
check("Spending is 460 — the card purchase IS in it, the payment is not", /Spending −460\b/.test(text(spending)), text(spending).slice(0, 80));
check("the gross card context row says 'Charged', never 'Spent'",
  text(liquidity).includes("Charged on credit") && !/spent on credit/i.test(text(liquidity)));

console.log(failures === 0 ? `\nPASS — ${passed} checks` : `\nFAIL — ${failures} of ${passed + failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
