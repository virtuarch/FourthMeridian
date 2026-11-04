/**
 * scripts/b10-5-decision-report.test.ts  (B10.5 owner-decision prep)
 *
 * DB-free coverage: the pure core with fixtures (CoinGecko batch classification,
 * UNAVAILABLE on a missing column, rendering, the output-leak predicate), the
 * transaction shape through a recording fake client (READ ONLY first, every
 * report, no write statement), the CLI's refusals before any database contact,
 * and source pins. The rows-against-a-real-Postgres proof is
 * scripts/b10-5-decision-report-acceptance.ts.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/b10-5-decision-report.test.ts
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  COINGECKO_DEFINITE_DAILY_MIN_SPAN, GOVERNANCE_LINES, READ_ONLY_STATEMENT, REPORTS, REQUIRED_COLUMNS,
  coinLabel, missingColumns, outputLeaks, renderDocument, runReport, summarizeAudit021, summarizeCoinGecko,
  type ReadOnlyClient, type ReportOutcome,
} from "./lib/b10-5-decision-report.core";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = path.resolve(__dirname, "..");

console.log("1. CoinGecko batch classification (pure)");
{
  const s = summarizeCoinGecko([
    { ticker: "btc", rows: 365, minDate: "2025-01-01", maxDate: "2025-12-31", spanDays: 365, fetchedDate: "2026-09-01" },
    { ticker: "BTC", rows: 40, minDate: "2026-01-01", maxDate: "2026-02-09", spanDays: 40, fetchedDate: "2026-09-01" },
    { ticker: "ETH", rows: COINGECKO_DEFINITE_DAILY_MIN_SPAN, minDate: "2024-01-01", maxDate: "2024-04-01", spanDays: COINGECKO_DEFINITE_DAILY_MIN_SPAN, fetchedDate: "2026-08-01" },
    { ticker: "ETH", rows: 91, minDate: "2024-05-01", maxDate: "2024-07-30", spanDays: 91, fetchedDate: "2026-08-01" },
    { ticker: "ETH", rows: 200, minDate: "2026-01-01", maxDate: "2026-07-19", spanDays: 200, fetchedDate: "2026-11-04" },
    { ticker: "Some Token Inc", rows: 120, minDate: "2025-03-01", maxDate: "2025-06-28", spanDays: 120, fetchedDate: "2026-10-01" },
  ], "2026-11-04");
  const btc = s.coins.find((c) => c.coin === "BTC")!;
  const eth = s.coins.find((c) => c.coin === "ETH")!;
  check("a batch spanning > 90 days is one day late; a short one is undetermined", btc.lateRows === 365 && btc.undeterminedRows === 40 && btc.lateFrom === "2025-01-01");
  check("the 91-day boundary is undetermined; the minimum definite span counts late", eth.lateRows === COINGECKO_DEFINITE_DAILY_MIN_SPAN && eth.undeterminedRows === 91);
  check("a batch fetched on/after --coingecko-fixed-from is excluded", eth.excludedRows === 200);
  check("an unsafe ticker prints as 'other'", s.coins.some((c) => c.coin === "other" && c.lateRows === 120));
  check("tickers sanitise", coinLabel("sol") === "SOL" && coinLabel(null) === "other" && coinLabel("a@b.co") === "other");
  check("latest late fetch is reported", s.lastLateFetch === "2026-10-01");
}

console.log("2. availability and buckets (pure)");
{
  const present = new Set(REQUIRED_COLUMNS["fin-e"].map(([t, c]) => `${t}.${c}`));
  check("all columns present ⇒ nothing missing", missingColumns("fin-e", present).length === 0);
  present.delete("SpaceSnapshot.restrictedCash");
  check("a missing column is named", missingColumns("fin-e", present).join() === "SpaceSnapshot.restrictedCash");
  const a = summarizeAudit021([{ verdict: "CANDIDATE", rows: 4, spaces: 2, fromDate: "2026-01-01", toDate: "2026-01-09" }]);
  check("absent buckets read zero", a.candidate.rows === 4 && a.clear.rows === 0 && a.undetermined.fromDate === null);
}

async function runnerSection(): Promise<void> {
  console.log("3. the runner: READ ONLY first, aggregates only, UNAVAILABLE on a missing column");
  const statements: string[][] = [];
  const allCols = Object.values(REQUIRED_COLUMNS).flat().map(([t, c]) => ({ t, c }));
  const fake = (cols: Array<{ t: string; c: string }>): ReadOnlyClient => ({
    async $transaction(fn) {
      const log: string[] = [];
      statements.push(log);
      return fn({
        async $executeRawUnsafe(sql: string) { log.push(sql); return 0; },
        async $queryRawUnsafe<T>(sql: string) {
          log.push(sql);
          if (/information_schema/.test(sql)) return cols as unknown as T;
          if (/PriceObservation/.test(sql)) return [{ ticker: "BTC", rows: 100, minDate: "2025-01-01", maxDate: "2025-04-10", spanDays: 100, fetchedDate: "2026-09-01" }] as unknown as T;
          if (/GROUP BY verdict/.test(sql)) return [{ verdict: "CLEAR", rows: 3, spaces: 1, fromDate: "2026-02-01", toDate: "2026-02-03" }] as unknown as T;
          if (/"plaidAccounts"/.test(sql)) return [{ plaidAccounts: 9, candidates: 2, inLedger: 1, preLedger: 1, noInstitutionClock: 2, minCreated: "2026-03-01", maxCreated: "2026-04-01", ledgerStart: "2026-03-15", byType: { checking: 1, debt: 1 } }] as unknown as T;
          return [{ allRows: 10, nullRows: 6, fillableRows: 4, fillableSpaces: 2, fillableFrom: "2026-01-01", fillableTo: "2026-01-04", frozenRows: 2, frozenSpaces: 1, frozenFrom: "2026-01-05", frozenTo: "2026-01-06", noInputRows: 0 }] as unknown as T;
        },
      });
    },
  });
  {
    const outcomes: ReportOutcome[] = [];
    for (const r of REPORTS) outcomes.push(await runReport(fake(allCols), r, { coingeckoFixedFrom: null }));
    check("every report ran in its own transaction", statements.length === REPORTS.length);
    check("the FIRST statement of every transaction is SET TRANSACTION READ ONLY", statements.every((l) => l[0] === READ_ONLY_STATEMENT));
    check("no statement writes", statements.flat().every((s) => !/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT)\b/i.test(s.replace(/"[^"]*"/g, ""))));
    check("no session-level SET", statements.flat().every((s) => !/^\s*SET\s+(?!LOCAL\b|TRANSACTION\b)/i.test(s)));
    check("every report is OK with all columns present", outcomes.every((o) => o.status === "OK"));
    const doc = renderDocument("local", "2026-11-04T06:00:00.000Z", outcomes);
    check("the rendered document carries the governance lines verbatim", GOVERNANCE_LINES.every((l) => doc.includes(l))
      && doc.includes("Preview/clone: engineering; Production: owner-run or owner-approved.") && /safety rail, NOT approval/.test(doc));
    check("the rendered document passes the leak predicate", outputLeaks(doc).length === 0, outputLeaks(doc).join());
    check("every report prints its heuristic", (doc.match(/\*Heuristic:\*/g) ?? []).length === 4);
    const missing = await runReport(fake(allCols.filter((c) => !(c.t === "FinancialAccount" && c.c === "balanceObserved"))), "fin-a2");
    check("a missing column ⇒ UNAVAILABLE naming it, and no report query runs",
      missing.status === "UNAVAILABLE" && /FinancialAccount\.balanceObserved/.test(missing.reason)
        && !statements[statements.length - 1].some((s) => /"plaidAccounts"/.test(s)));
    check("UNAVAILABLE renders", /\*\*UNAVAILABLE\*\*/.test(renderDocument("local", "2026-11-04T06:00:00.000Z", [missing])));
  }
}

