/**
 * lib/perspective-engine/debt.test.ts
 *
 * Debt lens tests — cost math, tier privacy (BALANCE_ONLY / SUMMARY_ONLY /
 * unknown tiers fail closed), knowledge-gap rules, estimated-minimum
 * labeling, promo expiry, determinism, empty state, and source tripwires.
 *
 * Standalone tsx script (house pattern — no jest/vitest):
 *
 *     npx tsx lib/perspective-engine/debt.test.ts
 *
 * Run from the repo root. Exits 0 on success, 1 on failure. Exercises the
 * PURE core with fixtures — no DB, no Next request scope.
 */

import { readFileSync } from "fs";
import { join } from "path";

import { validateLensResult } from "./index";
import {
  computeDebt,
  DEBT_EMPTY,
  DEBT_LENS_VERSION,
  type DebtAccountRow,
} from "./lenses/debt.core";
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

const SCOPE: PerspectiveScope = { spaceId: "space_debt_1", userId: "user_debt_1" };
const OPTS: ComputeOptions = { now: () => new Date("2026-07-03T12:00:00.000Z") };

const T = "2026-07-01T00:00:00.000Z";
const row = (over: Partial<DebtAccountRow> & { id: string }): DebtAccountRow => ({
  type: "debt",
  balance: 0,
  lastUpdated: T,
  visibilityLevel: "FULL",
  ...over,
});

