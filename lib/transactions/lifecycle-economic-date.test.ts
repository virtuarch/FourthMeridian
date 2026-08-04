/**
 * lib/transactions/lifecycle-economic-date.test.ts   (V27-L4A/B/C/D)
 *
 * Behavioural probes for the lifecycle, economic-date and transfer-maturation
 * authorities. Pure, no DB. Every fixture is a real row or a real measured shape
 * from the corpus (2026-08-04).
 */

import {
  resolveLifecycle, contributesPendingEvidence, LIFECYCLE_LABEL,
} from "./lifecycle";
import {
  resolveEconomicDate, economicPeriod, crossesPeriodBoundary,
  ECONOMIC_DATE_MAX_LAG_DAYS,
} from "./economic-date";
import {
  matureClassification, adoptIfMonotonic, adoptRetraction, maturityRank, isTransferCandidate,
  impliedFlowType, TRANSFER_MATCH_WINDOW_DAYS, MATURITY_LABEL,
  resolveDestinationEvidence, maturityForEvidence,
} from "./transfer-maturation";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── 4A — LIFECYCLE ───────────────────────────────────────────────────────────

console.log("4A. Lifecycle — settlementState is the authority, pending is compatibility");
{
  const posted = resolveLifecycle({ settlementState: "POSTED", pending: false, deletedAt: null });
  check("POSTED from the column", posted.state === "POSTED" && posted.basis === "SETTLEMENT_STATE");

  const pending = resolveLifecycle({ settlementState: "PENDING", pending: true, deletedAt: null });
  check("PENDING from the column", pending.state === "PENDING" && pending.basis === "SETTLEMENT_STATE");
  check("a live pending row contributes evidence", contributesPendingEvidence(pending));

  // The 352 seed rows: column unpopulated, boolean is all we have.
  const seedPosted = resolveLifecycle({ settlementState: null, pending: false, deletedAt: null });
  check("unpopulated column falls back to the boolean", seedPosted.state === "POSTED");
  check("...and SAYS it used the compatibility flag", seedPosted.basis === "COMPATIBILITY_FLAG");
  const seedPending = resolveLifecycle({ settlementState: null, pending: true, deletedAt: null });
  check("a seed pending row still contributes evidence", contributesPendingEvidence(seedPending));
  check("null is treated as UNPOPULATED, never as POSTED", seedPending.state === "PENDING");

  check("no row is reported as a contradiction when the column is merely absent",
    seedPosted.columnsDisagree === false && seedPending.columnsDisagree === false);
}

console.log("4A. Lifecycle — tombstones split on successor evidence");
{
  // 37 of 44: a real PENDING → POSTED transition.
  const transitioned = resolveLifecycle({
    settlementState: "PENDING", pending: true, deletedAt: new Date("2026-08-01"),
    hasLivePostedSuccessor: true,
  });
  check("tombstone WITH a live posted successor ⇒ the event POSTED", transitioned.state === "POSTED");
  check("...and the row is marked superseded", transitioned.superseded === true);
  check("...so it contributes NO pending evidence", !contributesPendingEvidence(transitioned));

  // 7 of 44: removed with no replacement.
  const withdrawn = resolveLifecycle({
    settlementState: "PENDING", pending: true, deletedAt: new Date("2026-08-01"),
    hasLivePostedSuccessor: false,
  });
  check("tombstone WITHOUT a successor ⇒ WITHDRAWN", withdrawn.state === "WITHDRAWN");
  check("...and contributes nothing", !contributesPendingEvidence(withdrawn));
  check("WITHDRAWN is one state, not a guess between cancelled and expired",
    LIFECYCLE_LABEL.WITHDRAWN === "Withdrawn");

  const notLookedUp = resolveLifecycle({
    settlementState: "PENDING", pending: true, deletedAt: new Date("2026-08-01"),
  });
  check("a tombstone nobody checked is UNKNOWN, not guessed", notLookedUp.state === "UNKNOWN");
}

