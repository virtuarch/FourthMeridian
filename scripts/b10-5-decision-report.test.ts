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
  BOUND_LABELS, COINGECKO_DEFINITE_DAILY_MIN_SPAN, GOVERNANCE_LINES, READ_ONLY_STATEMENT, REPORTS, REQUIRED_COLUMNS,
  FROZEN_RESTRICTED_SQL, RESTRICTED_DEPOSITORY_SUBTYPES,
  coinLabel, missingColumns, outputLeaks, renderDocument, renderReport, runReport, summarizeAudit021, summarizeCoinGecko,
  summarizeFrozenRestricted,
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
          if (/TRIVIAL_ZERO/.test(sql)) return [
            { verdict: "DERIVABLE", rows: 5, spaces: 1, fromDate: "2026-02-01", toDate: "2026-02-05" },
            { verdict: "TRIVIAL_ZERO", rows: 2, spaces: 1, fromDate: "2026-02-06", toDate: "2026-02-07" },
          ] as unknown as T;
          if (/"UserSession"/.test(sql)) return [{ allRows: 20, inLifetime: 9, reapable: 7, revokedDue: 3, newlyDue: 4, inGrace: 2, bandGraceTo90: 1, band90to180: 1, band180to365: 1, bandOver365: 1, oldestExpiry: "2025-06-01" }] as unknown as T;
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
    check("every report prints its heuristic", (doc.match(/\*Heuristic:\*/g) ?? []).length === REPORTS.length);
    check("expired-sessions: newly-due count and age bands render, labelled exact",
      /\| — \*\*newly due\*\* .*\| \*\*4\*\* \| exact \|$/m.test(doc) && /\| —— expired more than 365 d ago \| 1 \| exact \|$/m.test(doc) && /Oldest newly-due expiry: 2025-06-01\./.test(doc));
    // S2 (#370): every figure row names its bound kind literally, as its LAST cell.
    const tableRows = doc.split("\n").filter((l) => l.startsWith("| ") && !/^\|\s*(Coin|Measure|Frozen rows)\s*\|/.test(l));
    const unlabelled = tableRows.filter((l) => !BOUND_LABELS.some((b) => l.trimEnd().endsWith(`| ${b} |`)));
    check("every count row carries exactly one bound label (lower bound | upper bound | review list (includes genuine $0) | exact | exact for retained data (purged accounts can't be seen))",
      tableRows.length >= 15 && unlabelled.length === 0, unlabelled.join(" / "));
    check("the mapping: CoinGecko late = lower bound; FIN-A2 candidates = review list; FIN-E fillable = upper bound; FM-AUDIT-021 candidates = upper bound",
      /\| BTC \| one day late \|.*\| lower bound \|$/m.test(doc)
        && /\| \*\*Candidates\*\* \(\$0.*\| review list \(includes genuine \$0\) \|$/m.test(doc)
        && /\| \*\*Fillable by regeneration\*\*.*\| upper bound \|$/m.test(doc)
        && /\| \*\*Candidates\*\* \(stale.*\| upper bound \|$/m.test(doc)
        && /\| \*\*Derivable\*\*.*\| upper bound \|$/m.test(doc)
        && /\| Not derivable .*\| exact \|$/m.test(doc)
        && /\| No restricted-capable accounts: the split is trivially 0 .*\| exact for retained data \(purged accounts can't be seen\) \|$/m.test(doc));
    check("frozen-restricted renders through the fake: derivable 5 (1 Space), trivially 0 = 2, not derivable 0, population 7",
      /\| \*\*Derivable\*\* .*\| \*\*5\*\* \| \*\*1\*\* \| 2026-02-01 → 2026-02-05 \| upper bound \|$/m.test(doc)
        && /\| Not derivable .*\| 0 \| 0 \| — \| exact \|$/m.test(doc)
        && /trivially 0 \| 2 \| 1 \| 2026-02-06 → 2026-02-07 \| exact for retained data \(purged accounts can't be seen\) \|$/m.test(doc)
        && /\(population\) \| 7 \| — \| 2026-02-01 → 2026-02-07 \| exact \|$/m.test(doc));
    check("frozen-restricted says it is report-only and that a fill is owner-gated",
      /REPORT ONLY: this tool has no fill and no apply\. Any fill of frozen rows .* is a separate owner-gated repair\./.test(doc));
    check("undetermined is its own row, labelled exact, never folded into a bound",
      /\| BTC \| undetermined \|.*\| exact \|$/m.test(doc) && /\| Undetermined \(before the balance ledger\).*\| exact \|$/m.test(doc));
    check("the pre-FIN-011 lower-bound note is kept", /before FIN-011 the candidate count is also a lower bound/.test(doc));
    const missing = await runReport(fake(allCols.filter((c) => !(c.t === "FinancialAccount" && c.c === "balanceObserved"))), "fin-a2");
    check("a missing column ⇒ UNAVAILABLE naming it, and no report query runs",
      missing.status === "UNAVAILABLE" && /FinancialAccount\.balanceObserved/.test(missing.reason)
        && !statements[statements.length - 1].some((s) => /"plaidAccounts"/.test(s)));
    check("UNAVAILABLE renders", /\*\*UNAVAILABLE\*\*/.test(renderDocument("local", "2026-11-04T06:00:00.000Z", [missing])));
  }
}

console.log("2b. frozen-restricted (pure)");
{
  const s = summarizeFrozenRestricted([
    { verdict: "NOT_DERIVABLE", rows: 3, spaces: 2, fromDate: "2026-01-10", toDate: "2026-03-01" },
    { verdict: "DERIVABLE", rows: 4, spaces: 1, fromDate: "2026-02-01", toDate: "2026-02-04" },
    { verdict: "TRIVIAL_ZERO", rows: 1, spaces: 1, fromDate: "2025-12-31", toDate: "2025-12-31" },
  ]);
  check("buckets read through", s.derivable.rows === 4 && s.notDerivable.rows === 3 && s.trivialZero.rows === 1);
  check("the population is the sum of the buckets, over the widest range", s.total.rows === 8 && s.total.fromDate === "2025-12-31" && s.total.toDate === "2026-03-01");
  const none = summarizeFrozenRestricted([]);
  check("no frozen NULL rows ⇒ all zero, no range", none.total.rows === 0 && none.total.fromDate === null && none.derivable.fromDate === null);
  const text = renderReport({ report: "frozen-restricted", status: "OK", data: s });
  check("labels: derivable = upper bound; not derivable and the population = exact; trivially 0 = exact for retained data (S2 #376)",
    /\| \*\*Derivable\*\*.*\| \*\*4\*\* \| \*\*1\*\* \| 2026-02-01 → 2026-02-04 \| upper bound \|$/m.test(text)
      && /\| Not derivable .*\| 3 \| 2 \| 2026-01-10 → 2026-03-01 \| exact \|$/m.test(text)
      && /trivially 0 \| 1 \| 1 \| 2025-12-31 \| exact for retained data \(purged accounts can't be seen\) \|$/m.test(text)
      && /\(population\) \| 8 \| — \| 2025-12-31 → 2026-03-01 \| exact \|$/m.test(text));
  check("the heuristic names the walk-back, the posted-ledger rule and the owner gate",
    /WALKS BACK from each account's current posted balance/.test(text) && /posted ledger reaches the day/.test(text) && /separate owner-gated repair/.test(text));
  check("the heuristic names the hard-delete paths that can hide a linked HSA, and says purge is not the only one",
    /lib\/account-deletion\/purge\.ts\) is NOT the only hard-delete path/.test(text) && /scripts\/purge-plaid-connection\.ts/.test(text)
      && /scripts\/dev-reset-test-state\.ts/.test(text) && /links are revoked \(status \+ revokedAt\), never deleted/.test(text));
  check("the allowed-label set includes the retained-data label", BOUND_LABELS.includes("exact for retained data (purged accounts can't be seen)") && BOUND_LABELS.length === 5);
  check("the SQL reads frozen observed NULL rows only, posted non-deleted transactions only, and the restricted depository subtypes",
    /"isEstimated" = false AND s\."restrictedCash" IS NULL/.test(FROZEN_RESTRICTED_SQL)
      && /t\."deletedAt" IS NULL AND t\.pending = false/.test(FROZEN_RESTRICTED_SQL)
      && /p\."firstPosted" IS NOT NULL AND p\."firstPosted" <= c\.date/.test(FROZEN_RESTRICTED_SQL)
      && /l\."createdAt" < f\."dayEnd" AND \(l\."revokedAt" IS NULL OR l\."revokedAt" >= f\."dayEnd"\)/.test(FROZEN_RESTRICTED_SQL)
      && /fa\.type::text IN \('checking', 'savings'\)/.test(FROZEN_RESTRICTED_SQL) && /IN \('hsa'\)/.test(FROZEN_RESTRICTED_SQL));
  // The mirror must equal the classifier's set: a subtype added there and not here would make the report under-count.
  const cls = readFileSync(path.join(ROOT, "lib", "account-classifier.ts"), "utf8");
  const m = cls.match(/RESTRICTED_DEPOSITORY_SUBTYPES: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/);
  const classifierSet = (m?.[1] ?? "").split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean).sort();
  check("RESTRICTED_DEPOSITORY_SUBTYPES mirrors lib/account-classifier.ts exactly", m !== null && classifierSet.join() === [...RESTRICTED_DEPOSITORY_SUBTYPES].sort().join(), classifierSet.join());
  check("restrictedCash sums checking + savings only (the classifier's restricted bucket)", /const restrictedCash = \[\.\.\.checking, \.\.\.savings\]\.filter\(isRestricted\)/.test(cls));
  const present = new Set(REQUIRED_COLUMNS["frozen-restricted"].map(([t, c]) => `${t}.${c}`));
  present.delete("FinancialAccount.providerSubtype");
  check("a missing providerSubtype is named", missingColumns("frozen-restricted", present).join() === "FinancialAccount.providerSubtype");
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
  const coreSrc = readFileSync(path.join(ROOT, "scripts", "lib", "b10-5-decision-report.core.ts"), "utf8");
  check("expired-sessions derives its limits from session-proof and its grace from THE retention rule (no copied numbers)",
    /interval '\$\{SESSION_IDLE_TIMEOUT_MS\} milliseconds'/.test(coreSrc) && /interval '\$\{SESSION_ABSOLUTE_LIFETIME_MS\} milliseconds'/.test(coreSrc)
      && /RETENTION_RULES\.find\(\(r\) => r\.table === "userSession"\)!\.days/.test(coreSrc) && !/interval '30 days'/.test(coreSrc));
  check("expired-sessions selects aggregates only (no id / ipAddress / userAgent / userId)",
    !/"(ipAddress|userAgent|userId|sessionToken)"|u\.id\b/.test(coreSrc.slice(coreSrc.indexOf("EXPIRED_SESSIONS_SQL"), coreSrc.indexOf("// ── result shapes"))));
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
