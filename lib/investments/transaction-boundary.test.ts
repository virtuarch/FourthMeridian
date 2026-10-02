/**
 * lib/investments/transaction-boundary.test.ts  (RLS-C-S8)
 *
 * NO DATABASE TRANSACTION IN THE INVESTMENTS AND IMPORTS SPINE SPANS A PROVIDER
 * CALL.
 *
 * ── THE PROPERTY, AND WHY IT IS NOT A STYLE RULE ─────────────────────────────
 * `withTenantDb` is a SECURITY BOUNDARY, not a request-lifetime container. The
 * tenant identity the policies read is bound with `SET LOCAL`, so it can only
 * live inside a transaction — which means every tenant-scoped read and write is
 * inside one, which makes it tempting to stretch one around a whole operation.
 *
 * A transaction held across provider HTTP pins a pooled connection, and under RLS
 * a bound identity with it, for the duration of somebody else's latency. Plaid's
 * `investmentsTransactionsGet` here paginates 500 rows at a time with retries: a
 * slow item would hold one connection for the length of the whole fetch, and the
 * Supabase transaction pooler hands connections back only at COMMIT. Idle-in-
 * transaction is how a pool dies, and it dies under exactly the load that caused
 * it.
 *
 * Today nothing does this: the ingest's fetch loop completes IN FULL before its
 * persistence transaction opens. That is a property worth keeping and easy to
 * lose, because the natural way to "fix" a slow import is to wrap more of it.
 *
 * ── WHY A LEXICAL SCAN, AND HOW IT AVOIDS PASSING VACUOUSLY ──────────────────
 * There is no runtime assertion available: a fake client cannot tell you whether
 * a real `fetch` would have happened inside a real transaction. So the enclosure
 * is read off the source — comments stripped, callback bodies delimited by
 * brace/paren matching rather than by a regex that cannot count.
 *
 * A scan can be green because it found nothing, and a previous slice in this
 * programme shipped exactly that bug. So this file asserts its own denominators:
 * the callbacks it examined, and the provider references it found OUTSIDE them,
 * must both be non-zero. If a refactor renames the transaction openers or moves
 * the Plaid call, the test fails for THAT reason rather than quietly approving.
 *
 *   npx tsx lib/investments/transaction-boundary.test.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = join(__dirname, "..", "..");

/** Strip block and line comments, preserving length-independent structure. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * The text between the parentheses of `name(` … `)`, for every occurrence.
 * Counts parentheses, braces and brackets, and skips the contents of quotes and
 * template literals, so a `)` inside a string cannot end a callback early.
 */
function callArguments(src: string, name: string): string[] {
  const out: string[] = [];
  // ⚠️ ESCAPE THE NAME. `$transaction` begins with `$`, which in a regex is
  // end-of-string — an unescaped `\b$transaction\s*\(` matches NOTHING, and the
  // first version of this file reported a clean scan while never looking at a
  // single `$transaction` callback. A mutation (a `fetch` planted inside one)
  // passed. The denominator assertions below exist for the same reason, and they
  // did not catch it either, because the other two openers supplied the count.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundary = /^\w/.test(name) ? "\\b" : "";
  const needle = new RegExp(`${boundary}${escaped}\\s*\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = needle.exec(src)) !== null) {
    let i = m.index + m[0].length;
    let depth = 1;
    let quote: string | null = null;
    const start = i;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
      } else if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      i++;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

/** Anything that leaves the process: provider HTTP, a retry wrapper around it, a model call. */
const NETWORK = [
  /\bplaidClient\b/,
  /\bwithPlaidRetry\s*\(/,
  /\bfetch\s*\(/,
  /@\/lib\/plaid\/client/,
  /\bopenai\b/i,
  /\banthropic\b/i,
];

/** The three ways a transaction boundary is opened in this spine. */
const OPENERS = ["$transaction", "inOneTransaction", "withTenantDb"];

function spineFiles(): string[] {
  const inv = readdirSync(join(ROOT, "lib", "investments"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".fixtures.ts"))
    .map((f) => join("lib", "investments", f));
  return [
    ...inv,
    join("app", "api", "imports", "[id]", "rollback", "route.ts"),
    join("app", "api", "connections", "[id]", "import-history", "route.ts"),
    join("app", "api", "connections", "[id]", "import-accounts", "route.ts"),
    join("lib", "plaid", "sync-investments.ts"),
    join("jobs", "sync-banks.ts"),
  ];
}

function main(): void {
  const files = spineFiles();
  console.log(`scanning ${files.length} spine file(s) for a transaction that encloses a provider call`);

  let callbacksExamined = 0;
  let providerReferencesOutside = 0;
  const offenders: string[] = [];

  for (const rel of files) {
    const src = stripComments(readFileSync(join(ROOT, rel), "utf8"));
    const hasProvider = NETWORK.some((re) => re.test(src));

    for (const opener of OPENERS) {
      for (const body of callArguments(src, opener)) {
        callbacksExamined++;
        for (const re of NETWORK) {
          if (re.test(body)) offenders.push(`${rel}: ${opener}(…) encloses ${re.source}`);
        }
      }
    }

    if (hasProvider) {
      // Count it only if the provider reference is NOT inside an opener — i.e.
      // the file really is one where the hazard could occur and does not.
      const enclosed = OPENERS.flatMap((o) => callArguments(src, o)).join("\n");
      if (NETWORK.some((re) => re.test(src) && !re.test(enclosed))) providerReferencesOutside++;
    }
  }

  // ── The denominators, asserted so a green run cannot mean "found nothing" ──
  check(`the scan found transaction/phase callbacks to examine (${callbacksExamined})`,
    callbacksExamined >= 8, `only ${callbacksExamined}`);
  check(`the scan found provider calls in this spine, OUTSIDE every transaction (${providerReferencesOutside} file(s))`,
    providerReferencesOutside >= 2, `only ${providerReferencesOutside}`);

  check("no transaction, tenant phase or inOneTransaction callback encloses a provider or model call",
    offenders.length === 0, offenders.join("\n      "));

  // ── The specific ordering the ingest depends on ────────────────────────────
  //
  // Narrower than the scan above and stated separately because it is the one the
  // module header promises: the paginated fetch COMPLETES before any persistence
  // boundary opens. Positional, so moving the fetch below the persistence —
  // which the general scan would still pass if the call sat between two
  // transactions — fails here.
  const ingest = stripComments(readFileSync(join(ROOT, "lib", "investments", "investment-event-ingest.ts"), "utf8"));
  const lastProviderCall = ingest.lastIndexOf("plaidClient.");
  const firstBoundary = ingest.indexOf("inOneTransaction(");
  check("the ingest's provider fetch is positioned entirely before its persistence boundary",
    lastProviderCall > 0 && firstBoundary > 0 && lastProviderCall < firstBoundary,
    `provider@${lastProviderCall} boundary@${firstBoundary}`);

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll transaction-boundary checks passed");
}

main();
