/**
 * scripts/fixture-date-run-census.test.ts — public-repo hygiene: a LONG run of
 * exact, irregular dates sitting next to income vocabulary in a test fixture is
 * what a copied real pay history looks like. Sibling of
 * scripts/fixture-payroll-census.test.ts (payer names); this one is about dates.
 *
 * SCOPE — the same as the payroll census: every TRACKED test or fixture file
 * (`*.test.ts(x)`, `__fixtures__/` or `fixtures/` dirs, `fixture(s).{ts,tsx,json}`).
 *
 * HEURISTIC — generic, no list of real dates:
 *   - a RUN is a block of consecutive DATA lines carrying quoted ISO date
 *     literals ('YYYY-MM-DD'). A data line is one whose text after its first
 *     date is only dates, numbers, brackets, commas and a trailing comment, so
 *     an array of dates or of [date, amount] tuples is a run and a block of
 *     `check(...)` calls is not. A line that opens a new declaration, property
 *     or call (`=`, `:` or `name(` before its first date) starts a new run;
 *   - LONG means at least MIN_RUN dates;
 *   - INCOME CONTEXT means income vocabulary (payroll, paycheck, salary, wages,
 *     employer, direct deposit, income, …) within CONTEXT_LINES of the run;
 *   - only a SERIES is inspected: dates in chronological order, oldest-first or
 *     newest-first (a ledger history), not a table of unrelated windows;
 *   - a series is TEMPLATED, and passes, when its dates are strictly ordered
 *     and evenly spaced, all month-ends, or all on at most two days of the
 *     month. Generated schedules look like that; a real ledger, with its
 *     weekend and holiday rolls, does not;
 *   - an irregular long run in income context FAILS unless it is ATTESTED: the
 *     marker `fixture-census: synthetic-dates` in a comment on the run's first
 *     line or within ATTEST_LINES above it. The marker is a claim by the author
 *     that the dates are not a recoverable real history: either invented (a
 *     generated schedule plus test-placed perturbations) or moved by an
 *     undisclosed whole-week offset that is NOT a calendar repeat (a shift by
 *     whole years of identical calendar is recoverable by simple addition and
 *     does not qualify). Never attest a run whose origin you did not check.
 *
 * It is a prompt for a human, not proof: the marker attests ORIGIN, not shape.
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

const MIN_RUN = 10;
const CONTEXT_LINES = 4;
const ATTEST_LINES = 3;
const MARKER = "fixture-census: synthetic-dates";

const DATE_LITERAL = /(['"`])(\d{4}-\d{2}-\d{2})\1/g;
const FIRST_DATE = /['"`]\d{4}-\d{2}-\d{2}['"`]/;
const INCOME = /(?<![A-Za-z])(?:payroll|payrolls|paycheck|paychecks|payday|paydays|pay date|pay dates|salary|salaries|wages|employer|employers|direct dep|direct deposit|income)(?![A-Za-z])/i;

type Run = { start: number; end: number; dates: string[] };

/** The text after a line's first date, minus everything a data line may carry. */
function isDataLine(line: string): boolean {
  const at = line.search(FIRST_DATE);
  if (at < 0) return false;
  const residue = line.slice(at)
    .replace(/\/\/.*$/, "")
    .replace(DATE_LITERAL, "")
    .replace(/-?\d[\d_.]*/g, "")
    .replace(/[[\](),;\s]/g, "");
  return residue.length === 0;
}

export function dateRuns(lines: readonly string[], minRun = MIN_RUN): Run[] {
  const out: Run[] = [];
  let cur: Run | null = null;
  const close = () => { if (cur && cur.dates.length >= minRun) out.push(cur); cur = null; };
  lines.forEach((line, i) => {
    if (!isDataLine(line)) { close(); return; }
    const dates = [...line.matchAll(DATE_LITERAL)].map((m) => m[2]);
    const opens = /[=:]|\w\s*\(/.test(line.slice(0, line.search(FIRST_DATE)));
    if (cur && i === cur.end + 1 && !opens) { cur.dates.push(...dates); cur.end = i; }
    else { close(); cur = { start: i, end: i, dates }; }
  });
  close();
  return out;
}

const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

/** A chronological series, oldest-first or newest-first (equal neighbours allowed). */
export function isSeries(dates: readonly string[]): boolean {
  const gaps = dates.slice(1).map((d, i) => dayNumber(d) - dayNumber(dates[i]));
  return gaps.every((g) => g >= 0) || gaps.every((g) => g <= 0);
}

const isMonthEnd = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).getUTCDate() === 1;

export function isTemplated(dates: readonly string[]): boolean {
  const asc = dayNumber(dates[0]) <= dayNumber(dates[dates.length - 1]) ? [...dates] : [...dates].reverse();
  const gaps = asc.slice(1).map((d, i) => dayNumber(d) - dayNumber(asc[i]));
  if (gaps.some((g) => !(g > 0))) return false;
  if (new Set(gaps).size === 1) return true;
  if (asc.every(isMonthEnd)) return true;
  return new Set(asc.map((d) => d.slice(8))).size <= 2;
}

export function suspiciousRuns(text: string): Run[] {
  const lines = text.split("\n");
  return dateRuns(lines).filter((r) => {
    const context = lines.slice(Math.max(0, r.start - CONTEXT_LINES), r.end + CONTEXT_LINES + 1).join("\n");
    if (!INCOME.test(context)) return false;
    if (!isSeries(r.dates)) return false;
    if (isTemplated(r.dates)) return false;
    const attest = lines.slice(Math.max(0, r.start - ATTEST_LINES), r.start + 1).join("\n");
    return !attest.includes(MARKER);
  });
}

