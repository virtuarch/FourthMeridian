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
import { ledgerEpsilonFor, BTC_NATIVE, ETH_NATIVE, SOL_NATIVE } from "./native-asset";

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

  // ── J. W-M0 — the tolerance is a PROPERTY OF THE ASSET ────────────────────
  {
    // Default unchanged: every pre-W-M0 caller omits `epsilon` and gets a
    // satoshi. Sections A–I above all rely on this and are the real proof.
    check("J. omitting epsilon is exactly the pre-W-M0 satoshi tolerance",
      reconcileWalletLedger({ observedBalance: 1, movements: [1 - 5e-9] }).complete
        && reconcileWalletLedger({ observedBalance: 1, movements: [1 - 5e-9], epsilon: LEDGER_EPSILON }).complete);

    // A lamport-sized shortfall: reconciled under BTC's tolerance, refused under
    // SOL's. This is the case the single fixed constant could not express, and
    // it would have blessed a SOL ledger short by up to ten lamports.
    const shortByFiveLamports = { observedBalance: 10, movements: [10 - 5e-9] };
    check("J. a 5-lamport shortfall passes at a satoshi and FAILS at a lamport",
      reconcileWalletLedger({ ...shortByFiveLamports, epsilon: ledgerEpsilonFor(BTC_NATIVE) }).complete
        && !reconcileWalletLedger({ ...shortByFiveLamports, epsilon: ledgerEpsilonFor(SOL_NATIVE) }).complete);

    check("J. the SOL tolerance still reconciles a genuinely complete ledger",
      reconcileWalletLedger({ observedBalance: 10, movements: [4, 6], epsilon: ledgerEpsilonFor(SOL_NATIVE) }).complete);

    // ETH: float64 cannot distinguish a wei near unit magnitudes, so the ETH
    // tolerance is the stated floor. A complete 18-decimal ledger must still
    // reconcile through ordinary float summation noise.
    const ethMovements = Array.from({ length: 200 }, () => 0.01);   // Σ = 2, with drift
    check("J. an 18-decimal ledger reconciles through float summation noise",
      reconcileWalletLedger({ observedBalance: 2, movements: ethMovements, epsilon: ledgerEpsilonFor(ETH_NATIVE) }).complete);
    check("J. …while a materially short ETH ledger is still refused",
      !reconcileWalletLedger({ observedBalance: 2.0001, movements: ethMovements, epsilon: ledgerEpsilonFor(ETH_NATIVE) }).complete);

    // A broken tolerance must never WIDEN the comparison into silently passing.
    for (const bad of [NaN, 0, -1, Infinity]) {
      check(`J. an unusable epsilon (${bad}) falls back to the default, never blesses`,
        !reconcileWalletLedger({ observedBalance: 1, movements: [0.5], epsilon: bad }).complete);
    }
    check("J. an unusable epsilon reproduces the default verdict exactly",
      reconcileWalletLedger({ observedBalance: 1, movements: [1 - 5e-9], epsilon: NaN }).complete);
  }

  console.log(failures === 0 ? "\nAll ledger-completeness checks passed" : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
