/**
 * lib/plaid/sync-issue-isolation.test.ts
 *
 * PRE-V26-PLAID-CLOSE Phase 2B — proves unit tests can no longer write SyncIssue
 * rows into the developer's database (house pattern: standalone tsx, DB-free):
 *
 *   npx tsx lib/plaid/sync-issue-isolation.test.ts
 *
 * ── The bug this closes ──────────────────────────────────────────────────────
 * `recordSyncIssue` resolved `db` from module scope unconditionally, so it
 * escaped every caller's injected client. A unit test that passed a mocked client
 * and hit an error path wrote a REAL row into the dev Postgres — and because the
 * recorder swallows its own failures by design, nothing ever surfaced it. That is
 * the proven origin of the eight `stage: "opening-position-repair"` rows in the
 * local database, whose `financialAccountId` is the test fixture id `"fa1"`.
 *
 * Phase 2 gave `recordSyncIssue` an optional client (defaulting to the real `db`)
 * and threaded the already-injected client at every call site that has one.
 * Injection was chosen over a `NODE_ENV === "test"` no-op precisely so sync tests
 * can still ASSERT that an issue was recorded — see cursor-safety.test.ts, which
 * now observes UPSERT_ERROR / MISSING_ACCOUNT evidence through its fake.
 *
 * §1 is behavioural. §2 is the drift guard: a NEW call site that has an injected
 * client in scope but forgets to pass it silently reintroduces the leak, so the
 * source is scanned for exactly that shape.
 */

import { recordSyncIssue } from "./syncIssues";
import { readFileSync } from "node:fs";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── 1. Behavioural — the injected client receives the write ──────────────────
console.log("1. recordSyncIssue writes through the INJECTED client");

async function behavioural(): Promise<void> {
  const written: Record<string, unknown>[] = [];
  const fake = { syncIssue: { create: async ({ data }: { data: Record<string, unknown> }) => { written.push(data); return { id: "si1" }; } } };

  await recordSyncIssue(
    { kind: "UPSERT_ERROR", plaidTransactionId: "txn_1", detail: { stage: "unit-test" } },
    fake as never,
  );
  check("the fake captured the write", written.length === 1, `${written.length}`);
  check("payload is intact", written[0]?.kind === "UPSERT_ERROR" && written[0]?.plaidTransactionId === "txn_1");

  // Still never throws — the contract that makes it safe inside a catch block.
  const exploding = { syncIssue: { create: async () => { throw new Error("boom"); } } };
  let threw = false;
  try { await recordSyncIssue({ kind: "UPSERT_ERROR" }, exploding as never); } catch { threw = true; }
  check("a failing recorder still never throws (contract preserved)", !threw);

  // The default is unchanged for production callers: no second arg ⇒ real db.
  const src = readFileSync("lib/plaid/syncIssues.ts", "utf8");
  check("default parameter is the real db (production unchanged)",
    /client:\s*Pick<typeof db,\s*"syncIssue">\s*=\s*db/.test(src));
  check("the write goes through `client`, never a bare `db.`",
    /await client\.syncIssue\.create/.test(src) && !/await db\.syncIssue\.create/.test(src));
}

// ── 2. Drift guard — every call site with a client in scope must pass it ─────
//
// Narrow by construction: it inspects ONLY files that already resolve an
// injected client, and only their recordSyncIssue calls. A route or job that
// legitimately has no injected client (e.g. app/api/imports/[id]/rollback) is
// not listed and correctly keeps the `db` default.
console.log("2. Drift guard — no injected-client path may fall back to module db");
{
  const GUARDED: { file: string; arg: string }[] = [
    { file: "lib/plaid/syncTransactions.ts",                 arg: "database" },
    { file: "lib/investments/opening-position.ts",           arg: "client" },
    { file: "lib/investments/investment-import-commit.ts",   arg: "client" },
    { file: "lib/investments/investment-event-ingest.ts",    arg: "client" },
    { file: "lib/investments/instrument-resolver.ts",        arg: "client" },
    { file: "lib/investments/instrument-resolver-import.ts", arg: "client" },
  ];

  const EXPLANATION =
    "recordSyncIssue must be given the SAME injected client the surrounding " +
    "operation uses. Falling back to the module-level `db` is how unit tests " +
    "wrote real rows into the developer database (the 'fa1' incident).";

  /** Find each `recordSyncIssue(` call and return the text of its argument list. */
  function callArgs(src: string): string[] {
    const out: string[] = [];
    let i = 0;
    for (;;) {
      const j = src.indexOf("recordSyncIssue(", i);
      if (j < 0) break;
      let p = j + "recordSyncIssue(".length;
      let depth = 0;
      while (p < src.length) {
        const c = src[p];
        if (c === "(" || c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") depth--;
        else if (c === ")") { if (depth === 0) break; depth--; }
        p++;
      }
      out.push(src.slice(j + "recordSyncIssue(".length, p));
      i = p;
    }
    return out;
  }

  let violations = 0;
  let inspected = 0;
  for (const { file, arg } of GUARDED) {
    const src = readFileSync(file, "utf8");
    for (const args of callArgs(src)) {
      if (args.includes("export async function")) continue; // the declaration itself
      inspected++;
      // The client must be the LAST argument of the call.
      const tail = args.slice(args.lastIndexOf("}") + 1);
      if (!new RegExp(`,\\s*${arg}\\s*$`).test(tail.trim() ? tail : args)) {
        violations++;
        console.error(`  ✗ ${file} — a recordSyncIssue call does not pass \`${arg}\``);
      }
    }
  }
  check(`all ${inspected} injected-client call sites pass their client`,
    violations === 0, violations > 0 ? EXPLANATION : undefined);
  check("the guard actually inspected call sites (not vacuous)", inspected >= 8, `${inspected}`);

  // The detector must be able to fail.
  const BAD = "await recordSyncIssue({ kind: \"UPSERT_ERROR\", financialAccountId });";
  const GOOD = "await recordSyncIssue({ kind: \"UPSERT_ERROR\", financialAccountId }, client);";
  const argsOf = (s: string) => callArgs(s)[0] ?? "";
  const passes = (s: string, arg: string) => {
    const a = argsOf(s);
    const tail = a.slice(a.lastIndexOf("}") + 1);
    return new RegExp(`,\\s*${arg}\\s*$`).test(tail.trim() ? tail : a);
  };
  check("detector REJECTS a call missing the client", !passes(BAD, "client"));
  check("detector ACCEPTS a call passing the client", passes(GOOD, "client"));
}

// ── 3. The originally-leaking site is fixed ─────────────────────────────────
console.log("3. The 'fa1' leak site specifically");
{
  const src = readFileSync("lib/investments/opening-position.ts", "utf8");
  check("opening-position's repair catch passes its client",
    /stage: "opening-position-repair"[\s\S]{0,200}?\}, client\)/.test(src));
}

void behavioural().then(() => {
  console.log(failures === 0
    ? "\n✅ sync-issue isolation: all checks passed"
    : `\n❌ sync-issue isolation: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
});