function main(): void {
  // ── 1. Cost math over FULL rows ──────────────────────────────────────────
  console.log("1. Cost math (all FULL)");
  const fullRows: DebtAccountRow[] = [
    row({ id: "fa_cc",   balance: -4_000,  interestRate: 24, minimumPayment: 120 }),
    row({ id: "fa_loan", balance: -19_400, interestRate: 6,  minimumPayment: 300, lastUpdated: "2026-06-25T00:00:00.000Z" }),
    row({ id: "fa_chk",  type: "checking", balance: 9_999_999 }), // non-debt: ignored by every metric
  ];
  const r1 = computeDebt(SCOPE, OPTS, fullRows);

  check("status ok + validator clean", r1.status === "ok" && validateLensResult(r1).length === 0);
  check("total debt = 23,400 (|−4k| + |−19.4k|)", r1.headline?.value === 23_400);
  check("non-debt balances never leak into metrics",
    !JSON.stringify(r1.metrics).includes("9999999"));
  const mi = r1.metrics.find((m) => m.id === "monthlyInterest");
  check("monthly interest = 177 (80 + 97), flagged estimated",
    mi?.value === 177 && mi?.estimated === true, String(mi?.value));
  const apr = r1.metrics.find((m) => m.id === "blendedApr");
  check("blended APR balance-weighted ≈ 9.0769",
    typeof apr?.value === "number" && Math.abs((apr.value as number) - 212_400 / 23_400) < 1e-9);
  check("minimum payments = 420, not estimated",
    r1.metrics.find((m) => m.id === "minPayments")?.value === 420 &&
    r1.metrics.find((m) => m.id === "minPayments")?.estimated === undefined);
  check("verdict exact deterministic template",
    r1.verdict === "You carry $23,400 of debt across 2 accounts, accruing an estimated $177/month in interest at known rates.",
    r1.verdict);
  check("lensVersion stamped", r1.lensVersion === DEBT_LENS_VERSION);
  check("provenance = debt rows only, sorted; dataAsOf oldest",
    JSON.stringify(r1.provenance.accountIds) === JSON.stringify(["fa_cc", "fa_loan"]) &&
    r1.provenance.dataAsOf === "2026-06-25T00:00:00.000Z");
  check("interest + rate-source assumptions present",
    r1.assumptions.some((a) => a.id === "interest-simple-monthly") &&
    r1.assumptions.some((a) => a.id === "rate-sources"));

  // ── 2. Estimated minimums + unknown-rate knowledge gap (FULL only) ───────
  console.log("2. Estimates and knowledge gaps");
  const r2 = computeDebt(SCOPE, OPTS, [
    row({ id: "fa_est",  balance: -1_000, interestRate: 12, minimumPayment: 45, minimumPaymentIsEstimated: true }),
    row({ id: "fa_gap",  balance: -500 }), // FULL, no rate on file
  ]);
  check("estimated minimum flagged on metric + assumption",
    r2.metrics.find((m) => m.id === "minPayments")?.estimated === true &&
    r2.assumptions.some((a) => a.id === "estimated-minimums" && a.source === "estimate"));
  check("unknown-rate FULL account: balance in total, excluded from interest",
    r2.headline?.value === 1_500 &&
    r2.metrics.find((m) => m.id === "monthlyInterest")?.value === 10);
  check("knowledge-gap assumption counts FULL rows only (1 account)",
    r2.assumptions.some((a) => a.id === "unknown-rates" && a.text.startsWith("1 account has")));

  // ── 3. BALANCE_ONLY fails closed on metadata, counts on balance ──────────
  console.log("3. BALANCE_ONLY");
  const SENTINEL_APR = 77.77;
  const r3 = computeDebt(SCOPE, OPTS, [
    row({ id: "fa_full", balance: -2_000, interestRate: 12 }),
    // Over-supplied metadata on a shared row must be IGNORED (defense in depth):
    row({ id: "fa_bo", balance: -3_000, visibilityLevel: "BALANCE_ONLY", interestRate: SENTINEL_APR, minimumPayment: 4_242, promoAprEndDate: "2026-09-01" }),
  ]);
  check("balance-only balance counts toward total (5,000)", r3.headline?.value === 5_000);
  check("balance-only APR/minimum/promo never used or serialized",
    r3.metrics.find((m) => m.id === "monthlyInterest")?.value === 20 && // 2,000 × 12% ÷ 12 only
    !JSON.stringify(r3).includes(String(SENTINEL_APR)) &&
    !JSON.stringify(r3).includes("4242") &&
    !JSON.stringify(r3).includes("2026-09-01"));
  check("no knowledge-gap line for the shared account (assemblers' rule)",
    !r3.assumptions.some((a) => a.id === "unknown-rates"));
  check("rate-withheld redaction line present",
    r3.provenance.redactions.some((s) => s.includes("Rate and payment detail withheld for 1 shared account")));

  // ── 4. SUMMARY_ONLY + unknown tiers fail closed entirely ─────────────────
  console.log("4. SUMMARY_ONLY / unknown tiers");
  const LEAK = 888_888;
  const r4 = computeDebt(SCOPE, OPTS, [
    row({ id: "fa_full", balance: -2_000, interestRate: 12 }),
    row({ id: "fa_so",  balance: -LEAK, visibilityLevel: "SUMMARY_ONLY" }),
    row({ id: "fa_leg", balance: -LEAK, visibilityLevel: "SHARED" }), // legacy → fail closed
  ]);
  check("summary-only/unknown balances excluded from totals", r4.headline?.value === 2_000);
  check("excluded balances never appear in result JSON", !JSON.stringify(r4).includes(String(LEAK)));
  check("excluded ids not in accountIds; counted in tierCounts (2)",
    !r4.provenance.accountIds.includes("fa_so") &&
    !r4.provenance.accountIds.includes("fa_leg") &&
    r4.provenance.tierCounts.summaryOnly === 2);
  check("summary-only redaction line present",
    r4.provenance.redactions.some((s) => s.includes("excluded from all totals")));

  const rAllSo = computeDebt(SCOPE, OPTS, [
    row({ id: "fa_so1", balance: -LEAK, visibilityLevel: "SUMMARY_ONLY" }),
  ]);
  check("all-summary-only: withheld verdict, NO totals claimed (not even $0)",
    rAllSo.status === "ok" &&
    rAllSo.verdict === "Debt totals are withheld for the 1 summary-only shared account in this Space." &&
    rAllSo.headline === undefined && rAllSo.metrics.length === 0 &&
    !JSON.stringify(rAllSo).includes(String(LEAK)),
    rAllSo.verdict);

  // ── 5. Promo expiry uses the injected clock ──────────────────────────────
  console.log("5. Promotional APR expiry");
  const r5 = computeDebt(SCOPE, OPTS, [
    row({ id: "fa_p1", balance: -100, promoAprEndDate: "2026-08-15" }), // future
    row({ id: "fa_p2", balance: -100, promoAprEndDate: "2026-07-20" }), // future, earlier
    row({ id: "fa_p3", balance: -100, promoAprEndDate: "2026-06-01" }), // past → ignored
  ]);
  const promo = r5.metrics.find((m) => m.id === "promoEnds");
  check("earliest FUTURE promo end surfaces (2026-07-20), past ignored",
    promo?.value === "2026-07-20" && promo?.tone === "warning");

  // ── 6. Verdict branches, empty state, determinism ────────────────────────
  console.log("6. Branches, empty, determinism");
  check("no debt accounts → positive 'no debt' verdict with $0 headline",
    computeDebt(SCOPE, OPTS, [row({ id: "c", type: "checking", balance: 500 })]).verdict ===
      "No debt accounts in this Space.");
  check("debt accounts, zero balances → 'no outstanding balances' verdict",
    computeDebt(SCOPE, OPTS, [row({ id: "d", balance: 0, interestRate: 20 })]).verdict ===
      "No outstanding debt balances in this Space.");
  check("no rates on file → rate-free verdict",
    computeDebt(SCOPE, OPTS, [row({ id: "d", balance: -750 })]).verdict ===
      "You carry $750 of debt across 1 account; no interest rates are on file yet.");
  const rEmpty = computeDebt(SCOPE, OPTS, []);
  check("no rows → status empty with static safe copy",
    rEmpty.status === "empty" && rEmpty.empty?.headline === DEBT_EMPTY.headline &&
    validateLensResult(rEmpty).length === 0);

  const big = [
    ...fullRows,
    row({ id: "fa_bo", balance: -3_000, visibilityLevel: "BALANCE_ONLY" }),
    row({ id: "fa_so", balance: -LEAK, visibilityLevel: "SUMMARY_ONLY" }),
  ];
  check("byte-identical JSON across runs",
    JSON.stringify(computeDebt(SCOPE, OPTS, big)) === JSON.stringify(computeDebt(SCOPE, OPTS, big)));
  check("input order does not matter",
    JSON.stringify(computeDebt(SCOPE, OPTS, [...big].reverse()).provenance.accountIds) ===
    JSON.stringify(computeDebt(SCOPE, OPTS, big).provenance.accountIds));
  check("every fixture result passes the structural validator",
    [r1, r2, r3, r4, r5, rAllSo].every((r) => validateLensResult(r).length === 0));

  // ── 7. Source tripwires ───────────────────────────────────────────────────
  console.log("7. Source tripwires");
  const coreSrc = readFileSync(join(process.cwd(), "lib/perspective-engine/lenses/debt.core.ts"), "utf8");
  const bindSrc = readFileSync(join(process.cwd(), "lib/perspective-engine/lenses/debt.ts"), "utf8");
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
  console.log("\nAll debt lens checks passed.");
  process.exit(0);
}

main();
