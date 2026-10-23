/**
 * lib/db/conditional-write.test.ts  (RLS-C-S6a)
 *
 * Pins the three-state contract of the indeterminate-write guard, and the
 * conversion of the four sites that were reading a refusal as contention.
 *
 * THE PROPERTY THAT MATTERS MOST HERE IS A NEGATIVE ONE: the success path must
 * issue NO probe. The guard's whole claim to being affordable is that its cost
 * lives on the failure path, and nothing in the type system says so — a future
 * refactor that hoisted the count above the branch would stay green on every
 * other assertion in this file while doubling the write traffic of the busiest
 * lock in the Plaid pipeline. So the probe is a spy, and its call count is
 * asserted on both paths.
 *
 * The behavioural proof against a REAL fm_app policy refusal — Alice attempting
 * the CAS on a row only Bob can see — is case 40 of scripts/rls-app-acceptance.ts,
 * which needs a live Postgres and real roles. What this file defends is the shape
 * a future edit could quietly revert while every other test stayed green.
 *
 *   npx tsx lib/db/conditional-write.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  IndeterminateWriteError,
  PartialBulkWriteError,
  assertEveryObservedRowWasWritten,
  resolveConditionalWrite,
} from "@/lib/db/conditional-write";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = join(__dirname, "..", "..");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** Source with comments stripped: a header that EXPLAINS the defect must never satisfy a scan for it. */
const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** A probe that records every call, so "was it called" is an assertion and not a hope. */
function spyProbe(answer: number | (() => Promise<number>)) {
  let calls = 0;
  return {
    get calls() { return calls; },
    fn: async (): Promise<number> => {
      calls++;
      return typeof answer === "number" ? answer : answer();
    },
  };
}

const SITE = { table: "PlaidItem", rowId: "item-9", operation: "update" as const };

