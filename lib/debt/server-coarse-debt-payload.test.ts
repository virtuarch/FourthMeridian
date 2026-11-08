/* eslint-disable @typescript-eslint/no-explicit-any -- fake tenant client + untyped payload scans */
/**
 * lib/debt/server-coarse-debt-payload.test.ts
 *
 * S2 PRIVACY ruling P1-R1 (Production blocker) — the PAYLOAD, not just the
 * label, must not disclose a fine debt type to a viewer who neither owns nor
 * holds FULL visibility. The SERVER classifies from full evidence; a non-FULL
 * debt row reaches the client with `debtType` = the kind-preserving coarse type
 * and no raw `debtSubtype` / `providerSubtype` (creditLimit stays withheld).
 * Client math reads that server kind, so every figure equals the FULL view.
 *
 * One fake tenant client (the adjusted-balance.test.ts pattern) drives every
 * Space payload builder for a BALANCE_ONLY co-member, then for a FULL viewer:
 *
 *   a. lib/space/mount-composition loadSpaceAccounts  (Space mount / dashboard payload)
 *   b. lib/data/accounts getAccountsWithVisibility    (lenses, money view-context, export, as-of)
 *   c. lens cores over (b): computeLiquidity + computeDebt (liquidity / debt routes)
 *   d. the shared normalizer normalizeSharedAccounts  (accounts detail route)
 *   e. lib/ai/assemblers/accounts                     (AI payload)
 *   f. property equity (viewerPropertyEquity + aiPropertyFacts)
 *   g. client math over the payload: classifyAccounts, liquidNetWorthBasis,
 *      payoff kind, utilization — identical to FULL
 *   h. wealth/history: regenerateSpaceSnapshot (server-side, full evidence)
 *      writes the same row for both viewers.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { classifyAccounts } from "@/lib/account-classifier";
import { liquidNetWorthBasis } from "@/lib/debt/liquid-net-worth";
import { isInstallmentLoan, liabilityKind } from "@/lib/debt/liability-kind";
import { normalizeSharedAccounts } from "@/lib/account-privacy";
import { computeLiquidity, type LiquidityAccountRow } from "@/lib/perspective-engine/lenses/liquidity.core";
import { computeDebt, type DebtAccountRow } from "@/lib/perspective-engine/lenses/debt.core";
import { viewerPropertyEquity, aiPropertyFacts, type AiSpaceDebt } from "@/lib/assets/property-equity";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 600)}` : ""}`); }
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** The fine-type tokens S2 lists. */
const FINE = /mortgage|home equity|heloc|student|auto|line of credit|personal loan|line_of_credit|personal_loan|auto_loan|student_loan/i;
function scan(label: string, payload: unknown): void {
  const s = JSON.stringify(payload);
  const m = s.match(FINE);
  check(`SCAN ${label}: no fine debt-type token`, m === null, m ? s.slice(Math.max(0, (m.index ?? 0) - 120), (m.index ?? 0) + 60) : undefined);
}

const NOW = new Date("2026-11-08T12:00:00Z");
const fa = (id: string, type: string, balance: number, extra: Record<string, unknown> = {}) => ({
  id, type, institution: `Inst ${id}`, balance, availableBalance: null, currency: "USD",
  name: `Acct ${id}`, plaidName: null, officialName: null, nickname: null, customName: null, displayName: null, mask: null,
  lastUpdated: NOW, balanceLastUpdatedAt: NOW, creditLimit: null, debtSubtype: null, providerSubtype: null,
  syncStatus: "active", interestRate: null, minimumPayment: null, walletAddress: null, walletChain: null,
  balanceObserved: true, ownerUserId: "owner", deletedAt: null,
  debtProfile: null, connections: [], ...extra,
});
// The co-member's debts, every fine type S2 names.
const DEBTS = [
  fa("mtg",  "debt", 300_000, { debtSubtype: "mortgage" }),
  fa("pmtg", "debt", 150_000, { providerSubtype: "mortgage" }),
  fa("helc", "debt", 20_000,  { providerSubtype: "home equity", creditLimit: 50_000 }),
  fa("hel",  "debt", 10_000,  { providerSubtype: "home equity" }),       // closed-end, no limit
  fa("stu",  "debt", 25_000,  { providerSubtype: "student" }),
  fa("aut",  "debt", 18_000,  { debtSubtype: "auto_loan" }),
  fa("loc",  "debt", 3_000,   { providerSubtype: "line of credit", creditLimit: 10_000 }),
  fa("per",  "debt", 4_000,   { debtSubtype: "personal_loan" }),
  fa("cc",   "debt", 2_000,   { providerSubtype: "credit card", creditLimit: 8_000 }),
  fa("um",   "debt", 0,       { debtSubtype: "mortgage", balanceObserved: false }), // unobserved mortgage
];
const ACCOUNTS = [fa("chk", "checking", 12_000, { ownerUserId: "viewer" }), ...DEBTS];

