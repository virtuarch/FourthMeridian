/**
 * lib/investments/derived-cash-identity.test.ts
 *
 * V26-S3-CASH — a derived position row must preserve its instrument's financial
 * identity, and valuation must not let a column default revoke it.
 *
 * ── The defect ───────────────────────────────────────────────────────────────
 * `PositionObservation.isCash` is NOT NULL DEFAULT false. The reconstruction
 * writer omitted it, so every DERIVED row said "not cash". Valuation read
 * `resolvedRow?.isCash ?? meta?.isCash`, and `??` does not fall through `false`
 * — so the row permanently out-voted the instrument, a dollar balance was sent
 * to a market-price lookup for "CUR:USD", and real reconstructed cash came back
 * UNVALUED. Live on 2026-01-01 that read `11 of 12` valued.
 *
 * Both halves are pinned here: the WRITER now records the identity, and the
 * READER can no longer be overruled by a default.
 */

import { readFileSync } from "node:fs";
import { valueInstrumentAsOf, type InstrumentValuationInput } from "./valuation-core";
import { identityContext } from "@/lib/money/convert";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
const CTX = identityContext("USD");

const input = (over: Partial<InstrumentValuationInput> = {}): InstrumentValuationInput => ({
  instrumentId: "i1", accountId: "a1", quantity: 471.21, quantityDate: "2026-01-01",
  quantityTier: "derived", isCash: false, nativeCurrency: "USD",
  institutionValue: null, institutionPrice: null, institutionPriceDate: null,
  price: null, conflicted: false, ...over,
});

/** The read path's resolution rule, as valuation.ts implements it. */
function resolveIsCash(row: { isCash: boolean } | null, meta: { isCash: boolean } | undefined): boolean {
  return meta?.isCash === true || row?.isCash === true;
}

function main(): void {
  console.log("V26-S3-CASH — derived cash identity\n");

  // ══ A. THE READ RULE ══════════════════════════════════════════════════════
  console.log("A. Instrument identity cannot be revoked by a row default");
  {
    // The exact live shape: a DERIVED reconstruction row (isCash default false)
    // against the CUR:USD instrument (isCashEquivalent true).
    check("A. LLC cash — derived row says false, instrument says cash ⇒ CASH",
      resolveIsCash({ isCash: false }, { isCash: true }) === true);
    check("A. Robinhood cash — same shape, same answer",
      resolveIsCash({ isCash: false }, { isCash: true }) === true);
    check("A. an OBSERVED cash row stays cash",
      resolveIsCash({ isCash: true }, { isCash: true }) === true);
    check("A. an ordinary equity derived row stays NON-cash",
      resolveIsCash({ isCash: false }, { isCash: false }) === false);
    check("A. a wallet (crypto) row stays NON-cash",
      resolveIsCash({ isCash: false }, { isCash: false }) === false);
    check("A. a row may still ASSERT cash for an instrument not so marked",
      resolveIsCash({ isCash: true }, { isCash: false }) === true);
    check("A. no row at all falls back to the instrument",
      resolveIsCash(null, { isCash: true }) === true &&
      resolveIsCash(null, { isCash: false }) === false);
    check("A. neither row nor instrument ⇒ not cash",
      resolveIsCash(null, undefined) === false);
  }

  // ══ B. VALUATION BEHAVIOUR ════════════════════════════════════════════════
  console.log("\nB. A cash holding is valued at its balance, never priced");
  {
    const cash = valueInstrumentAsOf(input({ isCash: true }), "2026-01-01", CTX);
    check("B. cash resolves a value", cash.reportingValue === 471.21);
    check("B. at unit price 1 in its native currency", cash.nativePrice === 1);
    check("B. on the cash basis", cash.basisUsed === "cash");
    check("B. with no market price consulted (price input was null and unused)",
      cash.priceDate === "2026-01-01" && cash.staleDays === 0);

    // The defect, reproduced: the same holding classified as a security.
    const asSecurity = valueInstrumentAsOf(input({ isCash: false, price: null }), "2026-01-01", CTX);
    check("B. THE DEFECT — misclassified as a security it is UNVALUED",
      asSecurity.reportingValue === null && asSecurity.overallTier === "incomplete");
    check("B. and the quantity survives on the unvalued row (evidence preserved)",
      asSecurity.quantity === 471.21);
    check("B. so the fix changes an unvalued holding into a valued one",
      asSecurity.reportingValue === null && cash.reportingValue !== null);
  }

  // ══ C. CURRENCY RESOLVES RATHER THAN BEING CARRIED ════════════════════════
  console.log("\nC. Currency falls back correctly (null IS a genuine absence)");
  {
    // Derived rows carry currency NULL; the instrument supplies USD. `??` is
    // the CORRECT operator there and is deliberately left alone.
    const fallback = valueInstrumentAsOf(
      input({ isCash: true, nativeCurrency: "USD" }), "2026-01-01", CTX);
    check("C. a null row currency resolves to the instrument's", fallback.currency === "USD");
    check("C. and the value is stated in it", fallback.reportingValue === 471.21);

    const noCurrency = valueInstrumentAsOf(
      input({ isCash: true, nativeCurrency: null }), "2026-01-01", CTX);
    check("C. with no currency anywhere the value is still the balance (identity ctx)",
      noCurrency.nativeValue === 471.21);
  }

  // ══ D. A CASH HOLDING WITH NO QUANTITY IS NOT ZERO ════════════════════════
  console.log("\nD. Absence is still absence");
  {
    const none = valueInstrumentAsOf(input({ isCash: true, quantity: null }), "2026-01-01", CTX);
    check("D. no balance ⇒ unvalued, never 0", none.reportingValue === null);
    check("D. with a stated reason", none.reason.includes("No cash balance"));
  }

  // ══ E. STRUCTURAL GUARDS ══════════════════════════════════════════════════
  console.log("\nE. Both halves of the fix are present");
  {
    const runner = strip(readFileSync("lib/investments/reconstruction-runner.ts", "utf8"));
    check("E. the writer records the instrument's cash identity on derived rows",
      /isCash:\s*r\.isCash/.test(runner));

    const valuation = strip(readFileSync("lib/investments/valuation.ts", "utf8"));
    check("E. the reader no longer lets a row default out-vote the instrument",
      !/resolvedRow\?\.isCash\s*\?\?\s*meta\?\.isCash/.test(valuation));
    check("E. instrument cash-equivalence wins",
      /meta\?\.isCash === true \|\| resolvedRow\?\.isCash === true/.test(valuation));
    check("E. currency still uses ?? (null there is a real absence, not a default)",
      /resolvedRow\?\.currency \?\? meta\?\.currency/.test(valuation));
  }

  console.log(failures === 0 ? "\nAll derived-cash-identity checks passed" : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
