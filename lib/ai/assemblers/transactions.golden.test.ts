/**
 * lib/ai/assemblers/transactions.golden.test.ts
 *
 * MC1 Phase 2 Slice 4 golden gate, evolved into MC1 Phase 3 Slice 2
 * EQUIVALENCE GATES (plan D-10) over the exported pure seam
 * buildMonthlyBreakdown: pure-USD fixtures stay byte-identical (both paths
 * emit `estimated: false`, the new D-7 field); residue/mixed fixtures stay
 * NUMERICALLY identical under identity while months containing unresolved
 * rows flag `estimated: true`; real-rate contexts convert with correct flags.
 * kd17's invariant suite (context-less calls) remains the KD-17 regression
 * net. NOTE: importing the assembler transitively constructs the Prisma
 * client — pure fixtures only, no query is issued (same note as kd17).
 */

import { buildMonthlyBreakdown, accumulateNeedsClassification } from "./transactions";
import type { NeedsClassificationRow } from "./transactions";
import { shouldSurfaceAsNeedsClassification } from "@/lib/transactions/needs-classification";
import { identityContext } from "@/lib/money/convert";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import type { ConversionContext } from "@/lib/money/types";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

const CTX = identityContext(DEFAULT_DISPLAY_CURRENCY);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function row(dateISO: string, amount: number, flowType: string, category: string, currency: string | null, pending = false): any {
  return {
    date: new Date(`${dateISO}T00:00:00Z`),
    merchant: "M",
    category,
    amount,
    pending,
    currency,
    flowType,
    flowDirection: null,
  };
}

const numbersOf = (ms: ReturnType<typeof buildMonthlyBreakdown>) =>
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ms.map(({ estimated, ...rest }) => rest);

const pureUsd = [
  row("2026-05-03", -120.55, "SPENDING", "Food", "USD"),
  row("2026-05-10", 2500,    "INCOME",   "Income", "USD"),
  row("2026-05-12", -300,    "DEBT_PAYMENT", "Payment", "USD"),
  row("2026-05-14", 45.5,    "REFUND",   "Shopping", "USD"),
  row("2026-05-20", -80,     "TRANSFER", "Transfer", "USD"),
  row("2026-06-01", -60.25,  "FEE",      "Fees", "USD"),
  row("2026-06-05", 15,      "SPENDING", "Food", "USD"), // credit in a spending category (KD-17)
];
const pending = [row("2026-06-06", -25, "SPENDING", "Food", "USD", true)];

// ── kill switch: pure-USD byte-identity ───────────────────────────────────────

{
  const without = buildMonthlyBreakdown(pureUsd, pending, "2026-05-01", "2026-06-30", null);
  const withCtx = buildMonthlyBreakdown(pureUsd, pending, "2026-05-01", "2026-06-30", null, CTX);
  check("kill switch: monthly breakdown byte-identical (pure-USD)",
    JSON.stringify(without) === JSON.stringify(withCtx));
  check("kill switch: estimated false on every month, both paths",
    without.every((m) => m.estimated === false) && withCtx.every((m) => m.estimated === false));
  check("flow totals identical per month",
    without[0].incomeTotal === withCtx[0].incomeTotal &&
    without[0].debtPaymentTotal === withCtx[0].debtPaymentTotal &&
    without[1].expenseTotal === withCtx[1].expenseTotal);
}

// ── residue/mixed: numbers identical, month flags honest ─────────────────────

{
  const mixed = [
    ...pureUsd,
    row("2026-06-02", -10,  "SPENDING", "Food", null),   // Phase 0 null-residue → June flagged
    row("2026-06-07", -200, "SPENDING", "Food", "EUR"),  // unresolved under identity → June flagged
  ];
  const a = buildMonthlyBreakdown(mixed, [], "2026-05-01", "2026-06-30", null);
  const b = buildMonthlyBreakdown(mixed, [], "2026-05-01", "2026-06-30", null, CTX);
  check("mixed: numbers identical under identity (flags aside)",
    JSON.stringify(numbersOf(a)) === JSON.stringify(numbersOf(b)));
  check("mixed: month with residue/non-USD rows flagged with context, May stays exact",
    b.find((m) => m.month === "2026-06")?.estimated === true &&
    b.find((m) => m.month === "2026-05")?.estimated === false);
  check("mixed: context-less path never flags", a.every((m) => m.estimated === false));
}

// ── KD-7 truncated-month handling unaffected ──────────────────────────────────

{
  const a = buildMonthlyBreakdown(pureUsd, [], "2026-05-01", "2026-06-30", "2026-05");
  const b = buildMonthlyBreakdown(pureUsd, [], "2026-05-01", "2026-06-30", "2026-05", CTX);
  check("KD-7: truncated-month handling byte-identical (pure-USD)", JSON.stringify(a) === JSON.stringify(b));
}

// ── real-rate context: converts + flags (seam liveness) ───────────────────────

