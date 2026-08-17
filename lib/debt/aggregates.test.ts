/**
 * lib/debt/aggregates.test.ts   (v2.6-DEBT-1)
 *
 * Part A — the RULE. What the aggregate authority answers, including the three
 * cases the six former implementations disagreed on.
 *
 * Part B — ENROLMENT (source-scan). Roadmap item 1's exit criterion is not "one
 * module exists"; it is "each has a named owner AND an enrolment guard". This is
 * the guard: it bans re-deriving the blended rate, and pins each converged call
 * site to the authority. Modelled on lib/debt/effective-terms.test.ts, which the
 * roadmap names as the reference implementation.
 *
 * Run: npx tsx lib/debt/aggregates.test.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { computeDebtAggregate } from "./aggregates";

const ROOT = path.resolve(__dirname, "..", "..");
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
/** Strip block + line comments — this arc DOCUMENTS the banned shapes in prose. */
const code = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) { console.log(`  ✓ ${label}`); return; }
  failures++;
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

const row = (balance: number, apr: number | null = null, minimumPayment: number | null = null) =>
  ({ balance, apr, minimumPayment });

// ─── A. The rule ─────────────────────────────────────────────────────────────

console.log("\nA. The aggregate rule");

console.log("\n1. Empty input is total, never NaN");
{
  const a = computeDebtAggregate([]);
  check("totalOwed = 0", a.totalOwed === 0);
  check("weightedApr = null (no rate to state)", a.weightedApr === null);
  check("monthlyRate = 0", a.monthlyRate === 0);
  check("minimumPayment = 0", a.minimumPayment === 0);
}

console.log("\n2. Weighting is by amount OWED");
{
  // 1000 @ 10% and 3000 @ 20% ⇒ (10·1000 + 20·3000) / 4000 = 17.5
  const a = computeDebtAggregate([row(1000, 10), row(3000, 20)]);
  check("weightedApr = 17.5", a.weightedApr === 17.5, `${a.weightedApr}`);
  check("monthlyRate = 17.5/1200", Math.abs(a.monthlyRate - 17.5 / 100 / 12) < 1e-12);
  check("totalOwed = 4000", a.totalOwed === 4000);
}

console.log("\n3. NO CROSS-ACCOUNT NETTING (V25-SIDE-1)");
{
  // An issuer credit is spendable only at that issuer — it can never reduce
  // another card's obligation, so it contributes 0 rather than a negative.
  const a = computeDebtAggregate([row(1000, 20), row(-500, 20)]);
  check("totalOwed = 1000 (credit contributes 0, not -500)", a.totalOwed === 1000, `${a.totalOwed}`);
  check("weightedApr = 20", a.weightedApr === 20, `${a.weightedApr}`);
}

console.log("\n4. An UNRATED row is excluded from BOTH sides of the rate");
{
  // The SectionCard.tsx:149 defect: folding the unrated row in as 0% gave
  // (20·1000 + 0·3000)/4000 = 5%, understating the rate by 15 points.
  const a = computeDebtAggregate([row(1000, 20), row(3000, null)]);
  check("weightedApr = 20, not 5", a.weightedApr === 20, `${a.weightedApr}`);
  check("totalOwed still counts the unrated row", a.totalOwed === 4000, `${a.totalOwed}`);
  check("unratedCount = 1", a.unratedCount === 1);
  check("ratedCount = 1", a.ratedCount === 1);
}

console.log("\n5. A rate of exactly 0 is KNOWN, not missing");
{
  // The metrics.ts / engine.ts defect: `apr > 0` dropped a 0% promotional
  // balance, overstating the rate the borrower actually pays.
  const a = computeDebtAggregate([row(1000, 20), row(1000, 0)]);
  check("weightedApr = 10", a.weightedApr === 10, `${a.weightedApr}`);
  check("ratedCount = 2", a.ratedCount === 2, `${a.ratedCount}`);
  check("unratedCount = 0 (0% is not a data gap)", a.unratedCount === 0);
}

console.log("\n6. A row that owes nothing carries no weight and no obligation");
{
  // Why the lens (no owes-filter) and the planner (owes-filter) were always the
  // same function: the weight IS amountOwed, which is 0 for a settled row.
  const withSettled = computeDebtAggregate([row(1000, 20, 35), row(0, 5, 99)]);
  const without     = computeDebtAggregate([row(1000, 20, 35)]);
  check("settled row does not move the rate", withSettled.weightedApr === without.weightedApr, `${withSettled.weightedApr}`);
  check("nothing is DUE on a settled row", withSettled.minimumPayment === 35, `${withSettled.minimumPayment}`);
  check("settled row is not counted as a gap", withSettled.missingMinimumCount === 0);
}

