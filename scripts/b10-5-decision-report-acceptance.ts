/**
 * scripts/b10-5-decision-report-acceptance.ts  (B10.5 owner-decision prep — against a REAL Postgres)
 *
 * scripts/b10-5-decision-report.test.ts proves the pure core and the CLI's
 * refusals without a database. This suite proves the SQL: it builds its OWN
 * throwaway Postgres (scripts/lib/rls-harness.ts: a fresh container carrying the
 * committed migrations, removed afterwards with `docker rm -f -v`), seeds a few
 * rows per case, spawns the real CLI with --env=local, and asserts the exact
 * counts and date ranges, that nothing was written, that the output carries no
 * id / amount / name / email, that a non-bypass principal is refused, and that
 * a missing column reads UNAVAILABLE. It refuses to fall back to any configured
 * database.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/b10-5-decision-report-acceptance.ts [--keep]
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { makeRecorder, prepareHarness, psql, teardownHarness } from "./lib/rls-harness";
import { BOUND_LABELS, outputLeaks } from "./lib/b10-5-decision-report.core";

const KEEP = process.argv.includes("--keep");
const { check, report } = makeRecorder();
const ROOT = process.cwd();

/** cuid-shaped fixture ids, so the output-leak predicate is meaningful. */
const id = (tag: string) => `c${(tag + randomBytes(16).toString("hex")).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24).padEnd(24, "0")}`;

