/**
 * lib/investments/import-rollback-authority.test.ts  (RLS-C-S8)
 *
 * THE MOST DESTRUCTIVE ROUTE IN THE IMPORT FEATURE RUNS UNDER THE CALLER'S OWN
 * DATABASE IDENTITY — IN PHASES, AND WITHOUT LOSING THE LOUDNESS IT ALREADY HAD.
 *
 * `POST /api/imports/[id]/rollback` soft-deletes every Transaction a batch
 * created, plus (for INVESTMENT_HISTORY) its InvestmentEvent and
 * PositionObservation rows, and un-supersedes the assertions those had outranked.
 * Four of its writes are `updateMany` and three of their counts reach the user.
 *
 * Every property below is a thing a future edit could remove while the route
 * still returned 200 and every other test stayed green. Two of them are
 * NEGATIVES, which is why they are asserted rather than reviewed:
 *
 *   · the SyncIssue fallback must stay OUTSIDE every phase. `fm_app` holds a
 *     column-level READ grant on SyncIssue and nothing more, so a telemetry write
 *     inside a tenant phase raises `permission denied` — and it would abort the
 *     very phase it was reporting on. Split authority for that table belongs to
 *     the Plaid slice; until then this route's one SyncIssue write stays on the
 *     root client, deliberately.
 *   · the Transaction soft-delete must keep NO `financialAccountId` in its
 *     `where`. That omission is load-bearing (a merge re-points
 *     Transaction.financialAccountId without updating the batch's), and "tidying"
 *     it under RLS would look like harmless scoping.
 *
 *   npx tsx lib/investments/import-rollback-authority.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = join(__dirname, "..", "..");
const ROLLBACK = join("app", "api", "imports", "[id]", "rollback", "route.ts");

/** Comment-stripped: a header that EXPLAINS a hazard must never satisfy a scan for it. */
function code(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Every `name(` … `)` argument text, counting brackets and skipping quotes. */
function callArguments(src: string, name: string): string[] {
  const out: string[] = [];
  const needle = new RegExp(`\\b${name}\\s*\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = needle.exec(src)) !== null) {
    let i = m.index + m[0].length, depth = 1;
    let quote: string | null = null;
    const start = i;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (quote) { if (ch === "\\") i++; else if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      i++;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

function main(): void {
  const rollback = code(ROLLBACK);
  const phases = callArguments(rollback, "withTenantDb");

  console.log("the rollback route");
  // RLS-ACC-S2 — FOUR, not three, and the fourth is the one that was missing.
  // RLS-C-S8 counted three because the AUTHORIZATION between them was not a
  // phase at all: `resolveImportableFinancialAccount` defaulted `client = db`,
  // so the check ran as the migration principal one file away while this route's
  // own source held no `db` and the assertion below was true about it. The gate's
  // client is required and leading now, so the route opens a phase for it. The
  // invariant this case carries is unchanged — each unit of work is its OWN
  // phase, so a best-effort failure cannot un-roll-back — only the count moved.
  check("opens FOUR tenant phases — resolve, AUTHORIZE, the destructive claim, the repair",
    phases.length === 4, `found ${phases.length}`);
  check("reaches the database through no other authority",
    !/from\s+["']@\/lib\/db["']/.test(rollback) && !/\bdb\s*\.\w/.test(rollback));
  check("binds the identity from the authenticated session, never a body/query/cookie",
    phases.every((p) => /^\s*user\.id\s*,/.test(p)), phases.map((p) => p.slice(0, 24)).join(" | "));

  console.log("\nthe batch is resolved under the caller's own identity");
  {
    const resolve = phases.find((p) => /importBatch\.findUnique\b/.test(p));
    check("phase 1 reads the ImportBatch through the tenant client", !!resolve);
    check("a batch this identity cannot see is the same 404 as a missing one",
      /if\s*\(!batch\)/.test(rollback) && /status:\s*404/.test(rollback));
  }

  console.log("\nS6a's loudness survives the conversion (its pin requires both literals)");
  {
    const claimPhase = phases.find((p) => /importBatch\.updateMany\b/.test(p)) ?? "";
    check("the zero-claim branch is still spelled `claim.count === 0`", /claim\.count === 0/.test(claimPhase));
    check("…and is still resolved by findUniqueOrThrow, which RAISES on an invisible row",
      /findUniqueOrThrow/.test(claimPhase));
    check("the discriminating read is INSIDE the same phase as the claim",
      claimPhase.indexOf("claim.count === 0") < claimPhase.indexOf("findUniqueOrThrow"));
    // The exact edit that would reintroduce the defect S6a closed.
    check("the zero path does not resolve itself with a nullable findUnique",
      !/claim\.count === 0[\s\S]{0,400}?importBatch\.findUnique\b(?!OrThrow)/.test(claimPhase));
  }

  console.log("\nevery reported count is measured, not trusted");
  {
    const claimPhase = phases.find((p) => /transaction\.updateMany\b/.test(p)) ?? "";
    const observed = claimPhase.indexOf("transaction.count");
    const written = claimPhase.indexOf("transaction.updateMany");
    const asserted = claimPhase.indexOf("assertEveryObservedRowWasWritten");
    check("the eligible rows are observed BEFORE the soft-delete, in the same phase",
      observed > 0 && written > observed, `count@${observed} updateMany@${written}`);
    check("…and the written count is asserted against that observation AFTER it",
      asserted > written, `assert@${asserted}`);
  }

  console.log("\nthe load-bearing omissions are still omitted");
  {
    const softDelete = callArguments(rollback, "updateMany")
      .find((a) => /importBatchId/.test(a) && /deletedAt:\s*now/.test(a)) ?? "";
    check("the Transaction soft-delete was found", softDelete.length > 0);
    check("…and its `where` still carries NO financialAccountId (a merge relocates rows)",
      !/financialAccountId/.test(softDelete), softDelete.replace(/\s+/g, " ").slice(0, 160));
    // The counters are READ into the response (they are immutable historical
    // facts about what the import did), so scan the WRITE payloads only — a
    // whole-file regex would match the response body and pass for the wrong
    // reason, which is the vacuous-pass shape this programme keeps finding.
    const writes = [...callArguments(rollback, "updateMany"), ...callArguments(rollback, "update")];
    check("the WRITE payloads were found", writes.length >= 2, `found ${writes.length}`);
    check("…and none of them rewrites the historical counters or completedAt",
      writes.every((w) => !/importedCount|matchedCount|skippedCount|failedCount|rowCount|completedAt/.test(w)));
  }

  console.log("\nthe deferred SyncIssue write stays OUTSIDE every phase");
  {
    check("recordSyncIssue is called", /recordSyncIssue\s*\(/.test(rollback));
    check("…and not from inside any tenant phase",
      phases.every((p) => !/recordSyncIssue\s*\(/.test(p)));
    check("…and is not handed a tenant client",
      !/recordSyncIssue\s*\([\s\S]{0,400}?\}\s*,\s*tx\s*\)/.test(rollback));
  }

  console.log("\nthe repair is its own phase, so a best-effort failure cannot un-roll-back");
  {
    const repair = phases.find((p) => /repairReconstructionForAccount/.test(p));
    check("the repair runs in a phase of its own", !!repair);
    const claimPhase = phases.find((p) => /transaction\.updateMany\b/.test(p)) ?? "";
    check("…and NOT inside the destructive one", !/repairReconstructionForAccount/.test(claimPhase));
    check("…and it is wrapped in a try/catch, which is only safe because it is separate",
      /try\s*\{[\s\S]{0,400}?repairReconstructionForAccount/.test(rollback));
  }

  console.log("\nthe two connection import reads are tenant phases too");
  for (const rel of [
    join("app", "api", "connections", "[id]", "import-history", "route.ts"),
    join("app", "api", "connections", "[id]", "import-accounts", "route.ts"),
  ]) {
    const c = code(rel);
    const ph = callArguments(c, "withTenantDb");
    check(`${rel} opens exactly one phase`, ph.length === 1, `found ${ph.length}`);
    check(`${rel} binds the session user id`, ph.every((p) => /^\s*user\.id\s*,/.test(p)));
    check(`${rel} imports no global db`, !/from\s+["']@\/lib\/db["']/.test(c));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll import-rollback authority checks passed");
}

main();