console.log("\n7. A missing minimum is disclosed, not silently zeroed");
{
  const a = computeDebtAggregate([row(1000, 20, 35), row(2000, 15, null)]);
  check("minimumPayment = 35 (the known part)", a.minimumPayment === 35, `${a.minimumPayment}`);
  check("missingMinimumCount = 1", a.missingMinimumCount === 1);
}

console.log("\n8. NO ROUNDING — precision is the surface's choice");
{
  const a = computeDebtAggregate([row(285000, 3.875), row(5800, 22.99)]);
  check("unrounded", a.weightedApr !== null && a.weightedApr.toFixed(6) !== a.weightedApr.toFixed(2), `${a.weightedApr}`);
}

// ─── B. Enrolment (source-scan) ──────────────────────────────────────────────

console.log("\nB. Enrolment — the metric has ONE owner");

/** Every site that answers "at what blended rate?" must call the authority. */
const ENROLLED: [string, string][] = [
  ["components/space/sections/DebtPayoffSection.tsx", "the interactive payoff planner"],
  ["components/space/widgets/debt/debt-kpis.ts",      "the Debt workspace KPI strip + payoff aggregate"],
  ["components/space/sections/SectionCard.tsx",       "the collapsed payoff summary"],
  ["lib/perspective-engine/lenses/debt.core.ts",      "the debt perspective lens"],
  ["lib/ai/intelligence/annotations/metrics.ts",      "computeDebtStrategy (the AI's weightedAvgApr)"],
  ["lib/ai/intelligence/annotations/engine.ts",       "the debt health classification"],
];

console.log("\n9. Every former implementation now calls the authority");
for (const [file, what] of ENROLLED) {
  check(`${file} — ${what}`, /computeDebtAggregate\s*\(/.test(code(file)));
}

/**
 * The banned shape: a rate-weighted numerator divided by a balance denominator.
 * This is the arithmetic all six former implementations shared, and it is what
 * must never reappear outside the authority.
 */
const BANNED_APR = [
  // `reduce(... apr * bal ...) / reduce(...)` — the planner/kpis idiom
  /reduce\s*\([^)]*(?:interestRate|apr|Apr|APR)[^)]*\*[^)]*(?:bal|owed|balance)[^)]*\)\s*(?:\r?\n\s*)?\//,
  // `rateWeighted / rateKnownBalance` — the lens idiom
  /(?:rateWeighted|totalWeighted)\s*\/\s*(?:rateKnownBalance|totalForWeighting)/,
  // `interestBurden * 12 / total` — the engine's back-derivation
  /interestBurden\s*\*\s*12\s*\/\s*\w+/,
];

const SCAN_DIRS = ["lib", "components", "app"];
function walk(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  const out: string[] = [];
  for (const e of readdirSync(abs)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const child = path.join(rel, e);
    if (statSync(path.join(ROOT, child)).isDirectory()) {
      if (child.includes("prototype")) continue;
      out.push(...walk(child));
      continue;
    }
    if (!/\.tsx?$/.test(e) || /\.test\.tsx?$/.test(e)) continue;
    out.push(child);
  }
  return out;
}

console.log("\n10. No production file re-derives the blended rate inline");
{
  const offenders: string[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      if (file === path.join("lib", "debt", "aggregates.ts")) continue;   // the owner
      const body = code(file);
      if (BANNED_APR.some((re) => re.test(body))) offenders.push(file);
    }
  }
  check(
    "zero inline weighted-APR derivations outside lib/debt/aggregates.ts",
    offenders.length === 0,
    offenders.join(", "),
  );
}

console.log("\n11. The per-account utilization ratio has one owner too");
{
  // v2.6-DEBT-1 — debt-ledger-util.ts had transcribed `amountOwed(balance) / creditLimit`.
  const offenders: string[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      if (file === path.join("lib", "accounts", "credit-utilization.ts")) continue;   // the owner
      if (/amountOwed\s*\([^)]*\)\s*\/\s*\w*(?:creditLimit|limit)\b/.test(code(file))) offenders.push(file);
    }
  }
  check(
    "zero inline `amountOwed(...) / creditLimit` outside lib/accounts/credit-utilization.ts",
    offenders.length === 0,
    offenders.join(", "),
  );
}

console.log(
  failures === 0
    ? "\nAll aggregates checks passed.\n"
    : `\n${failures} aggregates check(s) failed\n`,
);
if (failures > 0) process.exit(1);