console.log("4A. Lifecycle — an actual contradiction is reported, and the column wins");
{
  const c = resolveLifecycle({ settlementState: "PENDING", pending: false, deletedAt: null });
  check("disagreement is flagged", c.columnsDisagree === true);
  check("settlementState wins", c.state === "PENDING" && c.basis === "SETTLEMENT_STATE");
  const c2 = resolveLifecycle({ settlementState: "POSTED", pending: true, deletedAt: null });
  check("...in both directions", c2.columnsDisagree === true && c2.state === "POSTED");
  check("a POSTED row never contributes pending evidence", !contributesPendingEvidence(c2));
}

// ── 4B — ECONOMIC DATE ───────────────────────────────────────────────────────

console.log("4B. Economic date — the Friday → Sunday proof");
{
  // Tap Talabat Food, live: authorized 2026-07-29, posted 2026-08-02.
  const r = resolveEconomicDate({ postingDate: "2026-08-02", authorizedAt: "2026-07-29" });
  check("economicDate is the AUTHORIZATION date", r.economicDate === "2026-07-29");
  check("postingDate is preserved, unchanged", r.postingDate === "2026-08-02");
  check("basis names the evidence", r.basis === "AUTHORIZATION" && r.state === "OK");
  check("the lag is reported", r.lagDays === 4);
  check("the event belongs to JULY, not August", economicPeriod(r) === "2026-07");
  check("...and the month crossing is detectable", crossesPeriodBoundary(r) === true);

  // Amazon: authorized 2026-07-23 → posted 2026-07-26.
  const amazon = resolveEconomicDate({ postingDate: "2026-07-26", authorizedAt: "2026-07-23" });
  check("Amazon keeps 2026-07-23", amazon.economicDate === "2026-07-23" && amazon.lagDays === 3);
  // Shake Shack: authorized 2026-07-16 → posted 2026-07-19.
  const shake = resolveEconomicDate({ postingDate: "2026-07-19", authorizedAt: "2026-07-16" });
  check("Shake Shack keeps 2026-07-16", shake.economicDate === "2026-07-16" && shake.lagDays === 3);
  check("neither crosses a month boundary",
    !crossesPeriodBoundary(amazon) && !crossesPeriodBoundary(shake));
}

console.log("4B. Economic date — immutable across the lifecycle transition");
{
  // While PENDING, Plaid's `date` IS the authorization date.
  const whilePending = resolveEconomicDate({ postingDate: "2026-07-29", authorizedAt: "2026-07-29" });
  // After POSTING, Plaid rewrites `date` to 2026-08-02 — but authorizedAt does not move.
  const afterPosting = resolveEconomicDate({ postingDate: "2026-08-02", authorizedAt: "2026-07-29" });
  check("the economic date is IDENTICAL before and after posting",
    whilePending.economicDate === afterPosting.economicDate);
  check("only the posting date moved",
    whilePending.postingDate === "2026-07-29" && afterPosting.postingDate === "2026-08-02");
  check("a July purchase does NOT migrate into August",
    economicPeriod(afterPosting) === "2026-07");
  check("a closed July total therefore cannot change because of an August posting",
    economicPeriod(whilePending) === economicPeriod(afterPosting));
}

