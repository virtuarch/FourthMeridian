/**
 * lib/debt/effective-terms.test.ts
 *
 * V26-PRE (B3) — effective debt terms (APR / minimum payment) have exactly ONE
 * resolution authority: lib/debt/effective-terms.ts. Before this slice the
 * `profile?.apr ?? interestRate` precedence rule lived duplicated in
 * lib/data/accounts.ts and lib/ai/assemblers/accounts.ts and was MISSING from
 * lib/space/mount-composition.ts — so after a user corrected an APR via the
 * debt profile, Personal Debt and Space Debt showed different interest costs
 * and payoff timelines for the same card.
 *
 * Layers:
 *   A. Behavioral — precedence semantics of the pure resolver.
 *   B. Enrolment  — the three readers consume the authority; the Space loader
 *      joins DebtProfile (the original hole).
 *   C. Ban        — no production file re-derives the precedence inline.
 *
 * Standalone tsx:  npx tsx lib/debt/effective-terms.test.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { resolveEffectiveDebtTerms } from "./effective-terms";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ─── A. Behavioral ───────────────────────────────────────────────────────────

{
  const t = resolveEffectiveDebtTerms({ interestRate: 24.99, minimumPayment: 50, debtProfile: { apr: 19.99, minimumPayment: 35 } });
  check("profile wins over flat column (apr)", t.apr === 19.99);
  check("profile wins over flat column (minimumPayment)", t.minimumPayment === 35);
}
{
  const t = resolveEffectiveDebtTerms({ interestRate: 24.99, minimumPayment: 50, debtProfile: null });
  check("no profile → flat column (apr)", t.apr === 24.99);
  check("no profile → flat column (minimumPayment)", t.minimumPayment === 50);
}
{
  const t = resolveEffectiveDebtTerms({ interestRate: 24.99, minimumPayment: 50, debtProfile: { apr: null, minimumPayment: null } });
  check("profile with null fields → falls through per-field", t.apr === 24.99 && t.minimumPayment === 50);
}
{
  const t = resolveEffectiveDebtTerms({ interestRate: 24.99, debtProfile: { apr: 0 } });
  check("explicit 0 APR in profile is a real value and WINS", t.apr === 0);
}
{
  const t = resolveEffectiveDebtTerms({ debtProfile: { apr: 12.5 }, interestRate: null, minimumPayment: null });
  check("mixed: profile apr + nothing else → minimumPayment null", t.apr === 12.5 && t.minimumPayment === null);
}
{
  const t = resolveEffectiveDebtTerms({});
  check("nothing anywhere → both null (never fabricated)", t.apr === null && t.minimumPayment === null);
}

// ─── B. Enrolment (source-scan) ──────────────────────────────────────────────

const ROOT = process.cwd();
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const src = (rel: string) => strip(readFileSync(path.join(ROOT, rel), "utf8"));

const CONSUMERS = [
  "lib/space/mount-composition.ts",
  "lib/data/accounts.ts",
  "lib/ai/assemblers/accounts.ts",
];
for (const rel of CONSUMERS) {
  check(`${rel} consumes resolveEffectiveDebtTerms`, src(rel).includes("resolveEffectiveDebtTerms("));
}
check(
  "mount-composition JOINS debtProfile (the loader that used to serve the stale flat APR)",
  /debtProfile:\s*\{\s*select:/.test(src("lib/space/mount-composition.ts")),
);

// ─── C. Ban — no inline re-derivation of the precedence rule ─────────────────
// The pattern that must not reappear: `<x>.apr ?? <y>.interestRate` — the APR
// precedence chain written inline (direct fallback, same expression). Client
// override-vs-server patterns (`.apr ?? undefined`) are not precedence
// re-derivations and do not match.

const BAN = /\.\s*apr\s*\?\?\s*[A-Za-z_$][\w$]*(\??\.)\s*interestRate/;

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === "prototype") continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

const offenders: string[] = [];
for (const rel of [...walk("lib"), ...walk("app"), ...walk("components")]) {
  if (rel === path.join("lib", "debt", "effective-terms.ts")) continue; // the authority itself
  if (BAN.test(src(rel))) offenders.push(rel);
}
check(
  "no production file re-derives `apr ?? interestRate` inline",
  offenders.length === 0,
  offenders.join(", "),
);

if (failures > 0) {
  console.error(`\neffective-terms: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll effective-terms checks passed.");
