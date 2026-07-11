/**
 * lib/perspective-engine/debt.asof.test.ts
 *
 * A5-P3 (Debt Time Machine) — tests for the as-of trust-envelope layer the debt
 * binding adds when options.asOf is set.
 *
 * Standalone tsx script (house pattern — no jest/vitest):
 *
 *     npx tsx lib/perspective-engine/debt.asof.test.ts
 *
 * The completeness math is fixture-tested through the PURE helper module
 * (lenses/asof-completeness.ts) — DB-free. Covers: revolving-vs-installment
 * bucketing from the S2 resolution method, tier derivation, incomplete-beyond-
 * depth shapes, determinism, and the binding's kill switch + the refusal to
 * decompose principal-vs-interest (no amortization engine).
 */

import { readFileSync } from "fs";
import { join } from "path";

import {
  buildDebtCompleteness,
  debtComponent,
  debtReason,
  type AsOfComponentStamp,
} from "./lenses/asof-completeness";
import type { CompletenessTier } from "./types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ASOF = "2026-01-15";

function main(): void {
  // ── 1. Bucketing keys off the S2 resolution method ────────────────────────
  console.log("1. debtComponent bucketing (revolving vs installment)");
  check("card-walkback → revolving", debtComponent("card-walkback") === "revolving");
  check("held-flat → installment", debtComponent("held-flat") === "installment");
  check("before-coverage → beyond-coverage", debtComponent("before-coverage") === "beyond-coverage");
  check("observed (present-day) → debt", debtComponent("observed") === "debt");

  // ── 2. Revolving derived, installment estimated → estimated overall ───────
  console.log("2. Tier derivation");
  const revolvingOnly: AsOfComponentStamp[] = [
    { tier: "derived", component: "revolving" },
    { tier: "derived", component: "revolving" },
  ];
  check("all revolving cards walked back → derived",
    buildDebtCompleteness(ASOF, revolvingOnly).tier === "derived");

  const mixedDebt: AsOfComponentStamp[] = [
    { tier: "derived",   component: "revolving" },   // credit card walked back
    { tier: "estimated", component: "installment" }, // loan held flat (no history)
  ];
  const mixed = buildDebtCompleteness(ASOF, mixedDebt);
  check("card derived + installment held flat → estimated overall", mixed.tier === "estimated");
  check("byComponent keeps revolving/installment detail",
    mixed.byComponent?.revolving === "derived" && mixed.byComponent?.installment === "estimated");
  check("estimated reason names installment held-flat, name-free",
    mixed.reason ===
      "Revolving-card balances are reconstructed as of 2026-01-15; installment loans are held at their current balance.");

  // ── 3. Incomplete-beyond-depth ────────────────────────────────────────────
  console.log("3. Incomplete-beyond-depth shapes");
  const beyond: AsOfComponentStamp[] = [
    { tier: "derived",    component: "revolving" },
    { tier: "incomplete", component: "beyond-coverage" }, // card linked after asOf
  ];
  const inc = buildDebtCompleteness(ASOF, beyond);
  check("before-coverage debt flips the whole result to incomplete", inc.tier === "incomplete");
  check("incomplete reason", inc.reason ===
    "Debt history does not reach 2026-01-15 for every account, so the total is incomplete.");

  // ── 4. Reason copy per tier ───────────────────────────────────────────────
  console.log("4. Reason copy per tier");
  check("observed reason", debtReason("observed", ASOF) === "Debt balances are as reported on 2026-01-15.");
  check("derived reason mentions revolving reconstruction",
    /Revolving-card balances are reconstructed from your transaction history/.test(debtReason("derived", ASOF)));
  check("unknown reason fails closed",
    debtReason("unknown", ASOF) === "Debt balances as of 2026-01-15 could not be determined.");

  // ── 5. Determinism + serialisability ──────────────────────────────────────
  console.log("5. Determinism");
  const a = buildDebtCompleteness(ASOF, mixedDebt);
  const b = buildDebtCompleteness(ASOF, mixedDebt);
  check("identical stamps → byte-identical JSON", JSON.stringify(a) === JSON.stringify(b));
  check("conflict defaults false", a.conflict === false);
  check("envelope round-trips through JSON unchanged",
    JSON.stringify(JSON.parse(JSON.stringify(a))) === JSON.stringify(a));

  // ── 6. Name-freedom ───────────────────────────────────────────────────────
  console.log("6. Name-freedom");
  const tiers: CompletenessTier[] = ["observed", "derived", "estimated", "incomplete", "unknown"];
  check("no reason string embeds an account/institution field",
    tiers.every((t) => !/\b(name|institution|bank|chase|amex)\b/i.test(debtReason(t, ASOF))));

  // ── 7. Binding source tripwires — kill switch + refusal to decompose ──────
  console.log("7. Binding source tripwires");
  const bindSrc = readFileSync(
    join(process.cwd(), "lib/perspective-engine/lenses/debt.ts"), "utf8",
  );
  check("as-of path reads through the S2 resolver (getAccountsAsOf)",
    /getAccountsAsOf/.test(bindSrc));
  check("resolver call is gated on options.asOf (kill switch)",
    /options\.asOf\s*\n?\s*\?[\s\S]*getAccountsAsOf/.test(bindSrc));
  check("completeness is attached only under an options.asOf guard",
    /if \(options\.asOf[\s\S]*completeness: buildDebtCompleteness/.test(bindSrc));
  check("binding never imports @/lib/db directly (engine import-graph rule)",
    !/from ["']@\/lib\/db["']/.test(bindSrc));
  // Scan CODE only — the doc comment legitimately says "no amortization engine
  // is built here", which a whole-file scan would trip on (engine.test.ts §4
  // strips comments for the same reason).
  const bindCode = bindSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  check("no amortization/principal-vs-interest engine is introduced in the binding",
    !/amorti[sz]|principalPortion|interestPortion|splitPrincipal/i.test(bindCode));

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll debt as-of checks passed.");
  process.exit(0);
}

main();