async function main(): Promise<void> {
  console.log("RLS-C-S6a — a zero-row conditional write is not an answer");

  console.log("\n1. the three states");
  {
    // ── THE WRITE LANDED ─────────────────────────────────────────────────────
    const won = spyProbe(0);
    check("count 1 → true", await resolveConditionalWrite(1, SITE, won.fn) === true);
    check("THE SUCCESS PATH PERFORMS NO PROBE AT ALL — the cost is on the failure path only",
      won.calls === 0, `probe called ${won.calls} time(s)`);

    const many = spyProbe(0);
    check("a count above 1 is still a landed write (no probe)",
      await resolveConditionalWrite(7, SITE, many.fn) === true && many.calls === 0);

    // ── GENUINE CONTENTION ───────────────────────────────────────────────────
    const raced = spyProbe(1);
    let threw = false;
    let contended: boolean | null = null;
    try { contended = await resolveConditionalWrite(0, SITE, raced.fn); } catch { threw = true; }
    check("count 0 with a VISIBLE row → ordinary false, and does NOT throw",
      contended === false && threw === false);
    check("contention probes exactly once", raced.calls === 1, `calls=${raced.calls}`);

    // ── THE REFUSAL ──────────────────────────────────────────────────────────
    const refused = spyProbe(0);
    let err: unknown = null;
    try { await resolveConditionalWrite(0, SITE, refused.fn); } catch (e) { err = e; }
    check("count 0 with an INVISIBLE row → throws IndeterminateWriteError",
      err instanceof IndeterminateWriteError, `got ${err === null ? "no error" : String(err)}`);
    check("the refusal probes exactly once", refused.calls === 1, `calls=${refused.calls}`);
    check("a negative/absent count is treated as a failure, not a success",
      await resolveConditionalWrite(0, SITE, spyProbe(1).fn) === false);
  }

  console.log("\n2. what the error carries — enough to act on, never a row's contents");
  {
    let err: IndeterminateWriteError | null = null;
    try {
      await resolveConditionalWrite(0, { table: "PlatformSetting", rowId: "refresh_cadence_bank", operation: "delete" },
        async () => 0);
    } catch (e) { err = e as IndeterminateWriteError; }

    check("name is IndeterminateWriteError (recognisable without instanceof across module copies)",
      err?.name === "IndeterminateWriteError");
    check("it carries the table, the row id and the operation",
      err?.table === "PlatformSetting" && err?.rowId === "refresh_cadence_bank" && err?.operation === "delete");
    check("the message names the table, the row and the verb",
      /PlatformSetting/.test(err!.message) && /refresh_cadence_bank/.test(err!.message) && /delete/.test(err!.message));
    check("the message refuses CONTENTION in so many words (the wrong conclusion is named)",
      /contention/i.test(err!.message) && /row-level security/i.test(err!.message));

    // No column values, no `data`, no payload — this travels into logs.
    const own = Object.keys(err as object).sort();
    check("the error exposes ONLY name/table/rowId/operation — no row contents can ride along",
      own.join(",") === ["name", "operation", "rowId", "table"].sort().join(","), own.join(","));
    check("the helper never receives the write's `data` (arity 3: count, site, probe)",
      resolveConditionalWrite.length === 3, `arity ${resolveConditionalWrite.length}`);

    const modCode = code("lib/db/conditional-write.ts");
    check("the module is dependency-free — no Prisma, no db client, no framework import",
      !/@prisma\/client/.test(modCode) && !/@\/lib\/db"/.test(modCode) && !/\bimport\b/.test(modCode));
  }

  console.log("\n3. a broken probe must not decay into 'contention'");
  {
    let err: unknown = null;
    try {
      await resolveConditionalWrite(0, SITE, async () => { throw new Error("probe exploded"); });
    } catch (e) { err = e; }
    check("a probe that rejects propagates untouched (never swallowed into false)",
      err instanceof Error && /probe exploded/.test((err as Error).message));
  }

  console.log("\n4. the four converted sites still route their zero through the guard");
  {
    // A ratchet in miniature. Each of these read `count === 0` / `count === 1`
    // as a business verdict; reverting any one of them reinstates the defect
    // and nothing else in the suite would notice.
    const lock = code("lib/plaid/sync-lock.ts");
    check("claimPlaidItemSyncLock resolves its claim against visibility",
      /resolveConditionalWrite\(\s*claim\.count/.test(lock) && !/claim\.count === 0/.test(lock));
    check("…and probes through the SAME client the claim used",
      /client\.plaidItem\.count\(\{\s*where:\s*\{\s*id:\s*plaidItemId/.test(lock));
    check("…and the syncIncompleteAt stamp is no longer silently swallowed",
      !/\.catch\(\(\)\s*=>\s*\{\s*\}\)/.test(lock) && /failed to stamp syncIncompleteAt/.test(lock));

    const settings = code("lib/platform-settings.ts");
    const conditional = settings.match(/resolveConditionalWrite\(/g) ?? [];
    check("both PlatformSetting conditional primitives are converted",
      conditional.length === 2 && !/return count === 1;/.test(settings), `found ${conditional.length}`);
    check("…and both probe PlatformSetting through the caller's client",
      (settings.match(/client\.platformSetting\.count\(\{ where: \{ key \} \}\)/g) ?? []).length === 2);

    const retry = code("jobs/retry-notifications.ts");
    check("the notification claim is resolved before claimLost is credited",
      /resolveConditionalWrite\(\s*claim\.count/.test(retry) && !/if \(claim\.count === 0\)/.test(retry));
    check("…and an indeterminate claim gets its OWN counter, never claimLost",
      /claimIndeterminate\+\+/.test(retry) && /result\.claimLost\+\+/.test(retry));
    check("…and it is logged at error level rather than counted in silence",
      /console\.error\([^)]*INDETERMINATE claim/.test(retry));
  }

  console.log("\n5. the deferred sites are deferred for stated reasons");
  {
    // lib/ai/brief/store.ts is the one site accidentally rescued: its fallback
    // is an INSERT, and inserts RAISE under a policy refusal. Nobody designed
    // that; it is luck, and it is owned by another slice. The rollback route is
    // likewise already loud — findUniqueOrThrow on the failure path — so its
    // conversion is a clarity change, not a bug fix.
    const rollback = code("app/api/imports/[id]/rollback/route.ts");
    check("the imports rollback route still fails LOUD on a zero claim (findUniqueOrThrow), pending conversion",
      /claim\.count === 0/.test(rollback) && /findUniqueOrThrow/.test(rollback));
  }

  console.log("\n6. the PARTIAL — the same defect, and the half that looks like success (RLS-C-S7)");
  {
    const SITE = { table: "SpaceAccountLink", operation: "update" as const, scope: "2 authorized account id(s)" };

    let nothing: unknown = null;
    try { assertEveryObservedRowWasWritten(SITE, 2, 2); } catch (e) { nothing = e; }
    check("every observed row written → silence", nothing === null);

    let zeroes: unknown = null;
    try { assertEveryObservedRowWasWritten(SITE, 0, 0); } catch (e) { zeroes = e; }
    check("NOTHING observed and nothing written is NOT a shortfall — an account with no links is legal",
      zeroes === null);

    let above: unknown = null;
    try { assertEveryObservedRowWasWritten(SITE, 2, 3); } catch (e) { above = e; }
    check("MORE written than observed is a benign race, not a defect: a row that became eligible needed writing",
      above === null);

    // The one that matters: 1-of-2. A zero at least looks like nothing happened.
    let partial: PartialBulkWriteError | null = null;
    try { assertEveryObservedRowWasWritten(SITE, 2, 1); } catch (e) { partial = e as PartialBulkWriteError; }
    check("1-of-2 RAISES — it is the form that looks exactly like success",
      partial instanceof PartialBulkWriteError);
    check("name is PartialBulkWriteError (recognisable without instanceof across module copies)",
      partial?.name === "PartialBulkWriteError");
    check("it carries the table, the verb, the scope and BOTH counts",
      partial?.table === "SpaceAccountLink" && partial?.operation === "update"
      && partial?.scope === "2 authorized account id(s)" && partial?.observed === 2 && partial?.written === 1);
    check("the message says a partially applied write is indistinguishable by its count alone",
      /partially applied/i.test(partial!.message) && /2/.test(partial!.message) && /1/.test(partial!.message));

    const own = Object.keys(partial as object).sort();
    check("the error exposes ONLY name/table/operation/scope/observed/written — no row contents ride along",
      own.join(",") === ["name", "operation", "scope", "table", "observed", "written"].sort().join(","), own.join(","));
    check("the helper never receives the write's `data` (arity 3: site, observed, written)",
      assertEveryObservedRowWasWritten.length === 3, `arity ${assertEveryObservedRowWasWritten.length}`);

    // The observation is the GUARD, not an optimisation. Every converted site
    // must still perform a read whose count is what gets compared.
    for (const [name, path] of [
      ["disconnect primitive",       "lib/accounts/disconnect.ts"],
      ["account restore route",      "app/api/accounts/[id]/restore/route.ts"],
      ["manual asset restore route", "app/api/accounts/manual/[id]/restore/route.ts"],
    ] as const) {
      const s = code(path);
      check(`${name}: observes before it writes, and compares the two`,
        /\.findMany\(/.test(s) && /assertEveryObservedRowWasWritten\(/.test(s));
    }
  }

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
