/**
 * lib/transactions/debt-payment-authority.test.ts   (v2.6-TRUTH-7)
 *
 * The one debt-payment total, and the double-count it makes impossible.
 *
 * Also hosts the MC1 P3 equivalence gates merged from lib/debt.golden.test.ts:
 * pure-USD fixtures stay byte-identical (kill switch); residue/mixed fixtures
 * stay NUMERICALLY identical under identity while `estimated` (D-7) turns
 * honest; real-rate contexts convert with correct flags; plus the literal base
 * rollup semantics of lib/debt.ts (flow-predicate exclusion, mixed-sign
 * abs-sum, group-by-account, descending sort, per-account count). The golden
 * gates route `totalDebtPaid` through this authority via the asCashLegs shim,
 * so the guarantees pinned there are the real ones. Pure: no DB, no network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  selectDebtPaymentCashLegs, totalDebtPaid, COUNTED_DEBT_PAYMENT_LEG,
} from "./debt-payment-authority";
import { tierResolver, type LiquidityTx } from "./liquidity";
import { rollupDebtPaymentsByAccount, type DebtPaymentTxnLike } from "../debt";
import { convertMoney, identityContext } from "../money/convert";
import type { ConversionContext } from "../money/types";
import { DEFAULT_DISPLAY_CURRENCY } from "../currency";

// v2.6-DEBT-1 — cardA..cardE (and amex/chase for the rollup fixtures) MUST be
// declared. The golden fixtures below use them as debt-payment destinations;
// membership requires positive evidence, so an undeclared destination is
// correctly refused. The fixtures always meant these to be cards.
const TIERS = tierResolver([
  { id: "chk", type: "checking" },
  { id: "sav", type: "savings" },
  { id: "card", type: "debt" },
  { id: "brk", type: "investment" },
  { id: "cardA", type: "debt" }, { id: "cardB", type: "debt" }, { id: "cardC", type: "debt" },
  { id: "cardD", type: "debt" }, { id: "cardE", type: "debt" },
  { id: "amex", type: "debt" }, { id: "chase", type: "debt" },
]);

const row = (o: Partial<LiquidityTx> & { own: string; amount: number }): LiquidityTx => ({
  id: `${o.own}:${o.amount}`, accountId: o.own, financialAccountId: o.own,
  counterpartyAccountId: o.counterpartyAccountId ?? null,
  amount: o.amount, flowType: o.flowType ?? "DEBT_PAYMENT", currency: "USD",
  date: "2026-06-01", merchant: "m", category: "Other", pending: false,
} as unknown as LiquidityTx);

const abs = (t: LiquidityTx) => Math.abs(t.amount);

// The two legs of ONE $300 card payment.
const CASH_LEG = row({ own: "chk", amount: -300, counterpartyAccountId: "card" });
const LIABILITY_LEG = row({ own: "card", amount: 300, counterpartyAccountId: "chk" });

test("the counted leg is named, not implied", () => {
  assert.equal(COUNTED_DEBT_PAYMENT_LEG, "CASH");
});

test("one payment counts once, however many legs you pass", () => {
  // The defect: lib/debt.ts abs-summed whatever it was handed, so this returned
  // $600 for a $300 payment.
  assert.equal(totalDebtPaid([CASH_LEG, LIABILITY_LEG], TIERS, abs).total, 300);
  assert.equal(totalDebtPaid([CASH_LEG], TIERS, abs).total, 300);
  assert.equal(totalDebtPaid([LIABILITY_LEG, CASH_LEG], TIERS, abs).total, 300);
});

test("passing ONLY the liability leg counts nothing, and says how much it skipped", () => {
  // Not a silent zero — the caller can see that 1 row of the other leg was there.
  const r = totalDebtPaid([LIABILITY_LEG], TIERS, abs);
  assert.equal(r.total, 0);
  assert.equal(r.count, 0);
  assert.equal(r.excludedLiabilityLegCount, 1);
});

test("selection is idempotent — re-selecting a counted set changes nothing", () => {
  const once = selectDebtPaymentCashLegs([CASH_LEG, LIABILITY_LEG], TIERS).counted;
  const twice = selectDebtPaymentCashLegs(once, TIERS).counted;
  assert.deepEqual(twice.map((r) => r.id), once.map((r) => r.id));
});

test("a payment toward an UNCONNECTED liability counts when the TYPE is attested", () => {
  // A cash leg whose liability is not connected to this app has no counterparty
  // and therefore no liability leg. A liability-scoped total cannot see it; this
  // one must — PROVIDED the transfer authority can still prove the destination
  // is a liability. That is the whole distinction: unconnected is not the same
  // as unevidenced.
  const unconnected = row({ own: "chk", amount: -4000, counterpartyAccountId: null });
  const attested = { ...unconnected, transferMaturity: "DEBT_PAYMENT" } as typeof unconnected;
  const r = totalDebtPaid([attested], TIERS, abs);
  assert.equal(r.total, 4000);
  assert.equal(r.count, 1);
});

test("v2.6-DEBT-1: an unconnected liability with NO evidence at all does NOT count", () => {
  // ⚠️ DELIBERATE SEMANTIC CHANGE, and the tradeoff is real.
  //
  // This case previously counted: a row with `flowType = DEBT_PAYMENT`, a liquid
  // own account, no counterparty and no authority verdict was admitted at
  // confidence 1 — on the provider's category alone, because nothing had
  // contradicted it.
  //
  // Membership now requires POSITIVE destination evidence. The consequence,
  // stated plainly: a payment toward a card this app does not know about, which
  // the transfer authority also cannot type-attest, no longer appears in Debt
  // Payments. It is not lost — it remains a visible movement, classified
  // UNRESOLVED — but it is not counted as debt.
  //
  // That is the correct trade. The alternative is counting a number because a
  // provider category derived from descriptor text said so, which is exactly how
  // a $4,000 savings transfer once entered this measure. On the live corpus the
  // change removes ZERO rows: all 119 counted payments carry positive evidence
  // (101 nameable, 18 type-proven).
  const unevidenced = row({ own: "chk", amount: -4000, counterpartyAccountId: null });
  const r = totalDebtPaid([unevidenced], TIERS, abs);
  assert.equal(r.total, 0, "a provider category is not evidence of a debt destination");
  assert.equal(r.count, 0);
});

test("a savings transfer is never a debt payment", () => {
  // The $4,000 Amex HYSA row: TRANSFER, savings ← checking, both owned.
  const savingsIn = row({ own: "sav", amount: 4000, flowType: "TRANSFER", counterpartyAccountId: "chk" });
  const savingsOut = row({ own: "chk", amount: -4000, flowType: "TRANSFER", counterpartyAccountId: "sav" });
  const r = totalDebtPaid([savingsIn, savingsOut], TIERS, abs);
  assert.equal(r.total, 0);
  assert.equal(r.count, 0);
});

test("non-payment rows never enter the total", () => {
  const rows = [
    CASH_LEG,
    row({ own: "chk", amount: -55, flowType: "SPENDING" }),
    row({ own: "chk", amount: 900, flowType: "INCOME" }),
    row({ own: "brk", amount: -100, flowType: "TRANSFER", counterpartyAccountId: "chk" }),
  ];
  assert.equal(totalDebtPaid(rows, TIERS, abs).total, 300);
});

test("an unconvertible row is EXCLUDED and disclosed, never counted as zero", () => {
  // V25-FINAL-1 — a null magnitude means no acceptable FX rate.
  const other = row({ own: "chk", amount: -100, counterpartyAccountId: "card" });
  const r = totalDebtPaid([CASH_LEG, other], TIERS, (t) => (t.amount === -100 ? null : Math.abs(t.amount)));
  assert.equal(r.total, 300);
  assert.equal(r.count, 1);
  assert.equal(r.unconverted, true);
});

test("empty input is zero, and honest about it", () => {
  const r = totalDebtPaid([], TIERS, abs);
  assert.deepEqual(r, { total: 0, count: 0, excludedLiabilityLegCount: 0, unconverted: false });
});

// ─────────────────────────────────────────────────────────────────────────────
// Standing probe
// ─────────────────────────────────────────────────────────────────────────────

test("nothing outside the authority selects debt-payment rows itself", () => {
  // Four surfaces each carried their own copy of this predicate, and two of them
  // disagreed by $6,000. One authority, or the divergence comes back.
  const ALLOWED = new Set([
    "lib/transactions/debt-payment-authority.ts",
    "lib/transactions/liquidity.ts",
    "lib/transactions/liquidity-breakdown.ts",
    // The calendar measure registry. Its `debtPayments` entry is one row in a
    // uniform table of eight measures, all expressed through the same generic
    // `reasonIs` helper, which reads classifyLiquidity. It selects the SAME leg
    // (CASH_OUT), so it agrees with the authority by construction rather than by
    // coincidence — a vocabulary projection, not a competing predicate.
    "lib/transactions/cash-flow-projection.ts",
  ]);
  const walk = (d: string, out: string[] = []): string[] => {
    let entries: string[] = [];
    try { entries = readdirSync(join(process.cwd(), d)); } catch { return out; }
    for (const e of entries) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      const rel = `${d}/${e}`;
      if (statSync(join(process.cwd(), rel)).isDirectory()) walk(rel, out);
      else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(rel);
    }
    return out;
  };
  const offenders = ["lib", "app", "components", "jobs"].flatMap((r) => walk(r))
    .filter((f) => !f.startsWith("prototype/") && !ALLOWED.has(f))
    .filter((f) => {
      const code = readFileSync(join(process.cwd(), f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
      // The shape every duplicate had: a CASH_OUT + DEBT_PAYMENT pair test.
      return /CASH_OUT[\s\S]{0,80}DEBT_PAYMENT/.test(code);
    });
  assert.deepEqual(offenders, [], "these modules re-derive debt-payment membership instead of using the authority");
});

// ─────────────────────────────────────────────────────────────────────────────
// ── merged from lib/debt.golden.test.ts (MC1 Phase 3 Slice 2 equivalence
//    gates, plan D-10; base rollup semantics from lib/debt.test.ts, TEST-2) ──
// ─────────────────────────────────────────────────────────────────────────────
// These fixtures are DESTINATION-side legs (each `accountId` is the card that
// received money). The authority counts the CASH leg, so it is presented the
// same payments from the paying side — which is what production actually sums.

const CTX = identityContext(DEFAULT_DISPLAY_CURRENCY);

const asCashLegs = (rows: DebtPaymentTxnLike[]): LiquidityTx[] =>
  rows.map((r, i) => ({
    id: `g${i}`, accountId: "chk", financialAccountId: "chk",
    counterpartyAccountId: r.accountId,
    amount: r.amount, flowType: r.flowType, currency: r.currency ?? null,
    date: r.dateISO ?? "", merchant: "m", category: "Other", pending: false,
  }) as unknown as LiquidityTx);

/** Σ|amount| over the authority's counted leg — the same conversion rowAmount does. */
// v2.6-TRUTH-7 — `totalDebtPaid` moved to this authority, which SELECTS the
// counted leg instead of abs-summing whatever a caller hands it. FX conversion
// is the caller's `magnitude` callback, so this shim performs exactly the
// conversion lib/debt.ts's own `rowAmount` does — same convertMoney call, same
// null-means-EXCLUDE rule.
const goldenTotal = (rows: DebtPaymentTxnLike[], ctx?: ConversionContext): number =>
  totalDebtPaid(asCashLegs(rows), TIERS, (t) => {
    if (!ctx) return t.amount;
    return convertMoney({ amount: t.amount, currency: t.currency ?? null }, t.date ?? "", ctx).amount;
  }).total;

