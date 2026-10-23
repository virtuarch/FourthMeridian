/**
 * lib/investments/quantity-timeline.test.ts
 *
 * V26-QUANTITY-1F — guards on the read authority. Standalone tsx script:
 *
 *     npx tsx lib/investments/quantity-timeline.test.ts
 *
 * The authority itself needs a database, so its behaviour is verified against
 * the real corpus read-only. What is locked here is what no corpus run can
 * prove by passing: that this module cannot write, and cannot invent a window.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const src = readFileSync(join(import.meta.dirname, "quantity-timeline.ts"), "utf8");
// Strip comments before matching: the header discusses writing and inferring at
// length, and a guard fooled by its own documentation guards nothing.
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("1. the read authority cannot write");
{
  for (const op of ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany", "executeRaw"]) {
    check(`no .${op}(`, !new RegExp(`\\.${op}\\s*\\(`).test(code));
  }
  check("no $transaction — a read authority has nothing to make atomic",
    !/\$transaction/.test(code));
  check("no provider import", !/plaid|tiingo|coingecko|fetch\(/i.test(code));
}

console.log("2. the window is the caller's, never inferred");
{
  check("windowFromISO is only ever read from args, never computed",
    !/windowFromISO\s*=\s*(?!args)/.test(code.replace(/const \{[^}]*windowFromISO[^}]*\} = args;/, "")));
  check("no ambient clock", !/Date\.now\(|new Date\(\s*\)/.test(code));
  check("it does not fall back to the earliest evidence",
    !/sort\(\)\[0\]|\.at\(0\)|earliest/i.test(code));
}

console.log("3. it composes the arc rather than re-implementing it");
{
  const imports = [...src.matchAll(/^\s*import\s[\s\S]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  for (const m of ["./quantity-event.core", "./quantity-replay.core",
                   "./quantity-reconciliation.core", "./event-coverage"]) {
    check(`composes ${m}`, imports.includes(m));
  }
  check("no second replay engine — no quantity arithmetic of its own",
    !/quantity\s*[+*]=|normalizedDelta\s*\+/.test(code));
  check("soft-deleted and superseded observations are excluded at the query",
    /deletedAt:\s*null/.test(code) && /supersededById:\s*null/.test(code));
  check("UNKNOWN is the fallback when coverage is absent",
    /UNKNOWN_EVENT_STREAM/.test(code));
}

console.log(failures === 0 ? "\nAll quantity-timeline guards passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
