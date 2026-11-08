/**
 * lib/assets/property-equity.test.ts — Mortgage F9 (owner 2026-11-08, HOME VALUATION)
 *
 * Pins:
 *   1. value 500k + linked mortgage 300k ⇒ equity 200k, net worth UNCHANGED
 *      (500k asset − 300k debt through the one classifier), equity never added on top;
 *   2. EQUITY_ENTERED 200k + linked mortgage 300k ⇒ double-count flag raised,
 *      nothing rewritten (value stays 200k, equity withheld, NW unchanged);
 *   3. an unlinked auto loan never reduces equity — and a LINKED auto / student /
 *      personal loan is ignored as NOT_SECURED_KIND;
 *   4. a linked HELOC reduces equity; a closed-end home-equity loan (#485 other_installment) does not;
 *   5. UNKNOWN basis heuristic is a prompt only; MARKET_VALUE never prompts;
 *   6. API authz: a debt from another Space / another user's private account /
 *      deleted / non-debt is 404; a non-secured kind is 400; owner or FULL same-Space ok;
 *   7. suggestion = exactly one candidate, never when something is linked;
 *   8. the action parser accepts exactly one action.
 *
 *   npx tsx lib/assets/property-equity.test.ts
 */

import { classifyAccounts } from "@/lib/account-classifier";
import {
  checkSecuredDebtLink, computePropertyEquity, parsePropertyAction, securedDebtKind, suggestSecuredDebt,
  canCarrySecuredDebt, type LinkCandidateDebt, type LinkedDebtInput,
} from "./property-equity";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const mortgage = (balance: number, extra: Partial<LinkedDebtInput> = {}): LinkedDebtInput =>
  ({ id: "m1", name: "Home mortgage", balance, currency: "USD", type: "debt", providerSubtype: "mortgage", ...extra });

console.log("1. market value 500k + linked mortgage 300k");
{
  const eq = computePropertyEquity({ value: 500_000, currency: "USD", valueBasis: "MARKET_VALUE", linkedDebts: [mortgage(300_000)] });
  check("equity = 200k", eq.equity === 200_000, String(eq.equity));
  check("secured total = 300k", eq.securedDebtTotal === 300_000);
  check("no double-count flag", eq.doubleCount === null);
  check("net-worth treatment constant", eq.netWorthTreatment === "PROPERTY_AT_VALUE_DEBT_AS_LIABILITY");
  const nw = classifyAccounts([
    { type: "other", balance: 500_000, syncStatus: "manual" },
    { type: "debt",  balance: 300_000 },
  ]);
  check("NW = 500k asset − 300k debt = 200k (unchanged by F9)", nw.netWorth === 200_000, String(nw.netWorth));
  check("equity is NOT additional wealth (NW ≠ NW + equity)", nw.netWorth !== nw.netWorth + (eq.equity ?? 0));
}

console.log("2. EQUITY_ENTERED 200k + linked mortgage 300k");
{
  const input = { value: 200_000, currency: "USD", valueBasis: "EQUITY_ENTERED" as const, linkedDebts: [mortgage(300_000)] };
  const before = JSON.stringify(input);
  const eq = computePropertyEquity(input);
  check("flag raised", eq.doubleCount?.reason === "EQUITY_ENTERED_WITH_LINKED_DEBT");
  check("possible understatement = linked debt", eq.doubleCount?.possibleUnderstatement === 300_000);
  check("nothing rewritten: value stays 200k", eq.value === 200_000);
  check("input untouched", JSON.stringify(input) === before);
  check("equity withheld (never value − debt again)", eq.equity === null && eq.equityUnavailableReason === "EQUITY_ENTERED_WITH_LINKED_DEBT");
  const nw = classifyAccounts([{ type: "other", balance: 200_000, syncStatus: "manual" }, { type: "debt", balance: 300_000 }]);
  check("nothing excluded automatically: NW still counts both rows (−100k)", nw.netWorth === -100_000, String(nw.netWorth));
  const noLink = computePropertyEquity({ ...input, linkedDebts: [] });
  check("EQUITY_ENTERED without a linked mortgage ⇒ no flag", noLink.doubleCount === null && noLink.equity === 200_000);
}