{
  const realCtx: ConversionContext = {
    target: "USD",
    resolve: (from, dateISO) =>
      from === "EUR"
        ? { kind: "rate", rate: 1.5, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" }
        : { kind: "miss", quote: from, requestedDateISO: dateISO },
  };
  const m = buildMonthlyBreakdown([row("2026-06-07", -200, "SPENDING", "Food", "EUR")], [], "2026-06-01", "2026-06-30", null, realCtx);
  check("real: EUR spending converts at row date (200 × 1.5 = 300), exact ⇒ month not estimated",
    m[0].expenseTotal === 300 && m[0].estimated === false);
  const mm = buildMonthlyBreakdown([row("2026-06-07", -100, "SPENDING", "Food", "SAR")], [], "2026-06-01", "2026-06-30", null, realCtx);
  check("real: missed rate stays native + month estimated (D-3)",
    mm[0].expenseTotal === 100 && mm[0].estimated === true);
}

// ── TI2-W1: needs-classification aggregate (additive; disclosure-only) ────────

function ncRow(
  id: string,
  amount: number,
  opts: Partial<NeedsClassificationRow> = {},
): NeedsClassificationRow {
  return {
    id,
    flowType:              opts.flowType ?? "SPENDING",
    classificationReason:  opts.classificationReason ?? null,
    transferRail:          opts.transferRail ?? null,
    merchantId:            opts.merchantId ?? null,
    counterpartyAccountId: opts.counterpartyAccountId ?? null,
    amount,
    currency:              opts.currency ?? "USD",
    date:                  opts.date ?? new Date("2026-06-01T00:00:00Z"),
  };
}

// Independent re-derivation of the Tab's UNKNOWN_PAYMENT_APP_PURPOSE count over
// the SAME rows + resolved-counterparty set — mirrors lib/data/transactions.ts
// contextFields()/deriveTransactionContext input construction exactly. A
// divergence between this and the assembler's aggregate is the KD-10 defect
// this parity test exists to catch.
function tabPaymentAppCount(rows: NeedsClassificationRow[], resolvedCp: ReadonlySet<string>): number {
  let n = 0;
  for (const r of rows) {
    const res = shouldSurfaceAsNeedsClassification({
      flowType:                r.flowType,
      classificationReason:    r.classificationReason,
      transferRail:            r.transferRail,
      hasResolvedMerchant:     r.merchantId != null,
      hasResolvedCounterparty: r.counterpartyAccountId != null || resolvedCp.has(r.id),
    });
    if (res.needsClassification && res.reason === "UNKNOWN_PAYMENT_APP_PURPOSE") n++;
  }
  return n;
}

{
  const rows: NeedsClassificationRow[] = [
    // A — payment-app, no counterparty, not read-time-resolved → flagged.
    ncRow("pa-1", -50, { flowType: "TRANSFER", transferRail: "PAYMENT_APP" }),
    // A but read-time-resolved (id in resolvedCp) → NOT flagged (parity, §3.3).
    ncRow("pa-2", -75, { flowType: "TRANSFER", transferRail: "PAYMENT_APP" }),
    // A but persisted counterparty present → NOT flagged.
    ncRow("pa-3", -90, { flowType: "TRANSFER", transferRail: "PAYMENT_APP", counterpartyAccountId: "acct-x" }),
    // B — sign-default inflow, no resolved merchant → flagged.
    ncRow("inf-1", 200, { flowType: "INCOME", classificationReason: "SIGN_DEFAULT_INFLOW" }),
    // B but merchant resolved → NOT flagged.
    ncRow("inf-2", 300, { flowType: "INCOME", classificationReason: "SIGN_DEFAULT_INFLOW", merchantId: "m-1" }),
    // Income classified by a real reason → NOT flagged.
    ncRow("inf-3", 400, { flowType: "INCOME", classificationReason: "MERCHANT_RULE" }),
    // Ordinary spending → NOT flagged.
    ncRow("sp-1", -25, { flowType: "SPENDING" }),
  ];
  const resolvedCp = new Set<string>(["pa-2"]);

  const agg = accumulateNeedsClassification(rows, resolvedCp, CTX);

  check("needs-classification: count = flagged rows (A + B)", agg.count === 2, JSON.stringify(agg));
  check("needs-classification: unknownPaymentAppCount = 1", agg.unknownPaymentAppCount === 1);
  check("needs-classification: unknownPaymentAppTotal = |−50| = 50", agg.unknownPaymentAppTotal === 50);
  check("needs-classification: unknownInflowCount = 1", agg.unknownInflowCount === 1);
  check("needs-classification: unknownInflowTotal = 200", agg.unknownInflowTotal === 200);

  // Parity: assembler's payment-app count equals the Tab's independent count.
  check("needs-classification: PARITY — assembler count === Tab-derived count",
    agg.unknownPaymentAppCount === tabPaymentAppCount(rows, resolvedCp));

  // Parity is load-bearing: without the read-time set, pa-2 would also flag.
  check("needs-classification: parity term actually suppresses pa-2",
    accumulateNeedsClassification(rows, new Set<string>(), CTX).unknownPaymentAppCount === 2 &&
    tabPaymentAppCount(rows, new Set<string>()) === 2);
}

// Target-currency conversion: flagged amounts convert at each row's own date.
{
  const eurCtx: ConversionContext = {
    target: "USD",
    resolve: (from, dateISO) =>
      from === "EUR"
        ? { kind: "rate", rate: 2, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" }
        : { kind: "miss", quote: from, requestedDateISO: dateISO },
  };
  const rows: NeedsClassificationRow[] = [
    ncRow("eur-pa", -40, { flowType: "TRANSFER", transferRail: "PAYMENT_APP", currency: "EUR" }),
    ncRow("eur-inf", 60, { flowType: "INCOME", classificationReason: "SIGN_DEFAULT_INFLOW", currency: "EUR" }),
  ];
  const agg = accumulateNeedsClassification(rows, new Set<string>(), eurCtx);
  check("needs-classification: payment-app total converted (|−40|×2 = 80)", agg.unknownPaymentAppTotal === 80);
  check("needs-classification: inflow total converted (60×2 = 120)", agg.unknownInflowTotal === 120);
}

if (failures.length > 0) {
  console.error(`\nMC1 P3 assembler equivalence gates: ${failures.length} FAILURE(S) (${passed} checks passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`MC1 P3 assembler equivalence gates: all ${passed} checks passed.`);
process.exit(0);
