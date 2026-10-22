/**
 * components/platform/widgets/plaid-usage-guard.test.ts  (UI-018)
 *
 * OpsPlaidUsageWidget dereferenced `data.cycles[0]` unguarded; an empty cycle
 * list crashed the render. Pinned: the current cycle is optional-chained and
 * every read of it is behind a presence check that renders an honest
 * Unavailable instead.
 *
 *   npx tsx components/platform/widgets/plaid-usage-guard.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const src = readFileSync(path.join(process.cwd(), "components/platform/widgets/OpsPlaidUsageWidget.tsx"), "utf8")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

check("no unguarded `data.cycles[0]`", !/data\.cycles\[0\]/.test(src));
check("current cycle is optional", src.includes("const current = data.cycles?.[0];"));
const reads = [...src.matchAll(/current\.during/g)].length;
const guarded = [...src.matchAll(/current \? `\$\{current\.during|!current \? <Unavailable[^]*?usd\(current\.during\.usd\)/g)].length;
check(`every current.during read is behind a presence check (${reads} reads)`, reads === 3 && guarded === 2);
check("absent cycle renders an honest Unavailable", (src.match(/<Unavailable reason="no billing cycle reported" \/>/g) ?? []).length === 2);
check("cycle list map tolerates an absent list", src.includes("(data.cycles ?? []).map("));

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll UI-018 checks passed.");