function clientFor(debtTier: "BALANCE_ONLY" | "FULL"): any {
  return {
    spaceAccountLink: {
      async findMany() {
        return ACCOUNTS.map((a) => ({
          id: `l-${a.id}`, status: "ACTIVE", spaceId: "space-1",
          visibilityLevel: a.id === "chk" ? "FULL" : debtTier,
          addedByUserId: a.id === "chk" ? "viewer" : "owner",
          addedByUser: { firstName: "Jane", name: "Jane" }, financialAccount: a,
        }));
      },
    },
    transaction: { async findMany() { return []; }, async groupBy() { return []; } },
    financialAccount: { async findMany() { return []; } },
    space: { async findUnique() { return { reportingCurrency: "USD" }; } },
    spaceSnapshot: { async upsert(a: any) { (clientFor as any).last = a; return {}; } },
    positionObservation: { async findMany() { return []; } },
    manualAssetValuation: { async findMany() { return []; } },
    manualAssetProfile: { async findMany() { return []; } },
    user: { async findMany() { return [{ id: "owner", firstName: "Jane", name: "Jane" }]; } },
  };
}

async function payloads(debtTier: "BALANCE_ONLY" | "FULL") {
  const client = clientFor(debtTier);
  const { loadSpaceAccounts } = await import("@/lib/space/mount-composition");
  const mount = await loadSpaceAccounts(client, "space-1") as any[];
  const { getAccountsWithVisibility } = await import("@/lib/data/accounts");
  const vis = await getAccountsWithVisibility(client, { spaceId: "space-1", userId: "viewer" });
  await import("@/lib/ai/assemblers/accounts");
  const { getAssembler } = await import("@/lib/ai/assembler-registry");
  const { FinanceDomains } = await import("@/lib/ai/types");
  const section = await getAssembler(FinanceDomains.ACCOUNTS)!(client, { spaceId: "space-1", userId: "viewer" } as any, { scopeHint: "full" } as any);
  const ai = section?.data as any;
  // The lens bindings map getAccountsWithVisibility rows exactly like this
  // (lib/perspective-engine/lenses/liquidity.ts / debt.ts — source-pinned below).
  const liqRows: LiquidityAccountRow[] = vis.map(({ account: a, visibilityLevel }) => ({
    id: a.id, type: a.type, providerSubtype: a.providerSubtype ?? null, debtSubtype: a.debtSubtype ?? null,
    debtType: a.debtType ?? null, balance: a.balance, currency: a.currency ?? null, creditLimit: a.creditLimit ?? undefined,
    lastUpdated: a.lastUpdated, balanceLastUpdatedAt: a.balanceLastUpdatedAt ?? null,
    ...(a.valuationUnknown === true ? { valuationUnknown: true } : {}), visibilityLevel: visibilityLevel as string,
  }));
  const debtRows: DebtAccountRow[] = vis.map(({ account: a, visibilityLevel }) => ({
    id: a.id, type: a.type, balance: a.balance, currency: a.currency ?? null, lastUpdated: a.lastUpdated,
    balanceLastUpdatedAt: a.balanceLastUpdatedAt ?? null, visibilityLevel: visibilityLevel as string,
    interestRate: a.interestRate ?? undefined, minimumPayment: a.minimumPayment ?? undefined,
    ...(a.valuationUnknown === true ? { valuationUnknown: true } : {}),
  }));
  const SCOPE = { spaceId: "space-1", userId: "viewer" };
  const OPTS = { now: () => NOW };
  const liquidity = computeLiquidity(SCOPE, OPTS as any, liqRows);
  const debt = computeDebt(SCOPE as any, OPTS as any, debtRows);
  const shared = normalizeSharedAccounts((await client.spaceAccountLink.findMany()).filter((l: any) => l.visibilityLevel !== "FULL"));
  return { mount, vis, ai, liquidity, debt, shared };
}

