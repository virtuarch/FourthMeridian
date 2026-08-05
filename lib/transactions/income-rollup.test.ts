/**
 * lib/transactions/income-rollup.test.ts   (V27-TRUTH-5)
 *
 * The read-boundary composition, plus the standing probes that keep income
 * classification out of React and keep the surfaces honest about scope.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { composeIncomeRollup, incomeLineAmount, INCLUDED_CLASSES } from "./income-rollup";
import { attributeIncome } from "./income-source";
import { foldEconomicRow, type EconomicAccumulator } from "./cash-flow";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const row = (id: string, amount: number, o: Parameters<typeof attributeIncome>[0]) =>
  ({ id, amount, attribution: attributeIncome(o) });
const base = { flowType: "INCOME", accountType: "checking", amount: 1 } as const;

/** The live corpus shape (2026-08-04). */
const LIVE = [
  row("salary", 255648.69, { ...base, providerDetail: "INCOME_SALARY" }),
  row("contract", 18480.84, { ...base, providerDetail: "INCOME_CONTRACTOR" }),
  row("int-hysa", 62.60, { ...base, providerDetail: "INCOME_INTEREST_EARNED", accountType: "savings", sourceAccountId: "hysa" }),
  row("int-chk", 6.03, { ...base, providerDetail: "INCOME_INTEREST_EARNED", sourceAccountId: "chk" }),
  row("btc", 0.24, { ...base, providerDetail: null, accountType: "crypto" }),
  row("msft", 280.45, { ...base, accountType: "debt", liabilityInflowIsIssuerCredit: true }),
  row("uber", 215.20, { ...base, accountType: "debt", liabilityInflowIsIssuerCredit: true }),
];
const DIVIDENDS = [
  { id: "d1", amount: 7.54, instrumentId: "i-tqqq", ticker: "TQQQ" },
  { id: "d2", amount: 7.40, instrumentId: "i-jpm", ticker: "JPM" },
  { id: "d3", amount: 12.82, instrumentId: "i-nke", ticker: "NKE" },
];
const LABELS = new Map([["hysa", "High Yield Savings Account"], ["chk", "CHASE SAVINGS"]]);

console.log("V27-TRUTH-5. (1) Broad income EQUALS the sum of its included lines");
{
  for (const scope of ["BANK_TRANSACTIONS", "ALL_SOURCES"] as const) {
    const r = composeIncomeRollup({ scope, rows: LIVE, dividends: DIVIDENDS, accountLabels: LABELS });
    check(`${scope}: broad === Σ lines`,
      Math.abs(r.broad - r.lines.reduce((s, l) => s + l.amount, 0)) < 1e-9);
    check(`${scope}: broad === earned+interest+dividends+other`,
      Math.abs(r.broad - INCLUDED_CLASSES.reduce((s, c) => s + incomeLineAmount(r, c), 0)) < 1e-9);
  }
}

console.log("V27-TRUTH-5. (2) Every included row belongs to exactly ONE line");
{
  const r = composeIncomeRollup({ scope: "ALL_SOURCES", rows: LIVE, dividends: DIVIDENDS });
  const all = r.lines.flatMap((l) => l.rowIds);
  check("no row id appears twice", new Set(all).size === all.length);
  check("included + excluded accounts for every input row",
    all.length + r.excluded.count === LIVE.length + DIVIDENDS.length);
}

console.log("V27-TRUTH-5. (3) NOT_INCOME never enters broad income");
{
  const r = composeIncomeRollup({ scope: "BANK_TRANSACTIONS", rows: LIVE });
  check("the issuer credits are excluded", r.excluded.count === 2);
  check("...with their amount reported", Math.abs(r.excluded.amount - 495.65) < 0.005);
  check("...and a named reason", r.excluded.byReason[0].subtype === "ISSUER_CREDIT");
  check("...and NOT inside broad", !r.lines.some((l) => l.rowIds.includes("msft")));
  check("no NOT_INCOME line is ever emitted",
    !r.lines.some((l) => l.incomeClass === "NOT_INCOME"));

  // The Cash Flow economic fold must agree.
  const acc: EconomicAccumulator = { income: 0, spendGross: 0, refunds: 0 };
  foldEconomicRow(acc, "INCOME", 280.45, "NOT_INCOME");
  check("foldEconomicRow refuses a NOT_INCOME row", acc.income === 0);
  foldEconomicRow(acc, "INCOME", 100, "EARNED_INCOME");
  check("...and accepts an earned one", acc.income === 100);
  foldEconomicRow(acc, "INCOME", 50, null);
  check("...and keeps prior behaviour when no attribution was supplied", acc.income === 150);
}

