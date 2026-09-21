/**
 * lib/transactions/calendar-tier-net.test.ts   (CF-TIER-NET)
 *
 * INSIDE THE SPENDING VIEW, EVERY TIER IS NET — and its drill-down proves it.
 *
 * The calendar's "Credit-card spending" / "Direct/debit spending" filters read
 * gross per-tier cost flows, so a label saying *spending* printed what was
 * CHARGED while "Spending" beside it was net (382897e · 74b2f46 · 7bdae15). This
 * pins the corrected contract, end to end through the PURE chain:
 *
 *   rows → foldDayFacts (the one fold: per-tier gross AND per-tier refunds)
 *        → economicSpendByTier (the one clamp, per tier)
 *        → CALENDAR_MEASURES[tier].value            — what the cell shows
 *        → CALENDAR_MEASURES[tier].rowMatches       — what the drawer opens
 *        → economicTotals over exactly those rows   — what the drawer prints
 *
 * THE DRILL-DOWN INVARIANT, stated once and asserted everywhere below: the
 * drawer folds the rows the cell counted through the SAME authority, so
 * `economicTotals(rowsForMeasures(...)).spend === measure.value(facts)` — at day
 * scope and at period scope, for every tier. A refund is never hidden to make a
 * number match: it is in the rows, and the drawer states charged / refunded / any
 * refund beyond the charges.
 *
 * Every expected figure is HAND ARITHMETIC beside the case. No live values.
 *
 * Run:  npx tsx lib/transactions/calendar-tier-net.test.ts
 */
import { readFileSync } from "node:fs";
import { tierResolver, type LiquidityTx } from "./liquidity";
import { economicTotals } from "./cash-flow";
import {
  aggregateDayFacts, projectDailyFacts, bucketDayFacts, economicSpend, economicSpendByTier,
  rowsForMeasures, netOfMeasures, CALENDAR_MEASURES, type CalendarMeasureId,
} from "./cash-flow-projection";
import { filterByPeriod, type CashFlowPeriod } from "./cash-flow";

