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
 *   9. S2 R2 viewer correctness: owner sees equity; co-member with every linked
 *      debt balance-visible sees it; co-member missing one sees none, with no
 *      hint which; the AI payload follows the same rule (flag only);
 *  10. S2 D2 one kind allowlist (unknown kind rejected) + NULL-safe link arrays;
 *  11. S2 R1 audit rows: actions, ids/enum-only metadata, same transaction.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/assets/property-equity.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { classifyAccounts } from "@/lib/account-classifier";
import { AuditAction, AUDIT_ACTION_GROUPS } from "@/lib/audit-actions";
import { propertyAuditRow } from "./property-links";
import {
  checkSecuredDebtLink, computePropertyEquity, parsePropertyAction, securedDebtKind, suggestSecuredDebt,
  canCarrySecuredDebt, viewerPropertyEquity, aiPropertyFacts, normalizeSecuredDebtIds, parseManualAssetKind,
  EQUITY_HIDDEN_MESSAGE, MANUAL_ASSET_KINDS,
  type AiSpaceDebt, type LinkCandidateDebt, type LinkedDebtInput, type ViewerDebtRow,
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
  const hidden = computePropertyEquity({ value: 500_000, currency: "USD", valueBasis: "MARKET_VALUE", linkedDebts: [mortgage(300_000)], someLinkedDebtHidden: true });
  check("a linked debt hidden ⇒ no equity, no partial list/total, no prompt",
    hidden.equity === null && hidden.equityUnavailableReason === "LINKED_DEBT_NOT_VISIBLE"
    && hidden.securedDebts.length === 0 && hidden.securedDebtTotal === null && hidden.doubleCount === null);
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

console.log("9. S2 R2 — viewer correctness (equity all-or-nothing)");
{
  const OWNER = "owner", CO = "co";
  const row = (id: string, ownerUserId: string, links: { spaceId: string; visibilityLevel: string }[], over: Partial<ViewerDebtRow> = {}): ViewerDebtRow =>
    ({ id, ownerUserId, deletedAt: null, type: "debt", providerSubtype: "mortgage", links, name: `Secret ${id}`, balance: 150_000, currency: "USD", ...over });
  // Two linked loans: the owner's mortgage (FULL in s1) and a HELOC (BALANCE_ONLY to the co-member).
  const m1 = row("m1", OWNER, [{ spaceId: "s1", visibilityLevel: "FULL" }]);
  const h1 = row("h1", OWNER, [{ spaceId: "s1", visibilityLevel: "BALANCE_ONLY" }], { providerSubtype: "home equity", creditLimit: 100_000, balance: 50_000 });
  const base = { propertySpaceIds: ["s1"], value: 500_000, currency: "USD", valueBasis: "MARKET_VALUE" as const, linkedIds: ["m1", "h1"] };

  const owner = viewerPropertyEquity({ ...base, viewerUserId: OWNER, debts: [m1, h1] });
  check("owner sees equity (500k − 150k − 50k = 300k)", owner.equity === 300_000, String(owner.equity));
  check("owner sees names", owner.securedDebts.map((d) => d.name).join() === "Secret m1,Secret h1");

  const co = viewerPropertyEquity({ ...base, viewerUserId: CO, debts: [m1, h1] });
  check("co-member with every linked debt balance-visible sees equity", co.equity === 300_000);
  check("…a BALANCE_ONLY debt is named by its kind, never its name",
    co.securedDebts.find((d) => d.id === "h1")?.name === "HELOC" && co.securedDebts.find((d) => d.id === "m1")?.name === "Secret m1");

  // The HELOC is not visible to the co-member at all (unshared / RLS-hidden ⇒ not loaded).
  const missing = viewerPropertyEquity({ ...base, viewerUserId: CO, debts: [m1] });
  const payload = JSON.stringify(missing);
  check("co-member missing one debt ⇒ no equity", missing.equity === null && missing.equityUnavailableReason === "LINKED_DEBT_NOT_VISIBLE");
  check("…no list, no total, no prompt", missing.securedDebts.length === 0 && missing.securedDebtTotal === null && missing.doubleCount === null);
  check("…no hint which: neither id nor name of ANY linked loan, no count",
    !payload.includes("m1") && !payload.includes("h1") && !payload.includes("Secret") && !/"(hidden|unavailable)[A-Za-z]*Count"/.test(payload), payload);
  check("…the UI words", EQUITY_HIDDEN_MESSAGE === "Equity not shown — a linked loan isn't visible to you");
  const notShared = viewerPropertyEquity({ ...base, viewerUserId: CO, debts: [m1, row("h1", OWNER, [{ spaceId: "s9", visibilityLevel: "FULL" }])] });
  check("a linked debt visible only in ANOTHER Space ⇒ hidden", notShared.equity === null);
  const deleted = viewerPropertyEquity({ ...base, viewerUserId: OWNER, debts: [m1, { ...h1, deletedAt: new Date() }] });
  check("a deleted linked debt ⇒ hidden (never silently dropped from the subtraction)", deleted.equity === null);
  const nullIds = viewerPropertyEquity({ ...base, linkedIds: null, viewerUserId: OWNER, debts: [m1] });
  check("NULL securedDebtAccountIds ⇒ no links, equity = value", nullIds.equity === 500_000 && nullIds.securedDebts.length === 0);

  // AI payload: the same rule over the Space's balance-disclosing rows.
  const spaceDebts = new Map<string, AiSpaceDebt>([
    ["m1", { id: "m1", name: "Secret m1", balance: 150_000, currency: "USD", type: "debt", providerSubtype: "mortgage", visibilityLevel: "FULL" }],
    ["h1", { id: "h1", name: "Secret h1", balance: 50_000, currency: "USD", type: "debt", providerSubtype: "home equity", creditLimit: 100_000, visibilityLevel: "BALANCE_ONLY" }],
  ]);
  const profile = { assetKind: "real_estate", valueBasis: "MARKET_VALUE" as const, securedDebtAccountIds: ["m1", "h1"] };
  const aiAll = aiPropertyFacts({ value: 500_000, currency: "USD", profile, spaceDebts });
  check("AI: all visible ⇒ derivedEquity matches the viewer rule", aiAll?.derivedEquity === co.equity && aiAll?.securedDebtTotal === 200_000);
  check("AI: BALANCE_ONLY loan named by kind", aiAll?.securedDebts.find((d) => d.id === "h1")?.name === "HELOC");
  const aiMissing = aiPropertyFacts({ value: 500_000, currency: "USD", profile, spaceDebts: new Map([["m1", spaceDebts.get("m1")!]]) });
  const aiPayload = JSON.stringify(aiMissing);
  check("AI: missing one ⇒ flag only (no equity figure, total, list or prompt)",
    aiMissing?.derivedEquity === null && aiMissing?.equityUnavailableReason === "LINKED_DEBT_NOT_VISIBLE"
    && aiMissing?.securedDebtTotal === null && aiMissing?.securedDebts.length === 0 && aiMissing?.possibleDoubleCount === undefined, aiPayload);
  check("AI: missing one ⇒ no id or name of any linked loan", !aiPayload.includes("m1") && !aiPayload.includes("h1") && !aiPayload.includes("Secret"));
  check("AI: an all-default profile emits nothing (pre-F9 context byte-identical)",
    aiPropertyFacts({ value: 1, currency: "USD", profile: { assetKind: null, valueBasis: "UNKNOWN", securedDebtAccountIds: null }, spaceDebts }) === null
    && aiPropertyFacts({ value: 1, currency: "USD", profile: undefined, spaceDebts }) === null);
}

console.log("10. S2 D2 — one kind allowlist; NULL-safety");
{
  check("the allowlist is the four route kinds", JSON.stringify([...MANUAL_ASSET_KINDS]) === JSON.stringify(["real_estate", "vehicle", "equipment", "other"]));
  const bad = parseManualAssetKind("boat");
  check("unknown kind ⇒ rejected with the allowlist in the error", !bad.ok && bad.error.includes("real_estate"));
  check("non-string kind rejected", !parseManualAssetKind(7).ok && !parseManualAssetKind(null).ok);
  check("real_estate accepted", parseManualAssetKind("real_estate").ok);
  check("normalizeSecuredDebtIds(NULL) = []", JSON.stringify(normalizeSecuredDebtIds(null)) === "[]" && JSON.stringify(normalizeSecuredDebtIds(undefined)) === "[]");
  check("normalizeSecuredDebtIds drops junk + dupes", JSON.stringify(normalizeSecuredDebtIds(["a", "", 3, "a", "b"])) === JSON.stringify(["a", "b"]));
  const root = process.cwd();
  const createRoute = readFileSync(path.join(root, "app/api/accounts/manual/route.ts"), "utf8");
  check("create route validates through parseManualAssetKind and keeps no list of its own",
    createRoute.includes("parseManualAssetKind(assetKind)") && !/VALID_KINDS|\["real_estate",\s*"vehicle"/.test(createRoute));
  const links = readFileSync(path.join(root, "lib/assets/property-links.ts"), "utf8");
  check("property endpoint rejects a stored kind outside the allowlist (400)",
    links.includes("!isManualAssetKind(storedKind)") && /status: 400, error: `Invalid assetKind/.test(links));
  const rawReads = links.match(/[\w(]*\b[pr]\.securedDebtAccountIds/g) ?? [];
  check("property-links reads every DB array only through normalizeSecuredDebtIds (NULL ⇒ [])",
    rawReads.length === 2 && rawReads.every((m) => m.startsWith("normalizeSecuredDebtIds(")), rawReads.join(" | "));
}

console.log("11. S2 R1 — audit rows (ids and enum values only)");
{
  const link = propertyAuditRow({ userId: "u", propertyId: "p", action: { op: "link", debtAccountId: "d" }, fromBasis: "UNKNOWN", ipAddress: "1.2.3.4" });
  check("link ⇒ MANUAL_ASSET_SECURED_DEBT_LINKED {propertyId, debtAccountId}",
    link.action === "MANUAL_ASSET_SECURED_DEBT_LINKED" && JSON.stringify(link.metadata) === JSON.stringify({ propertyId: "p", debtAccountId: "d" }) && link.ipAddress === "1.2.3.4");
  const unlink = propertyAuditRow({ userId: "u", propertyId: "p", action: { op: "unlink", debtAccountId: "d" }, fromBasis: "UNKNOWN" });
  check("unlink ⇒ MANUAL_ASSET_SECURED_DEBT_UNLINKED", unlink.action === "MANUAL_ASSET_SECURED_DEBT_UNLINKED" && JSON.stringify(unlink.metadata) === JSON.stringify({ propertyId: "p", debtAccountId: "d" }));
  const basis = propertyAuditRow({ userId: "u", propertyId: "p", action: { op: "setBasis", valueBasis: "MARKET_VALUE" }, fromBasis: "EQUITY_ENTERED" });
  check("basis ⇒ MANUAL_ASSET_VALUE_BASIS_CHANGED {propertyId, from, to}",
    basis.action === "MANUAL_ASSET_VALUE_BASIS_CHANGED" && JSON.stringify(basis.metadata) === JSON.stringify({ propertyId: "p", from: "EQUITY_ENTERED", to: "MARKET_VALUE" }));
  check("registered in the AuditLog vocabulary + the admin groups",
    AuditAction.MANUAL_ASSET_SECURED_DEBT_LINKED === "MANUAL_ASSET_SECURED_DEBT_LINKED"
    && AuditAction.MANUAL_ASSET_SECURED_DEBT_UNLINKED === "MANUAL_ASSET_SECURED_DEBT_UNLINKED"
    && AuditAction.MANUAL_ASSET_VALUE_BASIS_CHANGED === "MANUAL_ASSET_VALUE_BASIS_CHANGED"
    && ["MANUAL_ASSET_SECURED_DEBT_LINKED", "MANUAL_ASSET_SECURED_DEBT_UNLINKED", "MANUAL_ASSET_VALUE_BASIS_CHANGED"]
      .every((a) => AUDIT_ACTION_GROUPS.some((g) => (g.actions as string[]).includes(a))));
  const links = readFileSync(path.join(process.cwd(), "lib/assets/property-links.ts"), "utf8");
  const fn = links.slice(links.indexOf("export async function applyPropertyLinkAction"));
  check("the audit row is written on the SAME tx, after the profile upsert",
    fn.indexOf("tx.manualAssetProfile.upsert(") > 0 && fn.indexOf("await tx.auditLog.create(") > fn.indexOf("tx.manualAssetProfile.upsert("));
}

if (failures > 0) { console.error(`\n✗ ${failures} failure(s)`); process.exit(1); }
console.log("\n✓ property-equity: all checks passed");