console.log("4B. Economic date — the two 38-day outliers");
{
  // Amex Platinum · "AplPay Hunger StatioRIYADH SA" · authorized 2025-04-14, posted 2025-05-22.
  const r = resolveEconomicDate({ postingDate: "2025-05-22", authorizedAt: "2025-04-14" });
  check("38 days is beyond the bound ⇒ CONTRADICTORY", r.state === "CONTRADICTORY");
  check("the authorization is NOT silently accepted", r.economicDate !== "2025-04-14");
  check("...and NOT silently discarded — the reason states the disagreement",
    (r.reason ?? "").includes("38 days") && (r.reason ?? "").includes("beyond"));
  check("it falls back to the posting date", r.economicDate === "2025-05-22");
  check("so $25 does not move from May into April's closed totals",
    economicPeriod(r) === "2025-05");

  // The bound sits inside the empty region the data drew.
  const atBound = resolveEconomicDate({ postingDate: "2026-01-15", authorizedAt: "2026-01-01" });
  check(`${ECONOMIC_DATE_MAX_LAG_DAYS} days is still credible`,
    atBound.state === "OK" && atBound.economicDate === "2026-01-01");
  const pastBound = resolveEconomicDate({ postingDate: "2026-01-16", authorizedAt: "2026-01-01" });
  check("one day past the bound is not", pastBound.state === "CONTRADICTORY");
  check("the largest OBSERVED credible lag (8d) is comfortably inside",
    resolveEconomicDate({ postingDate: "2026-01-09", authorizedAt: "2026-01-01" }).state === "OK");
}

console.log("4B. Economic date — inverted and absent evidence");
{
  const inverted = resolveEconomicDate({ postingDate: "2026-01-01", authorizedAt: "2026-01-05" });
  check("an authorization AFTER the posting is CONTRADICTORY", inverted.state === "CONTRADICTORY");
  check("...and falls back to posting", inverted.economicDate === "2026-01-01");

  const none = resolveEconomicDate({ postingDate: "2026-05-05" });
  check("no authorization ⇒ the posting date, basis POSTING",
    none.economicDate === "2026-05-05" && none.basis === "POSTING" && none.state === "OK");

  const imported = resolveEconomicDate({ postingDate: "2026-05-05", userSupplied: true });
  check("a user-supplied date says so", imported.basis === "USER_SUPPLIED");

  const firstPending = resolveEconomicDate({ postingDate: "2026-05-08", firstPendingDate: "2026-05-05" });
  check("a first-pending observation outranks the posting date",
    firstPending.economicDate === "2026-05-05" && firstPending.basis === "FIRST_PENDING_OBSERVATION");
}

// ── 4C / 4D — CLASSIFICATION MATURATION ─────────────────────────────────────

console.log("4C. Classification — DEBT_PAYMENT rows ENTER the resolver");
{
  check("TRANSFER is a candidate", isTransferCandidate("TRANSFER"));
  check("DEBT_PAYMENT is a candidate — the row excluded from its own repair",
    isTransferCandidate("DEBT_PAYMENT"));
  check("UNKNOWN is a candidate", isTransferCandidate("UNKNOWN"));
  check("null (the 352 seed rows) is a candidate", isTransferCandidate(null));
  check("SPENDING is NOT a candidate", !isTransferCandidate("SPENDING"));
  check("INCOME is NOT a candidate", !isTransferCandidate("INCOME"));
}

console.log("4C. Classification — the least-specific honest default");
{
  // The live source leg: pending outflow, descriptor names American Express,
  // stored as DEBT_PAYMENT, destination NOT yet established.
  const r = matureClassification({ flowType: "DEBT_PAYMENT", amount: -4000, counterparty: null });
  check("with no destination evidence it is an UNRESOLVED transfer",
    r.maturity === "UNRESOLVED_TRANSFER" && r.rank === 0);
  check("direction is still known", r.direction === "OUTFLOW");
  check("it is a reclassification away from the unearned leaf", r.reclassified === true);
  check("the audit reason says why",
    r.reason.includes("descriptor naming an institution does not identify the destination"));
  check("nothing is persistable without evidence", r.persistable === false);
}

