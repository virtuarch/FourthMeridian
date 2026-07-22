/**
 * lib/perspective-engine/liquidity.test.ts
 *
 * Liquidity lens tests — math, tier privacy (BALANCE_ONLY / SUMMARY_ONLY),
 * determinism, empty state, assumptions, and source tripwires.
 *
 * Standalone tsx script (house pattern — no jest/vitest):
 *
 *     npx tsx lib/perspective-engine/liquidity.test.ts
 *
 * Run from the repo root. Exits 0 on success, 1 on failure.
 *
 * Tests exercise the PURE core (lenses/liquidity.core.ts) with fixtures —
 * no DB, no Next request scope. The data binding (lenses/liquidity.ts) is
 * covered by source tripwires here plus the engine-wide import-graph guard
 * in engine.test.ts; its runtime behavior is a thin map over
 * getAccountsWithVisibility(), whose own redaction is KD-19-tested.
 */

import { readFileSync } from "fs";
import { join } from "path";

import { validateLensResult } from "./index";
import {
  computeLiquidity,
  LIQUIDITY_EMPTY,
  LIQUIDITY_LENS_VERSION,
  type LiquidityAccountRow,
} from "./lenses/liquidity.core";
import type { ComputeOptions, PerspectiveScope } from "./types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const SCOPE: PerspectiveScope = { spaceId: "space_liq_1", userId: "user_liq_1" };
const OPTS: ComputeOptions = { now: () => new Date("2026-07-03T12:00:00.000Z") };

const T = "2026-07-01T00:00:00.000Z";
const row = (over: Partial<LiquidityAccountRow> & { id: string }): LiquidityAccountRow => ({
  type: "checking",
  balance: 0,
  lastUpdated: T,
  visibilityLevel: "FULL",
  ...over,
});

