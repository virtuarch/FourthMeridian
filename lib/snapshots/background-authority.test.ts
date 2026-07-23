/**
 * lib/snapshots/background-authority.test.ts  (PS-1)
 *
 * THE INVARIANT
 * -------------
 *   Snapshot regeneration is system-owned computation over explicit
 *   Space/account authority. It must not depend on request-scoped identity or
 *   session state.
 *
 * Two independent checks, because one of them is not enough:
 *
 *   PART 1 — STRUCTURAL. Walk the real import graph from
 *     lib/snapshots/regenerate.ts and assert nothing reachable pulls in
 *     lib/space.ts or getServerSession. This is what stops the dependency
 *     creeping back in via a future "just reuse getAccounts()" edit.
 *
 *   PART 2 — BEHAVIOURAL. Actually RUN regenerateSpaceSnapshot with no session
 *     available and assert it completes and computes the right aggregates.
 *
 * WHY PART 2 EXISTS — read this before deleting it
 * ------------------------------------------------
 * CONN-3 shipped with lib/plaid/freshness-pipeline.test.ts, which asserts:
 *
 *     check("webhook regenerates today's snapshot",
 *           bg.includes("regenerateSnapshotsForAccounts("));
 *
 * That is a source scan. It proves the CALL IS PRESENT IN THE TEXT. It passed
 * continuously while that exact call threw on every single background
 * invocation for weeks, because the throw happened at runtime, inside a
 * dependency, on a path no test ever executed.
 *
 * A structural guard proves wiring. It cannot prove execution. PS-1 is
 * precisely a bug that a structural guard would have missed, so shipping only
 * Part 1 would reproduce the failure mode this slice exists to close.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── Part 1 — structural: no session dependency in the reachable graph ─────────

/** Remove block and line comments so prose can't satisfy (or trip) a code scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Resolve a TS import specifier to a file on disk, or null for a package. */
function resolveImport(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/"))      base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // node_modules — not ours to walk

  for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

/** Every first-party module transitively reachable from `entry`. */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];

  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    let src: string;
    try { src = readFileSync(file, "utf8"); } catch { continue; }

    // `from "x"`, `import("x")` — covers static and dynamic imports.
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)) {
      const resolved = resolveImport(m[1], file);
      if (resolved && !seen.has(resolved)) stack.push(resolved);
    }
  }
  return seen;
}