// ── pure-USD fixture: byte-identity (kill-switch gate) ────────────────────────

const pureUsd: DebtPaymentTxnLike[] = [
  { accountId: "cardA", amount: -300.25, flowType: "DEBT_PAYMENT", currency: "USD", dateISO: "2026-06-01" },
  { accountId: "cardA", amount: 150.5,   flowType: "DEBT_PAYMENT", currency: "USD", dateISO: "2026-06-15" },
  { accountId: "cardB", amount: -99.99,  flowType: "DEBT_PAYMENT", currency: "USD" }, // no dateISO — identity never reads it
  { accountId: "cardA", amount: -55,     flowType: "SPENDING",     currency: "USD" }, // excluded by flow
  { accountId: "cardC", amount: -10,     flowType: null,           currency: "USD" }, // null flow excluded
];

test("kill switch: totalDebtPaid byte-identical (pure-USD)", () => {
  assert.equal(JSON.stringify(goldenTotal(pureUsd)), JSON.stringify(goldenTotal(pureUsd, CTX)));
});

test("kill switch: rollup byte-identical incl. estimated:false (pure-USD)", () => {
  assert.equal(
    JSON.stringify(rollupDebtPaymentsByAccount(pureUsd)),
    JSON.stringify(rollupDebtPaymentsByAccount(pureUsd, CTX)),
  );
});

