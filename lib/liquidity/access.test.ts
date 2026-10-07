/**
 * lib/liquidity/access.test.ts  (2026-10-07)
 *
 * Owned wealth, investment class and LIQUIDITY ACCESS are separate questions.
 * Preview (Brandon): a 401(k) + IRA ($23,952.74) were "Available in days ·
 * Brokerage · crypto (settlement)", and a Plaid HSA ($6,009, Plaid subtype
 * `hsa`, stored as `checking`) was unrestricted cash — in "share reachable
 * now", runway, the AI liquid figure and the Daily Brief. The provider subtype
 * was discarded at import. It is now kept (FinancialAccount.providerSubtype)
 * and read by ONE rule, liquidityAccess.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/liquidity/access.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyAccounts, liquidityAccess, normalizeProviderSubtype, LIQUIDITY_ACCESS_MEANING } from "@/lib/account-classifier";
import { computeLiquidity, type LiquidityAccountRow } from "@/lib/perspective-engine/lenses/liquidity.core";
import { normalizeSharedAccounts, type ShareRow } from "@/lib/account-privacy";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
const src = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

console.log("1. The rule — every branch explicit");
{
  const A = (type: string, providerSubtype?: string | null) => liquidityAccess({ type, providerSubtype });
  check("checking → cash (existing meaning)", A("checking", "checking") === "cash");
  check("savings / money market / cd → cash (existing meaning)", A("savings", "savings") === "cash" && A("savings", "money market") === "cash" && A("savings", "cd") === "cash");
  check("depository with NO subtype keeps its existing meaning (cash)", A("checking", null) === "cash" && A("checking") === "cash");
  check("REGRESSION: HSA (type checking, subtype hsa) → restricted, not cash", A("checking", "hsa") === "restricted");
  check("REGRESSION: 401(k) → restricted, not marketable", A("investment", "401k") === "restricted");
  check("traditional IRA → restricted", A("investment", "ira") === "restricted");
  check("Roth IRA → restricted (no contribution-basis / penalty-free inference)", A("investment", "roth") === "restricted");
  check("Plaid's capitalised 403B normalises → restricted", A("investment", "403B") === "restricted");
  check("known taxable brokerage → marketable (within days, preserved)", A("investment", "brokerage") === "marketable");
  check("UNKNOWN investment (no subtype) → unverified — not brokerage, not retirement", A("investment", null) === "unverified" && A("investment") === "unverified");
  check("investment with an unclassified subtype → unverified, never guessed", A("investment", "variable annuity") === "unverified" && A("investment", "stock plan") === "unverified");
  check("crypto → marketable (preserved)", A("crypto") === "marketable");
  check("other → illiquid; debt → not a liquidity source", A("other") === "illiquid" && A("debt") === null);
  check("every verdict has one stated meaning, and the restricted one invents no amount or rate",
    (["cash", "restricted", "marketable", "unverified", "illiquid"] as const).every((k) => LIQUIDITY_ACCESS_MEANING[k].length > 0)
    && !/\$|\d/.test(LIQUIDITY_ACCESS_MEANING.restricted));
  check("normalizeProviderSubtype: trim/lowercase, empty ⇒ null", normalizeProviderSubtype(" 401K ") === "401k" && normalizeProviderSubtype("") === null && normalizeProviderSubtype(undefined) === null);
}

// Brandon's live Preview asset accounts (subtypes as Plaid Sandbox reports them).
const BRANDON = [
  { name: "Plaid Checking",        type: "checking",   providerSubtype: "checking",        balance: 110,        available: 100 },
  { name: "Plaid HSA",             type: "checking",   providerSubtype: "hsa",             balance: 6009,       available: 6009 },
  { name: "Plaid Cash Management", type: "checking",   providerSubtype: "cash management", balance: 12060,      available: 12060 },
  { name: "Plaid CD",              type: "savings",    providerSubtype: "cd",              balance: 1000,       available: null },
  { name: "Plaid Money Market",    type: "savings",    providerSubtype: "money market",    balance: 43200,      available: 43200 },
  { name: "Plaid Saving",          type: "savings",    providerSubtype: "savings",         balance: 210,        available: 200 },
  { name: "Plaid IRA",             type: "investment", providerSubtype: "ira",             balance: 320.76,     available: null },
  { name: "Plaid 401k",            type: "investment", providerSubtype: "401k",            balance: 23631.9805, available: null },
];
const WITHOUT_SUBTYPE = BRANDON.map((a) => ({ ...a, providerSubtype: null }));

console.log("2. Reconciliation — net worth and investment wealth never move");
{
  const before = classifyAccounts(WITHOUT_SUBTYPE); // what the discarded-subtype data produced for cash
  const after  = classifyAccounts(BRANDON);
  check("netWorth unchanged ($86,541.74)", after.netWorth === before.netWorth && near(after.netWorth, 86541.7405), String(after.netWorth));
  check("totalAssets unchanged", after.totalAssets === before.totalAssets);
  check("canonical investment wealth unchanged ($23,952.74)", after.totalInvestments === before.totalInvestments && near(after.totalInvestments, 23952.7405));
  check("snapshot cash columns unchanged (totalChecking / totalSavings include the HSA)", after.totalChecking === before.totalChecking && after.totalSavings === before.totalSavings);
  check("BEFORE: the HSA was unrestricted cash (totalLiquid $62,589)", before.totalLiquid === 62589 && before.totalRestrictedCash === 0);
  check("AFTER: unrestricted cash $56,580; the HSA's $6,009 is restricted cash", after.totalLiquid === 56580 && after.totalRestrictedCash === 6009);
  check("no double counting: unrestricted + restricted = the cash balance", after.totalLiquid + after.totalRestrictedCash === after.totalChecking + after.totalSavings);
  check("the HSA is still an asset (in liquid ∪ restrictedCash exactly once)",
    after.restrictedCash.length === 1 && !after.liquid.some((a) => a.name === "Plaid HSA"));
  check("byte-identical when nothing is restricted (old Spaces unchanged)",
    classifyAccounts(WITHOUT_SUBTYPE).totalLiquid === WITHOUT_SUBTYPE.filter((a) => a.type !== "investment").reduce((s, a) => s + a.balance, 0));
}

console.log("3. Assets reachability — Brandon's figures, recomputed from the rule");
{
  type Acct = Omit<(typeof BRANDON)[number], "providerSubtype"> & { providerSubtype: string | null };
  const lensRows = (accts: Acct[]): LiquidityAccountRow[] => accts.map((a, i) => ({
    id: `a${i}`, type: a.type, providerSubtype: a.providerSubtype, balance: a.balance,
    lastUpdated: "2026-10-06T00:00:00.000Z", visibilityLevel: "FULL",
    ...(a.type === "checking" || a.type === "savings" ? { reachableCash: a.available, unexplainedHold: null } : {}),
  }));
  const opts = { now: () => new Date("2026-10-07T00:00:00Z") };
  const scope = { spaceId: "s", userId: "u" } as never;
  const m = (r: ReturnType<typeof computeLiquidity>, id: string) => (r.metrics.find((x) => x.id === id)?.value as number | undefined) ?? 0;
  const before = computeLiquidity(scope, opts as never, lensRows(WITHOUT_SUBTYPE));
  const after  = computeLiquidity(scope, opts as never, lensRows(BRANDON));
  const total  = classifyAccounts(BRANDON).totalAssets;
  check("BEFORE: cash now $61,569 (HSA inside), share 71.1%", m(before, "cashNow") === 61569 && (61569 / total * 100).toFixed(1) === "71.1");
  check("not-yet-refreshed Plaid investments (no subtype) are unverified, never 'within days'",
    m(before, "marketable") === 0 && near(m(before, "unverified"), 23952.7405));
  check("AFTER: cash now $55,560 — the HSA is out of reachable cash", m(after, "cashNow") === 55560);
  check("AFTER: share reachable now = 55,560 / 86,541.74 = 64.2%", (55560 / total * 100).toFixed(1) === "64.2", (55560 / total * 100).toFixed(4));
  check("AFTER: nothing 'within days' — no known brokerage or crypto", m(after, "marketable") === 0);
  check("AFTER: restricted = HSA + 401(k) + IRA ($29,961.74), owned and shown", near(m(after, "restricted"), 29961.7405));
  check("the verdict never offers restricted money as raisable", !/raised by selling/.test(after.verdict ?? ""));
  check("assumption says restricted money is not counted and invents no tax/penalty amount",
    after.assumptions.some((a) => a.id === "restricted-not-accessible" && !/\$|\d+%/.test(a.text)));
  check("the old 'cannot be distinguished' disclaimer is gone", !after.assumptions.some((a) => a.id === "retirement-not-distinguished"));
}

console.log("4. Unknown investments and authoritative transitions");
{
  const manual = { type: "investment", balance: 10_000, providerSubtype: null };
  const base   = [{ type: "checking", balance: 1_000, providerSubtype: "checking" }];
  const nw = (accts: Array<{ type: string; balance: number; providerSubtype: string | null }>) => classifyAccounts(accts);
  check("unknown manual investment → unverified, indefinitely (no name inference)", liquidityAccess({ ...manual, name: "Vanguard Brokerage" } as never) === "unverified");
  const unknownNW = nw([...base, manual]);
  const toBrokerage = nw([...base, { ...manual, providerSubtype: "brokerage" }]);
  const toRetirement = nw([...base, { ...manual, providerSubtype: "401k" }]);
  check("UNKNOWN → brokerage: becomes marketable", liquidityAccess({ ...manual, providerSubtype: "brokerage" }) === "marketable");
  check("UNKNOWN → 401k: becomes restricted", liquidityAccess({ ...manual, providerSubtype: "401k" }) === "restricted");
  check("neither transition changes net worth or investment wealth",
    unknownNW.netWorth === toBrokerage.netWorth && unknownNW.netWorth === toRetirement.netWorth
    && unknownNW.totalInvestments === toBrokerage.totalInvestments && unknownNW.totalInvestments === toRetirement.totalInvestments);
  check("investment with no holdings: access comes from the account, not holdings", liquidityAccess({ type: "investment", providerSubtype: "ira" }) === "restricted");
}

console.log("5. Mixed portfolio — each figure keeps its own definition");
{
  const mixed = [
    { type: "checking",   balance: 5_000,  providerSubtype: "checking" },
    { type: "checking",   balance: 2_000,  providerSubtype: "hsa" },
    { type: "investment", balance: 40_000, providerSubtype: "brokerage" },
    { type: "investment", balance: 60_000, providerSubtype: "401k" },
    { type: "investment", balance: 7_000,  providerSubtype: null },
    { type: "crypto",     balance: 3_000,  providerSubtype: null },
  ];
  const c = classifyAccounts(mixed);
  check("unrestricted cash = 5,000 (HSA excluded)", c.totalLiquid === 5_000 && c.totalRestrictedCash === 2_000);
  check("investment wealth = 107,000 (brokerage + 401k + unknown), all counted", c.totalInvestments === 107_000);
  check("net worth = 117,000 (everything owned)", c.netWorth === 117_000);
  const within = mixed.filter((a) => liquidityAccess(a) === "marketable").reduce((s, a) => s + a.balance, 0);
  check("'within days' = brokerage + crypto only = 43,000", within === 43_000);
}

console.log("6. Privacy aggregation keeps access apart");
{
  const share = (id: string, providerSubtype: string | null): ShareRow => ({
    visibilityLevel: "BALANCE_ONLY", addedByUserId: "u1", addedByUser: { firstName: "Brandon", name: null },
    financialAccount: { id, name: id, type: "checking", institution: "x", balance: 100, currency: "USD", lastUpdated: new Date(),
      creditLimit: null, debtSubtype: null, interestRate: null, minimumPayment: null, providerSubtype },
  });
  const { accounts } = normalizeSharedAccounts([share("chk", "checking"), share("hsa", "hsa")]);
  check("an HSA does not merge into an ordinary checking aggregate", accounts.length === 2);
  check("…and the aggregate still classifies as restricted", accounts.some((a) => liquidityAccess(a) === "restricted"));
}

console.log("7. Write path and consumers — one authority, provider evidence only");
{
  for (const f of ["lib/plaid/refresh.ts", "lib/plaid/exchangeToken.ts", "lib/accounts/recover-plaid-account.ts"]) {
    check(`${f} stores the provider's subtype via normalizeProviderSubtype`, /normalizeProviderSubtype\(acct\.subtype\)/.test(src(f)));
  }
  check("refresh rewrites it on every refresh (rows self-correct)", /providerSubtype: normalizeProviderSubtype\(acct\.subtype\)/.test(src("lib/plaid/refresh.ts")));
  check("no subtype is inferred from a name anywhere in the rule", !/name/i.test(src("lib/account-classifier.ts").split("export function liquidityAccess")[1].split("\n}\n")[0]));
  check("AI accounts assembler selects and classifies with providerSubtype (runway, Brief, scenarios read its totalLiquid)",
    /providerSubtype: true/.test(src("lib/ai/assemblers/accounts.ts")) && /providerSubtype: l\.financialAccount\.providerSubtype/.test(src("lib/ai/assemblers/accounts.ts")));
  check("Space mount loader selects providerSubtype", /providerSubtype: true/.test(src("lib/space/mount-composition.ts")));
  check("historical (as-of) liquidity rows carry providerSubtype too", /providerSubtype: r\.account\.providerSubtype/.test(src("lib/liquidity/space-data.ts")));
  check("REGRESSION: Assets 'within days' is marketable only, not investments + crypto",
    !/totalInvestments \+ c(lassification)?\.totalDigitalAssets/.test(src("components/space/widgets/liquidity-adapters.tsx"))
    && !/totalInvestments \+ classification\.totalDigitalAssets/.test(src("components/space/widgets/liquidity/LiquidityWorkspace.tsx")));
  check("REGRESSION: reachable cash uses the rule, not a checking/savings type check",
    /liquidityAccess\(a\) === "cash"/.test(src("components/space/widgets/liquidity-adapters.tsx")));
  check("the lens tiers come from liquidityAccess (no private type sets)", !/MARKETABLE_TYPES|CASH_TYPES/.test(src("lib/perspective-engine/lenses/liquidity.core.ts")));
  check("scenario opening cash conserves value: other assets = totalAssets − totalLiquid − investments",
    /\(accounts\.totalAssets \?\? 0\) - \(accounts\.totalLiquid \?\? 0\) - composition\.combined/.test(src("lib/ai/conversation/tools.ts")));
  check("net-worth Cash composition is the cash BALANCE (restricted included)", /c\.totalLiquid \+ c\.totalRestrictedCash/.test(src("components/space/widgets/wealth-adapters.tsx")));
}

if (failures > 0) { console.error(`\naccess.test: ${failures} failure(s).`); process.exit(1); }
console.log("\naccess.test: all passed.");