console.log("V27-TRUTH-5. (4) Earned excludes everything it must");
{
  const r = composeIncomeRollup({ scope: "ALL_SOURCES", rows: LIVE, dividends: DIVIDENDS });
  const earned = r.lines.find((l) => l.incomeClass === "EARNED_INCOME")!;
  check("earned is salary + contract only", Math.abs(earned.amount - 274129.53) < 0.005);
  check("...excludes interest", !earned.rowIds.includes("int-hysa"));
  check("...excludes dividends", !earned.rowIds.some((id) => id.startsWith("d")));
  check("...excludes issuer credits", !earned.rowIds.includes("msft"));
  for (const [name, o] of [
    ["a transfer", { ...base, isOwnedInternalTransfer: true }],
    ["a refund", { ...base, flowType: "REFUND" }],
    ["loan proceeds", { ...base, providerDetail: "LOAN_DISBURSEMENTS_STUDENT_LOAN_DISBURSEMENT" }],
  ] as const) {
    const one = composeIncomeRollup({ scope: "BANK_TRANSACTIONS", rows: [row("x", 100, o)] });
    check(`...excludes ${name}`, incomeLineAmount(one, "EARNED_INCOME") === 0 && one.excluded.count === 1);
  }
}

console.log("V27-TRUTH-5. (5) Interest retains its source account");
{
  const r = composeIncomeRollup({ scope: "BANK_TRANSACTIONS", rows: LIVE, accountLabels: LABELS });
  const interest = r.lines.find((l) => l.incomeClass === "INTEREST_INCOME")!;
  check("interest is separated", Math.abs(interest.amount - 68.63) < 0.005);
  check("...and names both paying accounts", interest.sources.length === 2);
  check("...with resolved labels",
    interest.sources[0].label === "High Yield Savings Account" && interest.sources[0].amount === 62.60);
  check("...sources sum to the line", Math.abs(interest.sources.reduce((s, x) => s + x.amount, 0) - interest.amount) < 1e-9);
}

console.log("V27-TRUTH-5. (6) Dividends retain their instrument/ticker");
{
  const r = composeIncomeRollup({ scope: "ALL_SOURCES", rows: LIVE, dividends: DIVIDENDS });
  const div = r.lines.find((l) => l.incomeClass === "DIVIDEND_INCOME")!;
  check("dividends are a line of their own", Math.abs(div.amount - 27.76) < 0.005);
  check("...each carrying a ticker", div.sources.map((s) => s.label).sort().join(",") === "JPM,NKE,TQQQ");
  check("...ordered by amount", div.sources[0].label === "NKE");
}

console.log("V27-TRUTH-5. (7) No dividend is double counted across the two ledgers");
{
  const bank = composeIncomeRollup({ scope: "BANK_TRANSACTIONS", rows: LIVE, dividends: DIVIDENDS });
  const all  = composeIncomeRollup({ scope: "ALL_SOURCES", rows: LIVE, dividends: DIVIDENDS });
  check("BANK_TRANSACTIONS scope IGNORES investment dividends entirely",
    !bank.lines.some((l) => l.incomeClass === "DIVIDEND_INCOME"));
  check("...so the two scopes differ by exactly the dividend total",
    Math.abs((all.broad - bank.broad) - 27.76) < 0.005);
  check("the scope is NAMED on the rollup", bank.scope === "BANK_TRANSACTIONS");
  check("...and carried into the headline label",
    bank.headlineLabel === "Income (bank transactions)" && all.headlineLabel === "Income (all sources)");
  check("a dividend id never appears in both scopes' bank lines",
    !bank.lines.flatMap((l) => l.rowIds).some((id) => DIVIDENDS.some((d) => d.id === id)));
}

console.log("V27-TRUTH-5. (8) Headline / chart / card / drawer share ROW IDENTITIES");
{
  const r = composeIncomeRollup({ scope: "ALL_SOURCES", rows: LIVE, dividends: DIVIDENDS });
  // A chart segment, a card and a drawer all read the SAME line object, so
  // parity is structural rather than a coincidence of three computations.
  for (const l of r.lines) {
    check(`${l.label}: rowIds count matches the line count`, l.rowIds.length === l.count);
  }
  const headline = r.broad;
  const fromCards = r.lines.reduce((s, l) => s + l.amount, 0);
  const fromDrawerIds = r.lines.flatMap((l) => l.rowIds).length;
  check("headline equals the sum of the cards", Math.abs(headline - fromCards) < 1e-9);
  check("every drawer row is in exactly one card", fromDrawerIds === new Set(r.lines.flatMap((l) => l.rowIds)).size);
}

console.log("V27-TRUTH-5. Static probes");
{
  const root = join(__dirname, "..", "..");
  const strip = (s: string) => s
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ")
    .replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  const src = strip(readFileSync(join(root, "lib/transactions/income-rollup.ts"), "utf8"));

  // (11) React performs no income classification or arithmetic.
  const reactHits = execSync(
    `grep -rln "attributeIncome\\|composeIncomeRollup\\|INCOME_SUBTYPE_LABEL" ${root}/components ${root}/app 2>/dev/null || true`,
    { encoding: "utf8" }).trim();
  check("no component or route classifies income", reactHits === "", reactHits);
  const reactMath = execSync(
    `grep -rn "incomeClass" ${root}/components ${root}/app 2>/dev/null | grep -E "\\+=|reduce\\(" || true`,
    { encoding: "utf8" }).trim();
  check("no component sums by income class", reactMath === "", reactMath);

  // (12) No merchant-string classification anywhere in the income path.
  for (const f of ["merchant", "description", "toUpperCase", "RegExp"]) {
    check(`the rollup never references \`${f}\``, !src.includes(f));
  }
  // (14) No economic-date or L8 work in this slice.
  for (const f of ["economicDate", "EconomicEvent", "ProviderObservation"]) {
    check(`the rollup never touches \`${f}\``, !src.includes(f));
  }
  check("the rollup is pure — no DB, no React, no clock",
    !src.includes("@/lib/db") && !src.includes("react") && !src.includes("Date."));
}

