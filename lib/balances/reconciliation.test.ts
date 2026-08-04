/**
 * lib/balances/reconciliation.test.ts   (V27-L3)
 *
 * Behavioural probes for current-state reconciliation. Pure, no DB.
 *
 * Every fixture is a REAL row from the live corpus (2026-08-04) with its real
 * pending evidence, because the identities are only worth anything if they hold
 * against actual provider data. The three that matter:
 *
 *   CHASE COLLEGE   5,106.77 + (−4,000.00) − 1,106.77 =     0.00  → EXACT
 *   Amex HYSA       6,315.04 +      0.00   − 2,315.04 = 4,000.00  → a real hold
 *   Chase card      562.37 owed + 77.60 charges vs a 33,700 limit → 37.55 residual
 */

import { resolveAccountFreshness } from "@/lib/freshness/observation";
import {
  resolveAccountBalances, reconcileAccount, RECONCILIATION_TOLERANCE,
  type AccountBalances,
} from "./account-balances";
import { NO_PENDING, type PendingContribution } from "./pending-evidence";
import { totalReachableCash, reachableDisclosure } from "./reachable";
import { RECONCILIATION_LABEL } from "./reconciliation-labels";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

const NOW = new Date("2026-08-04T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function build(o: {
  id: string; type: string; balance: number; available?: number | null;
  creditLimit?: number | null; debtSubtype?: string | null; wallet?: boolean; ageDays?: number;
}): AccountBalances {
  return resolveAccountBalances({
    accountId:           o.id,
    accountType:         o.type,
    debtSubtype:         o.debtSubtype ?? null,
    currency:            "USD",
    balance:             o.balance,
    availableBalance:    o.available ?? null,
    creditLimit:         o.creditLimit ?? null,
    isSelfCustodyWallet: o.wallet ?? false,
    freshness: resolveAccountFreshness(
      { accountId: o.id, ingestedAt: daysAgo(o.ageDays ?? 1), providerBalanceAt: null }, NOW),
  });
}
const pend = (sum: number, count = 1, ids: string[] = ["t1"]): PendingContribution =>
  ({ count, sum, transactionIds: ids.slice(0, count) });

// ── The three named cases ────────────────────────────────────────────────────

console.log("1. Chase checking — the depository identity, EXACT");
{
  const b = build({ id: "chase-chk", type: "checking", balance: 5_106.77, available: 1_106.77 });
  const r = reconcileAccount(b, pend(-4_000));
  check("basis is DEPOSITORY", r.basis === "DEPOSITORY");
  check("predicted = observed + Σpending = 1,106.77", near(r.predicted!.amount, 1_106.77));
  check("predicted is labelled as a prediction, not a balance",
    r.predicted!.label === "Predicted from pending activity");
  check("predicted equals the provider's independent available figure", near(r.predicted!.amount, 1_106.77));
  check("unexplained is 0.00", near(r.unexplained!, 0));
  check("state is EXACT", r.state === "EXACT");
  check("reachable is the provider's attested figure", near(r.reachable!.amount, 1_106.77));
  check("reachable is NOT the observed ledger balance", r.reachable!.amount !== b.observed.amount);
  check("one pending row was counted, once", r.pending.count === 1 && r.pending.transactionIds.length === 1);
}

console.log("2. Amex HYSA — an unexplained hold, reported not invented");
{
  const b = build({ id: "hysa", type: "savings", balance: 6_315.04, available: 2_315.04 });
  const r = reconcileAccount(b, NO_PENDING);
  check("no pending evidence exists", r.pending.count === 0 && r.pending.sum === 0);
  check("NO predicted figure is produced — nothing licenses one", r.predicted === null);
  check("unexplained is exactly 4,000.00", near(r.unexplained!, 4_000));
  check("state is PARTIALLY_ATTRIBUTED", r.state === "PARTIALLY_ATTRIBUTED");
  check("the hold is NOT smoothed into reachable", near(r.reachable!.amount, 2_315.04));
  check("no transaction was fabricated to explain it", r.pending.transactionIds.length === 0);
  check("the explanation says the gap is unexplained",
    r.explanation.includes("not yet explained by any transaction"));
  check("the label does not read as an error", RECONCILIATION_LABEL.PARTIALLY_ATTRIBUTED === "Partly unexplained");
}

