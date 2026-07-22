/**
 * lib/perspective-engine/liquidity.asof.test.ts
 *
 * A5-P2 (Liquidity Time Machine) — tests for the as-of trust-envelope layer the
 * liquidity binding adds when options.asOf is set.
 *
 * Standalone tsx script (house pattern — no jest/vitest):
 *
 *     npx tsx lib/perspective-engine/liquidity.asof.test.ts
 *
 * The completeness math is fixture-tested through the PURE helper module
 * (lenses/asof-completeness.ts) — DB-free, exactly like liquidity.core.ts is
 * fixture-tested while the DB binding (lenses/liquidity.ts) is covered by source
 * tripwires. Covers: tier derivation, byComponent per-bucket detail, worst-tier
 * propagation, incomplete-beyond-depth shapes, determinism, visibility-tier
 * privacy (withheld rows never reach the envelope), and the binding's kill
 * switch (asOf-absent path emits no completeness).
 */

import { readFileSync } from "fs";
import { join } from "path";

import {
  buildLiquidityCompleteness,
  liquidityComponent,
  liquidityReason,
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
  // ── 1. Component bucketing mirrors the core's type partitions ─────────────
  console.log("1. liquidityComponent bucketing");
  check("checking/savings → cash",
    liquidityComponent("checking") === "cash" && liquidityComponent("savings") === "cash");
  check("investment/crypto → marketable",
    liquidityComponent("investment") === "marketable" && liquidityComponent("crypto") === "marketable");
  check("other → illiquid", liquidityComponent("other") === "illiquid");
  check("debt → credit", liquidityComponent("debt") === "credit");
  check("unrecognised type fails to a generic bucket, never dropped",
    liquidityComponent("some_new_type") === "other");

  // ── 2. Tier derivation — worst tier wins ──────────────────────────────────
  console.log("2. Tier derivation (worst tier wins)");
  const allDerived: AsOfComponentStamp[] = [
    { tier: "derived", component: "cash" },
    { tier: "derived", component: "cash" },
  ];
  check("all cash walked back → derived",
    buildLiquidityCompleteness(ASOF, allDerived).tier === "derived");

  const cashDerivedInvestEstimated: AsOfComponentStamp[] = [
    { tier: "derived",   component: "cash" },
    { tier: "estimated", component: "marketable" },
  ];
  const mixed = buildLiquidityCompleteness(ASOF, cashDerivedInvestEstimated);
  check("cash derived + marketable estimated → estimated overall", mixed.tier === "estimated");
  check("byComponent keeps per-bucket detail, never collapsed",
    mixed.byComponent?.cash === "derived" && mixed.byComponent?.marketable === "estimated");

  // ── 3. Incomplete-beyond-depth: one before-coverage account taints total ──
  console.log("3. Incomplete-beyond-depth shapes");
  const beyondDepth: AsOfComponentStamp[] = [
    { tier: "derived",    component: "cash" },
    { tier: "incomplete", component: "cash" },   // account linked after asOf → gap
  ];
  const inc = buildLiquidityCompleteness(ASOF, beyondDepth);
  check("any incomplete contributor flips the whole result to incomplete",
    inc.tier === "incomplete");
  check("incomplete reason names the boundary, name-free",
    inc.reason === "Balance history does not reach 2026-01-15 for every account, so the total is incomplete.");
  check("worst tier within a bucket surfaces in byComponent",
    inc.byComponent?.cash === "incomplete");

  // ── 4. Present-day (observed) and reason copy per tier ────────────────────
  console.log("4. Reason copy per tier");
  check("observed reason", liquidityReason("observed", ASOF) === "Balances are as reported on 2026-01-15.");
  check("derived reason mentions reconstruction",
    /reconstructed from your transaction history/.test(liquidityReason("derived", ASOF)));
  check("estimated reason mentions held at current value",
    /held at their current value/.test(liquidityReason("estimated", ASOF)));
  check("unknown reason fails closed",
    liquidityReason("unknown", ASOF) === "Balances as of 2026-01-15 could not be determined.");

  // ── 5. conflict flag defaults false (S2 emits no conflict signal today) ───
  console.log("5. Conflict flag");
  check("no conflict signal → conflict false",
    buildLiquidityCompleteness(ASOF, allDerived).conflict === false);

  // ── 6. Determinism + serialisability ──────────────────────────────────────
  console.log("6. Determinism");
  const a = buildLiquidityCompleteness(ASOF, cashDerivedInvestEstimated);
  const b = buildLiquidityCompleteness(ASOF, cashDerivedInvestEstimated);
  check("identical stamps → byte-identical JSON", JSON.stringify(a) === JSON.stringify(b));
  check("envelope round-trips through JSON unchanged (no Date/functions)",
    JSON.stringify(JSON.parse(JSON.stringify(a))) === JSON.stringify(a));

  // ── 7. Name-freedom of every emitted reason ───────────────────────────────
  console.log("7. Name-freedom");
  const tiers: CompletenessTier[] = ["observed", "derived", "estimated", "incomplete", "unknown"];
  check("no reason string embeds an account/institution field",
    tiers.every((t) => !/\b(name|institution|bank|chase|amex)\b/i.test(liquidityReason(t, ASOF))));

  // ── 8. Binding source tripwires — as-of wiring + kill switch ──────────────
  console.log("8. Binding source tripwires (kill switch + resolver wiring)");
  const bindSrc = readFileSync(
    join(process.cwd(), "lib/perspective-engine/lenses/liquidity.ts"), "utf8",
  );
  check("as-of path reads through the S2 resolver (getAccountsAsOf)",
    /getAccountsAsOf/.test(bindSrc));
  check("resolver call is gated on options.asOf (kill switch, not always-on)",
    /options\.asOf\s*\n?\s*\?[\s\S]*getAccountsAsOf/.test(bindSrc));
  check("completeness is attached only under an options.asOf guard",
    /if \(options\.asOf[\s\S]*completeness: buildLiquidityCompleteness/.test(bindSrc));
  check("binding still never imports @/lib/db directly (engine import-graph rule)",
    !/from ["']@\/lib\/db["']/.test(bindSrc));
  check("binding does not re-derive tiers by hand (uses the S1 propagation helper)",
    /buildLiquidityCompleteness/.test(bindSrc) && !/COMPLETENESS_TIERS/.test(bindSrc));

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll liquidity as-of checks passed.");
  process.exit(0);
}

main();