console.log("4D. Transfer maturation — the $4,000 Chase → Amex HYSA case");
{
  const r = matureClassification({
    flowType: "DEBT_PAYMENT", amount: -4000,
    counterparty: { accountId: "amex-hysa", accountType: "savings", evidence: "MATCHED_LEG" },
  });
  check("a SAVINGS destination makes it a savings transfer", r.maturity === "SAVINGS_TRANSFER");
  check("it is NOT a debt payment", r.maturity !== "DEBT_PAYMENT");
  check("...and the implied flow type is TRANSFER", impliedFlowType(r.maturity) === "TRANSFER");
  check("specificity reached the leaf", r.rank === 2);
  check("the reclassification is recorded", r.reclassified === true);
  check("the reason names the discriminator",
    r.reason.includes("SAVINGS") && r.reason.includes("savings"));
  check("the counterparty is carried", r.counterpartyAccountId === "amex-hysa");
  check("a uniquely matched leg IS strong enough to persist", r.persistable === true);
  check("the label reads correctly", MATURITY_LABEL[r.maturity] === "Savings transfer");
}

console.log("4D. Non-regression — a TRUE debt payment stays a debt payment");
{
  // Live counter-example: 2026-03-13, CHASE COLLEGE −4,000
  // "AMERICAN EXPRESS ACH PMT M9576" → Amex Platinum Card® (a LIABILITY).
  // Same institution, same amount, same direction, similar descriptor.
  const r = matureClassification({
    flowType: "DEBT_PAYMENT", amount: -4000,
    counterparty: { accountId: "amex-card", accountType: "debt", evidence: "MATCHED_LEG" },
  });
  check("a LIABILITY destination is a debt payment", r.maturity === "DEBT_PAYMENT");
  check("...and is NOT reclassified", r.reclassified === false);
  check("the implied flow type stays DEBT_PAYMENT", impliedFlowType(r.maturity) === "DEBT_PAYMENT");
  check("only the destination TYPE separates it from the savings case",
    r.maturity !== matureClassification({
      flowType: "DEBT_PAYMENT", amount: -4000,
      counterparty: { accountId: "x", accountType: "savings", evidence: "MATCHED_LEG" },
    }).maturity);
}

console.log("4D. Transfer maturation — every destination type");
{
  const t = (type: string) => matureClassification({
    flowType: "TRANSFER", amount: -100,
    counterparty: { accountId: "a", accountType: type, evidence: "MATCHED_LEG" },
  }).maturity;
  check("checking → internal cash transfer", t("checking") === "CASH_TRANSFER");
  check("savings → savings transfer", t("savings") === "SAVINGS_TRANSFER");
  check("debt → debt payment", t("debt") === "DEBT_PAYMENT");
  check("investment → investment transfer", t("investment") === "INVESTMENT_TRANSFER");
  check("crypto → investment transfer", t("crypto") === "INVESTMENT_TRANSFER");
  check("an unrecognised owned type stops at INTERNAL, not a guessed leaf",
    t("other") === "INTERNAL_TRANSFER" && maturityRank("INTERNAL_TRANSFER") === 1);
}

console.log("4D. Balance-gap evidence supports, never fabricates");
{
  const gapOnly = matureClassification({
    flowType: "DEBT_PAYMENT", amount: -4000,
    counterparty: { accountId: "hysa", accountType: "savings", evidence: "BALANCE_GAP_SUPPORT" },
  });
  check("a gap ALONE cannot establish a destination", gapOnly.maturity === "UNRESOLVED_TRANSFER");
  check("...and yields no counterparty id", gapOnly.counterpartyAccountId === null);
  check("...and is never persistable", gapOnly.persistable === false);
  check("the reason says a gap is not a transaction",
    gapOnly.reason.includes("a gap is not a transaction"));

  const supported = matureClassification({
    flowType: "DEBT_PAYMENT", amount: -4000,
    counterparty: { accountId: "hysa", accountType: "savings", evidence: "MATCHED_LEG" },
    balanceGapSupports: true,
  });
  check("a gap may SUPPORT a matched leg", supported.maturity === "SAVINGS_TRANSFER");
  check("...and the support is recorded in the reason",
    supported.reason.includes("balance-gap support"));
}

