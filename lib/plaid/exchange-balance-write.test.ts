/**
 * lib/plaid/exchange-balance-write.test.ts   (FM-AUDIT-023, token-exchange half)
 *
 * The FIN-011 rule on the EXCHANGE path. At connect/reconnect a null Plaid
 * `current` used to be written as `balance: 0` with `lastUpdated = now` on an
 * existing row — a false zero, stamped "verified just now". The two existing-row
 * writes now spread `planExchangeBalanceStamp`, which shares FIN-011's
 * `isObservedBalance` predicate with `planBalanceWrite`.
 *
 * performPlaidTokenExchange is end-to-end Plaid + DB, so the wiring is pinned
 * structurally (house pattern: exchange-account-isolation.test.ts) and the rule
 * itself is pinned on the pure planner.
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/plaid/exchange-balance-write.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { isObservedBalance, planBalanceWrite, planExchangeBalanceStamp } from "./refresh";

let failures = 0, passed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed++;
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = new Date("2026-01-15T12:00:00Z");

// 1. Observed balance ⇒ exactly what the exchange wrote before (balance + lastUpdated).
{
  const s = planExchangeBalanceStamp(1234.56, NOW);
  check("observed ⇒ balance written", s.balance === 1234.56);
  check("observed ⇒ balance-verified stamp written", s.lastUpdated === NOW);
  check("observed ⇒ ONLY balance + lastUpdated (no new balanceLastUpdatedAt write on the exchange)",
    JSON.stringify(Object.keys(s).sort()) === JSON.stringify(["balance", "lastUpdated"]));
  check("observed zero is still an observation", planExchangeBalanceStamp(0, NOW).balance === 0);
  check("observed negative (card credit) is still an observation", planExchangeBalanceStamp(-12.5, NOW).balance === -12.5);
}

// 2. Null / undefined / non-finite ⇒ nothing about the balance is written.
for (const [label, v] of [["null", null], ["undefined", undefined], ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY]] as const) {
  const s = planExchangeBalanceStamp(v, NOW);
  check(`${label} current ⇒ no balance key (prior balance stands)`, !("balance" in s));
  check(`${label} current ⇒ no lastUpdated key (prior clock stands)`, !("lastUpdated" in s));
}

// 3. One predicate, two authorities — the exchange and refresh cannot disagree.
for (const v of [0, 1, -1, 1e9, null, undefined, Number.NaN, Number.NEGATIVE_INFINITY]) {
  check(`exchange and refresh agree on observed(${String(v)})`,
    ("balance" in planExchangeBalanceStamp(v, NOW)) === planBalanceWrite({ current: v }, null).observed
    && planBalanceWrite({ current: v }, null).observed === isObservedBalance(v));
}

// 4. Simulated existing row: the prior value and timestamp survive a null; a
//    non-null overwrites exactly as before.
{
  const prior = { balance: 500, lastUpdated: new Date("2025-12-01T00:00:00Z"), availableBalance: 450 };
  const afterNull = { ...prior, ...planExchangeBalanceStamp(null, NOW), availableBalance: 400 };
  check("existing row + null ⇒ prior balance kept", afterNull.balance === 500);
  check("existing row + null ⇒ prior lastUpdated kept", afterNull.lastUpdated.getTime() === prior.lastUpdated.getTime());
  const afterObserved = { ...prior, ...planExchangeBalanceStamp(510, NOW) };
  check("existing row + observed ⇒ balance + clock move", afterObserved.balance === 510 && afterObserved.lastUpdated === NOW);
}

// 5. Wiring in exchangeToken.ts — all three balance sites.
{
  const code = readFileSync(path.join(__dirname, "exchangeToken.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const loopAt = code.indexOf("for (const acct of plaidAccounts) {");
  const loop = code.slice(loopAt, code.indexOf("const investmentAccounts", loopAt));
  check("the account loop is found", loopAt > 0 && loop.length > 500);
  check("site 1 (compute): no `current ?? 0` anywhere in the exchange", !/balances\.current \?\? 0/.test(code));
  check("site 1 (compute): the stamp is planned from Plaid's current via the shared planner",
    /const balanceStamp\s*=\s*planExchangeBalanceStamp\(acct\.balances\.current, new Date\(\)\)/.test(loop));
  const spreads = loop.match(/\.\.\.balanceStamp,/g) ?? [];
  check("sites 2+3 (resolved/restored row, fingerprint-reused row): both updates spread the stamp", spreads.length === 2, `${spreads.length}`);
  check("no unconditional balance-verified stamp left in the account loop", !/lastUpdated:\s*new Date\(\)/.test(loop));
  check("no bare `balance,` shorthand write left (would be an undeclared or unconditional balance)", !/^\s*balance,\s*$/m.test(loop));
  const updates = loop.split("db.financialAccount.update(").slice(1);
  check("two financialAccount.update calls in the loop", updates.length === 2, `${updates.length}`);
  for (const [i, u] of updates.entries()) {
    const data = u.slice(0, u.indexOf("});"));
    check(`update #${i + 1} writes the stamp and still restores + marks synced`,
      /\.\.\.balanceStamp/.test(data) && /deletedAt:\s*null/.test(data) && /syncStatus:\s*"synced"/.test(data));
  }
  const create = loop.slice(loop.indexOf("db.financialAccount.create("));
  check("new row (create): observed balance written, null still 0 (open — no unknown state in schema)",
    /balance:\s*balanceStamp\.balance \?\? 0,/.test(create.slice(0, create.indexOf("});"))));
  check("availableBalance null stays unwritten (`?? undefined`), never coerced to 0",
    /const availableBalance = acct\.balances\.available \?\? undefined;/.test(loop) && !/available \?\? 0/.test(loop));
  check("creditLimit null stays unwritten (`?? undefined`), never coerced to 0",
    /const creditLimit\s*= acct\.balances\.limit \?\? undefined;/.test(loop) && !/limit \?\? 0/.test(loop));
}

if (failures > 0) { console.error(`\n❌ exchange balance write: ${failures} check(s) failed (${passed} passed)`); process.exit(1); }
console.log(`\n✅ exchange balance write: ${passed} checks passed`);
