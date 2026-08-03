/**
 * lib/crypto/ledger-completeness.core.test.ts
 *
 * V26-S1-BTC — the wallet ledger reconciliation. Standalone tsx, pure.
 *
 * The anchor case is the REAL incident: address bc1q8kv3hyy… holds
 * 0.24060252 BTC across 28 confirmed transactions; an unpaginated fetch imported
 * 25 of them, summing 0.22031745. Every assertion about "incomplete" below is
 * calibrated against those measured numbers rather than invented ones.
 */

import { reconcileWalletLedger, LEDGER_EPSILON } from "./ledger-completeness.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** The measured incident. */
const OBSERVED_BALANCE = 0.24060252;
const IMPORTED_SUM     = 0.22031745; // what the truncated 25-row ledger summed to
const MISSING          = 0.02028507; // the 3 unimported transactions

function main(): void {
  console.log("V26-S1-BTC — wallet ledger completeness\n");

  // ── A. The incident, exactly as it was ────────────────────────────────────
  {
    const r = reconcileWalletLedger({ observedBalance: OBSERVED_BALANCE, movements: [IMPORTED_SUM] });
    check("A. the truncated ledger is REFUSED", !r.complete);
    check("A. refusal is LEDGER_SHORTFALL", r.refusal === "LEDGER_SHORTFALL");
    check("A. the residual is the missing 0.02028507 BTC",
      Math.abs(r.residual! - MISSING) < 1e-8, `got ${r.residual}`);
    check("A. the reason states both sides", r.reason.includes(String(OBSERVED_BALANCE)));
  }

  // ── B. The repaired ledger reconciles ─────────────────────────────────────
  {
    const r = reconcileWalletLedger({ observedBalance: OBSERVED_BALANCE, movements: [IMPORTED_SUM, MISSING] });
    check("B. the complete ledger is ACCEPTED", r.complete && r.refusal === null);
    check("B. movementTotal is the sum", Math.abs(r.movementTotal - OBSERVED_BALANCE) < 1e-8);
    check("B. residual is ~0", Math.abs(r.residual!) <= LEDGER_EPSILON);
  }

  // ── C. Sign handling — outflows and fees are negative deltas ──────────────
  {
    const r = reconcileWalletLedger({ observedBalance: 0.5, movements: [1.0, -0.4, -0.1, 0.0] });
    check("C. signed movements sum correctly", r.complete, `residual ${r.residual}`);
  }

  // ── D. A wallet that holds nothing, with no movements, reconciles ─────────
  {
    const r = reconcileWalletLedger({ observedBalance: 0, movements: [] });
    check("D. 0 == 0 is COMPLETE, not a refusal", r.complete && r.refusal === null);
    check("D. movementCount 0 is reported honestly", r.movementCount === 0);
  }

  // ── E. A wallet that HOLDS something with no movements is refused ─────────
  {
    const r = reconcileWalletLedger({ observedBalance: OBSERVED_BALANCE, movements: [] });
    check("E. balance with no ledger is NO_MOVEMENTS", !r.complete && r.refusal === "NO_MOVEMENTS");
  }

  // ── F. No observed balance ⇒ nothing to reconcile against ─────────────────
  {
    const r = reconcileWalletLedger({ observedBalance: null, movements: [0.1] });
    check("F. null balance is NO_OBSERVED_BALANCE", !r.complete && r.refusal === "NO_OBSERVED_BALANCE");
    check("F. residual is null, never 0", r.residual === null);
  }

  // ── G. Non-finite input can never PASS ────────────────────────────────────
  // Postgres treats NaN = NaN as TRUE and this codebase has been bitten by it;
  // the equivalent trap here is NaN propagating into a comparison that then
  // reads as agreement. It must read as a shortfall instead.
  {
    const nanBal = reconcileWalletLedger({ observedBalance: NaN, movements: [1] });
    check("G. NaN balance is refused", !nanBal.complete && nanBal.refusal === "NO_OBSERVED_BALANCE");
    const nanMove = reconcileWalletLedger({ observedBalance: 1, movements: [1, NaN] });
    check("G. a NaN movement is refused, never silently skipped into agreement",
      !nanMove.complete && nanMove.refusal === "LEDGER_SHORTFALL");
    const infMove = reconcileWalletLedger({ observedBalance: 1, movements: [Infinity] });
    check("G. an infinite movement is refused", !infMove.complete);
  }

  // ── H. Satoshi-level tolerance, both directions ───────────────────────────
  {
    const within = reconcileWalletLedger({ observedBalance: 1, movements: [1 - LEDGER_EPSILON / 2] });
    check("H. a sub-satoshi residual reconciles", within.complete);
    const outside = reconcileWalletLedger({ observedBalance: 1, movements: [1 - 1e-7] });
    check("H. a residual above one satoshi does not", !outside.complete);
  }

  // ── I. Determinism / order independence ───────────────────────────────────
  {
    const a = reconcileWalletLedger({ observedBalance: 0.5, movements: [0.3, 0.1, 0.1] });
    const b = reconcileWalletLedger({ observedBalance: 0.5, movements: [0.1, 0.1, 0.3] });
    check("I. order does not change the verdict", a.complete === b.complete);
  }

  console.log(failures === 0 ? "\nAll ledger-completeness checks passed" : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
