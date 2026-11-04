/**
 * scripts/fixture-payroll-census.test.ts — public-repo hygiene: payroll-like
 * descriptors in test and fixture files name an obviously FAKE payer
 * ("EMPLOYER A PAYROLL", "ACME CORP PAYROLL SEC:PPD"), never a real one.
 *
 * SCOPE — the same as scripts/fixture-institution-census.test.ts: every TRACKED
 * test or fixture file (`*.test.ts(x)`, `__fixtures__/` or `fixtures/` dirs,
 * `fixture(s).{ts,tsx,json}` modules).
 *
 * HEURISTIC — generic, no list of real names:
 *   - a payroll KEYWORD in ALL CAPS: PAYROLL, DIRECT DEP, DIRECT DEPOSIT,
 *     DIR DEP, SALARY;
 *   - the up-to-three ALL-CAPS tokens immediately BEFORE it, and the up-to-two
 *     immediately AFTER it, are its payer context. A token is ≥ 2 characters of
 *     [A-Z0-9&'.-] starting with a letter (so "EMPLOYER A" contributes only
 *     EMPLOYER: a single letter is a placeholder, not a name);
 *   - a context token is fine when it is DESCRIPTOR VOCABULARY (CORP, SEC,
 *     PPD, DEDUCTION, …) or a KNOWN FAKE (ACME, EMPLOYER, EXAMPLE, …);
 *   - any other context token is "proper-noun-like" and fails the census.
 * Lowercase and Title Case are not inspected: provider descriptors are ALL CAPS,
 * and prose about "payroll" is not a descriptor.
 *
 * To add a new fake payer, add it to FAKE_PAYERS — a name that is obviously
 * invented. Never add a real one.
 *
 * Hermetic: reads the working tree only.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const KEYWORD = String.raw`(?:PAYROLL|DIRECT DEPOSIT|DIRECT DEP|DIR DEP|SALARY)`;
const TOKEN = String.raw`[A-Z][A-Z0-9&'.-]+`;
const BEFORE = new RegExp(String.raw`((?:${TOKEN} ){1,3})${KEYWORD}(?![A-Za-z0-9_])`, "g");
const AFTER = new RegExp(String.raw`(?<![A-Za-z0-9_])${KEYWORD}((?: ${TOKEN}){1,2})`, "g");

const DESCRIPTOR_VOCABULARY = new Set([
  "CORP", "CORPORATION", "INC", "LLC", "LTD", "CO", "CO.", "COMPANY", "SEC", "SEC:PPD", "PPD", "CCD", "ACH", "ID",
  "DEP", "DEPOSIT", "DIRECT", "DIR", "PAYROLL", "SALARY", "NET", "GROSS", "PAY", "PAYMENT", "PMT", "CREDIT", "DEBIT",
  "TRANSFER", "XFER", "TAX", "ADJUSTMENT", "ADJ", "DEDUCTION", "REFUND", "REVERSAL", "BONUS", "MONTHLY", "WEEKLY",
  "BIWEEKLY", "SEMIMONTHLY", "OF", "FROM", "TO", "FOR", "THE", "AND", "REAL", "A.", "B.", "MOBILE", "ONLINE", "REF",
  "WAGES", "INCOME", "PENDING", "POSTED",
]);
const FAKE_PAYERS = new Set([
  "ACME", "EMPLOYER", "EXAMPLE", "SAMPLE", "DEMO", "FAKE", "TEST", "SYNTHCO", "PAYEE",
]);

type Hit = { token: string; context: string };
function suspiciousPayers(line: string): Hit[] {
  const out: Hit[] = [];
  const inspect = (ctx: string) => {
    for (const token of ctx.trim().split(/\s+/)) {
      const bare = token.replace(/['.-]+$/, "");
      const known = (t: string) => DESCRIPTOR_VOCABULARY.has(t) || FAKE_PAYERS.has(t);
      if (!known(token) && !known(bare) && !/^\d/.test(token)) out.push({ token, context: ctx.trim() });
    }
  };
  for (const m of line.matchAll(BEFORE)) inspect(m[1]);
  for (const m of line.matchAll(AFTER)) inspect(m[1]);
  return out;
}

function isTestOrFixture(file: string): boolean {
  const base = path.posix.basename(file);
  return /\.test\.tsx?$/.test(base)
    || /(^|\/)(__fixtures__|fixtures)\//.test(file)
    || /(^|\.|-)fixtures?\.(ts|tsx|json)$/.test(base);
}

console.log("1. the heuristic");
const flags = (s: string) => suspiciousPayers(s).map((h) => h.token);
check("flags a proper-noun-like payer BEFORE the keyword", flags('"QWERTYCO SYSTEMS PAYROLL PPD"').join() === "QWERTYCO,SYSTEMS");
check("flags a payer AFTER the keyword", flags("PAYROLL ZORBLAX").join() === "ZORBLAX");
check("flags DIRECT DEP and SALARY forms", flags("ZORBLAX DIRECT DEP").join() === "ZORBLAX" && flags("ZORBLAX SALARY").join() === "ZORBLAX");
check("passes the known fakes", flags("ACME CORP PAYROLL SEC:PPD").length === 0 && flags("EMPLOYER A PAYROLL").length === 0
  && flags("EMPLOYER B PAYROLL PPD ID: 0000000000").length === 0 && flags("PAYROLL SYNTHCO").length === 0);
check("passes descriptor vocabulary", flags("PAYROLL DEDUCTION REFUND").length === 0 && flags("COMPANY DIRECT DEPOSIT").length === 0
  && flags("PAYROLL TAX ADJUSTMENT").length === 0);
check("ignores lowercase and Title Case prose", flags("the Qwertyco payroll; Zorblax Payroll").length === 0);
check("the fake list carries no real-looking entry beyond obvious placeholders", [...FAKE_PAYERS].every((n) => /^[A-Z][A-Z-]+$/.test(n)));

console.log("2. this checkout");
{
  const SELF = "scripts/fixture-payroll-census.test.ts";
  let tracked: string[] = [];
  try {
    tracked = execFileSync("git", ["ls-files", "-z"], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\0").filter(Boolean);
  } catch (e) {
    check("git ls-files is readable (a census that sees no files guards nothing)", false, String(e));
  }
  const inScope = tracked.filter((f) => f !== SELF && isTestOrFixture(f));
  check("the census sees test files", inScope.length > 100, `${inScope.length} files`);
  const violations: string[] = [];
  for (const file of inScope) {
    let text: string;
    try { text = readFileSync(path.join(process.cwd(), file), "utf8"); } catch { continue; }
    text.split("\n").forEach((line, i) => {
      for (const h of suspiciousPayers(line)) violations.push(`${file}:${i + 1}: "${h.token}" in "${h.context}"`);
    });
  }
  check("no payroll-like descriptor names a proper-noun-like payer (use EMPLOYER A / ACME / EXAMPLE …)",
    violations.length === 0, `\n      ${violations.slice(0, 40).join("\n      ")}`);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