function partOneStructural(): void {
  console.log("\nPart 1 — structural: no request-scoped auth in the snapshot graph");

  const entry = path.join(ROOT, "lib/snapshots/regenerate.ts");
  const graph = reachableFrom(entry);

  // Sanity: the walker must actually be walking. A silently-empty graph would
  // make every assertion below vacuously true — which is exactly the class of
  // false green this file exists to prevent.
  check(
    "import walker reaches a non-trivial graph (guard is not vacuous)",
    graph.size >= 5,
    `reached ${graph.size} module(s)`,
  );
  check(
    "walker reaches the new system read (proves resolution works)",
    graph.has(path.join(ROOT, "lib/snapshots/space-accounts.ts")),
  );

  const spaceModule = path.join(ROOT, "lib/space.ts");
  check(
    "regenerate.ts does NOT reach lib/space.ts (getSpaceContext)",
    !graph.has(spaceModule),
    graph.has(spaceModule) ? "a request-scoped Space context leaked back in" : undefined,
  );

  // Strip comments before scanning. A doc comment that merely NAMES
  // getServerSession — like the one in space-accounts.ts explaining why the
  // dependency was removed — is prose, not a call, and matching it makes the
  // guard fire on its own documentation. (Same trap as PO-1A's source scans.)
  const offenders: string[] = [];
  for (const file of graph) {
    const code = stripComments(readFileSync(file, "utf8"));
    if (/getServerSession\s*\(/.test(code)) offenders.push(file.replace(`${ROOT}/`, ""));
  }
  check(
    "no module reachable from regenerate.ts calls getServerSession()",
    offenders.length === 0,
    offenders.join(", "),
  );

  // The presentation read must stay OFF this path — it is the specific helper
  // whose internal context resolution caused the outage.
  check(
    "regenerate.ts does not import the viewer-scoped lib/data/accounts.ts",
    !graph.has(path.join(ROOT, "lib/data/accounts.ts")),
  );

  // ...but it must remain available to request paths; PS-1 deleted nothing.
  const accountsSrc = readFileSync(path.join(ROOT, "lib/data/accounts.ts"), "utf8");
  check(
    "lib/data/accounts.ts still exports getAccounts for request-path callers",
    /export async function getAccounts\b/.test(accountsSrc),
  );

  // getSpaceContext itself must remain strict — PS-1 fixed the caller, and
  // explicitly did NOT weaken the authority.
  const spaceSrc = readFileSync(spaceModule, "utf8");
  check(
    "getSpaceContext still THROWS on a missing session (authority not weakened)",
    spaceSrc.includes('throw new Error("Not authenticated — no active session")'),
  );

  // Containment: the reactivated fan-out stays sequential.
  const regenSrc = readFileSync(entry, "utf8");
  check(
    "regenerateSnapshotsForAccounts does not Promise.all over spaces",
    !/Promise\.all\(\s*spaceIds/.test(regenSrc),
  );
}

// ── Part 2 — behavioural: it actually runs with no session ───────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */

type UpsertArgs = { where: any; create: any; update: any };

/** In-memory fake covering every query regenerateSpaceSnapshot makes. */
function makeFake(accounts: Array<{ id: string; type: string; balance: number; currency: string }>) {
  const calls: string[] = [];
  let upserted: UpsertArgs | null = null;

  const client = {
    spaceAccountLink: {
      async findMany() {
        calls.push("spaceAccountLink.findMany");
        return accounts.map((a) => ({ financialAccount: a }));
      },
    },
    financialAccount: {
      async findMany() {
        calls.push("financialAccount.findMany");
        return [] as Array<{ id: string }>; // no consent-gated investment accounts
      },
    },
    space: {
      async findUnique() {
        calls.push("space.findUnique");
        return { reportingCurrency: "USD" };
      },
    },
    spaceSnapshot: {
      async upsert(args: UpsertArgs) {
        calls.push("spaceSnapshot.upsert");
        upserted = args;
        return {};
      },
    },
  };

  return { client, calls, get upserted() { return upserted; } };
}

async function partTwoBehavioural(): Promise<void> {
  console.log("\nPart 2 — behavioural: regenerateSpaceSnapshot EXECUTES with no session");

  // Import lazily so Part 1's structural verdict is reported even if this throws.
  const { regenerateSpaceSnapshot } = await import("@/lib/snapshots/regenerate");

  // One of every bucket that contributes to the aggregates.
  //
  // NOTE THE DEBT SIGN. Under V25-SIDE-1 (lib/debt/balance-semantics.ts) the
  // stored liability balance is POSITIVE when money is owed —
  // `amountOwed = Math.max(balance, 0)`. A NEGATIVE debt balance is an
  // OVERPAID card (a credit held with the issuer), which owes nothing and must
  // contribute 0 to `debt`. Pinned as its own case below.
  const fake = makeFake([
    { id: "fa-check", type: "checking",   balance: 1000, currency: "USD" },
    { id: "fa-save",  type: "savings",    balance: 500,  currency: "USD" },
    { id: "fa-inv",   type: "investment", balance: 2000, currency: "USD" },
    { id: "fa-card",  type: "debt",       balance: 250,  currency: "USD" },
  ]);

  // THE CENTRAL ASSERTION: this call would have thrown
  // "Not authenticated — no active session" before PS-1. There is no session,
  // no cookie, no request scope anywhere in this process.
  let threw: unknown = null;
  try {
    await regenerateSpaceSnapshot("space-1", new Date(Date.UTC(2026, 0, 15)), fake.client as never);
  } catch (e) {
    threw = e;
  }

  check(
    "completes with NO session available (the PS-1 regression signal)",
    threw === null,
    threw instanceof Error ? threw.message : undefined,
  );
  check(
    "specifically: does not throw 'Not authenticated'",
    !(threw instanceof Error && threw.message.includes("Not authenticated")),
  );

  check("read the space's ACTIVE account links", fake.calls.includes("spaceAccountLink.findMany"));
  check("wrote today's snapshot row",            fake.calls.includes("spaceSnapshot.upsert"));

  // Every query went through the injected client — nothing silently reached for
  // module-level `db` (the recordSyncIssue mistake this repo has already made).
  check("all four queries used the injected client", fake.calls.length === 4, `saw: ${fake.calls.join(", ")}`);

  const up = fake.upserted as UpsertArgs | null;
  if (!up) {
    check("snapshot payload available for assertions", false);
    return;
  }

  // Aggregates: assets 1000 + 500 + 2000 = 3500; debt 250; netWorth 3250.
  check("cash aggregated",        up.create.cash === 1000,        `got ${up.create.cash}`);
  check("savings aggregated",     up.create.savings === 500,      `got ${up.create.savings}`);
  check("investments aggregated", up.create.stocks === 2000,      `got ${up.create.stocks}`);
  check("debt aggregated as a positive magnitude", up.create.debt === 250, `got ${up.create.debt}`);
  check("totalAssets = 3500",     up.create.totalAssets === 3500, `got ${up.create.totalAssets}`);
  check("netWorth = 3250",        up.create.netWorth === 3250,    `got ${up.create.netWorth}`);
  check("netLiquid = 1250",       up.create.netLiquid === 1250,   `got ${up.create.netLiquid}`);
  check("reportingCurrency stamped from the Space", up.create.reportingCurrency === "USD");
  check("upsert keyed on (spaceId, date)", up.where?.spaceId_date?.spaceId === "space-1");

  // V25-SIDE-1 regression pin: an OVERPAID card (negative liability balance)
  // owes nothing, so it must contribute 0 debt — not 250 via Math.abs. Kept
  // here because the snapshot writer is a net-worth authority and this is the
  // sign convention most likely to be "helpfully" reintroduced wrongly.
  const overpaid = makeFake([
    { id: "fa-check", type: "checking", balance: 1000, currency: "USD" },
    { id: "fa-card",  type: "debt",     balance: -250, currency: "USD" },
  ]);
  await regenerateSpaceSnapshot("space-2", new Date(Date.UTC(2026, 0, 15)), overpaid.client as never);
  const op = overpaid.upserted as UpsertArgs | null;
  check("overpaid card contributes 0 debt",  op?.create.debt === 0,     `got ${op?.create.debt}`);
  check("overpaid card is not an asset",     op?.create.netWorth === 1000, `got ${op?.create.netWorth}`);
}

// ── Run ───────────────────────────────────────────────────────────────────────

// Async IIFE — the test runner transforms to CJS, where top-level await is
// unavailable.
void (async () => {
  console.log("PS-1 — background snapshot authority");
  partOneStructural();
  await partTwoBehavioural();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll background-authority checks passed.");
})();