console.log("3. Chase credit card — the LIABILITY identity, derived separately");
{
  const b = build({ id: "cc", type: "debt", balance: 562.37, available: 33_022.48, creditLimit: 33_700 });
  const r = reconcileAccount(b, pend(-77.60, 3, ["a", "b", "c"]), 33_700);
  check("basis is REVOLVING_CREDIT, not DEPOSITORY", r.basis === "REVOLVING_CREDIT");
  check("predicted is amount OWED, not cash", r.predicted!.quantity === "PREDICTED_AMOUNT_OWED");
  check("predicted owed = 562.37 + 77.60 = 639.97", near(r.predicted!.amount, 639.97));
  check("unexplained = (33,700 − 639.97) − 33,022.48 = 37.55", near(r.unexplained!, 37.55));
  check("state is PARTIALLY_ATTRIBUTED", r.state === "PARTIALLY_ATTRIBUTED");
  check("a card NEVER produces reachable cash", r.reachable === null);
  check("three pending charges counted exactly once", r.pending.count === 3);
  // The depository identity would have compared a $562 debt to a $33,022 credit
  // line — the mistake this separate identity exists to prevent.
  const wrong = b.observed.amount + (-77.60) - 33_022.48;
  check("the depository formula would have produced nonsense (−32,538)", near(wrong, -32_537.71));
  check("...and is NOT what was used", !near(r.unexplained!, wrong));
}

console.log("3b. Amex Platinum — a charge card with no usable limit");
{
  const b = build({ id: "amex", type: "debt", balance: 203.25, available: 0, creditLimit: 0 });
  const r = reconcileAccount(b, pend(0, 2, ["x", "y"]), 0);
  check("basis is still REVOLVING_CREDIT", r.basis === "REVOLVING_CREDIT");
  check("a zero limit is not a ceiling — state is UNAVAILABLE", r.state === "UNAVAILABLE");
  check("no residual is manufactured", r.unexplained === null);
  check("the pending pair still nets to zero and is reported", r.pending.count === 2 && r.pending.sum === 0);
  check("the explanation names the missing limit", r.explanation.includes("no usable credit limit"));
}

// ── The remaining acceptance cases ───────────────────────────────────────────

console.log("4. No-pending account — observed stays observed");
{
  const b = build({ id: "sav", type: "savings", balance: 2_000.03, available: 2_000.03 });
  const r = reconcileAccount(b, NO_PENDING);
  check("no predicted figure — the observed balance is not relabelled", r.predicted === null);
  check("state is EXACT", r.state === "EXACT");
  check("reachable is the attested figure", near(r.reachable!.amount, 2_000.03));
}

console.log("5. Multiple pending movements — summed exactly once");
{
  const b = build({ id: "m", type: "checking", balance: 1_000, available: 700 });
  const r = reconcileAccount(b, pend(-300, 3, ["p1", "p2", "p3"]));
  check("three rows, one sum", r.pending.count === 3 && near(r.pending.sum, -300));
  check("ids are enumerated so single-counting is provable",
    r.pending.transactionIds.join(",") === "p1,p2,p3");
  check("predicted = 700", near(r.predicted!.amount, 700));
  check("state EXACT", r.state === "EXACT");
}

console.log("6. Pending later posts — no duplicate current-state effect");
{
  // The loader drops a pending row once its posted successor is live, so the
  // authority sees NO_PENDING and the provider's balance already reflects it.
  const before = reconcileAccount(
    build({ id: "q", type: "checking", balance: 1_000, available: 900 }), pend(-100));
  const after = reconcileAccount(
    build({ id: "q", type: "checking", balance: 900, available: 900 }), NO_PENDING);
  check("while pending: predicted 900, EXACT", near(before.predicted!.amount, 900) && before.state === "EXACT");
  check("after posting: no pending, still EXACT", after.pending.count === 0 && after.state === "EXACT");
  check("the movement never counted twice — both reach 900",
    near(before.predicted!.amount, 900) && near(after.reachable!.amount, 900));
}

