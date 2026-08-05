/**
 * lib/transactions/liability-inflow.test.ts   (V27-TRUTH-3)
 *
 * The issuer-credit authority, and its ONE integration point: the own-side
 * liability-inflow override in `maturityForEvidence`.
 *
 * The rule being replaced said "positive amount on a liability = debt payment".
 * These tests pin the inverted default: a debt payment must now be positively
 * attested, and every other outcome declines the claim rather than forcing it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  liabilityInflowIsCustomerPayment, PAYMENT_FAMILIES,
} from "./liability-inflow";
import {
  maturityForEvidence, resolveDestinationEvidence, impliedFlowType,
  isTransferCandidate, maturityRank, adoptIfMonotonic, matureClassification,
  MATURITY_LABEL,
} from "./transfer-maturation";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** No destination evidence — the common shape for a card credit. */
const NONE = resolveDestinationEvidence([]);
/** A mutually-unique owned funding leg. */
const OWNED = resolveDestinationEvidence([
  { legId: "chk-leg", accountId: "chk", accountType: "checking", competingSourceCount: 1, superseded: false },
]);

console.log("V27-TRUTH-3 (1). A payment-family inflow IS a debt payment");
{
  for (const family of PAYMENT_FAMILIES) {
    const v = liabilityInflowIsCustomerPayment({ providerFamily: family });
    check(`${family} ⇒ YES`, v.verdict === "YES");
    check(`...and matures to DEBT_PAYMENT`,
      maturityForEvidence(NONE, { accountType: "debt", amount: 120, providerFamily: family }) === "DEBT_PAYMENT");
  }
  check("the payment set is exactly the two observed families",
    PAYMENT_FAMILIES.size === 2 && PAYMENT_FAMILIES.has("LOAN_PAYMENTS") && PAYMENT_FAMILIES.has("LOAN_DISBURSEMENTS"));
}

console.log("V27-TRUTH-3 (2). A mutually matched owned funding leg IS a debt payment");
{
  // No family at all, but the transfer authority proved where the money came from.
  check("a mutually matched owned leg ⇒ DEBT_PAYMENT even with NO family",
    maturityForEvidence(OWNED, { accountType: "debt", amount: 500, providerFamily: null }) === "DEBT_PAYMENT");
  check("...and a PERSISTED counterparty does the same",
    maturityForEvidence(NONE, { accountType: "debt", amount: 500, providerFamily: null,
      persistedCounterpartyAccountId: "chk" }) === "DEBT_PAYMENT");
  check("an owned leg OUTRANKS a non-payment family",
    liabilityInflowIsCustomerPayment({ providerFamily: "OTHER", hasMutuallyMatchedOwnedCounterparty: true }).verdict === "YES");
  // ...but a NON-mutual match must not count: that is the V27-TRUTH-1 veto.
  const contested = resolveDestinationEvidence([
    { legId: "l", accountId: "chk", accountType: "checking", competingSourceCount: 2, superseded: false },
  ]);
  check("a NON-mutual match does NOT prove a payment",
    maturityForEvidence(contested, { accountType: "debt", amount: 500, providerFamily: null }) !== "DEBT_PAYMENT");
}

console.log("V27-TRUTH-3 (3). An issuer / non-payment family is NOT a debt payment");
{
  // The four live shapes, by FAMILY only — never by descriptor.
  for (const family of ["OTHER", "GOVERNMENT_AND_NON_PROFIT", "GENERAL_MERCHANDISE", "TRAVEL"]) {
    check(`${family} ⇒ NO`, liabilityInflowIsCustomerPayment({ providerFamily: family }).verdict === "NO");
    check(`...matures to ISSUER_CREDIT, not DEBT_PAYMENT`,
      maturityForEvidence(NONE, { accountType: "debt", amount: 363.8, providerFamily: family }) === "ISSUER_CREDIT");
  }
  const r = liabilityInflowIsCustomerPayment({ providerFamily: "OTHER" });
  check("...and the refusal names the reason", /issuer-originated credit/.test(r.reason));
}

console.log("V27-TRUTH-3 (4). No family and no match ⇒ UNDETERMINED, never forced");
{
  for (const family of [null, undefined, ""]) {
    check(`family ${JSON.stringify(family)} ⇒ UNDETERMINED`,
      liabilityInflowIsCustomerPayment({ providerFamily: family }).verdict === "UNDETERMINED");
  }
  const m = maturityForEvidence(NONE, { accountType: "debt", amount: 800, providerFamily: null });
  check("...matures to UNRESOLVED_LIABILITY_INFLOW", m === "UNRESOLVED_LIABILITY_INFLOW");
  check("...which is NOT a debt payment", m !== "DEBT_PAYMENT");
  check("...and is rank 0, so later evidence may still raise it", maturityRank(m) === 0);
  check("...a later matched funding leg DOES raise it",
    adoptIfMonotonic(m, matureClassification({
      flowType: "UNKNOWN", amount: 800, ownAccountType: "debt", destination: OWNED,
    })).adopt);
  check("UNDETERMINED is distinct from ISSUER_CREDIT — a positive finding vs a gap",
    m !== "ISSUER_CREDIT");
}

