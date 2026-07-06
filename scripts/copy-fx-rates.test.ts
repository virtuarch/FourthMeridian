/**
 * scripts/copy-fx-rates.test.ts
 *
 * Pure unit test for the extractable helpers in scripts/copy-fx-rates.ts.
 * No DB, no network: importing the script only pulls in the pure helpers —
 * its main() is guarded behind an "invoked directly" check, so nothing
 * connects. House-style standalone tsx script: exits 0 on pass / 1 on failure.
 *
 * Run:  npx tsx scripts/copy-fx-rates.test.ts
 */

import {
  isISODate,
  isoToUTCDate,
  parseQuotes,
  buildConfig,
  buildReadWhere,
  computeCounts,
  dateRangeOf,
  quotesOf,
  chunk,
  type FxRateRow,
} from "./copy-fx-rates";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

function throws(fn: () => unknown, match?: RegExp): boolean {
  try { fn(); return false; }
  catch (e) { return match ? match.test(e instanceof Error ? e.message : String(e)) : true; }
}

const BASE_ENV = {
  SOURCE_DATABASE_URL: "postgres://u:p@src/db",
  TARGET_DATABASE_URL: "postgres://u:p@tgt/db",
} as unknown as NodeJS.ProcessEnv;

function row(date: string, quote: string, id = `${date}-${quote}`): FxRateRow {
  return { id, date: isoToUTCDate(date), base: "USD", quote, rate: 1, source: "test", fetchedAt: new Date(0) };
}

// ── isISODate ────────────────────────────────────────────────────────────────
check("valid ISO date accepted", isISODate("2026-01-15"));
check("non-existent calendar date rejected", !isISODate("2026-02-30"));
check("wrong format rejected", !isISODate("2026-1-5"));
check("garbage rejected", !isISODate("nope"));

// ── parseQuotes ──────────────────────────────────────────────────────────────
check("undefined quotes → null (all)", parseQuotes(undefined) === null);
check("empty string → null (all)", parseQuotes("  ") === null);
{
  const q = parseQuotes(" eur, gbp , eur ");
  check("quotes normalized/upper/deduped", JSON.stringify(q) === JSON.stringify(["EUR", "GBP"]), JSON.stringify(q));
}

// ── buildConfig: refusals ────────────────────────────────────────────────────
check("missing both env vars refused",
  throws(() => buildConfig({} as NodeJS.ProcessEnv, []), /must be set/));
check("missing target refused",
  throws(() => buildConfig({ SOURCE_DATABASE_URL: "x" } as unknown as NodeJS.ProcessEnv, []), /must be set/));
check("identical source/target refused",
  throws(() => buildConfig({ SOURCE_DATABASE_URL: "same", TARGET_DATABASE_URL: "same" } as unknown as NodeJS.ProcessEnv, []), /onto itself/));
check("bad START_DATE refused",
  throws(() => buildConfig({ ...BASE_ENV, START_DATE: "2026-13-01" }, []), /START_DATE/));
check("start after end refused",
  throws(() => buildConfig({ ...BASE_ENV, START_DATE: "2026-06-01", END_DATE: "2026-01-01" }, []), /after END_DATE/));

// ── buildConfig: happy path & flags ──────────────────────────────────────────
{
  const cfg = buildConfig({ ...BASE_ENV, QUOTES: "eur,gbp" }, ["--apply"]);
  check("apply flag parsed", cfg.apply === true);
  check("quotes carried into config", JSON.stringify(cfg.quotes) === JSON.stringify(["EUR", "GBP"]));
  check("dry-run is default (no flag)", buildConfig(BASE_ENV, []).apply === false);
}

// ── buildReadWhere ───────────────────────────────────────────────────────────
{
  const empty = buildReadWhere(buildConfig(BASE_ENV, []));
  check("no filters → empty where", Object.keys(empty).length === 0);

  const cfg = buildConfig({ ...BASE_ENV, START_DATE: "2026-01-01", END_DATE: "2026-06-30", QUOTES: "EUR" }, []);
  const where = buildReadWhere(cfg);
  const dateFilter = where.date as { gte?: Date; lte?: Date };
  check("gte set from START_DATE", dateFilter.gte?.toISOString() === "2026-01-01T00:00:00.000Z");
  check("lte set from END_DATE", dateFilter.lte?.toISOString() === "2026-06-30T00:00:00.000Z");
  check("quote IN filter set", JSON.stringify(where.quote) === JSON.stringify({ in: ["EUR"] }));
}

// ── computeCounts ────────────────────────────────────────────────────────────
{
  const c = computeCounts(10, 7);
  check("duplicates = found − inserted", c.duplicates === 3 && c.inserted === 7 && c.found === 10);
  check("duplicates never negative", computeCounts(5, 9).duplicates === 0);
}

// ── dateRangeOf / quotesOf ───────────────────────────────────────────────────
{
  const rows = [row("2026-03-01", "EUR"), row("2026-01-15", "GBP"), row("2026-06-30", "EUR")];
  check("empty rows → null range", dateRangeOf([]) === null);
  const r = dateRangeOf(rows)!;
  check("min/max date computed", r.min === "2026-01-15" && r.max === "2026-06-30", JSON.stringify(r));
  check("distinct sorted quotes", JSON.stringify(quotesOf(rows)) === JSON.stringify(["EUR", "GBP"]));
}

// ── chunk ────────────────────────────────────────────────────────────────────
{
  check("chunks by size", JSON.stringify(chunk([1, 2, 3, 4, 5], 2)) === JSON.stringify([[1, 2], [3, 4], [5]]));
  check("empty stays empty", chunk([], 3).length === 0);
  check("bad size throws", throws(() => chunk([1], 0)));
}

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`copy-fx-rates.test: ${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`copy-fx-rates.test: all ${passed} checks passed.`);
process.exit(0);
