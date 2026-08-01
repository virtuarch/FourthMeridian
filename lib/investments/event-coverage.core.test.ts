/**
 * lib/investments/event-coverage.core.test.ts
 *
 * V26-QUANTITY-1E′ fixtures. Standalone tsx script:
 *
 *     npx tsx lib/investments/event-coverage.core.test.ts
 *
 * The property that matters most: no outcome other than COMPLETE may ever
 * license a claim, and a missing record must withhold rather than assume.
 */

import {
  eventStreamCompletenessFor, mergeIntervals, COVERAGE_LICENSING_OUTCOMES,
  type CoverageRecord,
} from "./event-coverage.core";
import { licensedCoverage } from "./quantity-replay.core";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** By default a record CARRIES evidence from its own window start. */
const rec = (from: string, to: string, outcome = "COMPLETE", fetchedCount = 1,
             earliestReturnedISO: string | null = from): CoverageRecord =>
  ({ requestedFromISO: from, requestedToISO: to, outcome, fetchedCount, earliestReturnedISO });
const decide = (records: CoverageRecord[], from = "2026-01-01", to = "2026-12-31") =>
  eventStreamCompletenessFor({ records, requestedFromISO: from, requestedToISO: to });

function main(): void {
  console.log("0. purity");
  {
    const src = readFileSync(join(import.meta.dirname, "event-coverage.core.ts"), "utf8");
    const imports = [...src.matchAll(/^\s*import\s[\s\S]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    check("imports only the 1C contract", imports.length === 1 && imports[0] === "./quantity-replay.core");
    check("no Prisma, database or provider import",
      !/@prisma|lib\/db|lib\/prices|plaid/i.test(imports.join(" ")));
    check("no ambient clock", !/Date\.now\(|new Date\(\s*\)/.test(src));
  }

  console.log("1. absence withholds, it never assumes");
  {
    check("no records at all → UNKNOWN", decide([]).kind === "UNKNOWN");
    check("…and says so, rather than reporting an empty interval",
      /no ingest attempt/.test((decide([]) as { reason: string }).reason));
    for (const o of ["PARTIAL", "FAILED", "DISABLED", "CONSENT_REQUIRED", "NOT_READY"]) {
      const r = decide([rec("2026-01-01", "2026-12-31", o)]);
      check(`${o} licenses nothing → UNKNOWN`, r.kind === "UNKNOWN");
    }
    check("only COMPLETE licenses a claim",
      COVERAGE_LICENSING_OUTCOMES.size === 1 && COVERAGE_LICENSING_OUTCOMES.has("COMPLETE"));
    check("a PARTIAL window's covered prefix is NOT salvaged — the shortfall's location is unknown",
      decide([rec("2026-01-01", "2026-12-31", "PARTIAL")]).kind === "UNKNOWN");
    const mixed = decide([rec("2026-01-01", "2026-12-31", "FAILED"), rec("2026-01-01", "2026-12-31", "DISABLED")]);
    check("several non-licensing attempts still yield UNKNOWN, and count themselves",
      mixed.kind === "UNKNOWN" && /2 recorded attempt/.test((mixed as { reason: string }).reason));
  }

  console.log("2. COMPLETE windows license exactly what they span");
  {
    const full = decide([rec("2026-01-01", "2026-12-31")]);
    check("a window spanning the request → COMPLETE", full.kind === "COMPLETE");
    check("…bounded to the REQUEST, not the record",
      full.kind === "COMPLETE" && full.fromISO === "2026-01-01" && full.toISO === "2026-12-31");

    const wider = decide([rec("2025-01-01", "2027-12-31")]);
    check("a wider window still reports only the requested interval",
      wider.kind === "COMPLETE" && wider.fromISO === "2026-01-01" && wider.toISO === "2026-12-31");

    // V26-QUANTITY-1H reversed this. A reconciled EMPTY window proves the
    // provider was asked, not that it holds history there.
    const zeroFetched = decide([rec("2026-01-01", "2026-12-31", "COMPLETE", 0, null)]);
    check("a reconciled window that returned NOTHING licenses nothing",
      zeroFetched.kind === "UNKNOWN");
    check("…and says why, rather than reading silence as absence of activity",
      /silence|not that it holds history/.test((zeroFetched as { reason: string }).reason));

    const lateEvidence = decide([rec("2026-01-01", "2026-12-31", "COMPLETE", 5, "2026-04-01")]);
    check("a window whose earliest RETURNED row is later licenses only from there",
      lateEvidence.kind === "PARTIAL" && lateEvidence.coveredFromISO === "2026-04-01");
    check("…so a window reaching past the provider's history floor cannot manufacture an opening",
      lateEvidence.kind === "PARTIAL" && lateEvidence.coveredToISO === "2026-12-31");

    const short = decide([rec("2026-01-01", "2026-06-30")]);
    check("a window covering part of the request → PARTIAL", short.kind === "PARTIAL");
    check("…reporting exactly what it covers",
      short.kind === "PARTIAL" && short.coveredFromISO === "2026-01-01" && short.coveredToISO === "2026-06-30");

    const elsewhere = decide([rec("2020-01-01", "2020-12-31")]);
    check("a COMPLETE window that does not overlap the request → UNKNOWN",
      elsewhere.kind === "UNKNOWN");
  }

  console.log("3. rolling windows accumulate into real coverage");
  {
    // The actual production shape: a 24-month window recomputed every sync.
    const rolling = decide([
      rec("2026-01-01", "2026-03-31"), rec("2026-02-01", "2026-06-30"),
      rec("2026-05-01", "2026-09-30"), rec("2026-08-01", "2026-12-31"),
    ]);
    check("overlapping rolling windows merge into full coverage", rolling.kind === "COMPLETE");

    const adjacent = decide([rec("2026-01-01", "2026-03-31"), rec("2026-04-01", "2026-12-31")]);
    check("day-ADJACENT windows merge — no hole is invented between them",
      adjacent.kind === "COMPLETE");

    const holed = decide([rec("2026-01-01", "2026-03-31"), rec("2026-06-01", "2026-12-31")]);
    check("a genuine hole is NOT merged over", holed.kind === "PARTIAL");
    check("…the LARGEST component is reported, under-claiming the other",
      holed.kind === "PARTIAL" && holed.coveredFromISO === "2026-06-01" && holed.coveredToISO === "2026-12-31");
    check("…and the under-claim is stated, not hidden",
      holed.kind === "PARTIAL" && /2 covered component/.test(holed.reason) && /under-claim/.test(holed.reason));

    check("a hole means the head is never licensed as complete",
      licensedCoverage(holed)?.fromISO === "2026-06-01");
  }

  console.log("4. determinism and merging");
  {
    const rs = [rec("2026-05-01", "2026-09-30"), rec("2026-01-01", "2026-03-31"),
                rec("2026-02-01", "2026-06-30"), rec("2026-08-01", "2026-12-31")];
    const a = decide(rs), b = decide([...rs].reverse());
    check("shuffled records → byte-identical result", JSON.stringify(a) === JSON.stringify(b));
    check("repeat invocation → byte-identical", JSON.stringify(decide(rs)) === JSON.stringify(a));

    const merged = mergeIntervals([
      { fromISO: "2026-03-01", toISO: "2026-03-31" }, { fromISO: "2026-01-01", toISO: "2026-02-28" },
      { fromISO: "2026-06-01", toISO: "2026-06-30" },
    ]);
    check("mergeIntervals returns a sorted, disjoint, minimal set",
      merged.length === 2 && merged[0].fromISO === "2026-01-01" && merged[0].toISO === "2026-03-31");
    check("…dropping inverted intervals rather than emitting them",
      mergeIntervals([{ fromISO: "2026-06-01", toISO: "2026-01-01" }]).length === 0);
    check("an inverted REQUEST is refused", decide([rec("2026-01-01", "2026-12-31")], "2026-12-31", "2026-01-01").kind === "UNKNOWN");

    const single = decide([rec("2026-06-15", "2026-06-15")], "2026-06-15", "2026-06-15");
    check("a single-day request covered by a single-day window is COMPLETE",
      single.kind === "COMPLETE");
  }

  console.log("5. the claim is bounded and says so");
  {
    const r = decide([rec("2026-01-01", "2026-12-31")]);
    check("COMPLETE names its source rather than asserting bare truth",
      r.kind === "COMPLETE" && r.source.includes("InvestmentEventCoverage"));
    check("every non-COMPLETE result carries a reason a human can act on",
      [decide([]), decide([rec("2026-01-01", "2026-06-30")]),
       decide([rec("2026-01-01", "2026-12-31", "FAILED")])].every((x) =>
        x.kind === "COMPLETE" || (x as { reason: string }).reason.length > 20));
  }

  console.log(failures === 0 ? "\nAll event-coverage checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