let failures = 0, passed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? `  — ${detail}` : ""}`); }
}
const cents = (n: number) => Math.round(n * 100);
const eq = (a: number, b: number) => cents(a) === cents(b);

let seq = 0;
function tx(over: Partial<LiquidityTx> & { amount: number; date: string }): LiquidityTx {
  return {
    id: `t${seq++}`, accountId: "chk", financialAccountId: "chk", merchant: "m", category: "Shopping",
    pending: false, currency: "USD", flowType: "SPENDING", counterpartyAccountId: null, transferDisposition: null, ...over,
  } as unknown as LiquidityTx;
}
const CARD = { accountId: "card", financialAccountId: "card" };
const card       = (amount: number, date: string, o: Partial<LiquidityTx> = {}) => tx({ amount: -Math.abs(amount), date, ...CARD, ...o });
const direct     = (amount: number, date: string, o: Partial<LiquidityTx> = {}) => tx({ amount: -Math.abs(amount), date, ...o });
const cardRefund   = (amount: number, date: string) => tx({ amount: Math.abs(amount), date, flowType: "REFUND", ...CARD });
const directRefund = (amount: number, date: string) => tx({ amount: Math.abs(amount), date, flowType: "REFUND" });
const ctx = tierResolver([{ id: "chk", type: "checking" }, { id: "card", type: "debt" }, { id: "brk", type: "investment" }]);

const CARD_TIER: CalendarMeasureId = "creditCardSpending";
const DIRECT_TIER: CalendarMeasureId = "directDebitSpending";
const ALL: CalendarMeasureId = "allSpending";

/** THE invariant: what the cell shows === what the drawer's own fold makes of the rows it opens. */
function reconciles(rows: LiquidityTx[], id: CalendarMeasureId, scopeRows = rows): boolean {
  const cell = CALENDAR_MEASURES[id].value(aggregateDayFacts(scopeRows, ctx));
  const opened = rowsForMeasures(scopeRows, [id], ctx);
  return eq(economicTotals(opened as never).spend, cell);
}
const cellOf = (rows: LiquidityTx[], id: CalendarMeasureId) => CALENDAR_MEASURES[id].value(aggregateDayFacts(rows, ctx));
const openedIds = (rows: LiquidityTx[], id: CalendarMeasureId) => rowsForMeasures(rows, [id], ctx).map((r) => r.id).sort();

console.log("1 + 2. purchases with no refund — unchanged, and each in its own tier");
{
  const rows = [card(100, "2026-07-02"), direct(40, "2026-07-02")];
  check("card tier 100, direct tier 40, total 140", eq(cellOf(rows, CARD_TIER), 100) && eq(cellOf(rows, DIRECT_TIER), 40) && eq(cellOf(rows, ALL), 140));
  check("both drill-downs reconcile", reconciles(rows, CARD_TIER) && reconciles(rows, DIRECT_TIER) && reconciles(rows, ALL));
  check("no row is in both tiers", openedIds(rows, CARD_TIER).every((i) => !openedIds(rows, DIRECT_TIER).includes(i)));
}

console.log("3. card purchase + partial card refund, same day — the brief's $100 / −$30 / $70");
{
  const rows = [card(100, "2026-07-02"), cardRefund(30, "2026-07-02")];
  check("the cell is NET 70, not the charged 100", eq(cellOf(rows, CARD_TIER), 70));
  check("the drill-down OPENS the refund row — it is not hidden to make the number match", openedIds(rows, CARD_TIER).length === 2);
  check("and the drawer's own fold lands on 70", reconciles(rows, CARD_TIER));
  const t = economicTotals(rowsForMeasures(rows, [CARD_TIER], ctx) as never);
  check("the drawer can state it: 100 charged · −30 refunded · 0 beyond", eq(t.spendGross, 100) && eq(t.refunds, 30) && eq(t.refundsUnapplied, 0));
  check("a card refund does NOT reduce the direct tier", eq(cellOf(rows, DIRECT_TIER), 0));
}

console.log("4. direct purchase + partial direct refund");
{
  const rows = [direct(80, "2026-07-03"), directRefund(25, "2026-07-03")];
  check("direct tier is 55", eq(cellOf(rows, DIRECT_TIER), 55) && reconciles(rows, DIRECT_TIER));
  check("…and the card tier is untouched at 0", eq(cellOf(rows, CARD_TIER), 0));
}

console.log("5. full refund — the tier goes to exactly 0, and the rows are still there");
{
  const rows = [card(150, "2026-07-04"), cardRefund(150, "2026-07-04")];
  check("cell 0, drawer 0, both rows opened", eq(cellOf(rows, CARD_TIER), 0) && reconciles(rows, CARD_TIER) && openedIds(rows, CARD_TIER).length === 2);
}

console.log("6. refund dated LATER than its purchase — it counts in ITS OWN day, never backwards");
{
  const rows = [card(200, "2026-07-05"), cardRefund(60, "2026-07-20")];
  const daily = projectDailyFacts(rows, ctx);
  check("the purchase day is still 200 — the later refund does not rewrite it", eq(CALENDAR_MEASURES[CARD_TIER].value(daily.get("2026-07-05")!), 200));
  check("the refund day is 0, with 60 unapplied (floored, never negative)",
    eq(CALENDAR_MEASURES[CARD_TIER].value(daily.get("2026-07-20")!), 0) && eq(economicSpendByTier(daily.get("2026-07-20")!).refundsUnapplied, 60));
  check("over the whole period the tier is 140", eq(cellOf(rows, CARD_TIER), 140) && reconciles(rows, CARD_TIER));
  check("each day's drill-down reconciles with that day's cell",
    reconciles(rows, CARD_TIER, rows.filter((r) => r.date === "2026-07-05")) && reconciles(rows, CARD_TIER, rows.filter((r) => r.date === "2026-07-20")));
}

console.log("7 + 8. refunds with no charge, and refunds exceeding charges — floor + disclose");
{
  const only = [cardRefund(40, "2026-07-06")];
  check("a refund alone: cell 0, 40 disclosed as unapplied", eq(cellOf(only, CARD_TIER), 0) && eq(economicSpendByTier(aggregateDayFacts(only, ctx)).refundsUnapplied, 40));
  check("…the drawer still opens it and reconciles at 0", reconciles(only, CARD_TIER) && openedIds(only, CARD_TIER).length === 1);
  const over = [card(30, "2026-07-06"), cardRefund(100, "2026-07-06")];
  check("refunds beyond charges: cell 0, unapplied 70 — the excess is reported, not discarded",
    eq(cellOf(over, CARD_TIER), 0) && eq(economicSpendByTier(aggregateDayFacts(over, ctx)).refundsUnapplied, 70));
  const t = economicTotals(rowsForMeasures(over, [CARD_TIER], ctx) as never);
  check("…and the drawer says the same: 30 charged · −100 refunded · 70 beyond", eq(t.spendGross, 30) && eq(t.refunds, 100) && eq(t.refundsUnapplied, 70));
}

console.log("9. mixed card + direct on one day — parts − unapplied = whole");
{
  // card 100 − 30 = 70 ; direct 80 − 25 = 55 ; total gross 180 − refunds 55 = 125.
  const rows = [card(100, "2026-07-07"), cardRefund(30, "2026-07-07"), direct(80, "2026-07-07"), directRefund(25, "2026-07-07")];
  const f = aggregateDayFacts(rows, ctx);
  const tier = economicSpendByTier(f);
  check("card 70 · direct 55 · Spending 125", eq(tier.creditCard, 70) && eq(tier.direct, 55) && eq(economicSpend(f), 125));
  check("card + direct − tier unapplied = gross − refunds", eq(tier.creditCard + tier.direct - tier.refundsUnapplied, f.spendGross - f.refunds));
  check("…which is the Spending cell when nothing is over-refunded", eq(tier.creditCard + tier.direct - tier.refundsUnapplied, economicSpend(f)));
  check("every tier's drill-down reconciles", reconciles(rows, CARD_TIER) && reconciles(rows, DIRECT_TIER) && reconciles(rows, ALL));
  // One tier over-refunded, the other not: card 10 − 60 ⇒ 0 (50 unapplied); direct 80 − 0 = 80.
  const lop = [card(10, "2026-07-08"), cardRefund(60, "2026-07-08"), direct(80, "2026-07-08")];
  const lf = aggregateDayFacts(lop, ctx), lt = economicSpendByTier(lf);
  check("a tier floored at 0 keeps the identity through its disclosed excess",
    eq(lt.creditCard, 0) && eq(lt.direct, 80) && eq(lt.refundsUnapplied, 50) && eq(lt.creditCard + lt.direct - lt.refundsUnapplied, lf.spendGross - lf.refunds));
  check("…while Spending itself nets across tiers (90 − 60 = 30)", eq(economicSpend(lf), 30));
}

console.log("10–14. what must NEVER enter a spending tier");
{
  const base = [card(100, "2026-07-09"), direct(40, "2026-07-09")];
  const withRow = (r: LiquidityTx) => [...base, r];
  const cases: [string, LiquidityTx][] = [
    ["card payment",      tx({ amount: -500, date: "2026-07-09", flowType: "DEBT_PAYMENT", counterpartyAccountId: "card" })],
    ["own transfer",      tx({ amount: -1000, date: "2026-07-09", flowType: "TRANSFER", transferDisposition: "ASSET_VENUE_TRANSFER" })],
    ["payment-app send",  tx({ amount: -50, date: "2026-07-09", flowType: "TRANSFER", transferDisposition: "PAYMENT_APP_MOVEMENT" })],
    ["income deposit",    tx({ amount: 3000, date: "2026-07-09", flowType: "INCOME", category: "Income" })],
    ["ATM withdrawal",    tx({ amount: -300, date: "2026-07-09", flowType: "TRANSFER", transferDisposition: "CASH_MOVEMENT" })],
  ];
  for (const [label, row] of cases) {
    const rows = withRow(row);
    check(`${label}: neither tier moves, and it is not in either drill-down`,
      eq(cellOf(rows, CARD_TIER), 100) && eq(cellOf(rows, DIRECT_TIER), 40)
        && !openedIds(rows, CARD_TIER).includes(row.id) && !openedIds(rows, DIRECT_TIER).includes(row.id));
  }
  // A fee and interest on the card ARE cost flows: card tier 100 + 12 + 8 = 120.
  const withCost = [...base, tx({ amount: -12, date: "2026-07-09", flowType: "FEE", ...CARD }), tx({ amount: -8, date: "2026-07-09", flowType: "INTEREST", ...CARD })];
  check("fee + interest on the card ARE in the card tier (120) and in its drill-down",
    eq(cellOf(withCost, CARD_TIER), 120) && reconciles(withCost, CARD_TIER) && openedIds(withCost, CARD_TIER).length === 3);
}

console.log("15 + 16. pending rows count, and one event is never counted twice");
{
  const rows = [card(100, "2026-07-10", { pending: true }), cardRefund(30, "2026-07-10", )];
  check("a pending purchase is in the tier and its drill-down (policy: nothing pending is filtered)",
    eq(cellOf(rows, CARD_TIER), 70) && reconciles(rows, CARD_TIER) && rowsForMeasures(rows, [CARD_TIER], ctx).some((r) => r.pending === true));
  // The server keeps ONE row per event (pending → posted replaces in place), so a
  // posted row carrying the same id cannot double-count.
  const posted = [{ ...rows[0], pending: false }, rows[1]];
  check("the same event, now posted, gives the same figure — no double count", eq(cellOf(posted as LiquidityTx[], CARD_TIER), 70));
}

console.log("17–20. periods: 1 month, MTD, multi-month, past anchor — the window decides, not the tier");
{
  // Jun: card 300 − 100 ; Jul: card 200, direct 50 ; Aug: card 80.
  const rows = [
    card(300, "2026-06-10"), cardRefund(100, "2026-06-18"),
    card(200, "2026-07-05"), direct(50, "2026-07-06"),
    card(80, "2026-08-03"),
  ];
  const at = (p: CashFlowPeriod, now: Date) => filterByPeriod(rows as never, p, now) as unknown as LiquidityTx[];
  const JUL_END = new Date(2026, 6, 31), AUG_MID = new Date(2026, 7, 15);
  const july = at({ kind: "month", year: 2026, month: 7 }, JUL_END);
  check("17. an explicit month: card 200, direct 50", eq(cellOf(july, CARD_TIER), 200) && eq(cellOf(july, DIRECT_TIER), 50) && reconciles(july, CARD_TIER));
  const mtd = at("MTD", AUG_MID);
  check("18. MTD in August: card 80 only", eq(cellOf(mtd, CARD_TIER), 80) && reconciles(mtd, CARD_TIER));
  const quarter = at("PAST_QUARTER", AUG_MID);
  check("19. a multi-month window nets June's refund: 300 − 100 + 200 + 80 = 480",
    eq(cellOf(quarter, CARD_TIER), 480) && eq(cellOf(quarter, DIRECT_TIER), 50) && reconciles(quarter, CARD_TIER));
  const past = at({ kind: "month", year: 2026, month: 6 }, AUG_MID);
  check("20. a PAST anchor (June, viewed in August) is still June's own net: 200",
    eq(cellOf(past, CARD_TIER), 200) && reconciles(past, CARD_TIER));
  // Buckets (history mode) clamp at bucket scope, exactly like a day cell.
  // Buckets clamp at BUCKET scope, exactly as day cells clamp at day scope: here
  // the weekly bucket holding June's 100 refund has no charge of its own, so it
  // floors at 0 and discloses 100 unapplied. Σbuckets − Σunapplied is the period
  // figure — the same floor-and-disclose identity, one scope down.
  const buckets = bucketDayFacts(quarter, ctx, "PAST_QUARTER");
  const bucketNet = buckets.reduce((n, b) => n + CALENDAR_MEASURES[CARD_TIER].value(b), 0);
  const bucketUnapplied = buckets.reduce((n, b) => n + economicSpendByTier(b).refundsUnapplied, 0);
  check("every bucket is ≥ 0 and none is gross", buckets.every((b) => CALENDAR_MEASURES[CARD_TIER].value(b) >= 0) && bucketNet <= 580.001);
  check("Σbuckets − Σbucket unapplied = the period's tier figure (480)", eq(bucketNet - bucketUnapplied, 480), `${bucketNet} − ${bucketUnapplied}`);
}

console.log("21 + 22. the invariant across every tier, and the tiles it must agree with");
{
  const rows = [
    card(692.97, "2026-07-11"), cardRefund(20, "2026-07-12"), direct(120.5, "2026-07-11"), directRefund(5.5, "2026-07-13"),
    tx({ amount: -12, date: "2026-07-11", flowType: "FEE", ...CARD }),
    tx({ amount: -500, date: "2026-07-14", flowType: "DEBT_PAYMENT", counterpartyAccountId: "card" }),
    tx({ amount: 3000, date: "2026-07-01", flowType: "INCOME", category: "Income" }),
  ];
  for (const id of [CARD_TIER, DIRECT_TIER, ALL]) {
    check(`${id}: cell === drawer fold (the drill-down invariant)`, reconciles(rows, id));
  }
  const f = aggregateDayFacts(rows, ctx), tier = economicSpendByTier(f);
  // card 692.97 + 12 − 20 = 684.97 ; direct 120.50 − 5.50 = 115 ; Spending 799.97.
  check("card 684.97 · direct 115.00 · Spending 799.97", eq(tier.creditCard, 684.97) && eq(tier.direct, 115) && eq(economicSpend(f), 799.97));
  check("22. the Spending TILE figure is the same value the calendar's Spending cell shows",
    eq(netOfMeasures(f, [ALL]).out, economicSpend(f)));
  check("…and the two tiers add up to it (nothing over-refunded here)", eq(tier.creditCard + tier.direct, economicSpend(f)));
  check("the debt payment is in NO spending measure, but IS Cash Out", !openedIds(rows, ALL).includes(rows[5].id) && eq(netOfMeasures(f, ["cashOut"]).out, 500 + 120.5 + 5.5 - 5.5), String(f.cashOut));
}

console.log("23. Cash Out is untouched by all of this — a separate cash measure");
{
  const rows = [card(100, "2026-07-15"), cardRefund(30, "2026-07-16"), direct(40, "2026-07-15"),
    tx({ amount: -500, date: "2026-07-20", flowType: "DEBT_PAYMENT", counterpartyAccountId: "card" })];
  const f = aggregateDayFacts(rows, ctx);
  check("a card purchase is NOT Cash Out; the card PAYMENT is (500 + the 40 direct)", eq(f.cashOut, 540));
  check("a card refund does not reduce Cash Out", eq(f.cashOut, 540) && eq(economicSpendByTier(f).creditCard, 70));
  check("Cash Out ≠ Spending here, by design (540 vs 110)", eq(economicSpend(f), 110));
}

console.log("24. source guards — one authority, no React arithmetic, tiers labelled net");
{
  const code = (rel: string) => readFileSync(rel, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const proj = code("lib/transactions/cash-flow-projection.ts");
  check("both tiers read economicSpendByTier — neither reads the gross field", /creditCardSpending:[\s\S]{0,400}?economicSpendByTier\(f\)\.creditCard/.test(proj) && /directDebitSpending:[\s\S]{0,400}?economicSpendByTier\(f\)\.direct/.test(proj));
  check("…and both admit their tier's REFUND rows into the drill-down", (proj.match(/isEconomicSpendRow\(t\) && tierOfRow/g) ?? []).length === 2);
  const drawer = code("components/space/widgets/TransactionSliceDrawer.tsx");
  check("the drawer's figures come from economicTotals, not from summing rows", drawer.includes("economicTotals(displayRows, ctx)") && !/displayRows\.reduce\([^)]*amount/.test(drawer));
  check("the drawer discloses charged / refunded from that same fold", drawer.includes("spendGross") && drawer.includes("refundsUnapplied") && drawer.includes("charged"));
  const widget = code("components/space/widgets/CashFlowSummaryWidget.tsx");
  check("the Cash Out hint exists, is subordinate copy, and never calls Cash Out spending",
    widget.includes("CASH_OUT_HINT") && /hint=\{CASH_OUT_HINT\}/.test(widget));
  check("a gross slice is labelled Charged, never Spending", widget.includes('spendLabel: "Charged"'));
}

console.log(failures === 0 ? `\nPASS — ${passed} checks` : `\nFAIL — ${failures} of ${passed + failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