console.log("4D. Match window — evidence-derived, wider than the observed skew");
{
  check("the window exceeds the observed 3-day skew", TRANSFER_MATCH_WINDOW_DAYS > 3);
  check("...and is wider than the old 2-day bound that missed the real case",
    TRANSFER_MATCH_WINDOW_DAYS > 2);
  // Beyond ~6 days the corpus's pair density RISES again (recurrence, not lag),
  // so the bound must stop before that regime.
  check("...and stops before the recurrence regime begins (≤ 6)",
    TRANSFER_MATCH_WINDOW_DAYS <= 6);
  check("3 days — the real case — is inside the window", 3 <= TRANSFER_MATCH_WINDOW_DAYS);
}

console.log("4C. Monotonic specificity");
{
  const leaf = matureClassification({
    flowType: "TRANSFER", amount: -100,
    counterparty: { accountId: "a", accountType: "savings", evidence: "MATCHED_LEG" },
  });
  const unresolved = matureClassification({ flowType: "TRANSFER", amount: -100, counterparty: null });
  check("first assessment is always adopted", adoptIfMonotonic(null, leaf).adopt);
  check("rising specificity is adopted", adoptIfMonotonic("UNRESOLVED_TRANSFER", leaf).adopt);
  check("an unchanged assessment is adopted", adoptIfMonotonic("SAVINGS_TRANSFER", leaf).adopt);
  check("a DESCENT is refused", !adoptIfMonotonic("SAVINGS_TRANSFER", unresolved).adopt);
  check("...with the reason stated",
    adoptIfMonotonic("SAVINGS_TRANSFER", unresolved).reason.includes("Would reduce specificity"));
  const wrongLeaf = matureClassification({
    flowType: "TRANSFER", amount: -100,
    counterparty: { accountId: "b", accountType: "debt", evidence: "MATCHED_LEG" },
  });
  check("a same-rank correction IS adopted (a wrong destination is superseded)",
    adoptIfMonotonic("SAVINGS_TRANSFER", wrongLeaf).adopt);
}

console.log("4-AUDIT. Destination evidence levels");
{
  const A = resolveDestinationEvidence([{ accountId: "hysa", accountType: "savings" }]);
  check("one candidate ⇒ ACCOUNT_CERTAIN", A.level === "ACCOUNT_CERTAIN");
  check("...account and type both known", A.accountId === "hysa" && A.accountType === "savings");
  check("...and a counterparty MAY be persisted", A.persistableCounterparty === true);

  const B = resolveDestinationEvidence([
    { accountId: "hysa", accountType: "savings" },
    { accountId: "chase-sav", accountType: "savings" },
  ]);
  check("many candidates, ONE type ⇒ TYPE_CERTAIN_ACCOUNT_AMBIGUOUS",
    B.level === "TYPE_CERTAIN_ACCOUNT_AMBIGUOUS");
  check("...the TYPE is known", B.accountType === "savings");
  check("...the ACCOUNT is NOT — never guessed from the set", B.accountId === null);
  check("...so no counterparty may be persisted", B.persistableCounterparty === false);
  check("...and it still reaches the leaf", maturityForEvidence(B) === "SAVINGS_TRANSFER");

  const C = resolveDestinationEvidence([
    { accountId: "hysa", accountType: "savings" },
    { accountId: "card", accountType: "debt" },
  ]);
  check("candidates spanning types ⇒ TYPE_AMBIGUOUS", C.level === "TYPE_AMBIGUOUS");
  check("...nothing above 'a transfer happened'", maturityForEvidence(C) === "UNRESOLVED_TRANSFER");
  check("...and no type is claimed", C.accountType === null);

  const D = resolveDestinationEvidence([]);
  check("no candidates ⇒ NO_DESTINATION_EVIDENCE", D.level === "NO_DESTINATION_EVIDENCE");
  check("...distinct from TYPE_AMBIGUOUS — nothing to be ambiguous between",
    D.level !== C.level && maturityForEvidence(D) === "UNRESOLVED_TRANSFER");
}