async function main(): Promise<number> {
  console.log("\n=== B10.5 DECISION REPORT — THROWAWAY POSTGRES ACCEPTANCE ===\n");
  const h = prepareHarness("b105");
  const owner = h.ownerUrl;
  const one = (sql: string) => { const r = psql(owner, sql); if (!r.ok) throw new Error(`fixture SQL failed: ${r.err}`); return r.out; };

  const U = id("u"), S1 = id("sa"), S2 = id("sb"), S3 = id("sc"), S4 = id("sd"), RX = id("rx");
  const A = Object.fromEntries(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "b1", "b2", "m1"].map((k) => [k, id(k)])) as Record<string, string>;
  const BTC = id("ibtc"), ETH = id("ieth"), EQ = id("ieq");
  const INSTITUTION = "Fixture Credit Union";
  const EMAIL = "fixture-owner@example.test";

  // Account columns: id, type, plaidAccountId, balance, balanceObserved, createdAt, deletedAt, syncStatus
  const acct = (k: string, type: string, plaid: boolean, balance: string, observed: boolean, created: string, deleted: string | null = null, sync = "active") =>
    `('${A[k]}','Acct ${k}','${type}','${INSTITUTION}','USER','${U}',${plaid ? `'plaid-${k}-${A[k]}'` : "NULL"},${balance},${observed},'${created}',${deleted ? `'${deleted}'` : "NULL"},'${sync}',now())`;
  one(`
    insert into "User" (id,email,name,"updatedAt") values ('${U}','${EMAIL}','Fixture Owner',now());
    insert into "Space" (id,name,type,"updatedAt") values
      ('${S1}','Space One','PERSONAL',now()),('${S2}','Space Two','PERSONAL',now()),
      ('${S3}','Space Three','PERSONAL',now()),('${S4}','Space Four','PERSONAL',now());
    insert into "FinancialAccount" (id,name,type,institution,"ownerType","ownerUserId","plaidAccountId",balance,"balanceObserved","createdAt","deletedAt","syncStatus","updatedAt") values
      ${acct("a1", "checking", true, "0", true, "2026-04-01")},
      ${acct("a2", "savings", true, "0", true, "2026-02-01")},
      ${acct("a3", "checking", true, "0", true, "2026-04-01")},
      ${acct("a4", "checking", true, "0", false, "2026-04-01")},
      ${acct("a5", "checking", true, "1234.56", true, "2026-04-01")},
      ${acct("a6", "checking", false, "0", true, "2026-04-01", null, "manual")},
      ${acct("a7", "checking", true, "0", true, "2026-04-01", "2026-04-15")},
      ${acct("a8", "debt", true, "0", true, "2026-04-01")},
      ${acct("b1", "checking", true, "4321.09", true, "2026-03-10")},
      ${acct("b2", "checking", true, "77.31", true, "2026-03-10")},
      ${acct("m1", "checking", false, "10.50", true, "2026-03-01", null, "manual")};
    update "FinancialAccount" set "balanceLastUpdatedAt" = '2026-04-02' where id in ('${A.a2}','${A.a8}');
    insert into "SpaceAccountLink" (id,"spaceId","financialAccountId",kind,status,"createdAt","revokedAt","updatedAt") values
      ('${id("l1")}','${S1}','${A.a5}','HOME','ACTIVE','2026-04-01',NULL,now()),
      ('${id("l2")}','${S2}','${A.a3}','HOME','REVOKED','2026-04-01','2026-04-02',now()),
      ('${id("l3")}','${S3}','${A.b1}','HOME','ACTIVE','2026-03-10',NULL,now()),
      ('${id("l4")}','${S4}','${A.m1}','HOME','ACTIVE','2026-03-01',NULL,now()),
      ('${id("l5")}','${S4}','${A.b2}','HOME','REVOKED','2026-03-10','2026-04-01',now());
    insert into "RefreshExecution" (id,"runId",trigger,profile,"startedAt","overallStatus") values ('${RX}','run-${RX}','CRON','FULL_REFRESH','2026-03-01','SUCCEEDED');
    insert into "RefreshEndpointAccountCoverage" (id,"refreshExecutionId",endpoint,"financialAccountId",status,"freshnessAdvanced","createdAt") values
      ('${id("cv0")}','${RX}','BALANCES','${id("ghost")}','SKIPPED',false,'2026-03-01 00:00:00'),
      ('${id("cv1")}','${RX}','BALANCES','${A.a3}','COVERED',true,'2026-04-05 12:00:00'),
      ('${id("cv2")}','${RX}','BALANCES','${A.a8}','COVERED',false,'2026-04-05 12:00:00'),
      ('${id("cv3")}','${RX}','BALANCES','${A.b1}','COVERED',true,'2026-04-10 12:00:00'),
      ('${id("cv4")}','${RX}','BALANCES','${A.b1}','COVERED',true,'2026-04-20 12:00:00'),
      ('${id("cv5")}','${RX}','BALANCES','${A.a5}','COVERED',true,'2026-05-03 12:00:00'),
      ('${id("cv6")}','${RX}','HOLDINGS','${A.a1}','COVERED',true,'2026-04-05 12:00:00');
    insert into "SpaceSnapshot" (id,"spaceId",date,"isEstimated","restrictedCash",cash) values
      ('${id("s11")}','${S1}','2026-05-01',true,NULL,1234.56),
      ('${id("s12")}','${S1}','2026-05-02',true,NULL,1234.56),
      ('${id("s13")}','${S1}','2026-05-03',true,NULL,1234.56),
      ('${id("s14")}','${S1}','2026-05-05',true,0,1234.56),
      ('${id("s15")}','${S1}','2026-05-04',false,NULL,1234.56),
      ('${id("s21")}','${S2}','2026-05-01',true,NULL,0),
      ('${id("s22")}','${S2}','2026-05-02',true,NULL,0),
      ('${id("s31")}','${S3}','2026-03-05',false,0,4321.09),
      ('${id("s32")}','${S3}','2026-03-12',false,0,4321.09),
      ('${id("s33")}','${S3}','2026-04-12',false,0,4321.09),
      ('${id("s34")}','${S3}','2026-04-18',false,0,4321.09),
      ('${id("s35")}','${S3}','2026-04-19',false,0,4321.09),
      ('${id("s36")}','${S3}','2026-04-21',false,0,4321.09),
      ('${id("s37")}','${S3}','2026-04-25',true,0,4321.09),
      ('${id("s41")}','${S4}','2026-04-18',false,0,10.50);
    insert into "Instrument" (id,"tickerSymbol",name,"assetClass","updatedAt") values
      ('${BTC}','BTC','Bitcoin','CRYPTO',now()),('${ETH}','ETH','Ethereum','CRYPTO',now()),('${EQ}','ACME','Acme Corp','EQUITY',now());
    insert into "UserSession" (id,"userId","sessionToken","createdAt","lastActiveAt","revokedAt") values
      ('${id("us1")}','${U}','tok-${id("us1")}', now() - interval '40 days', now() - interval '31 days', now() - interval '31 days'),
      ('${id("us2")}','${U}','tok-${id("us2")}', now() - interval '70 days', now() - interval '61 days', NULL),
      ('${id("us3")}','${U}','tok-${id("us3")}', now() - interval '290 days', now() - interval '1 day', NULL),
      ('${id("us4")}','${U}','tok-${id("us4")}', now() - interval '500 days', now() - interval '500 days', NULL),
      ('${id("us5")}','${U}','tok-${id("us5")}', now() - interval '45 days', now() - interval '40 days', NULL),
      ('${id("us6")}','${U}','tok-${id("us6")}', now() - interval '5 days', now() - interval '1 day', NULL),
      ('${id("us7")}','${U}','tok-${id("us7")}', now() - interval '6 days', now() - interval '2 days', now() - interval '5 days');
    insert into "PriceObservation" (id,"instrumentId",date,price,currency,basis,source,"fetchedAt")
      select 'po_btc_a_'||g, '${BTC}', date '2025-01-01' + g, 43210.12, 'USD', 'RAW_CLOSE'::"PriceBasis", 'coingecko', timestamp '2026-06-01 10:00:00' from generate_series(0,119) g
      union all select 'po_btc_b_'||g, '${BTC}', date '2025-06-01' + g, 43210.12, 'USD', 'RAW_CLOSE'::"PriceBasis", 'coingecko', timestamp '2026-06-01 11:00:00' from generate_series(0,29) g
      union all select 'po_btc_i_'||g, '${BTC}', date '2025-08-01' + g, 43210.12, 'USD', 'INTRADAY'::"PriceBasis", 'coingecko', timestamp '2026-06-01 10:00:00' from generate_series(0,199) g
      union all select 'po_eth_a_'||g, '${ETH}', date '2024-01-01' + g, 2345.67, 'USD', 'RAW_CLOSE'::"PriceBasis", 'coingecko:token_market_chart', timestamp '2026-07-01 09:00:00' from generate_series(0,99) g
      union all select 'po_eth_f_'||g, '${ETH}', date '2025-01-01' + g, 2345.67, 'USD', 'RAW_CLOSE'::"PriceBasis", 'coingecko', timestamp '2026-11-01 09:00:00' from generate_series(0,199) g
      union all select 'po_eq_'||g, '${EQ}', date '2025-01-01' + g, 12.34, 'USD', 'RAW_CLOSE'::"PriceBasis", 'tiingo', timestamp '2026-06-01 10:00:00' from generate_series(0,199) g;
  `);

  const cli = (args: string[], url = owner) => spawnSync(
    path.join(ROOT, "node_modules", ".bin", "tsx"),
    ["--require", "./scripts/lib/server-only-preload.cjs", "scripts/b10-5-decision-report.ts", ...args],
    { cwd: ROOT, encoding: "utf8", timeout: 300_000,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
        DATABASE_URL: `${url}?schema=public`, DIRECT_URL: `${url}?schema=public` } as unknown as NodeJS.ProcessEnv },
  );
  const out = (r: ReturnType<typeof cli>) => `${r.stdout}${r.stderr}`;
  const row = (text: string, label: string) => text.split("\n").find((l) => l.startsWith(`| ${label}`)) ?? "";
  const fixtureSecrets = [U, S1, S2, S3, S4, ...Object.values(A), BTC, ETH, INSTITUTION, EMAIL, "Fixture Owner", "1234.56", "4321.09", "43210.12", "2345.67", owner];
  const leaked = (text: string) => [...outputLeaks(text), ...fixtureSecrets.filter((s) => text.includes(s))];
  const fingerprint = () => one(`select string_agg(t||'='||n, ',' order by t) from (
      select 'fa' t, count(*) n from "FinancialAccount" union all select 'ss', count(*) from "SpaceSnapshot"
      union all select 'po', count(*) from "PriceObservation" union all select 'cv', count(*) from "RefreshEndpointAccountCoverage"
      union all select 'rc', count(*) from "SpaceSnapshot" where "restrictedCash" is not null
      union all select 'bo', count(*) from "FinancialAccount" where "balanceObserved"
      union all select 'us', count(*) from "UserSession") x;`);
  const before = fingerprint();

  // ── all four, as the owner's run would ──
  const all = cli(["all", "--env=local"]);
  const text = out(all);
  console.log(all.stdout);
  check(1, "`all --env=local` exits 0", all.status === 0, text.slice(0, 2000));
  check(2, "the output carries the governance lines", text.includes("Preview/clone: engineering; Production: owner-run or owner-approved.") && /safety rail, NOT approval/.test(text));
  check(3, "no id, amount, name, email, institution or URL in the output", leaked(text).length === 0, leaked(text).join(", "));
  check(4, "nothing was written", fingerprint() === before, `${before} → ${fingerprint()}`);

  {
    const tableRows = text.split("\n").filter((l) => l.startsWith("| ") && !/^\|\s*(Coin|Measure|Frozen rows)\s*\|/.test(l));
    const unlabelled = tableRows.filter((l) => !BOUND_LABELS.some((b) => l.trimEnd().endsWith(`| ${b} |`)));
    check(24, "every figure row in the real output names its bound kind (S2)", tableRows.length > 10 && unlabelled.length === 0, unlabelled.join(" / "));
  }

  // 1. CoinGecko
  check(5, "BTC: the 120-day batch is late (2025-01-01 → 2025-04-30, lower bound), the 30-day batch undetermined (separate row); INTRADAY ignored",
    row(text, "BTC | one day late").includes("| 120 | 2025-01-01 → 2025-04-30 | lower bound |") && row(text, "BTC | undetermined").includes("| 30 | — | exact |"),
    `${row(text, "BTC | one day late")} / ${row(text, "BTC | undetermined")}`);
  check(6, "ETH: token + coin batches both late without --coingecko-fixed-from (300 rows)",
    row(text, "ETH | one day late").includes("| 300 | 2024-01-01 → 2025-07-19 | lower bound |") && row(text, "ETH | undetermined").includes("| 0 |"), row(text, "ETH | one day late"));
  check(7, "a non-CoinGecko (Tiingo) instrument is not in the table", !/\| ACME \|/.test(text) && !/\| other \|/.test(text));
  const fixed = cli(["coingecko", "--env=local", "--coingecko-fixed-from=2026-10-15"]);
  check(8, "--coingecko-fixed-from excludes the post-fix batch",
    row(out(fixed), "ETH | one day late").includes("| 100 | 2024-01-01 → 2024-04-09 | lower bound |") && row(out(fixed), "ETH | excluded").includes("| 200 | — | exact |"),
    `${row(out(fixed), "ETH | one day late")} / ${row(out(fixed), "ETH | excluded")}`);

  // 2. FIN-A2
  check(9, "FIN-A2 population: 8 live Plaid accounts", row(text, "Live Plaid accounts").includes("| 8 |"), row(text, "Live Plaid accounts"));
  check(10, "FIN-A2 candidates: 3 (unobserved since creation; an advanced=false row is not an observation)",
    row(text, "**Candidates** ($0").includes("| **3** | review list (includes genuine $0) |"), row(text, "**Candidates** ($0"));
  check(11, "FIN-A2 split: 2 after the ledger began, 1 before", row(text, "— created after").includes("| 2 |") && row(text, "— created before").includes("| 1 |"));
  check(12, "FIN-A2 no-institution-clock 1; types checking 1, debt 1, savings 1",
    row(text, "— of which no institution").includes("| 1 |") && row(text, "— type checking").includes("| 1 |") && row(text, "— type debt").includes("| 1 |") && row(text, "— type savings").includes("| 1 |"));
  check(13, "FIN-A2 created range and ledger start", text.includes("Candidates created: 2026-02-01 → 2026-04-01. Balance ledger begins: 2026-03-01."));

  // 3. FIN-E
  check(14, "FIN-E fillable: 3 days, 1 Space, 2026-05-01 → 2026-05-03",
    row(text, "**Fillable by regeneration**").includes("| **3** | **1** | 2026-05-01 → 2026-05-03 | upper bound |"), row(text, "**Fillable by regeneration**"));
  check(15, "FIN-E frozen NULL rows: 1 / 1 Space on 2026-05-04", row(text, "Frozen observed rows with NULL").includes("| 1 | 1 | 2026-05-04 |"), row(text, "Frozen observed rows with NULL"));
  check(16, "FIN-E no-input rows 2 (revoked link only); NULL 6 of 15", row(text, "Estimate rows with NULL and no active").includes("| 2 |") && row(text, "All rows with NULL").includes("| 6 / 15 |"), row(text, "All rows with NULL"));

  // 4. FM-AUDIT-021
  check(17, "FM-AUDIT-021 candidates: 2 days, 1 Space, 2026-04-18 → 2026-04-19",
    row(text, "**Candidates** (stale").includes("| **2** | **1** | 2026-04-18 → 2026-04-19 | upper bound |"), row(text, "**Candidates** (stale"));
  check(18, "FM-AUDIT-021 clear: 5 days (fresh, too-new, manual, revoked, observed), 3 Spaces",
    row(text, "Clear").includes("| 5 | 3 | 2026-03-12 → 2026-05-04 |"), row(text, "Clear"));
  check(19, "FM-AUDIT-021 undetermined: the day before the ledger horizon",
    row(text, "Undetermined").includes("| 1 | 1 | 2026-03-05 | exact |"), row(text, "Undetermined"));

  // 5. expired sessions (the reaper's dry run): us1 revoked 31 d ago; us2 idle-expired 31 d ago;
  // us3 absolute-expired 200 d ago; us4 expired 470 d ago; us5 expired 10 d ago (grace); us6 live; us7 revoked 5 d ago.
  check(25, "expired-sessions: population 7, 1 within lifetime, 4 reapable (1 revoked + 3 newly due), 1 in grace",
    row(text, "Session rows").includes("| 7 |") && row(text, "Unrevoked and within").includes("| 1 |")
      && row(text, "**Reapable now**").includes("| **4** |") && row(text, "— already reaped").includes("| 1 |")
      && row(text, "— **newly due**").includes("| **3** |") && row(text, "Expired, unrevoked, still inside").includes("| 1 |"),
    text.split("### 5.")[1]?.slice(0, 1500));
  check(26, "expired-sessions bands: 30–90 d 1, 90–180 d 0, 180–365 d 1, >365 d 1",
    row(text, "—— expired 30–90").includes("| 1 |") && row(text, "—— expired 90–180").includes("| 0 |")
      && row(text, "—— expired 180–365").includes("| 1 |") && row(text, "—— expired more than 365").includes("| 1 |"));

  // ── a non-bypass principal is refused (a count under RLS would silently miss rows) ──
  {
    const pw = randomBytes(18).toString("hex");
    one(`create role fm_b105_probe login password '${pw}' nobypassrls nosuperuser; grant usage on schema public to fm_b105_probe;`);
    const u = new URL(owner); u.username = "fm_b105_probe"; u.password = pw;
    const r = cli(["all", "--env=local"], u.toString());
    check(20, "a role without BYPASSRLS is refused (exit 2) before any report", r.status === 2 && /must bypass RLS/.test(r.stderr) && !/### 1\./.test(r.stdout), out(r).slice(0, 800));
    check(21, "the refusal prints no secret or URL", leaked(out(r)).length === 0 && !out(r).includes(pw), leaked(out(r)).join(", "));
  }

  // ── the transaction really is read-only: a write inside it would fail ──
  {
    const r = psql(owner, `BEGIN; SET TRANSACTION READ ONLY; UPDATE "SpaceSnapshot" SET cash = cash; COMMIT;`, true);
    check(22, "a write under SET TRANSACTION READ ONLY is rejected by Postgres (the mechanism the tool relies on)", !r.ok && /read-only transaction/.test(r.err), r.err);
  }

  // ── a missing column ⇒ UNAVAILABLE, never guessed ──
  {
    one(`alter table "SpaceSnapshot" drop column "restrictedCash"; alter table "FinancialAccount" drop column "balanceObserved";`);
    const r = cli(["all", "--env=local"]);
    const t = out(r);
    check(23, "fin-e and fin-a2 read UNAVAILABLE naming the column; the other two still report",
      r.status === 0 && /\*\*UNAVAILABLE\*\* — the target has no SpaceSnapshot\.restrictedCash/.test(t)
        && /\*\*UNAVAILABLE\*\* — the target has no FinancialAccount\.balanceObserved/.test(t)
        && row(t, "BTC | one day late").includes("| 120 |") && row(t, "**Candidates** (stale").includes("**2**"), t.slice(0, 3000));
  }

  return report("B10.5 DECISION REPORT ACCEPTANCE");
}

main()
  .then((failed) => { teardownHarness(KEEP); process.exit(failed ? 1 : 0); })
  .catch((e) => { console.error(e); teardownHarness(KEEP); process.exit(1); });
