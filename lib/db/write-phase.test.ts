/**
 * lib/db/write-phase.test.ts  (RLS-C-S8)
 *
 * Pins the transaction-boundary primitive the investments write spine now shares,
 * and in particular the NEGATIVE property that no type can express: a client that
 * is already inside a transaction must NOT be given one of its own, and must
 * still let a failure out so the enclosing phase rolls back.
 *
 * The companion test lib/investments/atomicity-under-phase.test.ts exercises the
 * three real writers end to end through a fake phase; this file defends the one
 * implementation they share, so a future edit cannot quietly change the branch
 * for all three at once.
 *
 *   npx tsx lib/db/write-phase.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { canOpenTransaction, inOneTransaction, type WriteClient } from "@/lib/db/write-phase";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = join(__dirname, "..", "..");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** Comment-stripped source: a header that EXPLAINS a hazard must never satisfy a scan for it. */
const code = (p: string) =>
  src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** A root client: it HAS `$transaction`, and it records every time one is opened. */
function fakeRoot() {
  const opened: string[] = [];
  const client = {
    tag: "root",
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      opened.push("tx");
      return fn({ tag: "inner-tx" });
    },
  };
  return { client: client as unknown as WriteClient, opened };
}

/** A phase client: structurally a `Prisma.TransactionClient` — NO `$transaction`. */
function fakePhase() {
  return { tag: "phase" } as unknown as WriteClient;
}

async function main(): Promise<void> {
  console.log("canOpenTransaction");
  {
    const { client } = fakeRoot();
    check("a root client can open a transaction", canOpenTransaction(client));
    check("a phase client cannot", !canOpenTransaction(fakePhase()));
  }

  console.log("\ninOneTransaction — a root client opens exactly one transaction");
  {
    const { client, opened } = fakeRoot();
    const seen: unknown[] = [];
    const out = await inOneTransaction(client, async (tx) => { seen.push(tx); return 7; });
    check("the callback ran once and its value is returned", out === 7 && seen.length === 1);
    check("exactly one transaction was opened", opened.length === 1, `opened ${opened.length}`);
    check("the callback received the TRANSACTION client, not the root one",
      (seen[0] as { tag: string }).tag === "inner-tx");
  }

  console.log("\ninOneTransaction — a phase client runs INLINE and opens nothing");
  {
    const phase = fakePhase();
    const seen: unknown[] = [];
    const out = await inOneTransaction(phase, async (tx) => { seen.push(tx); return "ok"; });
    check("the callback ran once and its value is returned", out === "ok" && seen.length === 1);
    check("the callback received the ENCLOSING phase's own client", seen[0] === phase);
    // This is the whole property. If a nested transaction were opened here, the
    // writer's statements would commit independently of the phase that wrapped
    // it, and nothing anywhere would say so.
    check("no `$transaction` was introduced onto the phase client",
      !("$transaction" in (phase as object)));
  }

  console.log("\ninOneTransaction — a failure ESCAPES, because that is how the phase rolls back");
  {
    const phase = fakePhase();
    let threw: unknown = null;
    try {
      await inOneTransaction(phase, async () => { throw new Error("statement 2 of 3 failed"); });
    } catch (e) { threw = e; }
    check("the error propagates out of the inline branch",
      threw instanceof Error && /statement 2 of 3/.test((threw as Error).message));

    // And the root branch must not swallow it either: Prisma's $transaction is
    // what rolls back, and it can only do that if the rejection reaches it.
    const { client, opened } = fakeRoot();
    let rootThrew: unknown = null;
    try {
      await inOneTransaction(client, async () => { throw new Error("inside the tx"); });
    } catch (e) { rootThrew = e; }
    check("the error propagates out of the root branch too, after opening one tx",
      rootThrew instanceof Error && opened.length === 1);
  }

  // The bulk-write guard this slice also needed — assertEveryObservedRowWasWritten —
  // is RLS-C-S7's, in lib/db/conditional-write.ts, and is pinned by its own test.
  // It is deliberately not re-pinned here; what this slice adds on top of it is
  // exercised through the real call site in
  // lib/investments/investment-import-rollback.test.ts.

  // ── Source scan: the three documented atomicity sites share ONE branch ─────
  //
  // The hazard this guards is specific. Each of these three writers used to
  // hand-write `if ("$transaction" in client) … else …`. That line is correct and
  // it is also invisible when it goes wrong: under a tenant phase it takes the
  // INLINE branch, which only delivers atomicity if a phase actually wraps the
  // call. Three copies are three places to lose the requirement; one named
  // helper is one place to test it, which is what the cases above do.
  console.log("\nsource — the three atomicity requirements go through one branch");
  {
    const sites: Array<[string, string]> = [
      ["holdings reconciliation",        "lib/investments/sync-current-holdings.ts"],
      ["investment-event correction",    "lib/investments/investment-event-ingest.ts"],
      ["reconstruction persistence",     "lib/investments/reconstruction-runner.ts"],
    ];
    for (const [label, path] of sites) {
      const c = code(path);
      check(`${label} delegates to inOneTransaction`, /\binOneTransaction\s*\(/.test(c), path);
      check(`${label} hand-rolls no "$transaction" in check`,
        !/["']\$transaction["']\s+in\s/.test(c), path);
      check(`${label} casts nothing to PrismaClient to reach $transaction`,
        !/as\s+PrismaClient\s*\)\s*\.\$transaction/.test(c), path);
    }
  }

  console.log("\nsource — no authority in the converted spine is optional");
  {
    // An OPTIONAL authority is an AMBIENT one: `client ?? db` is exactly the
    // escape this programme closes, and it is the edit most likely to come back
    // because it makes a test fixture shorter.
    const converted = [
      "lib/investments/sync-current-holdings.ts",
      "lib/investments/investment-event-ingest.ts",
      "lib/investments/reconstruction-runner.ts",
      "lib/investments/investment-import-rollback.ts",
      "lib/investments/investment-import-history.ts",
      "lib/investments/connection-import-accounts.ts",
      "app/api/imports/[id]/rollback/route.ts",
      "app/api/connections/[id]/import-history/route.ts",
      "app/api/connections/[id]/import-accounts/route.ts",
    ];
    for (const path of converted) {
      const c = code(path);
      check(`${path} re-derives no authority from a global`,
        !/\bclient\s*(\?\?|\|\|)\s*db\b/.test(c) && !/from\s+["']@\/lib\/db["']/.test(c), path);
    }
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll write-phase checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