console.log("4. the leak predicate catches what it must");
{
  check("cuid", outputLeaks("account ckl2q3w4e5r6t7y8u9i0o1p2a").includes("cuid-shaped id"));
  check("money", outputLeaks("balance 1234.56").includes("money-looking decimal"));
  check("email", outputLeaks("owner someone@example.com").includes("email address"));
  check("url", outputLeaks("postgresql://u:p@h/db").includes("connection string"));
  check("dates and integers pass", outputLeaks("| BTC | 365 | 2025-01-01 → 2025-12-31 |").length === 0);
}

console.log("5. the CLI refuses before any database contact");
{
  const PROD_REF = "prodprojectref0000001";
  const SECRET = "s3cr3tPassw0rd";
  const direct = (ref: string) => `postgresql://postgres:${SECRET}@db.${ref}.supabase.co:5432/postgres`;
  const LOCAL = `postgresql://fm:${SECRET}@127.0.0.1:9/fintracker`;
  const run = (args: string[], env: Record<string, string>) => spawnSync(
    path.join(ROOT, "node_modules", ".bin", "tsx"),
    ["--require", "./scripts/lib/server-only-preload.cjs", "scripts/b10-5-decision-report.ts", ...args],
    { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } as unknown as NodeJS.ProcessEnv, timeout: 120_000 },
  );
  const refused = (r: ReturnType<typeof run>, re: RegExp) => r.status === 2 && /REFUSED — nothing was read/.test(r.stderr) && re.test(r.stderr);
  const leaks = (r: ReturnType<typeof run>) => [SECRET, PROD_REF].some((s) => `${r.stdout}${r.stderr}`.includes(s));

  const noEnv = run(["all"], { DATABASE_URL: LOCAL });
  check("no --env is refused", refused(noEnv, /--env=<local\|preview\|production> is required/), noEnv.stderr);
  const noReport = run(["--env=local"], { DATABASE_URL: LOCAL });
  check("no report name is refused", refused(noReport, /exactly one report/), noReport.stderr);
  const badReport = run(["repair", "--env=local"], { DATABASE_URL: LOCAL });
  check("an unknown report is refused", refused(badReport, /exactly one report/), badReport.stderr);
  const apply = run(["all", "--env=local", "--apply"], { DATABASE_URL: LOCAL });
  check("--apply does not exist (unknown flag)", refused(apply, /unknown argument/), apply.stderr);
  const prodNoAck = run(["all", "--env=production"], { DATABASE_URL: direct(PROD_REF), FM_PRODUCTION_DB_REF: PROD_REF });
  check("--env=production without --acknowledge-production-read is refused, saying it is not approval",
    refused(prodNoAck, /--acknowledge-production-read/) && /NOT approval/.test(prodNoAck.stderr), prodNoAck.stderr);
  const ackElsewhere = run(["all", "--env=local", "--acknowledge-production-read"], { DATABASE_URL: LOCAL });
  check("the acknowledgement outside production is refused", refused(ackElsewhere, /only meaningful with --env=production/), ackElsewhere.stderr);
  const previewIsProd = run(["fin-e", "--env=preview"], { DATABASE_URL: direct(PROD_REF), FM_PRODUCTION_DB_REF: PROD_REF });
  check("--env=preview pointed at Production is refused", refused(previewIsProd, /IS the Production project/), previewIsProd.stderr);
  const previewNoRef = run(["fin-e", "--env=preview"], { DATABASE_URL: direct("previewprojectref0002") });
  check("--env=preview without FM_PRODUCTION_DB_REF is refused", refused(previewNoRef, /FM_PRODUCTION_DB_REF is not set/), previewNoRef.stderr);
  const localRemote = run(["fin-e", "--env=local"], { DATABASE_URL: direct("previewprojectref0002") });
  check("--env=local against a remote host is refused", refused(localRemote, /loopback/), localRemote.stderr);
  const badDate = run(["coingecko", "--env=local", "--coingecko-fixed-from=yesterday"], { DATABASE_URL: LOCAL });
  check("a malformed --coingecko-fixed-from is refused", refused(badDate, /YYYY-MM-DD/), badDate.stderr);
  check("no refusal prints a secret or the Production ref", ![noEnv, prodNoAck, previewIsProd, previewNoRef, localRemote].some(leaks));
}

console.log("6. source pins");
{
  const cli = readFileSync(path.join(ROOT, "scripts", "b10-5-decision-report.ts"), "utf8");
  const core = readFileSync(path.join(ROOT, "scripts", "lib", "b10-5-decision-report.core.ts"), "utf8");
  check("the header states who may run it (S2, verbatim)", cli.includes("Preview/clone: engineering; Production: owner-run or owner-approved."));
  check("the header states the acknowledgement is not approval", /safety rail, NOT approval/.test(cli) && /owner's explicit approval for that run/.test(cli));
  check("the CLI uses the shared env guard", /decideRepairEnvGuard\(\{\s*apply: false/.test(cli));
  check("lib/db is imported only after the gates", cli.indexOf('await import("@/lib/db")') > cli.indexOf("decideRepairEnvGuard({"));
  check("no write method anywhere in the tool", ![cli, core].some((s) => /\.(create|update|upsert|delete)(Many)?\(|createMany|executeRaw`/.test(s)));
  check("no --apply flag is known", !/"apply"/.test(cli.split("KNOWN_FLAGS")[1]?.split(";")[0] ?? "x"));
}

runnerSection().then(() => {
  if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nb10-5-decision-report: all checks passed.");
}, (e) => { console.error(e); process.exit(1); });