console.log("V27-TRUTH-3 (5). INCOME / INTEREST / REFUND rows never reach this rule");
{
  // Structural protection: they are not transfer candidates, so the corpus that
  // feeds the ladder excludes them entirely. This is what keeps the authority
  // narrow — it answers the debt-payment question and re-labels nothing.
  for (const ft of ["INCOME", "INTEREST", "REFUND", "SPENDING", "FEE", "INVESTMENT", "ADJUSTMENT"]) {
    check(`${ft} is NOT a transfer candidate`, !isTransferCandidate(ft));
  }
  for (const ft of ["TRANSFER", "DEBT_PAYMENT", "UNKNOWN", null]) {
    check(`${JSON.stringify(ft)} IS a transfer candidate`, isTransferCandidate(ft));
  }
}

console.log("V27-TRUTH-3 (6). Merchant descriptors are never consulted");
{
  // Behavioural: the verdict cannot vary with the descriptor, because the
  // evidence type has no field for one.
  const keys = Object.keys(liabilityInflowIsCustomerPayment({ providerFamily: "OTHER" }));
  check("the resolution exposes only a verdict and a reason",
    keys.sort().join(",") === "reason,verdict");

  // Structural: the module must not read merchant/description/name at all.
  const src = readFileSync(join(__dirname, "liability-inflow.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ")
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (const forbidden of ["merchant", "description", "descriptor", "includes(", "toUpperCase", "match(", "RegExp"]) {
    check(`the authority never references \`${forbidden}\``, !src.includes(forbidden));
  }
}

console.log("V27-TRUTH-3 (7). The ladder makes NO transfer claim about a card credit");
{
  check("ISSUER_CREDIT implies no flowType", impliedFlowType("ISSUER_CREDIT") === null);
  check("UNRESOLVED_LIABILITY_INFLOW implies no flowType", impliedFlowType("UNRESOLVED_LIABILITY_INFLOW") === null);
  check("...unlike UNRESOLVED_TRANSFER, which DOES claim TRANSFER",
    impliedFlowType("UNRESOLVED_TRANSFER") === "TRANSFER");
  check("a debt payment still implies DEBT_PAYMENT", impliedFlowType("DEBT_PAYMENT") === "DEBT_PAYMENT");

  // "No claim" must never be reported as a reclassification.
  const credit = matureClassification({
    flowType: "UNKNOWN", amount: 363.8, ownAccountType: "debt",
    ownProviderFamily: "OTHER", destination: NONE,
  });
  check("an issuer credit is NOT flagged as a reclassification", credit.reclassified === false);
  check("...and carries no counterparty", credit.counterpartyAccountId === null && credit.persistable === false);

  check("both new leaves have presentation wording",
    MATURITY_LABEL.ISSUER_CREDIT === "Issuer credit" &&
    MATURITY_LABEL.UNRESOLVED_LIABILITY_INFLOW === "Unconfirmed card credit");
}

console.log("V27-TRUTH-3 (7b). The two entry points agree for the same row");
{
  // `maturityForEvidence` is what the READ path calls; `matureClassification` is
  // what a repair/stored-classification path calls. They must not disagree.
  //
  // They DID: `matureClassification` had no way to pass the provider family, so
  // it resolved every liability inflow UNDETERMINED — including genuine payments
  // that the read path correctly called DEBT_PAYMENT. Caught by this comparison,
  // not by either module's own tests.
  const cases: Array<{ family: string | null; amount: number; dest: typeof NONE }> = [
    { family: "LOAN_PAYMENTS", amount: 120, dest: NONE },
    { family: "LOAN_DISBURSEMENTS", amount: 650, dest: NONE },
    { family: "OTHER", amount: 363.8, dest: NONE },
    { family: "GOVERNMENT_AND_NON_PROFIT", amount: 120, dest: NONE },
    { family: null, amount: 800, dest: NONE },
    { family: null, amount: 500, dest: OWNED },
    { family: "OTHER", amount: 500, dest: OWNED },
  ];
  let agree = true;
  for (const c of cases) {
    const readPath = maturityForEvidence(c.dest, {
      accountType: "debt", amount: c.amount, providerFamily: c.family,
    });
    const storedPath = matureClassification({
      flowType: "UNKNOWN", amount: c.amount, ownAccountType: "debt",
      ownProviderFamily: c.family, destination: c.dest,
    }).maturity;
    if (readPath !== storedPath) {
      agree = false;
      console.error(`      family=${c.family} amount=${c.amount}: read=${readPath} stored=${storedPath}`);
    }
  }
  check("read-time and stored classification agree on every liability-inflow shape", agree);
  check("...and a payment family really does reach DEBT_PAYMENT through matureClassification",
    matureClassification({ flowType: "UNKNOWN", amount: 120, ownAccountType: "debt",
      ownProviderFamily: "LOAN_PAYMENTS", destination: NONE }).maturity === "DEBT_PAYMENT");
}

console.log("V27-TRUTH-3 (8). A liability OUTFLOW is unaffected");
{
  check("money OUT of a liability is still never a debt payment",
    maturityForEvidence(OWNED, { accountType: "debt", amount: -50, providerFamily: "LOAN_PAYMENTS" }) === "UNRESOLVED_TRANSFER");
  check("a NON-liability account is entirely unaffected by the new rule",
    maturityForEvidence(OWNED, { accountType: "checking", amount: 500, providerFamily: "OTHER" }) === "CASH_TRANSFER");
}

console.log(failures === 0 ? "\nliability-inflow: all passed." : `\nliability-inflow: ${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
