/**
 * lib/debt/debt-type.test.ts
 *
 * Owner requirement 2026-11-08 — ONE fine-grained debt-type model. Mortgages and
 * installment loans share some accounting behaviour but remain distinct types;
 * only genuine revolving credit takes part in utilization; mortgage-specific
 * behaviour (mortgage rate label, equity, escrow, amortization) applies ONLY to a
 * mortgage.
 *
 * Locks:
 *   1. classification matrix — every Plaid credit/loan subtype + every FM
 *      debtSubtype → debtType + liabilityKind (+ case/whitespace, limit
 *      discrimination, FM-over-Plaid precedence, non-debt type, no evidence);
 *   2. liabilityKind ≡ kindOfDebtType(debtType) ≡ the pre-2026-11-08 rule (oracle);
 *   3. mortgage gate — auto/student/personal/closed-end home equity never read as
 *      a mortgage (label, isMortgage, rate label);
 *   4. rate labels per type (APR / Interest rate / Mortgage rate);
 *   5. utilization + available credit — revolving only (HELOC with a limit in,
 *      auto loan with a limit out);
 *   6. surfaces carry the type (AI assembler, snapshot tool, ledger labels agree);
 *   7. source scan — no NEW ad-hoc subtype comparisons outside the classifier.
 *
 * Fabricated fixtures only. Pure: no DB, no network.
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/debt/debt-type.test.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  debtType, debtTypeLabel, isMortgageDebt, kindOfDebtType, liabilityKind, isInstallmentLoan,
  DEBT_TYPES, DEBT_TYPE_LABEL, REVOLVING_DEBT_TYPES, INSTALLMENT_DEBT_TYPES,
  PLAID_CREDIT_SUBTYPES, PLAID_LOAN_SUBTYPES, PLAID_REVOLVING_LOAN_SUBTYPES, PLAID_LIMIT_DISCRIMINATED_SUBTYPES,
  REVOLVING_DEBT_SUBTYPES, INSTALLMENT_DEBT_SUBTYPES,
  type DebtType, type LiabilityKind, type LiabilityKindInput,
} from "@/lib/debt/liability-kind";
import { rateLabel, isMortgage } from "@/lib/debt/rate-label";
import { creditUtilization, isRevolvingLine } from "@/lib/accounts/credit-utilization";
import { resolveAccountBalances } from "@/lib/balances/account-balances";
import { resolveAccountFreshness } from "@/lib/freshness/observation";
import { presentationDebtLabel, accountUtilization } from "@/components/space/widgets/debt/debt-ledger-util";
import type { DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

// ── The pre-2026-11-08 liabilityKind, verbatim — the equivalence oracle ──────
function norm(s: string | null | undefined): string | null { const t = s?.trim().toLowerCase(); return t ? t : null; }
function legacyLiabilityKind(a: LiabilityKindInput): LiabilityKind {
  if (a.type != null && a.type !== "debt") return "unknown";
  const ds = norm(a.debtSubtype);
  if (ds !== null) return REVOLVING_DEBT_SUBTYPES.has(ds) ? "revolving" : "installment";
  const sub = norm(a.providerSubtype);
  if (sub === null) return "unknown";
  if (PLAID_CREDIT_SUBTYPES.has(sub) || PLAID_REVOLVING_LOAN_SUBTYPES.has(sub)) return "revolving";
  if (PLAID_LIMIT_DISCRIMINATED_SUBTYPES.has(sub)) return a.creditLimit != null && a.creditLimit > 0 ? "revolving" : "installment";
  if (PLAID_LOAN_SUBTYPES.has(sub)) return "installment";
  return "unknown";
}

console.log("1. Classification matrix — Plaid subtypes (no FM debtSubtype)");
const PLAID_MATRIX: Array<[string, number | null, DebtType]> = [
  ["credit card",    null,   "credit_card"],
  ["credit card",    5_000,  "credit_card"],
  ["paypal",         null,   "other_revolving"],
  ["line of credit", null,   "personal_line_of_credit"],
  ["overdraft",      null,   "overdraft"],
  ["home equity",    50_000, "heloc"],
  ["home equity",    null,   "other_installment"],
  ["home equity",    0,      "other_installment"],
  ["mortgage",       null,   "mortgage"],
  ["mortgage",       400_000,"mortgage"],
  ["auto",           30_000, "auto_loan"],
  ["auto",           null,   "auto_loan"],
  ["student",        null,   "student_loan"],
  ["consumer",       null,   "personal_installment"],
  ["loan",           null,   "other_installment"],
  ["business",       null,   "other_installment"],
  ["commercial",     null,   "other_installment"],
  ["construction",   null,   "other_installment"],
  ["other",          null,   "other_installment"],
];
for (const [sub, limit, want] of PLAID_MATRIX) {
  const a = { type: "debt", providerSubtype: sub, creditLimit: limit };
  const got = debtType(a);
  check(`Plaid "${sub}"${limit != null ? ` limit ${limit}` : ""} ⇒ ${want} (${kindOfDebtType(want)})`,
    got === want && liabilityKind(a) === kindOfDebtType(want), { got, kind: liabilityKind(a) });
}
{
  const covered = new Set(PLAID_MATRIX.map(([s]) => s));
  const all = [...PLAID_CREDIT_SUBTYPES, ...PLAID_LOAN_SUBTYPES];
  check("matrix covers EVERY Plaid credit + loan subtype", all.every((s) => covered.has(s)), all.filter((s) => !covered.has(s)));
  check("no Plaid credit/loan subtype classifies as unknown",
    all.every((s) => debtType({ type: "debt", providerSubtype: s }) !== "unknown"));
}
check("case/whitespace-insensitive ('  Mortgage ', 'AUTO')",
  debtType({ type: "debt", providerSubtype: "  Mortgage " }) === "mortgage" && debtType({ providerSubtype: "AUTO" }) === "auto_loan");

console.log("\n1b. Classification matrix — FM debtSubtype (explicit, wins over Plaid)");
const FM_MATRIX: Array<[string, DebtType]> = [
  ["credit_card",    "credit_card"],
  ["line_of_credit", "personal_line_of_credit"],
  ["heloc",          "heloc"],
  ["mortgage",       "mortgage"],
  ["auto_loan",      "auto_loan"],
  ["student_loan",   "student_loan"],
  ["personal_loan",  "personal_installment"],
  ["boat_loan",      "other_installment"],  // any other explicit kind amortises (F2 rule)
];
for (const [ds, want] of FM_MATRIX) {
  const a = { type: "debt", debtSubtype: ds, providerSubtype: "credit card", creditLimit: 9_000 };
  check(`FM "${ds}" ⇒ ${want} (beats Plaid "credit card")`, debtType(a) === want, debtType(a));
}
check("every FM vocabulary subtype is in the matrix",
  [...REVOLVING_DEBT_SUBTYPES, ...INSTALLMENT_DEBT_SUBTYPES].every((s) => FM_MATRIX.some(([d]) => d === s)));
check("FM heloc is revolving even without a limit", liabilityKind({ type: "debt", debtSubtype: "heloc" }) === "revolving");

console.log("\n1c. Unknown stays unknown");
for (const [name, a] of [
  ["untyped, no limit",          { type: "debt" }],
  ["untyped, with a limit",      { type: "debt", creditLimit: 5_000 }],
  ["unrecognised Plaid subtype", { type: "debt", providerSubtype: "personal" }],
  ["blank subtypes",             { type: "debt", debtSubtype: "  ", providerSubtype: "" }],
  ["non-debt type",              { type: "checking", debtSubtype: "mortgage", providerSubtype: "mortgage" }],
] as Array<[string, LiabilityKindInput]>) {
  check(`${name} ⇒ unknown / unknown / "Debt"`,
    debtType(a) === "unknown" && liabilityKind(a) === "unknown" && debtTypeLabel(a) === "Debt", debtType(a));
}

console.log("\n2. liabilityKind ≡ kindOfDebtType(debtType) ≡ pre-2026-11-08 rule");
{
  const subs: Array<string | null> = [null, "", ...PLAID_CREDIT_SUBTYPES, ...PLAID_LOAN_SUBTYPES, "personal", "401k", " Home Equity "];
  const dss: Array<string | null> = [null, "", ...REVOLVING_DEBT_SUBTYPES, ...INSTALLMENT_DEBT_SUBTYPES, "boat_loan"];
  const limits: Array<number | null> = [null, 0, -1, 1, 50_000];
  const types: Array<string | null | undefined> = [undefined, null, "debt", "checking"];
  let n = 0; const bad: unknown[] = [];
  for (const type of types) for (const debtSubtype of dss) for (const providerSubtype of subs) for (const creditLimit of limits) {
    const a = { type, debtSubtype, providerSubtype, creditLimit }; n++;
    const k = liabilityKind(a);
    if (k !== legacyLiabilityKind(a) || k !== kindOfDebtType(debtType(a))) bad.push(a);
  }
  check(`identical over ${n} combinations`, bad.length === 0, bad.slice(0, 3));
  check("revolving ∩ installment types = ∅; together with unknown they are every DebtType",
    [...REVOLVING_DEBT_TYPES].every((t) => !INSTALLMENT_DEBT_TYPES.has(t))
      && DEBT_TYPES.length === REVOLVING_DEBT_TYPES.size + INSTALLMENT_DEBT_TYPES.size + 1
      && DEBT_TYPES.every((t) => t === "unknown" || REVOLVING_DEBT_TYPES.has(t) || INSTALLMENT_DEBT_TYPES.has(t)));
  check("every DebtType has a distinct label",
    new Set(DEBT_TYPES.map((t) => DEBT_TYPE_LABEL[t])).size === DEBT_TYPES.length);
}

console.log("\n3. Mortgage gate — no other loan reads as a mortgage");
{
  const NON_MORTGAGE_LOANS: LiabilityKindInput[] = [
    { type: "debt", providerSubtype: "auto", creditLimit: 30_000 },
    { type: "debt", debtSubtype: "auto_loan", providerSubtype: "mortgage" },
    { type: "debt", providerSubtype: "student" },
    { type: "debt", debtSubtype: "personal_loan" },
    { type: "debt", providerSubtype: "home equity" },
    { type: "debt", providerSubtype: "construction" },
  ];
  for (const a of NON_MORTGAGE_LOANS) {
    const tag = `${a.debtSubtype ?? a.providerSubtype}`;
    check(`${tag}: installment, not a mortgage, no "Mortgage rate"`,
      isInstallmentLoan(a) && !isMortgageDebt(a) && !isMortgage(a) && rateLabel(a) !== "Mortgage rate" && debtTypeLabel(a) !== "Mortgage");
  }
  const mortgage = { type: "debt", providerSubtype: "mortgage", creditLimit: 400_000 };
  check("Plaid mortgage IS the mortgage (gate passes, label 'Mortgage', 'Mortgage rate')",
    isMortgageDebt(mortgage) && isMortgage(mortgage) && debtTypeLabel(mortgage) === "Mortgage" && rateLabel(mortgage) === "Mortgage rate");
  check("auto loan is labelled 'Auto loan'", debtTypeLabel({ type: "debt", providerSubtype: "auto" }) === "Auto loan");
}

console.log("\n4. Rate label per type");
{
  const want: Record<DebtType, string> = {
    credit_card: "APR", personal_line_of_credit: "APR", heloc: "APR", overdraft: "APR", other_revolving: "APR",
    mortgage: "Mortgage rate",
    auto_loan: "Interest rate", student_loan: "Interest rate", personal_installment: "Interest rate", other_installment: "Interest rate",
    unknown: "Interest rate",
  };
  const sample: Record<DebtType, LiabilityKindInput> = {
    credit_card: { type: "debt", debtSubtype: "credit_card" },
    personal_line_of_credit: { type: "debt", debtSubtype: "line_of_credit" },
    heloc: { type: "debt", debtSubtype: "heloc" },
    overdraft: { type: "debt", providerSubtype: "overdraft" },
    other_revolving: { type: "debt", providerSubtype: "paypal" },
    mortgage: { type: "debt", debtSubtype: "mortgage" },
    auto_loan: { type: "debt", debtSubtype: "auto_loan" },
    student_loan: { type: "debt", providerSubtype: "student" },
    personal_installment: { type: "debt", debtSubtype: "personal_loan" },
    other_installment: { type: "debt", providerSubtype: "loan" },
    unknown: { type: "debt" },
  };
  for (const t of DEBT_TYPES) {
    check(`${t} ⇒ "${want[t]}"`, debtType(sample[t]) === t && rateLabel(sample[t]) === want[t], rateLabel(sample[t]));
  }
  check("student loan reads 'Interest rate', never 'APR'", rateLabel({ type: "debt", debtSubtype: "student_loan" }) === "Interest rate");
}

console.log("\n5. Utilization + available credit — revolving only");
{
  const NOW = new Date("2026-06-30T12:00:00.000Z");
  const fresh = resolveAccountFreshness({ accountId: "x", ingestedAt: new Date(NOW.getTime() - 3_600_000).toISOString(), providerBalanceAt: null }, NOW);
  const helocFm   = { debtSubtype: "heloc",  providerSubtype: null,          creditLimit: 100_000 };
  const helocPl   = { debtSubtype: null,     providerSubtype: "home equity", creditLimit: 100_000 };
  const autoLimit = { debtSubtype: null,     providerSubtype: "auto",        creditLimit: 30_000 };
  const studLimit = { debtSubtype: null,     providerSubtype: "student",     creditLimit: 40_000 };
  const u = creditUtilization([
    { id: "hf", name: "hf", type: "debt", balance: 25_000, ...helocFm },
    { id: "hp", name: "hp", type: "debt", balance: 50_000, ...helocPl },
    { id: "au", name: "au", type: "debt", balance: 15_000, ...autoLimit },
    { id: "st", name: "st", type: "debt", balance: 20_000, ...studLimit },
  ]);
  check("HELOC (FM + Plaid with limit) are utilization rows at 25% / 50%",
    u.rows.length === 2 && u.rows.find((r) => r.id === "hf")?.pct === 25 && u.rows.find((r) => r.id === "hp")?.pct === 50, u.rows);
  check("auto + student loans with a limit: no utilization row, no 'add limit' prompt",
    !u.rows.some((r) => r.id === "au" || r.id === "st") && u.missingLimit.length === 0, u);
  check("isRevolvingLine: HELOC yes, auto no", isRevolvingLine(helocFm) && !isRevolvingLine(autoLimit));
  const ledger = (c: object): DebtPerspectiveAccount => ({ id: "l", name: "l", type: "debt", institution: "B", balance: 15_000, currency: "USD", ...c } as DebtPerspectiveAccount);
  check("ledger row utilization: HELOC 15%, auto loan null",
    accountUtilization(ledger(helocFm)) === 15 && accountUtilization(ledger(autoLimit)) === null);
  const avail = (c: { debtSubtype: string | null; providerSubtype: string | null; creditLimit: number | null }) =>
    resolveAccountBalances({ accountId: "x", accountType: "debt", currency: "USD", balance: 25_000, availableBalance: 75_000, freshness: fresh, ...c }).available;
  check("available credit: HELOC AVAILABLE_CREDIT", JSON.stringify(avail(helocFm)).includes("AVAILABLE_CREDIT"), avail(helocFm));
  check("available credit: auto loan NOT_APPLICABLE", JSON.stringify(avail(autoLimit)).includes("NOT_APPLICABLE"), avail(autoLimit));
}

console.log("\n6. Surfaces carry the ONE type");
{
  const root = process.cwd();
  const asm = readFileSync(join(root, "lib/ai/assemblers/accounts.ts"), "utf8");
  check("AI accounts assembler emits debtType + debtTypeLabel on FULL debt rows and gaps",
    /base\.debtType\s*=\s*dt/.test(asm) && /base\.debtTypeLabel\s*=\s*DEBT_TYPE_LABEL\[dt\]/.test(asm) && (asm.match(/debtType:\s+debtType\(fa\)/g) ?? []).length === 2);
  const snap = readFileSync(join(root, "lib/ai/conversation/tools/snapshot.ts"), "utf8");
  check("snapshot tool passes debtType + debtTypeLabel to the model", /debtType: a2\.debtType, debtTypeLabel: a2\.debtTypeLabel/.test(snap));
  // The ledger's display label agrees with debtTypeLabel wherever both name a specific type.
  const agree: Array<[object, string]> = [
    [{ debtSubtype: "credit_card" }, "credit_card"], [{ debtSubtype: "line_of_credit" }, "personal_line_of_credit"],
    [{ debtSubtype: "heloc" }, "heloc"], [{ debtSubtype: "mortgage" }, "mortgage"], [{ debtSubtype: "auto_loan" }, "auto_loan"],
    [{ debtSubtype: "student_loan" }, "student_loan"], [{ debtSubtype: "personal_loan" }, "personal_installment"],
    [{ providerSubtype: "credit card" }, "credit_card"], [{ providerSubtype: "line of credit" }, "personal_line_of_credit"],
    [{ providerSubtype: "home equity", creditLimit: 50_000 }, "heloc"], [{ providerSubtype: "mortgage" }, "mortgage"],
    [{ providerSubtype: "auto" }, "auto_loan"], [{ providerSubtype: "student" }, "student_loan"], [{ providerSubtype: "consumer" }, "personal_installment"],
  ];
  for (const [c, t] of agree) {
    const a = { id: "x", name: "x", type: "debt", institution: "B", balance: 1, currency: "USD", ...c } as DebtPerspectiveAccount;
    check(`ledger label = DEBT_TYPE_LABEL for ${JSON.stringify(c)}`,
      debtType(a) === t && presentationDebtLabel(a) === DEBT_TYPE_LABEL[t as DebtType], [debtType(a), presentationDebtLabel(a)]);
  }
}

console.log("\n7. Source scan — no NEW ad-hoc subtype checks outside the classifier");
{
  const root = process.cwd();
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e) && !/\.fixtures?\.ts$/.test(e)) files.push(p);
    }
  };
  for (const d of ["app", "lib", "components", "jobs", "scripts"]) { try { walk(join(root, d)); } catch { /* absent dir */ } }
  // Comparisons of a subtype field to a literal, a debt-type literal compared to
  // anything, or a `case "<debt subtype>"` arm.
  const SUBTYPE_VALUES = "mortgage|heloc|auto_loan|student_loan|personal_loan|line_of_credit|credit_card|home equity|line of credit|credit card|auto|student|overdraft|paypal|consumer";
  const PATTERNS = [
    /(debtSubtype|providerSubtype)\)?\s*[!=]==?\s*["'][a-z]/i,
    new RegExp(`["'](${SUBTYPE_VALUES})["']\\s*[!=]==`),
    new RegExp(`[!=]==\\s*["'](${SUBTYPE_VALUES})["']`),
    new RegExp(`case\\s+["'](${SUBTYPE_VALUES})["']`),
  ];
  // file → number of matching lines that predate this model (legitimate, reviewed).
  const ALLOW: Record<string, number> = {
    "lib/debt/liability-kind.ts": 2,      // the classifier itself (mortgage gate + doc)
    "lib/debt/rate-label.ts": 2,          // debtType(a) === "mortgage" — the classifier's output
    "lib/account-privacy.ts": 7,          // privacy generic names (persisted labels; S2-reviewed tier)
  };
  const counts: Record<string, number> = {};
  for (const f of files) {
    const rel = relative(root, f);
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (/typeof\s+\S+\s*===/.test(line)) continue;
      if (PATTERNS.some((re) => re.test(line))) counts[rel] = (counts[rel] ?? 0) + 1;
    }
  }
  const over = Object.entries(counts).filter(([f, n]) => n > (ALLOW[f] ?? 0));
  check("no file exceeds its allowlisted count of ad-hoc subtype checks", over.length === 0, over);
}

if (failures > 0) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nAll debt-type checks passed.");