console.log("3. non-secured loans never reduce equity");
{
  const unlinked = computePropertyEquity({ value: 500_000, currency: "USD", valueBasis: "MARKET_VALUE", linkedDebts: [] });
  check("unlinked auto loan (not in linkedDebts) ⇒ equity = value", unlinked.equity === 500_000);
  for (const [label, ev] of [
    ["auto (Plaid)",      { providerSubtype: "auto" }],
    ["student (Plaid)",   { providerSubtype: "student" }],
    ["auto_loan (FM)",    { debtSubtype: "auto_loan" }],
    ["personal_loan (FM)", { debtSubtype: "personal_loan" }],
    ["line of credit",    { providerSubtype: "line of credit" }],
    ["credit card",       { debtSubtype: "credit_card" }],
    ["consumer (Plaid)",  { providerSubtype: "consumer" }],
    ["generic loan (Plaid)", { providerSubtype: "loan" }],
    ["FM auto_loan overrides Plaid mortgage", { debtSubtype: "auto_loan", providerSubtype: "mortgage" }],
  ] as const) {
    const eq = computePropertyEquity({ value: 500_000, currency: "USD", valueBasis: "MARKET_VALUE",
      linkedDebts: [{ id: "x", name: "Loan", balance: 25_000, currency: "USD", type: "debt", ...ev }] });
    check(`linked ${label} ignored`, eq.equity === 500_000 && eq.ignoredLinks[0]?.reason === "NOT_SECURED_KIND");
    check(`${label} is not a secured kind`, securedDebtKind({ type: "debt", ...ev }) === null);
  }
  check("an asset row is never a secured debt", securedDebtKind({ type: "other", providerSubtype: "mortgage" }) === null);
}

console.log("4. HELOC reduces equity");
{
  const heloc = computePropertyEquity({ value: 500_000, currency: "USD", valueBasis: "MARKET_VALUE",
    linkedDebts: [mortgage(300_000), { id: "h1", name: "HELOC", balance: 40_000, currency: "USD", type: "debt", providerSubtype: "home equity", creditLimit: 100_000 }] });
  check("mortgage + HELOC ⇒ equity 160k", heloc.equity === 160_000, String(heloc.equity));
  check("HELOC kind (debtType)", heloc.securedDebts.find((d) => d.id === "h1")?.kind === "heloc");
  check("FM heloc subtype", securedDebtKind({ type: "debt", debtSubtype: "heloc" }) === "heloc");
  check("limitless Plaid home equity = other_installment (#485) ⇒ not linkable, no mortgage behaviour",
    securedDebtKind({ type: "debt", providerSubtype: "home equity" }) === null);
  const credit = computePropertyEquity({ value: 500_000, currency: "USD", valueBasis: "MARKET_VALUE", linkedDebts: [mortgage(-50)] });
  check("a credit balance on the mortgage is 0 owed, never added", credit.equity === 500_000);
  const fx = computePropertyEquity({ value: 500_000, currency: "USD", valueBasis: "MARKET_VALUE", linkedDebts: [mortgage(300_000, { currency: "EUR" })] });
  check("currency mismatch ⇒ equity withheld", fx.equity === null && fx.equityUnavailableReason === "CURRENCY_MISMATCH");
  const hidden = computePropertyEquity({ value: 500_000, currency: "USD", valueBasis: "MARKET_VALUE", linkedDebts: [], unavailableLinkedCount: 1 });
  check("linked debt not visible ⇒ equity withheld (never overstated)", hidden.equity === null && hidden.equityUnavailableReason === "LINKED_DEBT_NOT_VISIBLE");
}

console.log("5. UNKNOWN basis heuristic = prompt only");
{
  const low = computePropertyEquity({ value: 200_000, currency: "USD", valueBasis: "UNKNOWN", linkedDebts: [mortgage(300_000)] });
  check("UNKNOWN + value < 1.1 × debt ⇒ prompt", low.doubleCount?.reason === "VALUE_BELOW_LINKED_DEBT");
  check("UNKNOWN prompt keeps the computed equity (no restatement)", low.equity === -100_000 && low.value === 200_000);
  const high = computePropertyEquity({ value: 500_000, currency: "USD", valueBasis: "UNKNOWN", linkedDebts: [mortgage(300_000)] });
  check("UNKNOWN + value well above debt ⇒ no prompt", high.doubleCount === null);
  const confirmed = computePropertyEquity({ value: 200_000, currency: "USD", valueBasis: "MARKET_VALUE", linkedDebts: [mortgage(300_000)] });
  check("MARKET_VALUE (user-confirmed, underwater) ⇒ never prompts", confirmed.doubleCount === null);
}

