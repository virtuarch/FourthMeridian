/**
 * lib/balances/excluded-accounts-detector.test.ts
 *
 * Mortgage F8a/b/c — ONE excluded-accounts detector, type-attributed partial
 * totals. Fabricated fixtures only.
 *
 *   1. detector (table-driven): which rows are excluded, why, as what type
 *   2. F8a economic concepts: an unobserved MORTGAGE is a DEBT partial (never
 *      "crypto wallet(s) not yet valued"); an unvalued wallet is still digital
 *   3. F8b Brief quality block: PARTIAL with direction; installment ≠ liquid NW partial
 *   4. F8b liquidity lens: PARTIAL with direction for unobserved revolving debt
 *      / cash; an unobserved installment loan does NOT make liquid NW partial
 *   5. source scan: no ad-hoc `balanceObserved === false` / `totalsUnvaluedCount`
 *      interpretation outside the detector (allowlisted producers/writers only)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/balances/excluded-accounts-detector.test.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  detectExcludedAccounts, excludedAccountCounts, partialTotalStatement, aiExcludedAccountGroups,
  excludedFromAiAccounts, isBalanceUnobserved,
  type ExclusionDetectorRow, type ExcludedAccountClass, type ExclusionReason,
} from "./unobserved-totals";
import { composeExcludedTotals, composeInvestments, ComponentState } from "@/lib/ai/economic-concepts";
import { projectBriefPackage, type BriefInputs } from "@/lib/ai/brief/package";
import { computeLiquidity, type LiquidityAccountRow } from "@/lib/perspective-engine/lenses/liquidity.core";
import { validateLensResult } from "@/lib/perspective-engine/index";
import type { AccountsSectionData } from "@/lib/ai/types";

let passes = 0, failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passes++; return; }
  failures++;
  console.error(`✗ ${name}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

// ══ 1. Detector — table-driven ════════════════════════════════════════════════
{
  type Row = { name: string; row: ExclusionDetectorRow;
    want: null | { reason: ExclusionReason; cls: ExcludedAccountClass; label: string; count?: number; installment?: boolean } };
  const T: Row[] = [
    { name: "observed checking", row: { type: "checking" }, want: null },
    { name: "balanceObserved true", row: { type: "debt", debtSubtype: "mortgage", balanceObserved: true }, want: null },
    { name: "unobserved Plaid mortgage", row: { type: "debt", providerSubtype: "mortgage", balanceObserved: false },
      want: { reason: "UNOBSERVED", cls: "DEBT", label: "mortgage", installment: true } },
    { name: "flagged mortgage (valuationUnknown only)", row: { type: "debt", debtSubtype: "mortgage", valuationUnknown: true },
      want: { reason: "UNOBSERVED", cls: "DEBT", label: "mortgage", installment: true } },
    { name: "unobserved credit card", row: { type: "debt", providerSubtype: "credit card", balanceObserved: false },
      want: { reason: "UNOBSERVED", cls: "DEBT", label: "credit card" } },
    { name: "unobserved HELOC keeps its acronym", row: { type: "debt", debtSubtype: "heloc", valuationUnknown: true },
      want: { reason: "UNOBSERVED", cls: "DEBT", label: "HELOC" } },
    { name: "untyped debt", row: { type: "debt", valuationUnknown: true },
      want: { reason: "UNOBSERVED", cls: "DEBT", label: "debt" } },
    { name: "unvalued crypto wallet", row: { type: "crypto", valuationUnknown: true },
      want: { reason: "UNVALUED", cls: "DIGITAL_ASSET", label: "crypto wallet" } },
    { name: "never-observed crypto wallet", row: { type: "crypto", balanceObserved: false },
      want: { reason: "UNOBSERVED", cls: "DIGITAL_ASSET", label: "crypto wallet" } },
    { name: "unobserved checking", row: { type: "checking", balanceObserved: false },
      want: { reason: "UNOBSERVED", cls: "CASH", label: "checking account" } },
    { name: "unobserved brokerage", row: { type: "investment", valuationUnknown: true },
      want: { reason: "UNOBSERVED", cls: "INVESTMENT", label: "investment account" } },
    { name: "fold with 2 excluded members", row: { type: "crypto", unvaluedMemberCount: 2 },
      want: { reason: "UNVALUED", cls: "DIGITAL_ASSET", label: "crypto wallet", count: 2 } },
    { name: "unconverted", row: { type: "savings", unconverted: true },
      want: { reason: "UNCONVERTED", cls: "CASH", label: "savings account" } },
    { name: "redacted wins", row: { type: "debt", redacted: true, balanceObserved: false },
      want: { reason: "REDACTED", cls: "DEBT", label: "debt" } },
  ];
  for (const t of T) {
    const got = detectExcludedAccounts([t.row]);
    if (t.want === null) { check(`detector: ${t.name} ⇒ not excluded`, got.length === 0, got); continue; }
    const g = got[0];
    check(`detector: ${t.name}`,
      got.length === 1 && g.reason === t.want.reason && g.accountClass === t.want.cls && g.label === t.want.label
      && g.count === (t.want.count ?? 1) && (g.excludedFromLiquidNetWorth === true) === (t.want.installment === true), got);
  }
  check("isBalanceUnobserved: only false", isBalanceUnobserved({ balanceObserved: false })
    && !isBalanceUnobserved({ balanceObserved: null }) && !isBalanceUnobserved({}));
  // Counts unchanged in meaning: UNCONVERTED / REDACTED never feed the F8 totals.
  const c = excludedAccountCounts([
    { type: "debt", debtSubtype: "mortgage", valuationUnknown: true },
    { type: "debt", debtSubtype: "credit_card", valuationUnknown: true },
    { type: "checking", valuationUnknown: true },
    { type: "savings", unconverted: true },
    { type: "investment", redacted: true },
  ]);
  check("counts: debt 2 (1 installment), asset 1, liquid 1", c.debt === 2 && c.installmentDebt === 1 && c.asset === 1 && c.liquid === 1, c);
  const s = partialTotalStatement("TOTAL_DEBT", detectExcludedAccounts([{ type: "debt", debtSubtype: "mortgage", valuationUnknown: true }]));
  check("statement: total debt names the mortgage, may be understated",
    s?.text === "Total debt — partial: 1 balance unavailable (mortgage); may be understated", s?.text);
  check("statement: installment-only ⇒ liquid NW COMPLETE",
    partialTotalStatement("LIQUID_NET_WORTH", detectExcludedAccounts([{ type: "debt", debtSubtype: "mortgage", valuationUnknown: true }])) === null);
}

// ══ 2. F8a — economic concepts attribute by type ═════════════════════════════
const accFor = (rows: ExclusionDetectorRow[], over: Partial<AccountsSectionData> = {}): AccountsSectionData => {
  const groups = aiExcludedAccountGroups(rows);
  return {
    redactedCount: 0, totalsUnconverted: false,
    totalInvestments: 5000, totalDigitalAssets: 2000, totalLiquid: 10000, netWorth: 17000,
    totalAssets: 17000, totalLiabilities: 0,
    counts: { liquid: 1, investments: 1, digitalAssets: 1, realAssets: 0, liabilities: 1 },
    ...(groups.length ? { totalsExcluded: groups, totalsUnvaluedCount: groups.reduce((n, g) => n + g.count, 0) } : {}),
    ...over,
  } as unknown as AccountsSectionData;
};
{
  const mortgage = accFor([{ type: "debt", providerSubtype: "mortgage", balanceObserved: false }]);
  const inv = composeInvestments(mortgage);
  check("F8a: unobserved mortgage leaves digital assets ASSERTABLE",
    inv?.components.find((c) => c.key === "DIGITAL_ASSETS")?.state === ComponentState.ASSERTABLE, inv);
  check("F8a: …and traditional investments ASSERTABLE, combined stated",
    inv?.components.find((c) => c.key === "TRADITIONAL_INVESTMENTS")?.state === ComponentState.ASSERTABLE && inv?.combined === 7000, inv);
  const x = composeExcludedTotals(mortgage);
  const debt = x?.classes.find((c) => c.key === "DEBT");
  check("F8a: DEBT is PARTIAL, direction: true amount owed is higher",
    debt?.state === "PARTIAL" && debt.direction === "TRUE_TOTAL_HIGHER" && x?.classes.length === 1, x);
  check("F8a: copy names \"mortgage\" and says debt may be understated",
    /1 mortgage/.test(debt?.reason ?? "") && /debt may be understated/.test(debt?.reason ?? "") && !/crypto/.test(JSON.stringify(x)), debt?.reason);
  check("F8a: totals — net worth + total debt partial, liquid NW not (installment)",
    x!.totals.some((t) => t.total === "NET_WORTH") && x!.totals.some((t) => t.total === "TOTAL_DEBT")
    && !x!.totals.some((t) => t.total === "LIQUID_NET_WORTH"), x?.totals.map((t) => t.total));

  const wallet = accFor([{ type: "crypto", valuationUnknown: true }]);
  const w = composeInvestments(wallet);
  const dig = w?.components.find((c) => c.key === "DIGITAL_ASSETS");
  check("F8a: unvalued crypto wallet still ⇒ digital assets UNKNOWN, named",
    dig?.state === ComponentState.UNKNOWN && /crypto wallet/.test(dig.reason ?? "") && /not yet valued/.test(dig.reason ?? ""), dig);
  check("F8a: …traditional still stands", w?.components.find((c) => c.key === "TRADITIONAL_INVESTMENTS")?.state === ComponentState.ASSERTABLE);
  check("F8a: …and the class is DIGITAL_ASSETS", composeExcludedTotals(wallet)?.classes[0]?.key === "DIGITAL_ASSETS");

  // Legacy payload: a bare count is unattributable — never read as "crypto wallets".
  const legacy = { ...accFor([]), totalsUnvaluedCount: 1 } as AccountsSectionData;
  const l = composeInvestments(legacy);
  check("F8a: legacy bare count is not attributed to crypto",
    !/crypto/.test(JSON.stringify(l)) && excludedFromAiAccounts(legacy)[0]?.accountClass === "UNKNOWN", l);
  check("F8a: nothing excluded ⇒ no excluded-balances block", composeExcludedTotals(accFor([])) === null);
}

// ══ 3. F8b — Brief quality block ═════════════════════════════════════════════
const brief = (acc: AccountsSectionData, asOf = "2026-09-13"): ReturnType<typeof projectBriefPackage> => projectBriefPackage({
  asOf, today: "2026-09-13", now: new Date("2026-09-13T12:00:00.000Z"), currency: "USD",
  accounts: { ...acc, health: { errorCount: 0, staleCount: 0, needsReauthCount: 0, errorAccountNames: [], staleAccountNames: [], needsReauthAccountNames: [] }, knowledgeGaps: [], accounts: [] } as AccountsSectionData,
  transactions: null, snapshot: null, holdings: null, assessment: null, memories: [], recentActivity: null,
} as BriefInputs);
{
  const card = brief(accFor([{ type: "debt", debtSubtype: "credit_card", valuationUnknown: true }]));
  const lnw = card.dataQuality.partialTotals?.find((t) => t.total === "LIQUID_NET_WORTH");
  check("F8b Brief: unobserved card ⇒ liquid NW PARTIAL, may be overstated, names the card",
    lnw?.note === "Liquid net worth — partial: 1 balance unavailable (credit card); may be overstated"
    && lnw.directions.includes("TRUE_TOTAL_LOWER"), card.dataQuality.partialTotals);
  const cash = brief(accFor([{ type: "checking", valuationUnknown: true }]));
  const liquid = cash.dataQuality.partialTotals?.find((t) => t.total === "LIQUID_CASH");
  check("F8b Brief: unobserved checking ⇒ cash PARTIAL, may be understated",
    /may be understated/.test(liquid?.note ?? "") && liquid!.directions.includes("TRUE_TOTAL_MAY_BE_HIGHER"), cash.dataQuality.partialTotals);
  const mort = brief(accFor([{ type: "debt", debtSubtype: "mortgage", valuationUnknown: true }]));
  check("F8b Brief: unobserved mortgage ⇒ liquid NW NOT partial; debt partial",
    !mort.dataQuality.partialTotals?.some((t) => t.total === "LIQUID_NET_WORTH")
    && mort.dataQuality.partialTotals?.some((t) => t.total === "TOTAL_DEBT" && /mortgage/.test(t.note)) === true, mort.dataQuality.partialTotals);
  check("F8b Brief: complete Space ⇒ no partialTotals key", !("partialTotals" in brief(accFor([])).dataQuality));
}

// ══ 4. F8b — liquidity lens ═══════════════════════════════════════════════════
{
  const SCOPE = { spaceId: "space_f8", userId: "user_f8" };
  const OPTS = { now: () => new Date("2026-07-03T12:00:00.000Z") };
  const base = (over: Partial<LiquidityAccountRow>): LiquidityAccountRow =>
    ({ id: "a", type: "checking", balance: 1000, lastUpdated: "2026-07-03T06:00:00.000Z", visibilityLevel: "FULL", ...over });
  const chk = base({ id: "chk" });

  const card = computeLiquidity(SCOPE, OPTS, [chk, base({ id: "cc", type: "debt", debtSubtype: "credit_card", balance: 0, valuationUnknown: true })]);
  check("F8b lens: unobserved revolving debt ⇒ liquid NW PARTIAL with direction",
    card.liquidNetWorthCoverage?.status === "PARTIAL" && card.liquidNetWorthCoverage.directions.includes("TRUE_TOTAL_LOWER")
    && card.assumptions.some((a) => a.id === "liquid-net-worth-partial" && /credit card\); may be overstated/.test(a.text)), card);
  check("F8b lens: …the cash headline stays complete", card.totalsCoverage === undefined && card.headline?.label === "Available as cash now");
  check("F8b lens: …and the result validates", validateLensResult(card).length === 0, validateLensResult(card));

  const cash = computeLiquidity(SCOPE, OPTS, [chk, base({ id: "sav", type: "savings", balance: 0, valuationUnknown: true })]);
  check("F8b lens: unobserved savings ⇒ cash headline PARTIAL, may be understated",
    cash.totalsCoverage?.status === "PARTIAL" && /^Available as cash now — partial: 1 balance unavailable \(savings account\); may be understated$/.test(cash.headline?.label ?? ""),
    cash.headline?.label);
  check("F8b lens: …and liquid NW partial too", cash.liquidNetWorthCoverage?.status === "PARTIAL");

  const mort = computeLiquidity(SCOPE, OPTS, [chk, base({ id: "m", type: "debt", debtSubtype: "mortgage", balance: 0, valuationUnknown: true })]);
  check("F8b lens: unobserved installment loan does NOT make liquid NW partial (F1)",
    mort.liquidNetWorthCoverage === undefined && mort.totalsCoverage === undefined
    && !mort.assumptions.some((a) => a.id === "liquid-net-worth-partial"), mort);

  const plain = computeLiquidity(SCOPE, OPTS, [chk]);
  check("F8b lens: complete Space ⇒ no coverage keys (byte-identical)",
    !("totalsCoverage" in plain) && !("liquidNetWorthCoverage" in plain));
}

// ══ 5. Source scan — one detector ═════════════════════════════════════════════
{
  /**
   * Files allowed to read the raw flags, and why. Everything else asks the
   * detector (isBalanceUnobserved / detectExcludedAccounts / excludedFromAiAccounts).
   */
  const ALLOW: Record<string, string> = {
    "lib/balances/unobserved-totals.ts": "THE detector",
    "lib/ai/types.ts": "declares the legacy totalsUnvaluedCount field",
    "lib/ai/assemblers/accounts.ts": "PRODUCES totalsUnvaluedCount from classifyAccounts().unvaluedCount",
    "lib/snapshots/backfill.ts": "snapshot engine may import nothing from lib/balances (reconciliation-boundary.test.ts §14); routes the row through resolveWalletBalance",
    "lib/plaid/refresh.ts": "WRITE path: a first observation flips the flag to true",
    "lib/plaid/exchangeToken.ts": "WRITE path: stamps the flag at token exchange",
  };
  const ROOTS = ["lib", "app", "components", "jobs"];
  const PATTERNS = [
    /balanceObserved\s*(===|!==|==|!=)\s*(true|false)/,
    /!\s*[\w.?]*\.balanceObserved\b/,
    /\btotalsUnvaluedCount\b/,
  ];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === "node_modules" || name.startsWith(".")) continue;
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name) || /\.d\.ts$/.test(name)) continue;
      const rel = relative(process.cwd(), p);
      if (ALLOW[rel]) continue;
      const code = readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      for (const re of PATTERNS) if (re.test(code)) offenders.push(`${rel} (${re.source})`);
    }
  };
  for (const r of ROOTS) { try { walk(join(process.cwd(), r)); } catch { /* root absent */ } }
  check("source scan: no ad-hoc exclusion interpretation outside the detector", offenders.length === 0, offenders);
  // The allowlist must stay honest: each entry still matches (else remove it).
  for (const f of Object.keys(ALLOW)) {
    const code = readFileSync(join(process.cwd(), f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    check(`source scan: allowlisted ${f} still needs it`, PATTERNS.some((re) => re.test(code)) || f === "lib/balances/unobserved-totals.ts");
  }
}

console.log(`\nexcluded-accounts-detector: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