function isTestOrFixture(file: string): boolean {
  const base = path.posix.basename(file);
  return /\.test\.tsx?$/.test(base)
    || /(^|\/)(__fixtures__|fixtures)\//.test(file)
    || /(^|\.|-)fixtures?\.(ts|tsx|json)$/.test(base);
}

console.log("1. the heuristic (invented dates only)");
{
  // An irregular run: a nominal 1st/16th schedule with invented rolls.
  const irregular = [
    "const EMPLOYER_X = ['2091-01-01','2091-01-16','2091-02-02','2091-02-16','2091-03-01',",
    "  '2091-03-15','2091-04-02','2091-04-16','2091-05-01','2091-05-14','2091-06-01'];",
  ];
  const weekly = Array.from({ length: 12 }, (_, i) =>
    new Date(Date.UTC(2091, 0, 5 + 7 * i)).toISOString().slice(0, 10));
  const weeklyRun = [`const PAYROLL_W = [${weekly.slice(0, 6).map((d) => `'${d}'`).join(",")},`,
    `  ${weekly.slice(6).map((d) => `'${d}'`).join(",")}];`];
  const semimonthly = [
    "// employer pays on the 1st and 16th",
    "const S = ['2091-01-01','2091-01-16','2091-02-01','2091-02-16','2091-03-01','2091-03-16',",
    "  '2091-04-01','2091-04-16','2091-05-01','2091-05-16'];",
  ];
  const tuples = [
    "// income stream with amounts",
    "const T = [['2091-01-01', 100.5], ['2091-01-16', 100.5], ['2091-02-02', 100.5], ['2091-02-16', 100.5],",
    "  ['2091-03-01', 100.5], ['2091-03-15', 100.5], ['2091-04-02', 100.5], ['2091-04-16', 100.5],",
    "  ['2091-05-01', 100.5], ['2091-05-14', 100.5]];",
  ];
  const checks = [
    "// payroll slot checks",
    ...["01", "02", "03", "05", "08", "13", "21", "22", "23", "27", "28"].map((d) =>
      `check('slot', first('2091-01-${d}', ['2091-01-0${d.length}']) === '2091-02-${d}');`),
  ];
  check("flags an irregular long run beside income vocabulary", suspiciousRuns(irregular.join("\n")).length === 1);
  check("flags [date, amount] tuple runs too", suspiciousRuns(tuples.join("\n")).length === 1);
  check("passes an evenly spaced (generated-looking) run", suspiciousRuns(weeklyRun.join("\n")).length === 0);
  check("passes an exact day-of-month schedule", suspiciousRuns(semimonthly.join("\n")).length === 0);
  check("passes the same irregular run with no income context",
    suspiciousRuns(irregular.join("\n").replace(/EMPLOYER_X/, "WIDGETS")).length === 0);
  check("passes a short irregular run", suspiciousRuns(
    "const EMPLOYER_X = ['2091-01-01','2091-01-16','2091-02-02','2091-02-16'];").length === 0);
  check("an attested run passes; the marker must sit just above it",
    suspiciousRuns([`// ${MARKER}`, ...irregular].join("\n")).length === 0
    && suspiciousRuns([`// ${MARKER}`, "", "", "", "", ...irregular].join("\n")).length === 1);
  check("lines of calls with dates are not a data run", suspiciousRuns(checks.join("\n")).length === 0);
  check("a new array starts a new run (two short arrays are not one long one)", suspiciousRuns([
    "const EMPLOYER_X = ['2091-01-01','2091-01-16','2091-02-02','2091-02-16','2091-03-01'];",
    "const EMPLOYER_Y = ['2091-03-15','2091-04-02','2091-04-16','2091-05-01','2091-05-14'];",
  ].join("\n")).length === 0);
  check("a duplicated date is never templated", !isTemplated(["2091-01-01", "2091-01-01", "2091-01-08"]));
  check("month-end and newest-first schedules are templated",
    isTemplated(["2091-01-31", "2091-02-28", "2091-03-31", "2091-04-30"]) && isTemplated(["2091-03-15", "2091-03-01", "2091-02-15"]));
  check("a newest-first irregular run is still flagged",
    suspiciousRuns(["// employer", `const R = [${[...irregular.join("").matchAll(/'[^']+'/g)].map((m) => m[0]).reverse().join(",")}];`].join("\n")).length === 1);
  check("a table of unrelated windows is not a series", suspiciousRuns([
    "// income windows",
    "const W = [['2091-05-01', '2091-05-31'], ['2091-01-01', '2091-12-31'], ['2091-03-04', '2091-03-04'],",
    "  ['2091-02-01', '2091-02-28'], ['2091-07-09', '2091-07-22']];",
  ].join("\n")).length === 0);
}

console.log("2. this checkout");
{
  const SELF = "scripts/fixture-date-run-census.test.ts";
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
    for (const r of suspiciousRuns(text)) violations.push(`${file}:${r.start + 1}: ${r.dates.length} irregular dates beside income vocabulary`);
  }
  check(`no unattested long irregular date run beside income vocabulary (invent the dates, then mark the run "${MARKER}")`,
    violations.length === 0, `\n      ${violations.slice(0, 40).join("\n      ")}`);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
