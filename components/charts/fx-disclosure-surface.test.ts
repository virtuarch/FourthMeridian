/**
 * components/charts/fx-disclosure-surface.test.ts — V25-CLOSE-3 Part 1
 *
 * INVARIANT: the Net Worth history surface cannot render an FX-UNAVAILABLE value
 * without the unmistakable disclosure. This is the "missing FX cannot render
 * without disclosure" regression guard, at the surface where a single headline
 * value ($1,000,000 that is really ¥1,000,000) would otherwise read as authoritative.
 *
 *     npx tsx components/charts/fx-disclosure-surface.test.ts
 *
 * Source-scan (the file pulls React/chart deps and cannot import under bare tsx).
 * It asserts the surface consults the finer signal (fxDisclosureOf / the
 * "unavailable" branch) AND routes it through FxUnavailableNote — so neither the
 * classification nor the disclosure can be silently dropped.
 */

import { readFileSync } from "fs";
import { join } from "path";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}

const SURFACE = "components/charts/NetWorthChartModal.tsx";
const code = stripComments(read(SURFACE));

check(
  `${SURFACE} classifies FX disclosure finely (uses fxDisclosureOf)`,
  code.includes("fxDisclosureOf"),
  "the surface must distinguish 'unavailable' from 'estimated', not fold both into one boolean",
);

check(
  `${SURFACE} derives an 'unavailable' signal`,
  /unavailable/.test(code) && /conversionUnavailable/.test(code),
  "the surface must track whether any value was an unconverted native pass-through",
);

check(
  `${SURFACE} imports the unmistakable disclosure component`,
  code.includes("FxUnavailableNote"),
  "importing @/components/ui/FxUnavailableNote",
);

check(
  `${SURFACE} RENDERS FxUnavailableNote (disclosure cannot be dropped)`,
  /<FxUnavailableNote\b/.test(code),
  "the unavailable branch must render the note, not merely compute the flag",
);

// The unavailable branch must gate on the unavailable signal — guards against a
// refactor that renders the note unconditionally (which would read as noise) or
// wires it to the wrong (softer) flag.
check(
  `${SURFACE} gates the note on the unavailable signal`,
  /conversionUnavailable\s*\?[\s\S]{0,80}FxUnavailableNote/.test(read(SURFACE)),
  "FxUnavailableNote must render when conversionUnavailable is true",
);

// The disclosure component itself must carry copy that names the failure, not a
// glyph — the whole point of the slice.
{
  const note = read("components/ui/FxUnavailableNote.tsx");
  check(
    "FxUnavailableNote copy names the FX failure explicitly (not just a symbol)",
    /unavailable/i.test(note) && /native/i.test(note),
    "the note must say the rate is unavailable and the amount is native",
  );
}

console.log(`\nfx-disclosure-surface: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