function propertyFor(debtTier: "BALANCE_ONLY" | "FULL") {
  const debts = DEBTS.filter((d) => ["mtg", "helc"].includes(d.id)).map((d) => ({
    id: d.id, name: d.name, balance: d.balance, currency: d.currency, type: d.type,
    debtSubtype: d.debtSubtype as string | null, providerSubtype: d.providerSubtype as string | null, creditLimit: d.creditLimit as number | null,
    ownerUserId: "owner", deletedAt: null, links: [{ spaceId: "space-1", visibilityLevel: debtTier }],
  }));
  const product = viewerPropertyEquity({
    viewerUserId: "viewer", propertySpaceIds: ["space-1"], value: 600_000, currency: "USD", valueBasis: "MARKET_VALUE",
    linkedIds: ["mtg", "helc"], debts,
  });
  const ai = aiPropertyFacts({
    value: 600_000, currency: "USD",
    profile: { assetKind: "real_estate", valueBasis: "MARKET_VALUE", securedDebtAccountIds: ["mtg", "helc"] },
    spaceDebts: new Map<string, AiSpaceDebt>(debts.map((d) => [d.id, { ...d, visibilityLevel: debtTier }])),
  });
  return { product, ai };
}

function clientMath(rows: any[]) {
  const c = classifyAccounts(rows);
  const b = liquidNetWorthBasis(rows);
  const debts = rows.filter((r) => r.type === "debt");
  return {
    netWorth: c.netWorth, totalLiabilities: c.totalLiabilities, totalLiquid: c.totalLiquid,
    totalInstallmentLiabilities: (c as any).totalInstallmentLiabilities, unvaluedCount: c.unvaluedCount,
    lnwExcludedCount: b.excludedCount, lnwUnknownCount: b.unknownKindCount,
    installmentOwed: debts.filter((r) => isInstallmentLoan(r)).reduce((s, r) => s + r.balance, 0),
    revolvingOwed: debts.filter((r) => liabilityKind(r) === "revolving").reduce((s, r) => s + r.balance, 0),
  };
}

