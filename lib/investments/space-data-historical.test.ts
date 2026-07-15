/**
 * lib/investments/space-data-historical.test.ts  (PCS-1B)
 *
 * Pins the PCS-1B invariant for the Investments SpaceData contract's HISTORICAL
 * slice:  npx tsx lib/investments/space-data-historical.test.ts
 *
 *   Current    → getCurrentPositions()        (PCS-1A, the current seam)
 *   Historical → A10 getInvestmentsTimeMachine (this slice)
 *
 * Two layers of proof:
 *   • TYPE-LEVEL (caught by `tsc --noEmit`, the project-wide gate) — the historical
 *     contract IS the A10 result exactly, and reuses NONE of the current-position
 *     DTOs. Compile-time equality asserts, erased at runtime.
 *   • SOURCE-SCAN (caught by this tsx run) — the historical loader is the A10
 *     binding, the route reads through the contract module, the current view is
 *     never back-filled from the Time Machine, and the current seam is never used
 *     as a historical portal (its `asOf` clock is only ever today).
 *
 * Pure: every import is `import type` (erased) — no DB, no prisma generate.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { HistoricalPortfolio, InvestmentsSpaceData } from "./space-data-core";
import type { InvestmentsTimeMachineResult } from "./investments-time-machine-core";
import type { LoadInvestmentsHistoryArgs } from "./space-data";
import type { GetInvestmentsTimeMachineArgs } from "./investments-time-machine";

// ── TYPE-LEVEL invariant (compile-time; tsc is the gate) ─────────────────────
// Exact structural equality — a diverging edit to either side fails `tsc`.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

// Historical slice IS the A10 result, VERBATIM (not a reshaped/derived copy).
type _HistoricalIsA10 = Expect<Equal<HistoricalPortfolio, InvestmentsTimeMachineResult>>;
// The umbrella contract's `historical` slot carries exactly that A10 result.
type _SlotIsA10 = Expect<Equal<NonNullable<InvestmentsSpaceData["historical"]>, InvestmentsTimeMachineResult>>;
// The historical loader's args ARE the A10 Time Machine's args (no bespoke shape).
type _ArgsAreA10 = Expect<Equal<LoadInvestmentsHistoryArgs, GetInvestmentsTimeMachineArgs>>;

// ── SOURCE-SCAN invariant (runtime; this tsx run is the gate) ────────────────
let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Every non-test `.ts`/`.tsx` under a root (source-scan corpus). */
function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, e.name);
    if (e.isDirectory()) out.push(...collectSources(rel));
    else if ((e.name.endsWith(".ts") || e.name.endsWith(".tsx")) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

function main(): void {
  const spaceData = read("lib/investments/space-data.ts");
  const spaceDataCore = read("lib/investments/space-data-core.ts");
  const route = read("app/api/spaces/[id]/investments/time-machine/route.ts");

  console.log("1. Historical loader IS the A10 binding, under its contract name");
  check("space-data.ts re-exports getInvestmentsTimeMachine as loadInvestmentsHistory",
    /getInvestmentsTimeMachine as loadInvestmentsHistory/.test(spaceData));
  check("loadInvestmentsHistory is sourced from the A10 Time Machine module",
    /from ["']\.\/investments-time-machine["']/.test(spaceData));

  console.log("2. Historical slice = A10 result; NO current-position DTO reuse");
  check("HistoricalPortfolio is defined as InvestmentsTimeMachineResult (A10)",
    /HistoricalPortfolio\s*=\s*InvestmentsTimeMachineResult/.test(spaceDataCore));
  check("the `historical` field is typed HistoricalPortfolio (never CurrentPortfolio)",
    /historical\?:\s*HistoricalPortfolio/.test(spaceDataCore) &&
    !/historical\??:\s*(CurrentPortfolio|CurrentPositionRow|CurrentPositions)/.test(spaceDataCore));

  console.log("3. Current view is NEVER back-filled from the Time Machine");
  // The pure current assembler builds only the current slice — it must not read or
  // emit the historical result. Isolate its body and assert it is A10-free.
  const asmIdx = spaceDataCore.indexOf("export function assembleCurrentPortfolio");
  // Bound to JUST this function's body — up to the next top-level export — so the
  // sibling composition assembler (assembleInvestmentsSpaceData, which DOES read
  // `historical` by design) is not swallowed by a slice-to-EOF.
  const afterAsm = asmIdx >= 0 ? spaceDataCore.slice(asmIdx + 1) : "";
  // End at this function's own top-level closing brace (`\n}`) — excludes the next
  // function AND its doc comment, so a sibling that legitimately names `historical`
  // in its prose can't trip this isolation.
  const closeIdx = afterAsm.indexOf("\n}");
  const asmBody = closeIdx >= 0 ? afterAsm.slice(0, closeIdx) : afterAsm;
  check("assembleCurrentPortfolio does not touch the Time Machine result",
    asmBody.length > 0 &&
    !/InvestmentsTimeMachineResult|HistoricalPortfolio|getInvestmentsTimeMachine|\bhistorical\b/.test(asmBody));

  console.log("4. The historical route reads through the SpaceData contract module");
  check("route imports loadInvestmentsHistory from @/lib/investments/space-data",
    /import\s*\{\s*loadInvestmentsHistory\s*\}\s*from\s*["']@\/lib\/investments\/space-data["']/.test(route));
  check("route no longer imports getInvestmentsTimeMachine directly (comment mentions ok)",
    !/import[^;]*getInvestmentsTimeMachine/.test(route));
  check("route awaits loadInvestmentsHistory (byte-identical JSON to A10)",
    /await loadInvestmentsHistory\(\{\s*spaceId,\s*asOf,\s*compareTo/.test(route));

  console.log("5. The current seam is NEVER a historical portal (asOf = today only)");
  // Any production (non-test) caller that passes an `asOf` to getCurrentPositions
  // must bind it to todayIso() — the seam's injected clock, not a past date. A
  // genuine as-of read is an A10 caller. (The one caller today is the AI holdings
  // assembler; this catches a future regression.)
  const sources = [...collectSources("lib"), ...collectSources("app")];
  const offenders: string[] = [];
  // A genuine call passing an inline asOf option: `getCurrentPositions(<arg>, { …asOf… })`.
  // `[^)]`/`[^}]` keep the match inside ONE call/object, so comment mentions
  // (`getCurrentPositions()`) and the CurrentPortfolio.asOf field never match.
  const INLINE_ASOF_CALL = /getCurrentPositions\s*\([^)]*,\s*\{[^}]*\basOf\b[^}]*\}/;
  for (const rel of sources) {
    const src = read(rel);
    if (INLINE_ASOF_CALL.test(src) && !/todayIso\s*\(/.test(src)) {
      offenders.push(relative(ROOT, join(ROOT, rel)));
    }
  }
  check("no non-today asOf is passed to getCurrentPositions",
    offenders.length === 0, offenders.join(", "));

  console.log("6. The historical UI stays on A10 (current seam not smuggled in)");
  const widgets = collectSources("components/space/widgets/investments");
  const leaks = widgets.filter((rel) => /from ["'][^"']*current-positions["']|getCurrentPositions/.test(read(rel)));
  check("investments widgets read historical via A10 only (no current-seam import)",
    leaks.length === 0, leaks.join(", "));

  // Reference the type-level asserts so they are unmistakably load-bearing.
  void (null as unknown as [_HistoricalIsA10, _SlotIsA10, _ArgsAreA10]);

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll space-data-historical (PCS-1B invariant) checks passed.");
}

main();
