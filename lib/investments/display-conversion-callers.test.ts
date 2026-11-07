/**
 * lib/investments/display-conversion-callers.test.ts  (S2 sweep — PB-11b caller pin)
 *
 * `convertInvestmentsSpaceData` returns NULL when a display rate is missing
 * (PB-11b — never a relabelled contract). Every caller must turn that null into
 * `InvestmentsDisplayUnavailable` rather than fall back to the unconverted
 * figures. This is a CLOSED list of the callers that were reviewed for it: a new
 * caller fails here until it is reviewed and added.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/investments/display-conversion-callers.test.ts
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DEFINITION = "lib/investments/display-conversion.ts";

/** Reviewed callers, each with the proof that its null renders InvestmentsDisplayUnavailable. */
const REVIEWED_CALLERS: Record<string, (src: string) => boolean> = {
  "components/space/widgets/investments/InvestmentsWorkspace.tsx": (src) =>
    // null ⇒ the unavailable model…
    /const displayUnavailable = raw && ctx && data === null\s*\?\s*investmentsDisplayUnavailable\(/.test(src)
    // …which is rendered, before any figure.
    && /return <InvestmentsDisplayUnavailable unavailable=\{displayUnavailable\}/.test(src)
    && src.indexOf("return <InvestmentsDisplayUnavailable") < src.indexOf("if (!data || !primary)"),
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(path.relative(ROOT, p));
  }
  return out;
}
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const files = ["app", "components", "lib", "jobs", "scripts"].flatMap((d) => walk(path.join(ROOT, d)));
const callers = files
  .filter((f) => f !== DEFINITION)
  .filter((f) => /\bconvertInvestmentsSpaceData\b/.test(strip(readFileSync(path.join(ROOT, f), "utf8"))))
  .sort();

assert.deepEqual(callers, Object.keys(REVIEWED_CALLERS).sort(),
  `convertInvestmentsSpaceData has an unreviewed caller (or a reviewed one left). A caller must render `
  + `InvestmentsDisplayUnavailable when it returns null; review it, then add it to REVIEWED_CALLERS. Found: ${callers.join(", ")}`);
for (const f of callers) {
  assert.ok(REVIEWED_CALLERS[f](readFileSync(path.join(ROOT, f), "utf8")), `${f}: null must render InvestmentsDisplayUnavailable before any figure`);
}
// The definition still declares the null it is pinned for.
assert.ok(/export function convertInvestmentsSpaceData\([\s\S]*?\):\s*InvestmentsSpaceData \| null/.test(readFileSync(path.join(ROOT, DEFINITION), "utf8")),
  "convertInvestmentsSpaceData still returns InvestmentsSpaceData | null");

console.log(`  ✓ convertInvestmentsSpaceData callers = the reviewed list (${callers.length}); each renders InvestmentsDisplayUnavailable on null`);
console.log("display-conversion-callers: all checks passed");