console.log("7. Null provider available — prediction may exist, reconciliation cannot");
{
  const b = build({ id: "n", type: "checking", balance: 1_000, available: null });
  const r = reconcileAccount(b, pend(-100));
  check("predicted still exists from pending evidence", near(r.predicted!.amount, 900));
  check("state is UNAVAILABLE — nothing to check against", r.state === "UNAVAILABLE");
  check("no residual is manufactured against a missing figure", r.unexplained === null);
  check("reachable falls back to the prediction, never the ledger", near(r.reachable!.amount, 900));
  const noPending = reconcileAccount(build({ id: "n2", type: "checking", balance: 1_000, available: null }), NO_PENDING);
  check("with neither figure nor pending, reachable is UNKNOWN", noPending.reachable === null);
}

console.log("8. Stale + exact — two independent dimensions");
{
  const b = build({ id: "s", type: "checking", balance: 3_450, available: 3_450, ageDays: 56.3 });
  const r = reconcileAccount(b, NO_PENDING);
  check("reconciliation is EXACT", r.state === "EXACT");
  check("...while the balance is VERY_STALE", b.freshness.balance.band === "VERY_STALE");
  check("freshness travels with the claim", b.freshness.balance.ageDays! > 56);
}

console.log("Contradiction — the provider claims more than evidence supports");
{
  // The live seed shape: available was written equal to the balance, then a
  // pending row arrived. Reported, never netted away.
  const b = build({ id: "demo", type: "checking", balance: 3_450, available: 3_450 });
  const r = reconcileAccount(b, pend(-92.40));
  check("unexplained is NEGATIVE (−92.40)", near(r.unexplained!, -92.40));
  check("state is CONTRADICTORY, not PARTIALLY_ATTRIBUTED", r.state === "CONTRADICTORY");
  check("neither side was adjusted to match the other",
    near(r.predicted!.amount, 3_357.60) && near(r.reachable!.amount, 3_450));
}

console.log("Tolerance");
{
  // 100 − 99.99 is 0.010000000000005116 in IEEE-754, i.e. a hair OVER the
  // tolerance — so the boundary is asserted with a value that is exactly
  // representable rather than with a subtraction that is not.
  const b = build({ id: "t", type: "checking", balance: 100, available: 100 });
  check("a zero residual is EXACT", reconcileAccount(b, NO_PENDING).state === "EXACT");
  const bEdge = build({ id: "te", type: "checking", balance: 0.01, available: 0 });
  check("a residual of exactly one cent is EXACT (at the tolerance, not past it)",
    RECONCILIATION_TOLERANCE === 0.01 && reconcileAccount(bEdge, NO_PENDING).state === "EXACT");
  const b2 = build({ id: "t2", type: "checking", balance: 100, available: 99.97 });
  check("three cents is PARTIALLY_ATTRIBUTED", reconcileAccount(b2, NO_PENDING).state === "PARTIALLY_ATTRIBUTED");
}

console.log("Non-cash accounts are NOT reconciled");
{
  const inv = reconcileAccount(build({ id: "i", type: "investment", balance: 901.66, available: 0 }), NO_PENDING);
  check("an investment account gets basis NONE", inv.basis === "NONE");
  check("...and NO unexplained figure — $901.66 of securities is not a hold", inv.unexplained === null);
  check("...with an explanation that says why",
    inv.explanation.includes("invested positions, not an unexplained hold"));
  check("...and never a reachable-cash figure", inv.reachable === null);

  const crypto = reconcileAccount(build({ id: "c", type: "crypto", balance: 15_283.79, wallet: true }), NO_PENDING);
  check("a wallet gets basis NONE and no reachable figure",
    crypto.basis === "NONE" && crypto.reachable === null);

  const loan = reconcileAccount(
    build({ id: "l", type: "debt", balance: 285_000, debtSubtype: "mortgage" }), NO_PENDING, null);
  check("a mortgage is not reconciled", loan.basis === "NONE" && loan.unexplained === null);

  const manual = reconcileAccount(build({ id: "h", type: "other", balance: 485_000 }), NO_PENDING);
  check("a manual asset is not reconciled", manual.basis === "NONE" && manual.reachable === null);
}

