/**
 * lib/money/fx-disclosure.test.ts — V25-CLOSE-3 Part 1
 *
 * Proves the FX honesty upgrade:
 *   1. `fxDisclosureOf` distinguishes "unavailable" (no rate applied, native
 *      amount shown) from "estimated" (real rate, walked back) from "exact".
 *   2. `convertAndSum` preserves the "unavailable" fact through the fold.
 *   3. SUCCESSFUL conversions are UNCHANGED — same amount, and never classified
 *      as unavailable/estimated when the rate was exact.
 *
 *     npx tsx lib/money/fx-disclosure.test.ts
 */

import type { Resolution } from "@/lib/fx/types";
import { convertMoney, convertAndSum, fxDisclosureOf } from "./convert";
import type { ConversionContext } from "./types";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

// ── Test contexts (all target USD) ────────────────────────────────────────────

/** Every non-USD resolves MISS → native pass-through + estimated (the doctrine D-3 case). */
const missCtx: ConversionContext = {
  target: "USD",
  resolve: (from, dateISO): Resolution => ({ kind: "miss", quote: from, requestedDateISO: dateISO }),
};

/** A real EXACT rate: 1 JPY = 0.0065 USD, not stale. */
const exactCtx: ConversionContext = {
  target: "USD",
  resolve: (from, dateISO): Resolution =>
    from === "JPY"
      ? { kind: "rate", rate: 0.0065, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" }
      : { kind: "miss", quote: from, requestedDateISO: dateISO },
};

/** A real but WALKED-BACK rate (a rate WAS applied — value is roughly right). */
const staleCtx: ConversionContext = {
  target: "USD",
  resolve: (from, dateISO): Resolution =>
    from === "JPY"
      ? { kind: "rate", rate: 0.0065, requestedDateISO: dateISO, effectiveDates: { from: "2020-01-01", to: "2020-01-01" }, staleness: "walked-back" }
      : { kind: "miss", quote: from, requestedDateISO: dateISO },
};

const D = "2026-07-20";

// ── 1. fxDisclosureOf classification ─────────────────────────────────────────

// identity (native === target): exact, not estimated
check("identity → exact", fxDisclosureOf(convertMoney({ amount: 100, currency: "USD" }, D, exactCtx)) === "exact");

// exact applied rate: exact
{
  const c = convertMoney({ amount: 1_000_000, currency: "JPY" }, D, exactCtx);
  check("exact rate → exact", fxDisclosureOf(c) === "exact");
  check("exact rate converts the amount (¥1,000,000 → $6,500)", Math.abs(c.amount - 6500) < 1e-9, `amount=${c.amount}`);
  check("exact rate is not estimated", c.estimated === false);
}

// walked-back rate: estimated (a rate WAS applied)
{
  const c = convertMoney({ amount: 1_000_000, currency: "JPY" }, D, staleCtx);
  check("walked-back rate → estimated (NOT unavailable)", fxDisclosureOf(c) === "estimated");
  check("walked-back still applied the rate (amount converted, not native)", Math.abs(c.amount - 6500) < 1e-9, `amount=${c.amount}`);
}

// rate miss: unavailable — native amount shown, mislabelled as target
{
  const c = convertMoney({ amount: 1_000_000, currency: "JPY" }, D, missCtx);
  check("rate miss → unavailable", fxDisclosureOf(c) === "unavailable");
  check("rate miss passes NATIVE amount through unchanged (¥1,000,000 stays 1,000,000)", c.amount === 1_000_000, `amount=${c.amount}`);
  check("rate miss has no conversion metadata", c.conversion === null);
}

// null-residue currency: unavailable
{
  const c = convertMoney({ amount: 42, currency: null }, D, exactCtx);
  check("null-residue currency → unavailable", fxDisclosureOf(c) === "unavailable");
  check("null-residue passes the raw amount through", c.amount === 42);
}

// ── 2. convertAndSum preserves the unconverted fact ──────────────────────────

{
  const total = convertAndSum(
    [
      { money: { amount: 100, currency: "USD" }, dateISO: D },        // exact
      { money: { amount: 1_000_000, currency: "JPY" }, dateISO: D },  // MISS → unavailable
    ],
    missCtx,
  );
  check("mixed total is estimated", total.estimated === true);
  check("mixed total is unconverted (a member had no rate)", total.unconverted === true);
}

{
  // Only a walked-back member — estimated but NOT unconverted (a rate was applied).
  const total = convertAndSum(
    [{ money: { amount: 1_000_000, currency: "JPY" }, dateISO: D }],
    staleCtx,
  );
  check("walked-back-only total is estimated", total.estimated === true);
  check("walked-back-only total is NOT unconverted", total.unconverted === false);
}

// ── 3. Successful conversions remain unchanged ───────────────────────────────

{
  const total = convertAndSum(
    [
      { money: { amount: 100, currency: "USD" }, dateISO: D },
      { money: { amount: 1_000_000, currency: "JPY" }, dateISO: D },
    ],
    exactCtx,
  );
  check("all-exact total amount = 100 + 6500", Math.abs(total.amount - 6600) < 1e-9, `amount=${total.amount}`);
  check("all-exact total is NOT estimated", total.estimated === false);
  check("all-exact total is NOT unconverted", total.unconverted === false);
}

// A pure-USD (identity) total is exact and unmarked — the common case, unchanged.
{
  const total = convertAndSum([{ money: { amount: 250, currency: "USD" }, dateISO: D }], exactCtx);
  check("identity total is exact/unmarked", total.estimated === false && total.unconverted === false && total.amount === 250);
}

console.log(`\nfx-disclosure: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
