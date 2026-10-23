/**
 * lib/plaid/refresh-balance-write.test.ts   (FIN-011)
 *
 * A NULL `current` BALANCE IS NOT AN OBSERVATION. `refreshBalancesForItem` used
 * to keep the prior balance on a transient null (right) while overwriting
 * `balanceLastUpdatedAt` and stamping `lastUpdated = now` (wrong), so every
 * freshness surface called a number nobody had seen "verified just now". The
 * write is now planned by the pure `planBalanceWrite`, pinned here.
 *
 *     npx tsx --require scripts/lib/server-only-preload.cjs lib/plaid/refresh-balance-write.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { planBalanceWrite } from "./refresh";

let failures = 0, passed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed++;
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// 1. An observed balance writes the balance AND both clocks.
{
  const p = planBalanceWrite({ current: 1234.56, available: 1200, limit: null, last_updated_datetime: "2026-10-21T11:30:00Z" }, "checking");
  check("observed ⇒ observed=true", p.observed === true);
  check("observed ⇒ balance written", p.data.balance === 1234.56);
  check("observed ⇒ provider attestation written verbatim",
    p.data.balanceLastUpdatedAt?.toISOString() === "2026-10-21T11:30:00.000Z");
  check("observed ⇒ available / subtype / syncStatus written", p.data.availableBalance === 1200 && p.data.providerSubtype === "checking" && p.data.syncStatus === "synced");
  const noAttest = planBalanceWrite({ current: 10, last_updated_datetime: null }, null);
  check("observed with no provider attestation ⇒ balanceLastUpdatedAt written as null (what Plaid returned)",
    "balanceLastUpdatedAt" in noAttest.data && noAttest.data.balanceLastUpdatedAt === null);
}

// 2. A null `current` keeps the prior balance AND the prior clocks.
{
  const p = planBalanceWrite({ current: null, available: 900, limit: 5000, last_updated_datetime: "2026-10-21T11:30:00Z" }, "credit card");
  check("null current ⇒ observed=false", p.observed === false);
  check("null current ⇒ NO balance key (the prior balance stands untouched)", !("balance" in p.data));
  check("null current ⇒ NO provider attestation write, even when Plaid sent a timestamp beside the null",
    !("balanceLastUpdatedAt" in p.data));
  check("null current ⇒ the side facts the answer DID carry are still written",
    p.data.availableBalance === 900 && p.data.creditLimit === 5000 && p.data.providerSubtype === "credit card" && p.data.syncStatus === "synced");
  const undef = planBalanceWrite({ current: undefined }, undefined);
  check("undefined current ⇒ same as null", undef.observed === false && !("balance" in undef.data));
  const nan = planBalanceWrite({ current: Number.NaN }, undefined);
  check("a non-finite current is not an observation either", nan.observed === false && !("balance" in nan.data));
}

// 3. The authority consumes the plan — pinned at the source.
{
  const src = readFileSync(path.join(__dirname, "refresh.ts"), "utf8");
  check("refreshBalancesForItem writes the planned data", /\.\.\.plan\.data/.test(src));
  check("the balance-verified stamp (lastUpdated) is written ONLY when a balance was observed",
    /plan\.observed && \{ lastUpdated: new Date\(\) \}/.test(src));
  check("coverage freshnessAdvanced follows the plan, not a constant", /freshnessAdvanced: plan\.observed/.test(src));
  check("no remaining unconditional balance-verified stamp in the balance loop",
    !/balance: acct\.balances\.current \?\? fa\.balance/.test(src));
}

console.log(failures === 0 ? `\nFIN-011 balance write: ${passed} checks passed.` : `\n${failures} FAILED (${passed} passed)`);
process.exit(failures === 0 ? 0 : 1);