console.log("4-AUDIT. The row's OWN account settles a liability inflow");
{
  // The 103-row defect the full-corpus audit exposed: "+$980.48 MOBILE PAYMENT -
  // THANK YOU" ARRIVING at the Platinum Card®, counterparty a CHECKING account.
  // Destination-type alone called it a cash transfer. It is a debt payment.
  const fromChecking = resolveDestinationEvidence([{ accountId: "chk", accountType: "checking" }]);
  check("destination type ALONE would say cash transfer",
    maturityForEvidence(fromChecking) === "CASH_TRANSFER");
  check("...but money INTO a liability is a debt payment",
    maturityForEvidence(fromChecking, { accountType: "debt", amount: 980.48 }) === "DEBT_PAYMENT");
  check("money OUT of a liability is never a debt payment (the structural veto)",
    maturityForEvidence(fromChecking, { accountType: "debt", amount: -50 }) === "UNRESOLVED_TRANSFER");
  check("a liability inflow resolves even with NO destination evidence",
    maturityForEvidence(resolveDestinationEvidence([]), { accountType: "debt", amount: 100 }) === "DEBT_PAYMENT");
  check("a non-liability row is unaffected — the destination still decides",
    maturityForEvidence(fromChecking, { accountType: "checking", amount: -50 }) === "CASH_TRANSFER");

  const r = matureClassification({
    flowType: "DEBT_PAYMENT", amount: 980.48, ownAccountType: "debt",
    destination: fromChecking,
  });
  check("matureClassification honours the own-side rule", r.maturity === "DEBT_PAYMENT");
  check("...and is NOT a reclassification", r.reclassified === false);
  check("...with a reason naming the receiving account's type",
    r.reason.includes("arriving at a liability account"));
}

console.log("4C. Retraction is NOT monotonicity — and a caller must say which");
{
  const unresolved = matureClassification({ flowType: "DEBT_PAYMENT", amount: -100, counterparty: null });
  check("monotonicity REFUSES the descent (its job is protecting knowledge)",
    !adoptIfMonotonic("DEBT_PAYMENT", unresolved).adopt);
  check("a retraction ALLOWS it when the prior leaf is asserted unearned",
    adoptRetraction("DEBT_PAYMENT", unresolved, { priorWasUnearned: true }).adopt);
  check("...and says what it retracted and why",
    adoptRetraction("DEBT_PAYMENT", unresolved, { priorWasUnearned: true }).reason
      .includes("not supported by evidence"));
  check("a retraction WITHOUT the assertion is refused — no accidental descents",
    !adoptRetraction("DEBT_PAYMENT", unresolved, { priorWasUnearned: false }).adopt);
  check("...and points the caller back at monotonicity",
    adoptRetraction("DEBT_PAYMENT", unresolved, { priorWasUnearned: false }).reason
      .includes("adoptIfMonotonic"));
  const leaf = matureClassification({
    flowType: "TRANSFER", amount: -100,
    counterparty: { accountId: "a", accountType: "savings", evidence: "MATCHED_LEG" },
  });
  check("a rise is not a retraction at all",
    adoptRetraction("UNRESOLVED_TRANSFER", leaf, { priorWasUnearned: true }).reason
      .includes("raises specificity"));
  check("an unchanged assessment retracts nothing",
    !adoptRetraction("SAVINGS_TRANSFER", leaf, { priorWasUnearned: true }).adopt);
  check("monotonicity is UNCHANGED for maturation",
    adoptIfMonotonic("UNRESOLVED_TRANSFER", leaf).adopt);
}

if (failures > 0) { console.error(`\nlifecycle-economic-date: ${failures} failure(s).`); process.exit(1); }
console.log("\nlifecycle-economic-date: all passed.");
