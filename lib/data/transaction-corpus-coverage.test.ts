/**
 * lib/data/transaction-corpus-coverage.test.ts
 *
 * THE INFORMATION-CEILING DEFECT, PINNED.
 *
 * `queryTransactions` answers "what is in this window". A window with nothing in
 * it and a record with nothing in it produce the same empty page, and a consumer
 * that cannot tell them apart will state the second having established only the
 * first. The 2×2 causal-evidence experiment (bb2f6ec) measured that directly: 28
 * of 28 searches were windowed, every window verified genuinely empty, the SAME
 * search unwindowed returned the evidence, and 11 of 18 negative answers escalated
 * a windowed miss into an absence claim.
 *
 * `transactionCoverage` is the fix, and it is pure so its semantics can be proved
 * without a database. The DB half — where the bounds COME from — is pinned by
 * source-scan in transaction-query.test.ts and exercised live by
 * scripts/ai-baseline/transaction-corpus.check.ts.
 *
 *   npx tsx lib/data/transaction-corpus-coverage.test.ts
 */

import { readFileSync } from "node:fs";

import { transactionCoverage, type TransactionCorpusBounds } from "@/lib/data/transaction-query-core";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

/** The real Space's span at the time of the experiment. */
const CORPUS: TransactionCorpusBounds = { from: "2024-07-18", to: "2026-09-07", unavailableReason: null };

console.log("1. AN UNWINDOWED RESULT REPORTS THE FULL AVAILABLE SPAN");
{
  const c = transactionCoverage({ corpus: CORPUS, searchedFrom: null, searchedTo: "2026-09-08" });
  check("both ends reported", c.transactionsAvailableFrom === "2024-07-18"
    && c.transactionsAvailableTo === "2026-09-07");
  check("no `from` + a `to` past the end ⇒ the window covers the record",
    c.windowCoversAvailableRecord === true);
  check("nothing to qualify ⇒ no note", c.note === undefined);
}

console.log("\n2. A WINDOWED RESULT REPORTS WINDOW AND SPAN INDEPENDENTLY");
{
  // Exactly the window cells A and B chose in all 20 of their calls.
  const c = transactionCoverage({ corpus: CORPUS, searchedFrom: "2026-06-10", searchedTo: "2026-09-08" });
  check("the span is the record's, NOT the window's",
    c.transactionsAvailableFrom === "2024-07-18" && c.transactionsAvailableTo === "2026-09-07");
  check("the span does not move when the window does",
    transactionCoverage({ corpus: CORPUS, searchedFrom: "2026-01-01", searchedTo: "2026-01-31" })
      .transactionsAvailableFrom === "2024-07-18");
  check("a 90-day window of a 26-month record is NOT complete coverage",
    c.windowCoversAvailableRecord === false);
  check("the note names both the window searched and the record available",
    (c.note ?? "").includes("2026-06-10..2026-09-08") && (c.note ?? "").includes("2024-07-18"));
}

console.log("\n3. AN EMPTY WINDOWED RESULT STILL REPORTS THE BROADER SPAN");
{
  // Coverage is computed from window ∩ corpus and never sees a row, so an empty
  // page and a full page produce identical metadata — which is the whole point.
  const c = transactionCoverage({ corpus: CORPUS, searchedFrom: "2026-06-10", searchedTo: "2026-09-08" });
  check("span survives a zero-row window", c.transactionsAvailableFrom === "2024-07-18");
  check("the miss is explicitly scoped to the window",
    (c.note ?? "").includes("this window only, not the whole available record"));
}