function main(): void {
  // ── 1. Math over a mixed FULL fixture ────────────────────────────────────
  console.log("1. Tier math (all FULL)");
  const fullRows: LiquidityAccountRow[] = [
    row({ id: "fa_chk", type: "checking",   balance: 10_000 }),
    row({ id: "fa_sav", type: "savings",    balance: 8_400, lastUpdated: "2026-06-28T00:00:00.000Z" }),
    row({ id: "fa_inv", type: "investment", balance: 40_000 }),
    row({ id: "fa_cry", type: "crypto",     balance: 12_000 }),
    row({ id: "fa_oth", type: "other",      balance: 300_000 }),
    row({ id: "fa_cc",  type: "debt",       balance: 4_000, creditLimit: 10_000 }),
  ];
  const r1 = computeLiquidity(SCOPE, OPTS, fullRows);

  check("status ok", r1.status === "ok");
  check("passes structural validator", validateLensResult(r1).length === 0, validateLensResult(r1).join("; "));
  check("headline = cash now (18,400)", r1.headline?.id === "cashNow" && r1.headline?.value === 18_400);
  check("marketable = 52,000", r1.metrics.find((m) => m.id === "marketable")?.value === 52_000);
  check("illiquid = 300,000", r1.metrics.find((m) => m.id === "illiquid")?.value === 300_000);
  check("available credit = 6,000 (limit 10k − |−4k|)",
    r1.metrics.find((m) => m.id === "availableCredit")?.value === 6_000);
  check("verdict is the exact deterministic template",
    r1.verdict === "About $18,400 is available as cash now, and roughly $52,000 more could be raised by selling investments.",
    r1.verdict);
  check("lensVersion stamped", r1.lensVersion === LIQUIDITY_LENS_VERSION);
  check("accountIds sorted + complete",
    JSON.stringify(r1.provenance.accountIds) ===
    JSON.stringify(["fa_cc", "fa_chk", "fa_cry", "fa_inv", "fa_oth", "fa_sav"]));
  check("dataAsOf = OLDEST contributor freshness",
    r1.provenance.dataAsOf === "2026-06-28T00:00:00.000Z");
  check("tierCounts all-full", JSON.stringify(r1.provenance.tierCounts) === JSON.stringify({ full: 6, balanceOnly: 0, summaryOnly: 0 }));
  check("no redactions when nothing withheld", r1.provenance.redactions.length === 0);
  check("marketable assumptions present (before-costs + retirement)",
    r1.assumptions.some((a) => a.id === "marketable-before-costs") &&
    r1.assumptions.some((a) => a.id === "retirement-not-distinguished"));
  check("credit-not-liquidity assumption present",
    r1.assumptions.some((a) => a.id === "credit-not-liquidity"));

  // ── 2. BALANCE_ONLY behavior ─────────────────────────────────────────────
  console.log("2. BALANCE_ONLY");
  const boRows = [
    row({ id: "fa_mine", type: "checking", balance: 5_000 }),
    row({ id: "fa_bo",   type: "savings",  balance: 2_000, visibilityLevel: "BALANCE_ONLY" }),
    // BALANCE_ONLY debt: even if a creditLimit somehow appeared, tier gate must ignore it.
    row({ id: "fa_bocc", type: "debt", balance: 1_000, creditLimit: 9_999, visibilityLevel: "BALANCE_ONLY" }),
  ];
  const r2 = computeLiquidity(SCOPE, OPTS, boRows);
  check("balance-only balance feeds cash tier (7,000)", r2.headline?.value === 7_000);
  check("balance-only debt NEVER feeds credit (fail closed even if limit present)",
    r2.metrics.find((m) => m.id === "availableCredit") === undefined &&
    !JSON.stringify(r2).includes("9999"));
  check("tierCounts.balanceOnly = 2", r2.provenance.tierCounts.balanceOnly === 2);
  check("balance-only redaction line present",
    r2.provenance.redactions.some((s) => s.includes("2 shared accounts contribute a balance only")));
  check("balance-only ids appear in provenance (they contributed)",
    r2.provenance.accountIds.includes("fa_bo") && r2.provenance.accountIds.includes("fa_bocc"));

  // ── 3. SUMMARY_ONLY + unknown tiers fail closed ──────────────────────────
  console.log("3. SUMMARY_ONLY (and unknown tiers) fail closed");
  const LEAK_BALANCE = 999_999;
  const soRows = [
    ...fullRows,
    row({ id: "fa_so",  type: "checking", balance: LEAK_BALANCE, visibilityLevel: "SUMMARY_ONLY" }),
    row({ id: "fa_wat", type: "savings",  balance: LEAK_BALANCE, visibilityLevel: "SHARED" }), // legacy → fail closed
  ];
  const r3 = computeLiquidity(SCOPE, OPTS, soRows);
  check("totals unchanged by summary-only/unknown rows",
    r3.headline?.value === r1.headline?.value &&
    r3.metrics.find((m) => m.id === "marketable")?.value === 52_000);
  check("excluded balances never appear anywhere in result JSON",
    !JSON.stringify(r3).includes(String(LEAK_BALANCE)));
  check("excluded ids never appear in accountIds",
    !r3.provenance.accountIds.includes("fa_so") && !r3.provenance.accountIds.includes("fa_wat"));
  check("tierCounts.summaryOnly = 2 (incl. unknown-tier row, fail closed)",
    r3.provenance.tierCounts.summaryOnly === 2);
  check("summary-only redaction line present",
    r3.provenance.redactions.some((s) => s.includes("excluded from all totals")));

  // ── 4. Determinism ───────────────────────────────────────────────────────
  console.log("4. Determinism");
  const a = computeLiquidity(SCOPE, OPTS, soRows);
  const b = computeLiquidity(SCOPE, OPTS, soRows);
  check("byte-identical JSON across runs", JSON.stringify(a) === JSON.stringify(b));
  check("input order does not matter (sorted provenance, summed metrics)",
    JSON.stringify(computeLiquidity(SCOPE, OPTS, [...soRows].reverse()).provenance.accountIds) ===
    JSON.stringify(a.provenance.accountIds));
  check("computedAt from injected clock", a.computedAt === "2026-07-03T12:00:00.000Z");

  // ── 5. Empty & zero-liquidity branches ───────────────────────────────────
  console.log("5. Empty state and verdict branches");
  const rEmpty = computeLiquidity(SCOPE, OPTS, []);
  check("no rows → status empty with static safe copy",
    rEmpty.status === "empty" &&
    rEmpty.empty?.headline === LIQUIDITY_EMPTY.headline &&
    rEmpty.empty?.subline === LIQUIDITY_EMPTY.subline);
  check("empty result passes validator", validateLensResult(rEmpty).length === 0);

  const rDebtOnly = computeLiquidity(SCOPE, OPTS, [
    row({ id: "fa_d1", type: "debt", balance: 2_000, creditLimit: 5_000 }),
  ]);
  check("debt-only → ok with zero-funds verdict (not empty)",
    rDebtOnly.status === "ok" && rDebtOnly.verdict === "No readily accessible funds in this Space.");
  check("cash-only verdict branch",
    computeLiquidity(SCOPE, OPTS, [row({ id: "c", balance: 500 })]).verdict ===
    "About $500 is available as cash now.");
  check("marketable-only verdict branch",
    computeLiquidity(SCOPE, OPTS, [row({ id: "i", type: "investment", balance: 500 })]).verdict ===
    "No cash on hand, but roughly $500 could be raised by selling investments.");

  // ── 6. Source tripwires (name-freedom at the adapter boundary) ───────────
  console.log("6. Source tripwires");
  const coreSrc = readFileSync(join(process.cwd(), "lib/perspective-engine/lenses/liquidity.core.ts"), "utf8");
  const bindSrc = readFileSync(join(process.cwd(), "lib/perspective-engine/lenses/liquidity.ts"), "utf8");
  check("core input type declares no name/institution fields",
    !/\bname\??:|institution\??:/.test(coreSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "")));
  check("adapter never maps .name or .institution",
    !/account\.(name|institution|displayName|officialName|plaidName)/.test(bindSrc));
  check("adapter reads through getAccountsWithVisibility (the KD-19 path)",
    /getAccountsWithVisibility/.test(bindSrc) && !/from ["']@\/lib\/db["']/.test(bindSrc));

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll liquidity lens checks passed.");
  process.exit(0);
}

main();