test("abs-sum shape preserved (300.25 + 150.5 + 99.99)", () => {
  assert.equal(goldenTotal(pureUsd, CTX), 300.25 + 150.5 + 99.99);
});

test("estimated: false on every pure-USD entry (both paths)", () => {
  assert.ok(rollupDebtPaymentsByAccount(pureUsd, CTX).every((e) => e.estimated === false));
  assert.ok(rollupDebtPaymentsByAccount(pureUsd).every((e) => e.estimated === false));
});

// ── residue/mixed: numbers identical under identity, flags honest ─────────────

const eurPayment = { accountId: "cardD", amount: -500, flowType: "DEBT_PAYMENT", currency: "EUR", dateISO: "2026-06-10" } as const;
const mixedResidue: DebtPaymentTxnLike[] = [
  ...pureUsd,
  eurPayment,                                                                      // EUR miss → excluded under identity
  { accountId: "cardD", amount: -75,  flowType: "DEBT_PAYMENT", currency: null },  // null-residue → passthrough (kept)
  { accountId: "cardE", amount: -120, flowType: "DEBT_PAYMENT" },                  // bare legacy shape → null-residue (kept)
];

test("mixed: cardD reporting total EXCLUDES the unavailable EUR 500 (75, not 575)", () => {
  // V25-FINAL-1 — the unavailable EUR payment (500) is EXCLUDED (contributes 0)
  // under identity, but the row is still PRESENT (2 occurrences on cardD). So the
  // with-context cardD total is the null-residue 75 alone, NOT 575, while the
  // context-less raw addition still blends the EUR native 500 in.
  const cardDWithCtx = rollupDebtPaymentsByAccount(mixedResidue, CTX).find((e) => e.accountId === "cardD")!.total;
  assert.equal(cardDWithCtx, 75);
});

