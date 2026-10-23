/**
 * lib/money/round.test.ts   (FIN-013 — one rounding rule, one epsilon)
 *
 *     npx tsx lib/money/round.test.ts
 *
 * Pins the arithmetic, and pins that the money-authority paths (lib/transactions,
 * lib/forecast, lib/money, lib/liquidity, lib/ai/forecast, lib/ai/measures/baseline.ts)
 * hold no private `round2` / `MONEY_EPSILON` copy. The copies elsewhere are a
 * reported follow-up, not this gate's claim.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { round2, MONEY_EPSILON } from "./round";

let failures = 0, passed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed++;
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

check("round2 rounds to cents", round2(1234.5678) === 1234.57 && round2(-1234.5678) === -1234.57);
check("round2 clears f64 residue: 0.1 + 0.2 ⇒ 0.3", round2(0.1 + 0.2) === 0.3);
check("round2 is identical to the copies it replaced", [5286.645, 0.005, -0.005, 1e-14, 99.995]
  .every((n) => round2(n) === Math.round(n * 100) / 100));
check("MONEY_EPSILON is half a cent", MONEY_EPSILON === 0.005);
check("a 2.8e-14 residue compares as zero, a cent does not", Math.abs(2.8e-14) < MONEY_EPSILON && !(0.01 < MONEY_EPSILON));

const ROOT = process.cwd();
const OWNED = ["lib/transactions", "lib/forecast", "lib/money", "lib/liquidity", "lib/ai/forecast", "lib/ai/measures/baseline.ts"];
const files: string[] = [];
const walk = (p: string) => {
  const abs = path.join(ROOT, p);
  if (statSync(abs).isDirectory()) { for (const e of readdirSync(abs)) walk(path.join(p, e)); return; }
  if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith("lib/money/round.ts")) files.push(p);
};
OWNED.forEach(walk);
const offenders = files.filter((f) => {
  const src = readFileSync(path.join(ROOT, f), "utf8");
  return /(const|function)\s+(round2|r2)\b\s*=?\s*\(?/.test(src) && /Math\.round\([^)]*\* 100\) \/ 100/.test(src) || /MONEY_EPSILON\s*=/.test(src);
});
check(`no private round2 / MONEY_EPSILON in the money-authority paths (${files.length} files scanned)`,
  offenders.length === 0, offenders.join(", "));

console.log(failures === 0 ? `\nFIN-013 money rounding: ${passed} checks passed.` : `\n${failures} FAILED (${passed} passed)`);
process.exit(failures === 0 ? 0 : 1);
