/**
 * lib/ai/bounded-selection.test.ts  (CF-1)
 *
 * A BOUNDED LIST MUST CARRY ITS DENOMINATOR.
 *
 *     npx tsx lib/ai/bounded-selection.test.ts
 *
 * CF-0 reproduced this end to end on the real Space:
 *
 *     174 distinct spend merchants in the window
 *      → 25   MERCHANT_ROLLUP_LIMIT               (cap hit)
 *      → 8    context-serializer slice(0, 8)
 *      → 164  withheld, with no disclosure anywhere
 *
 * The prompt then instructs the model to answer "who did I spend the most with /
 * top merchants" from those rows, and it does — "Your top merchants based on
 * spending in the analysis window are:", unqualified. Every figure in that reply
 * is correct. The superlative is not, and nothing in the context could have told
 * the model otherwise.
 *
 * The assessment guard cannot see this: merchant rankings are CONTEXT-ONLY, no
 * dimension grades them, so there is no refused verdict to contradict. This is a
 * framing failure on ungraded evidence, which is exactly the class A5 does not
 * cover.
 *
 * ── What is pinned ──────────────────────────────────────────────────────────
 * That the DENOMINATOR SURVIVES SELECTION. The producer owns the eligible
 * population and must hand it on; the serializer must never infer a total from
 * an array it has already truncated, because that array's length is the one
 * number guaranteed to be wrong.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { boundedSelection, isComplete, describeBounds } from "./bounded-selection";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const read = (...s: string[]) => readFileSync(join(process.cwd(), ...s), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

// ══ THE CONTRACT ══════════════════════════════════════════════════════════════
{
  const all = [1, 2, 3, 4, 5, 6, 7];
  const capped = boundedSelection(all, 3);
  check("a hit cap reports what it returned AND what existed",
    capped.items.length === 3 && capped.totalCount === 7 && capped.limit === 3);
  check("…and is NOT complete", !isComplete(capped));

  const whole = boundedSelection(all, 10);
  check("an unhit cap returns everything", whole.items.length === 7 && whole.totalCount === 7);
  check("…and IS complete", isComplete(whole));
  check("an exactly-filled cap is complete — 7 of 7 is not a truncation",
    isComplete(boundedSelection(all, 7)),
    "off-by-one here would hedge every list that happens to fit");
  check("an empty population is complete", isComplete(boundedSelection([], 5)));

  // The property the whole slice exists for.
  check("completeness is DERIVED from counts, never stored separately",
    !/truncated:|complete:\s*(true|false)/.test(code(read("lib", "ai", "bounded-selection.ts"))),
    "a stored flag can contradict the counts beside it; a derived one cannot");
}

// ══ THE DENOMINATOR CANNOT COLLAPSE TO THE TRUNCATED ARRAY ════════════════════
{
  const capped = boundedSelection([1, 2, 3, 4, 5, 6, 7], 3);
  check("totalCount is NOT items.length after truncation",
    capped.totalCount !== capped.items.length && capped.totalCount === 7,
    "this is the exact collapse that produced the CF-0 failure");

  // Composition: a second selector downstream must not become the denominator.
  const rendered = capped.items.slice(0, 2);
  check("a SECOND narrowing keeps the ORIGINAL eligible population",
    describeBounds(rendered.length, capped.totalCount) === "2 of 7",
    "174 → 25 → 8 must disclose 8 of 174, never 8 of 25");
}

// ══ HOW IT READS ══════════════════════════════════════════════════════════════
{
  check("a complete list is stated as complete, not as a ratio",
    describeBounds(7, 7) === "all 7");
  check("a truncated list states both numbers",
    describeBounds(8, 174) === "8 of 174");
  check("…and never invites a superlative it cannot support",
    !/top|largest|most/i.test(describeBounds(8, 174)));
}

// ══ THE PRODUCERS HAND ON THEIR DENOMINATOR ═══════════════════════════════════
//
// Source-level, because this is precisely where CF-0 found the number being
// discarded: buildMerchantRollup built the full map, sorted it, sliced it, and
// returned only the slice.
{
  const txns = code(read("lib", "ai", "assemblers", "transactions.ts"));
  for (const fn of ["buildMerchantRollup", "buildIncomeSourceRollup"]) {
    const body = txns.slice(txns.indexOf(`export function ${fn}`));
    const end  = body.indexOf("\nexport ", 10);
    const src  = end > 0 ? body.slice(0, end) : body;
    check(`${fn} returns a BoundedSelection`, /BoundedSelection</.test(src),
      "the eligible population is known here and nowhere later");
    check(`${fn} does not return a bare sliced array`,
      !/\.slice\(0, limit\);\s*$/m.test(src));
  }
  const holdings = code(read("lib", "ai", "assemblers", "holdings-core.ts"));
  check("holdings hands on its position denominator",
    /boundedSelection\(/.test(holdings));
}

// ══ THE SERIALIZER RENDERS THE DENOMINATOR IT WAS GIVEN ═══════════════════════
{
  const ser = code(read("lib", "ai", "prompts", "context-serializer.ts"));
  check("the merchant block renders bounds",
    /describeBounds\(/.test(ser));
  check("…and never derives a total from the array it just truncated",
    !/of \$\{[a-z]+\.(merchants|incomeSources)\.length\}/i.test(ser),
    "the truncated array's length is the one number guaranteed to be wrong");

  // The instruction that made this dangerous must no longer promise exhaustiveness.
  check("the model is no longer told to answer superlatives from a bounded list "
      + "without qualification",
    /describeBounds|of \$\{/.test(ser.slice(ser.indexOf("MERCHANT SUMMARY"), ser.indexOf("MERCHANT SUMMARY") + 2500)));
}

console.log(`\nbounded-selection: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
