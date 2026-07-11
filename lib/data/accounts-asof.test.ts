/**
 * lib/data/accounts-asof.test.ts
 *
 * A5-S2 — pure tests for the as-of balance resolver core. Standalone (no DB, no
 * prisma generate); runs under the shared runner via tsx, house pattern:
 *
 *   npx tsx lib/data/accounts-asof.test.ts
 *
 * Covers every resolution class and the tier it stamps, plus determinism. The
 * DB binding (accounts-asof.ts) is validated on real data, not here — same
 * split as backfill-core.test.ts (pure) vs backfill.ts (orchestration).
 */

import { resolveAccountsAsOf } from "./accounts-asof.core";
import {
  ACCOUNTS,
  ASOF,
  CASH_DELTAS,
  CARD_DELTAS,
  TODAY,
} from "./accounts-asof.fixtures";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("resolveAccountsAsOf — in-coverage historical date (2026-07-02)");
{
  const r = resolveAccountsAsOf(ACCOUNTS, CASH_DELTAS, CARD_DELTAS, TODAY, ASOF.inCoverage);

  const chk = r.get("chk")!;
  check("checking walks back via transactions → 850", chk.balance === 850, `got ${chk.balance}`);
  check("checking method = cash-walkback", chk.method === "cash-walkback");
  check("checking tier = derived", chk.tier === "derived");

  const sav = r.get("sav")!;
  check("savings with no deltas holds flat at 5000 (still derived)",
    sav.balance === 5000 && sav.tier === "derived" && sav.method === "cash-walkback");

  const card = r.get("card")!;
  check("credit card owed walks back → 400", card.balance === 400, `got ${card.balance}`);
  check("card method = card-walkback, tier = derived",
    card.method === "card-walkback" && card.tier === "derived");

  const loan = r.get("loan")!;
  check("installment loan held flat at 10000 → estimated",
    loan.balance === 10000 && loan.method === "held-flat" && loan.tier === "estimated");

  const inv = r.get("inv")!;
  check("investment held flat at 20000 → estimated",
    inv.balance === 20000 && inv.method === "held-flat" && inv.tier === "estimated");

  check("every account is resolved exactly once", r.size === ACCOUNTS.length);
}

console.log("resolveAccountsAsOf — before an account's floor (incomplete)");
{
  // 2026-06-10 predates the investment's floor (2026-06-15) but not the others'.
  const r = resolveAccountsAsOf(ACCOUNTS, CASH_DELTAS, CARD_DELTAS, TODAY, ASOF.beforeInvFloor);

  const inv = r.get("inv")!;
  check("before-coverage account is incomplete", inv.tier === "incomplete");
  check("before-coverage method = before-coverage", inv.method === "before-coverage");
  check("before-coverage contributes 0, never a fabricated value", inv.balance === 0);

  const chk = r.get("chk")!;
  check("an in-coverage account on the same date is still derived (not incomplete)",
    chk.tier === "derived" && chk.method === "cash-walkback");
}

console.log("resolveAccountsAsOf — the present resolves to current observed balances");
{
  const r = resolveAccountsAsOf(ACCOUNTS, CASH_DELTAS, CARD_DELTAS, TODAY, ASOF.present);
  check("every account is observed at asOf = today",
    [...r.values()].every((v) => v.tier === "observed" && v.method === "observed"));
  check("observed balances equal the current balances",
    r.get("chk")!.balance === 1000 && r.get("card")!.balance === 500 && r.get("inv")!.balance === 20000);
}

console.log("resolveAccountsAsOf — determinism");
{
  const a = resolveAccountsAsOf(ACCOUNTS, CASH_DELTAS, CARD_DELTAS, TODAY, ASOF.inCoverage);
  const b = resolveAccountsAsOf(ACCOUNTS, CASH_DELTAS, CARD_DELTAS, TODAY, ASOF.inCoverage);
  const ser = (m: Map<string, unknown>) => JSON.stringify([...m.entries()]);
  check("identical inputs → byte-identical resolution", ser(a) === ser(b));

  // The resolver must not mutate its inputs (fixtures are reused across tests).
  check("input accounts untouched (chk still 1000)",
    ACCOUNTS.find((x) => x.id === "chk")!.balance === 1000);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll accounts-asof core checks passed");
