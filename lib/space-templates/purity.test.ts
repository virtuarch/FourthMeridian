/**
 * lib/space-templates/purity.test.ts
 *
 * SP-1 purity / source-scan guard (precedent: lib/security-surface.test.ts).
 * Standalone tsx script:  npx tsx lib/space-templates/purity.test.ts
 *
 * Templates are pure data. The non-test modules in this directory may import
 * ONLY from each other and lib/space-presets — enforced as an allowlist, so
 * TI, AI, DB/Prisma-runtime, Plaid, auth/session, React, and Next imports are
 * all structurally impossible, not just currently absent.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
}

const DIR = path.join(process.cwd(), "lib", "space-templates");

// Every non-test module in this directory, discovered (not hardcoded) so a
// future module can't silently escape the scan.
const moduleFiles = readdirSync(DIR).filter(
  (f) => f.endsWith(".ts") && !f.endsWith(".test.ts")
);
check(
  "module discovery found the SP-1 modules",
  ["apply.ts", "registry.ts", "types.ts"].every((f) => moduleFiles.includes(f))
);

// Allowlist: intra-directory imports + the preset contract. Nothing else.
const ALLOWED = /^(\.\/(types|registry|apply)|\.\.\/space-presets)$/;

// Named forbidden surfaces — redundant with the allowlist, but produces
// pointed failure messages if the allowlist is ever loosened.
const FORBIDDEN: [RegExp, string][] = [
  [/transactions/, "TI (lib/transactions / lib/data/transactions)"],
  [/\/data\//, "data layer"],
  [/\/ai\//, "AI modules"],
  [/lib\/db|\.\.\/db/, "DB client"],
  [/@prisma\/client/, "Prisma runtime"],
  [/plaid/i, "Plaid"],
  [/auth|session/, "auth/session"],
  [/^react|^next/, "React/Next"],
];

for (const file of moduleFiles) {
  const src = readFileSync(path.join(DIR, file), "utf8");
  // import ... from "x" | export ... from "x" | import("x") | require("x")
  const specifiers = [
    ...src.matchAll(/(?:import|export)[^"']*?from\s*["']([^"']+)["']/g),
    ...src.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...src.matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => m[1]);

  for (const spec of specifiers) {
    check(
      `${file}: import "${spec}" is on the SP-1 allowlist`,
      ALLOWED.test(spec)
    );
    for (const [pattern, label] of FORBIDDEN) {
      check(
        `${file}: import "${spec}" does not touch ${label}`,
        !pattern.test(spec)
      );
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll purity checks passed.");