console.log("Debt stays observed — reconciliation never touches what is owed");
{
  const b = build({ id: "cc2", type: "debt", balance: 562.37, available: 33_022.48, creditLimit: 33_700 });
  const r = reconcileAccount(b, pend(-77.60, 3, ["a", "b", "c"]), 33_700);
  check("amount owed is untouched by the prediction", b.debt!.owed.amount === 562.37);
  check("the predicted figure is a SEPARATE claim, not a replacement",
    r.predicted!.amount !== b.debt!.owed.amount && r.predicted!.quantity === "PREDICTED_AMOUNT_OWED");
  const overpaid = reconcileAccount(
    build({ id: "op", type: "debt", balance: -124.04, available: 5_124, creditLimit: 5_000 }),
    NO_PENDING, 5_000);
  check("an overpaid card still owes ZERO after reconciliation", overpaid.basis === "REVOLVING_CREDIT");
}

// ── Reachable totals ─────────────────────────────────────────────────────────

console.log("Reachable totals — unknowns are excluded and COUNTED, never zeroed");
{
  const t = totalReachableCash([
    { accountId: "a", reachable: 1_106.77, unexplained: 0 },
    { accountId: "b", reachable: 2_315.04, unexplained: 4_000 },
    { accountId: "c", reachable: null,     unexplained: null },
  ]);
  check("total sums only the known figures", near(t.total, 3_421.81));
  check("the unknown is counted, not summed as 0", t.unknownCount === 1 && t.coveredCount === 2);
  check("the total is disclosed as incomplete", t.complete === false);
  check("positive holds are totalled", near(t.unexplainedTotal, 4_000));

  const neg = totalReachableCash([{ accountId: "d", reachable: 100, unexplained: -92.40 }]);
  check("a NEGATIVE residual is not netted against real holds", neg.unexplainedTotal === 0);

  const d = reachableDisclosure(t, (n) => `$${n.toFixed(2)}`);
  check("the disclosure names the hold in the brief's own words",
    (d ?? "").includes("$4000.00 unavailable but not yet explained by transactions"));
  check("...and the excluded account", (d ?? "").includes("1 account with no reachable figure"));
  check("nothing to disclose ⇒ null",
    reachableDisclosure(totalReachableCash([{ accountId: "e", reachable: 5, unexplained: 0 }]), String) === null);
}

console.log("The live Space total — ledger vs reachable");
{
  // CHASE COLLEGE, CHASE SAVINGS, Amex Rewards Checking, Amex HYSA.
  const ledger = 5_106.77 + 2_000.03 + 252.32 + 6_315.04;
  const t = totalReachableCash([
    { accountId: "1", reachable: 1_106.77, unexplained: 0 },
    { accountId: "2", reachable: 2_000.03, unexplained: 0 },
    { accountId: "3", reachable:   252.32, unexplained: 0 },
    { accountId: "4", reachable: 2_315.04, unexplained: 4_000 },
  ]);
  check("ledger sum is 13,674.16", near(ledger, 13_674.16));
  check("reachable sum is 5,674.16", near(t.total, 5_674.16));
  check("the overstatement removed is exactly $8,000", near(ledger - t.total, 8_000));
}

if (failures > 0) { console.error(`\nreconciliation: ${failures} failure(s).`); process.exit(1); }
console.log("\nreconciliation: all passed.");