async function main(): Promise<void> {
  const bo = await payloads("BALANCE_ONLY");
  const full = await payloads("FULL");

  console.log("1. BALANCE_ONLY co-member — every Space payload, scanned");
  const boDebt = (rows: any[]) => rows.filter((r) => r.type === "debt");
  scan("mount / dashboard accounts (debt rows)", boDebt(bo.mount));
  scan("getAccountsWithVisibility (debt rows)", boDebt(bo.vis.map((r) => r.account)));
  scan("liquidity lens result", bo.liquidity);
  scan("debt lens result", bo.debt);
  scan("shared normalizer / accounts detail aggregates", bo.shared);
  scan("AI accounts (debt rows)", boDebt(bo.ai.accounts));
  scan("AI trackedAccounts (debt rows)", boDebt(bo.ai.trackedAccounts));
  scan("AI totalsExcluded + liquidNetWorth.excludedKinds", { t: bo.ai.totalsExcluded, k: bo.ai.liquidNetWorth?.excludedKinds });
  const prop = propertyFor("BALANCE_ONLY");
  scan("property equity (product securedDebts)", prop.product.securedDebts);
  scan("property equity (AI securedDebts)", prop.ai?.securedDebts);

  check("non-FULL debt rows carry NO raw subtype and a coarse debtType (mount + data layer)",
    [...boDebt(bo.mount), ...boDebt(bo.vis.map((r) => r.account))].every((r: any) =>
      r.debtSubtype == null && r.providerSubtype == null && r.creditLimit == null
      && ["other_installment", "other_revolving", "unknown"].includes(r.debtType)),
    [...boDebt(bo.mount), ...boDebt(bo.vis.map((r) => r.account))].map((r: any) => [r.id, r.debtSubtype, r.providerSubtype, r.debtType]));
  check("AI balance-only debt rows: coarse debtType + label + kind, no raw subtype",
    boDebt(bo.ai.accounts).every((r: any) => r.providerSubtype == null && /^other_|^unknown$/.test(r.debtType) && ["Loan", "Credit line", "Debt"].includes(r.debtTypeLabel)),
    boDebt(bo.ai.accounts));
  check("property: coarse kinds ('other_installment', 'other_revolving'), coarse labels",
    JSON.stringify(prop.product.securedDebts.map((d) => [d.kind, d.label, d.name])) === JSON.stringify([["other_installment", "Loan", "Loan"], ["other_revolving", "Credit line", "Credit line"]]),
    prop.product.securedDebts);

  console.log("\n2. Math identical to the FULL view");
  // Money only for the mount: BALANCE_ONLY rows are aggregated (row COUNTS differ by design).
  const money = (m: ReturnType<typeof clientMath>) => {
    const { lnwExcludedCount: _a, lnwUnknownCount: _b, ...rest } = m; return JSON.stringify(rest);
  };
  const mBo = clientMath(bo.mount), mFull = clientMath(full.mount);
  check("mount payload: classifier + liquid-NW + kind totals identical to FULL", money(mBo) === money(mFull), { mBo, mFull });
  // The data layer's own FULL rows turn a null creditLimit into `undefined`
  // (pre-existing), which counts a closed-end Plaid "home equity" loan as
  // unknown; the server's classification (and the mount / AI / snapshot FULL
  // views) excludes it. The coarse rows match the canonical FULL classification.
  const vBo = clientMath(bo.vis.map((r) => r.account));
  check("data-layer payload: classifier + liquid-NW + kind totals identical to the canonical FULL classification",
    JSON.stringify(vBo) === JSON.stringify(mFull), { vBo, mFull });
  check("AI totals + liquid NW amount identical",
    near(bo.ai.netWorth, full.ai.netWorth) && near(bo.ai.totalLiabilities, full.ai.totalLiabilities)
    && near(bo.ai.liquidNetWorth.amount, full.ai.liquidNetWorth.amount)
    && near(bo.ai.liquidNetWorth.excludedInstallmentDebt, full.ai.liquidNetWorth.excludedInstallmentDebt));
  // availableCredit needs creditLimit, which BALANCE_ONLY has always withheld (unchanged).
  const liqFig = (l: any) => JSON.stringify(l.metrics?.filter?.((m: any) => m.id !== "availableCredit").map((m: any) => [m.id, m.value]) ?? l.headline);
  check("liquidity lens figures identical", liqFig(bo.liquidity) === liqFig(full.liquidity), [liqFig(bo.liquidity), liqFig(full.liquidity)]);
  check("debt lens total identical", JSON.stringify(bo.debt.headline?.value) === JSON.stringify(full.debt.headline?.value));
  const fp = propertyFor("FULL");
  check("property equity figure identical", prop.product.equity === fp.product.equity && prop.product.securedDebtTotal === fp.product.securedDebtTotal
    && prop.ai?.derivedEquity === fp.ai?.derivedEquity);
  const owedByKind = (rows: any[]) => {
    const m: Record<string, number> = {};
    for (const r of rows.filter((x) => x.type === "debt")) m[r.liabilityKind ?? "?"] = (m[r.liabilityKind ?? "?"] ?? 0) + (r.amountOwed ?? r.balance);
    return JSON.stringify(Object.entries(m).sort());
  };
  check("payoff kind (AI liabilityKind → scenario targeting): owed per kind identical to FULL",
    owedByKind(bo.ai.accounts) === owedByKind(full.ai.accounts), [owedByKind(bo.ai.accounts), owedByKind(full.ai.accounts)]);

  console.log("\n3. Owner / FULL unchanged");
  check("FULL rows keep raw subtypes (mount)", boDebt(full.mount).some((r: any) => r.debtSubtype === "mortgage") && boDebt(full.mount).some((r: any) => r.providerSubtype === "home equity"));
  check("FULL AI rows name 'Mortgage' / 'HELOC'", boDebt(full.ai.accounts).some((r: any) => r.debtTypeLabel === "Mortgage") && boDebt(full.ai.accounts).some((r: any) => r.debtTypeLabel === "HELOC"));
  check("FULL property: kind 'mortgage' / 'heloc'", JSON.stringify(fp.product.securedDebts.map((d) => d.kind)) === '["mortgage","heloc"]', fp.product.securedDebts);

  console.log("\n4. Source pins — routes that map the normalizer / data layer");
  const root = process.cwd();
  const read = (p: string) => readFileSync(join(root, p), "utf8");
  check("liquidity lens + space-data + historical splice carry debtType",
    /debtType:\s+account\.debtType/.test(read("lib/perspective-engine/lenses/liquidity.ts"))
    && /debtType: r\.account\.debtType/.test(read("lib/liquidity/space-data.ts"))
    && (read("lib/liquidity/historical-splice.ts").match(/debtType: r\.debtType/g) ?? []).length === 2);
  const detail = read("app/api/spaces/[id]/accounts/detail/route.ts");
  const aggMap = detail.slice(detail.indexOf("normalizeSharedAccounts(balanceOnlyShares)"));
  check("accounts detail route: aggregated rows map no subtype field", !/Subtype/.test(aggMap.slice(0, 2500)));
  check("payoff kind evidence carries the server debtType", /debtType: a\.debtType \?\? null/.test(read("components/space/sections/DebtPayoffSection.tsx")));

  if (failures > 0) { console.error(`\n${failures} failure(s)`); process.exit(1); }
  console.log("\nall server-coarse-debt-payload checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
