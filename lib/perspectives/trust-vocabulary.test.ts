/**
 * lib/perspectives/trust-vocabulary.test.ts
 *
 * Convergence guard for the Trust Surface slice: ONE authoritative trust model,
 * many consumers. Pure, DB-free:  npx tsx lib/perspectives/trust-vocabulary.test.ts
 *
 * Proves:
 *   1. Vocabulary parity — the envelope's presentation authority is keyed by
 *      EXACTLY the canonical CompletenessTier set (no parallel/omitted tier), and
 *      the five tiers carry the agreed semantic labels (Reconstructed / Unavailable).
 *   2. No drift — the retired parallel vocabularies (`WealthTier`, `EnvelopeTier`)
 *      exist NOWHERE in lib/ or components/ (identifier scan).
 *   3. TrustIndicator is domain-neutral — it imports the trust contract + the
 *      shell's tier-agnostic detail surfaces ONLY; no financial-domain imports.
 *   4. Every workspace resolves trust through the ONE canonical resolver
 *      (resolvePerspectiveEnvelope), never a bespoke tier calculation.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { COMPLETENESS_PRESENTATION } from "./envelope";
import { COMPLETENESS_TIERS } from "@/lib/perspective-engine/completeness";

const ROOT = process.cwd();
let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** Recursively collect .ts/.tsx under a dir, skipping dot-dirs and node_modules. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

console.log("1. Vocabulary parity — the presentation authority IS the canonical tier set");
{
  const presentationKeys = Object.keys(COMPLETENESS_PRESENTATION).sort();
  const canonical = [...COMPLETENESS_TIERS].sort();
  check("COMPLETENESS_PRESENTATION is keyed by exactly the canonical CompletenessTier set",
    JSON.stringify(presentationKeys) === JSON.stringify(canonical), `${presentationKeys} vs ${canonical}`);
  // The agreed semantic buckets: derived≙Reconstructed, unknown≙Unavailable.
  check("observed ⇒ Observed / positive", COMPLETENESS_PRESENTATION.observed.label === "Observed" && COMPLETENESS_PRESENTATION.observed.tone === "positive");
  check("derived ⇒ Reconstructed / neutral", COMPLETENESS_PRESENTATION.derived.label === "Reconstructed" && COMPLETENESS_PRESENTATION.derived.tone === "neutral");
  check("estimated ⇒ Estimated / warning", COMPLETENESS_PRESENTATION.estimated.label === "Estimated" && COMPLETENESS_PRESENTATION.estimated.tone === "warning");
  check("incomplete ⇒ Incomplete / warning", COMPLETENESS_PRESENTATION.incomplete.label === "Incomplete" && COMPLETENESS_PRESENTATION.incomplete.tone === "warning");
  check("unknown ⇒ Unavailable / warning", COMPLETENESS_PRESENTATION.unknown.label === "Unavailable" && COMPLETENESS_PRESENTATION.unknown.tone === "warning");
  // Every tier has a non-empty popover detail (so a chip is never dead where it should explain).
  check("every tier carries a non-empty detail", canonical.every((t) => (COMPLETENESS_PRESENTATION as Record<string, { detail: string }>)[t].detail.length > 0));
}

console.log("2. No parallel vocabulary — WealthTier / EnvelopeTier retired everywhere (code, not prose)");
{
  // Strip block + line comments so retired names surviving only in documentation
  // (this slice's own explanatory headers) don't read as live code.
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const files = [...walk(path.join(ROOT, "lib")), ...walk(path.join(ROOT, "components"))]
    .filter((f) => !f.endsWith("trust-vocabulary.test.ts")); // this guard names them in prose
  const offenders = (id: string) =>
    files.filter((f) => new RegExp(`\\b${id}\\b`).test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => path.relative(ROOT, f));
  const wealthTier = offenders("WealthTier");
  const envelopeTier = offenders("EnvelopeTier");
  check("no `WealthTier` identifier remains in code", wealthTier.length === 0, wealthTier.join(", "));
  check("no `EnvelopeTier` identifier remains in code", envelopeTier.length === 0, envelopeTier.join(", "));
}

console.log("3. TrustIndicator is domain-neutral (no financial-domain imports)");
{
  const src = readFileSync(path.join(ROOT, "components/space/trust/TrustIndicator.tsx"), "utf8");
  const importLines = src.split("\n").filter((l) => /^\s*import\b/.test(l));
  const forbidden = ["@/lib/wealth", "@/lib/debt", "@/lib/investments", "@/lib/liquidity", "@/lib/transactions", "@/lib/format", "@/lib/money", "WealthResult", "LensResult"];
  for (const f of forbidden) {
    check(`does not import ${f}`, !importLines.some((l) => l.includes(f)));
  }
  // It DOES consume the canonical trust contract + the shell's tier-agnostic surfaces.
  check("consumes the canonical PerspectiveEnvelope contract", src.includes("@/lib/perspectives/envelope"));
  check("reuses the shell EvidenceDrawer (not a re-implementation)", src.includes("@/components/space/shell/EvidenceDrawer"));
  // It must NOT compute trust — no tier ranking / worst-tier / propagate logic.
  check("does not calculate trust (no worstTier / propagate / buildCompleteness)",
    !/worstTier|propagateCompleteness|buildDebtCompleteness|buildLiquidityCompleteness/.test(src));
}

console.log("4. Workspaces resolve trust through the ONE canonical resolver");
{
  const workspaces = [
    "components/space/widgets/wealth/WealthWorkspace.tsx",
    "components/space/widgets/debt/DebtWorkspace.tsx",
    "components/space/widgets/liquidity/LiquidityWorkspace.tsx",
    "components/space/widgets/cashflow/CashFlowWorkspace.tsx",
    "components/space/widgets/investments/InvestmentsWorkspace.tsx",
  ];
  for (const w of workspaces) {
    const src = readFileSync(path.join(ROOT, w), "utf8");
    check(`${path.basename(w)} resolves via resolvePerspectiveEnvelope`, src.includes("resolvePerspectiveEnvelope("));
    check(`${path.basename(w)} does not recompute a completeness tier`,
      !/buildDebtCompleteness|buildLiquidityCompleteness|COMPLETENESS_TIERS|worstTier/.test(src));
  }
}

if (failures > 0) { console.error(`\n${failures} trust-vocabulary check(s) failed`); process.exit(1); }
console.log("\nAll trust-vocabulary checks passed");