console.log("\n4. `rankingIsComplete` DOES NOT IMPLY CORPUS COMPLETENESS");
{
  // The tool emits both. They answer different questions and must never be fused:
  // a complete ranking of 90 days is still a ranking of 90 days.
  const c = transactionCoverage({ corpus: CORPUS, searchedFrom: "2026-06-10", searchedTo: "2026-09-08" });
  // ⚠️ COMMENTS STRIPPED FIRST. This read the raw file, and a comment that
  // DESCRIBES the separation ("`windowCoversAvailableRecord: false` AND an
  // incomplete page") tripped the very assertion that forbids deriving one from
  // the other. The claim is about code, so scan code.
  const src = readFileSync("lib/ai/conversation/tools.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  check("a complete ranking coexists with incomplete coverage", c.windowCoversAvailableRecord === false);
  check("`rankingIsComplete` is still `complete` — the searched-population fact, unchanged",
    /rankingIsComplete:\s*complete,/.test(src));
  check("coverage is not derived from `complete` anywhere",
    !/windowCoversAvailableRecord[^\n]*complete/.test(src));
}

console.log("\n5. A WINDOW WHOLLY INSIDE THE RECORD REMAINS VISIBLY PARTIAL");
{
  for (const [from, to] of [["2026-01-01", "2026-01-31"], ["2025-12-15", "2026-02-15"],
                            ["2024-07-19", "2026-09-07"], ["2024-07-18", "2026-09-06"]]) {
    const c = transactionCoverage({ corpus: CORPUS, searchedFrom: from, searchedTo: to });
    check(`${from}..${to} is partial and says so`,
      c.windowCoversAvailableRecord === false && typeof c.note === "string");
  }
}

console.log("\n6. A WINDOW COVERING THE RECORD IS RECOGNIZABLE FROM THE RESULT");
{
  for (const [from, to] of [["2024-07-18", "2026-09-07"], ["2020-01-01", "2030-01-01"]]) {
    const c = transactionCoverage({ corpus: CORPUS, searchedFrom: from, searchedTo: to });
    check(`${from}..${to} covers the record, with no note to qualify`,
      c.windowCoversAvailableRecord === true && c.note === undefined);
  }
  check("the boundary is inclusive on both ends",
    transactionCoverage({ corpus: CORPUS, searchedFrom: "2024-07-18", searchedTo: "2026-09-07" })
      .windowCoversAvailableRecord === true);
}

console.log("\n7. FILTERS DO NOT SHRINK THE SPAN TO THE MATCHING ROWS");
{
  // `transactionCoverage` is structurally incapable of seeing rows, text, flow or
  // category — its whole input is the window and the corpus. A 'coinbase' search
  // that matches nothing reports the same span as one that matches everything,
  // because otherwise the metadata would shrink to the miss it exists to qualify.
  const src = readFileSync("lib/data/transaction-query-core.ts", "utf8");
  const decl = src.slice(src.indexOf("export function transactionCoverage"));
  const body = decl.slice(0, decl.indexOf("\n}\n"));
  // Strip the note's prose — a template literal that TALKS about rows is not a
  // function that READS them, and the distinction is the assertion.
  const executable = body.replace(/`[^`]*`|'[^']*'|"[^"]*"/g, "''");
  check("takes exactly one argument object", transactionCoverage.length === 1);
  check("its signature admits only corpus + searchedFrom + searchedTo",
    /corpus: TransactionCorpusBounds;\s*\n[^}]*searchedFrom: string \| null;\s*\n[^}]*searchedTo: string;/.test(body));
  for (const forbidden of ["rows", "text", "flowTypes", "category", "shown", "amount", "population"]) {
    check(`never reads \`${forbidden}\``, !new RegExp(`\\b${forbidden}\\b`).test(executable));
  }
  // The identical-metadata property, stated as behaviour rather than as source:
  // there is no input by which a filter could reach this function at all.
  const matched = transactionCoverage({ corpus: CORPUS, searchedFrom: "2026-06-10", searchedTo: "2026-09-08" });
  const missed  = transactionCoverage({ corpus: CORPUS, searchedFrom: "2026-06-10", searchedTo: "2026-09-08" });
  check("a matching search and a missing search over the same window are metadata-identical",
    JSON.stringify(matched) === JSON.stringify(missed));
}

console.log("\n8. UNAVAILABLE BOUNDS ARE REPRESENTED, NEVER FABRICATED");
{
  const none: TransactionCorpusBounds = { from: null, to: null,
    unavailableReason: "no dated transactions are available on or before 2020-01-01" };
  const c = transactionCoverage({ corpus: none, searchedFrom: "2019-01-01", searchedTo: "2020-01-01" });
  check("both ends stay null", c.transactionsAvailableFrom === null && c.transactionsAvailableTo === null);
  check("the requested window is NOT substituted for the missing span",
    c.transactionsAvailableFrom !== "2019-01-01" && c.transactionsAvailableTo !== "2020-01-01"
    && c.transactionsAvailableFrom === null && c.transactionsAvailableTo === null);
  check("the reason is carried", c.unavailableReason?.startsWith("no dated transactions") === true);
  check("unknown bounds are not claimed as coverage", c.windowCoversAvailableRecord === false);
  check("no note is invented over a span that is not known", c.note === undefined);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