test("mixed: raw addition still blends the EUR native magnitude in (575)", () => {
  const cardDRaw = rollupDebtPaymentsByAccount(mixedResidue).find((e) => e.accountId === "cardD")!.total;
  assert.equal(cardDRaw, 575);
});

test("mixed: totalDebtPaid also excludes the EUR (context differs from raw addition)", () => {
  assert.notEqual(goldenTotal(mixedResidue), goldenTotal(mixedResidue, CTX));
  assert.equal(goldenTotal(mixedResidue) - goldenTotal(mixedResidue, CTX), 500);
});

test("mixed: EUR/null entries flagged estimated with context", () => {
  const withCtx = rollupDebtPaymentsByAccount(mixedResidue, CTX);
  assert.equal(withCtx.find((e) => e.accountId === "cardD")?.estimated, true);
  assert.equal(withCtx.find((e) => e.accountId === "cardE")?.estimated, true);
});

test("mixed: pure-USD entries stay unflagged", () => {
  const withCtx = rollupDebtPaymentsByAccount(mixedResidue, CTX);
  assert.equal(withCtx.find((e) => e.accountId === "cardA")?.estimated, false);
});

test("mixed: context-less path never flags", () => {
  assert.ok(rollupDebtPaymentsByAccount(mixedResidue).every((e) => e.estimated === false));
});

// ── real-rate context: converts + flags correctly (seam liveness) ─────────────