console.log("6. link authorization");
{
  const debt = (over: Partial<LinkCandidateDebt> = {}): LinkCandidateDebt => ({
    id: "d1", ownerUserId: "me", deletedAt: null, type: "debt", providerSubtype: "mortgage",
    links: [{ spaceId: "s1", visibilityLevel: "FULL" }], ...over,
  });
  const run = (d: LinkCandidateDebt | null, spaces = ["s1"]) => checkSecuredDebtLink({ viewerUserId: "me", propertySpaceIds: spaces, debt: d });
  check("own mortgage in the property's Space ⇒ ok", run(debt()).ok);
  const other = run(debt({ links: [{ spaceId: "s2", visibilityLevel: "FULL" }] }));
  check("debt from ANOTHER Space ⇒ 404", !other.ok && other.status === 404);
  const otherUser = run(debt({ ownerUserId: "them", links: [{ spaceId: "s1", visibilityLevel: "BALANCE_ONLY" }] }));
  check("another user's debt, BALANCE_ONLY in the shared Space ⇒ 404", !otherUser.ok && otherUser.status === 404);
  check("another user's debt with a FULL link in the shared Space ⇒ ok", run(debt({ ownerUserId: "them" })).ok);
  const privateOther = run(debt({ ownerUserId: "them", links: [] }));
  check("another user's private (unshared) debt ⇒ 404", !privateOther.ok && privateOther.status === 404);
  const missing = run(null);
  check("missing ⇒ 404", !missing.ok && missing.status === 404);
  const deleted = run(debt({ deletedAt: new Date() }));
  check("deleted ⇒ 404", !deleted.ok && deleted.status === 404);
  const asset = run(debt({ type: "other" }));
  check("non-debt ⇒ 404", !asset.ok && asset.status === 404);
  const auto = run(debt({ providerSubtype: "auto" }));
  check("auto loan ⇒ 400 (not a secured kind)", !auto.ok && auto.status === 400);
  const noSpace = run(debt(), []);
  check("property in no Space ⇒ 404", !noSpace.ok && noSpace.status === 404);
  check("vehicle cannot carry a secured debt", !canCarrySecuredDebt("vehicle") && canCarrySecuredDebt("real_estate") && canCarrySecuredDebt(null));
}

console.log("7. suggestion requires confirmation");
{
  check("exactly one candidate ⇒ suggested", suggestSecuredDebt({ candidateIds: ["d1"], linkedIds: [] }) === "d1");
  check("two candidates ⇒ none", suggestSecuredDebt({ candidateIds: ["d1", "d2"], linkedIds: [] }) === null);
  check("already linked ⇒ none", suggestSecuredDebt({ candidateIds: ["d2"], linkedIds: ["d1"] }) === null);
}

console.log("8. action parser");
{
  check("valueBasis", JSON.stringify(parsePropertyAction({ valueBasis: "EQUITY_ENTERED" })) === JSON.stringify({ op: "setBasis", valueBasis: "EQUITY_ENTERED" }));
  check("link", JSON.stringify(parsePropertyAction({ link: "d1" })) === JSON.stringify({ op: "link", debtAccountId: "d1" }));
  check("unlink", JSON.stringify(parsePropertyAction({ unlink: "d1" })) === JSON.stringify({ op: "unlink", debtAccountId: "d1" }));
  check("two actions rejected", "error" in parsePropertyAction({ link: "d1", valueBasis: "MARKET_VALUE" }));
  check("bad basis rejected", "error" in parsePropertyAction({ valueBasis: "EQUITY" }));
  check("empty rejected", "error" in parsePropertyAction({}) && "error" in parsePropertyAction(null));
}

if (failures > 0) { console.error(`\n✗ ${failures} failure(s)`); process.exit(1); }
console.log("\n✓ property-equity: all checks passed");