console.log("V27-TRUTH-6. Cash Flow consumes the rollup; incomeBySource is retired as a UI authority");
{
  const root2 = join(__dirname, "..", "..");
  const sh = (cmd: string) => execSync(cmd, { encoding: "utf8" }).trim();

  // (1) No component reads `incomeBySource` — neither the contract field nor the
  //     function. Comments are stripped so prose ABOUT the retirement passes.
  // Test files legitimately NAME the retired authority when asserting it is gone.
  const uiSrc = sh(`grep -rl "incomeBySource" ${root2}/components ${root2}/app 2>/dev/null || true`)
    .split("\n").filter(Boolean).filter((f) => !/\.test\.[tj]sx?$/.test(f));
  const stripFile = (f: string) => readFileSync(f, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
  const realHits = uiSrc.filter((f) => /incomeBySource/.test(stripFile(f)));
  check("no component or route references incomeBySource in code", realHits.length === 0, realHits.join(", "));

  // (2) Every Cash Flow income UI path goes through the canonical entry point.
  const consumers = [
    "components/space/widgets/cashflow/CashFlowWorkspace.tsx",
    "components/space/widgets/cash-flow-adapters.tsx",
    "components/space/widgets/cashflow/cash-flow-insights.ts",
  ];
  for (const f of consumers) {
    const src = stripFile(join(root2, f));
    check(`${f.split("/").pop()} consumes the canonical rollup`,
      /rollupIncomeFromTransactions|data\.income\.lines/.test(src));
  }

  // (3) No React arithmetic or classification over income.
  const mathHits = sh(`grep -rn "incomeClass\\|incomeSubtype" ${root2}/components ${root2}/app 2>/dev/null | grep -E "\\+=|reduce\\(|filter\\(.*===" || true`);
  check("no component sums or filters by income class", mathHits === "", mathHits);
  const authHits = sh(`grep -rl "attributeIncome\\|composeIncomeRollup(" ${root2}/components ${root2}/app 2>/dev/null || true`);
  check("no component calls the classification authority directly", authHits === "", authHits);

  // (10) No economic-date or L8 work entered this slice.
  for (const f of consumers.concat(["lib/transactions/income-rollup.ts"])) {
    const src = stripFile(join(root2, f));
    check(`${f.split("/").pop()} touches no economicDate/L8 symbol`,
      !/economicDate|EconomicEvent|ProviderObservation/.test(src));
  }
}

console.log("V27-TRUTH-6. incomeBySource, where it survives, is DERIVED from the rollup");
{
  // The contract keeps the payer grouping for compatibility, but its membership
  // is the rollup's — so a NOT_INCOME row cannot appear in it.
  const src = readFileSync(join(__dirname, "cash-flow.ts"), "utf8");
  check("incomeBySource accepts an included-row-id set", src.includes("includedRowIds"));
  check("...and skips any row outside it",
    /includedRowIds && !includedRowIds\.has\(t\.id\)/.test(src));
  const sd = readFileSync(join(__dirname, "cash-flow-space-data.ts"), "utf8");
  check("the contract derives incomeBySource from the rollup's membership",
    /includedIncomeIds/.test(sd) && /incomeBySource\(windowed, moneyCtx, includedIncomeIds\)/.test(sd));
  check("...and builds the rollup through the ONE entry point",
    /rollupIncomeFromTransactions\(windowed/.test(sd));
}

console.log("V27-TRUTH-6. Attribution population === the population income is summed over");
{
  // The regression this pins: `serialize.ts` attributed an income class to EVERY
  // positive-amount row — transfers in, refunds, debt-payment inflows. Each fell
  // through to UNRESOLVED_INCOME, so the moment a surface summed the field
  // "Other income" read $380,127.32 over 252 rows against a real total of $0.24.
  // Only the parity check caught it; no unit test could, because each module was
  // individually correct.
  const src = readFileSync(join(__dirname, "serialize.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
  check("the serializer gates attribution on isIncome, not merely a positive amount",
    /amount\s*>\s*0\s*&&\s*isIncome\(/.test(src));
  check("...using the SAME predicate the economic fold uses",
    src.includes("flow-predicates"));

  // And the rollup entry point must not re-widen it.
  const roll = readFileSync(join(__dirname, "income-rollup.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
  check("the rollup skips rows with no attribution rather than defaulting them",
    /incomeClass\s*==\s*null\)\s*continue/.test(roll));
  check("...and never invents a class for one", !/UNRESOLVED_INCOME\"?\s*:/.test(roll.replace(/incomeSubtype \?\? \"UNRESOLVED_INCOME\"/, "")));
}

console.log(failures === 0 ? "\nincome-rollup: all passed." : `\nincome-rollup: ${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