const realCtx = {
  target: "USD",
  resolve: (from: string, dateISO: string) =>
    from === "EUR" && dateISO === "2026-06-10"
      ? ({ kind: "rate", rate: 1.2, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" } as const)
      : ({ kind: "miss", quote: from, requestedDateISO: dateISO } as const),
};
const realRows: DebtPaymentTxnLike[] = [
  { accountId: "cardD", amount: -500, flowType: "DEBT_PAYMENT", currency: "EUR", dateISO: "2026-06-10" },
  { accountId: "cardE", amount: -100, flowType: "DEBT_PAYMENT", currency: "SAR", dateISO: "2026-06-10" },
];

test("real: EUR converts at its row date (500 × 1.2 = 600), exact ⇒ not estimated", () => {
  const rollup = rollupDebtPaymentsByAccount(realRows, realCtx);
  assert.equal(rollup[0].total, 600);
  assert.equal(rollup[0].estimated, false);
});

test("real: missed SAR EXCLUDED to 0 + estimated (V25-FINAL-1, not native 100)", () => {
  const rollup = rollupDebtPaymentsByAccount(realRows, realCtx);
  assert.equal(rollup[1].total, 0);
  assert.equal(rollup[1].estimated, true);
});

test("real: totalDebtPaid is the convertible-only sum (600 + 0)", () => {
  assert.equal(goldenTotal(realRows, realCtx), 600);
});

// ── base rollup semantics (merged from lib/debt.test.ts, TEST-2) ──────────────
// The equivalence gates above compare CODE PATHS (no-ctx vs identity-ctx). These
// pin the literal base semantics that nothing else does: flow-predicate
// exclusion, mixed-sign abs-sum, group-by-account, descending sort by total, and
// per-account count.
// v2.6-DEBT-1 — every id used here must be a DECLARED debt account, because
// `asCashLegs` maps it to the counterparty and membership now requires a
// proven liability destination. Previously any string worked: an unknown
// destination was admitted anyway.

const tx = (accountId: string, amount: number, flowType: string | null): DebtPaymentTxnLike =>
  ({ accountId, amount, flowType });

test("empty input → 0", () => {
  assert.equal(goldenTotal([]), 0);
});

test("non-DEBT_PAYMENT rows ignored", () => {
  assert.equal(goldenTotal([tx("cardA", -50, "SPENDING"), tx("cardA", 100, "INCOME"), tx("cardA", -35, "FEE")]), 0);
});

test("null flowType excluded (legacy Payment rows not counted by flow predicate)", () => {
  assert.equal(goldenTotal([tx("cardA", -300, null)]), 0);
});

test("abs-sums across mixed signs (INTERNAL negative + INFLOW positive legs)", () => {
  assert.equal(goldenTotal([tx("cardA", -300, "DEBT_PAYMENT"), tx("cardB", 200, "DEBT_PAYMENT")]), 500);
});

test("empty input → empty rollup", () => {
  assert.equal(rollupDebtPaymentsByAccount([]).length, 0);
});

const baseRollupRows = [
  tx("amex", -300, "DEBT_PAYMENT"),
  tx("chase", 500, "DEBT_PAYMENT"),
  tx("amex", -100, "DEBT_PAYMENT"),
  tx("amex", -20, "SPENDING"), // purchase on the card — not a payment
  tx("chase", -15, null), // unclassified — excluded
];

test("groups by account id", () => {
  assert.equal(rollupDebtPaymentsByAccount(baseRollupRows).length, 2);
});

test("sorted descending by total", () => {
  const rollup = rollupDebtPaymentsByAccount(baseRollupRows);
  assert.equal(rollup[0]?.accountId, "chase");
  assert.equal(rollup[0]?.total, 500);
});

test("per-account total + count (abs-summed)", () => {
  const rollup = rollupDebtPaymentsByAccount(baseRollupRows);
  assert.equal(rollup[1]?.accountId, "amex");
  assert.equal(rollup[1]?.total, 400);
  assert.equal(rollup[1]?.count, 2);
});

test("rollup totals reconcile to totalDebtPaid over the same rows", () => {
  const rollup = rollupDebtPaymentsByAccount(baseRollupRows);
  assert.equal(rollup.reduce((s, e) => s + e.total, 0), goldenTotal(baseRollupRows));
});
