/**
 * lib/balances/unobserved-totals.test.ts
 *
 * Mortgage F8 (S2) — a total that excludes an account of unknown balance is
 * PARTIAL at the TOTAL, with its direction. Fabricated fixtures only ($10k
 * checking, $500k property, a $300k mortgage whose balance was never observed).
 *
 *   1. unobserved debt  ⇒ net worth PARTIAL, "the true total is lower"
 *   2. unobserved asset ⇒ "the true total may be higher"
 *   3. both             ⇒ both directions listed
 *   4. none             ⇒ COMPLETE, no badge (envelope has no caveat)
 *   5. surfaces: wealth envelope / hero coverage per metric, debt lens, AI
 *      payload (get_financial_snapshot carries status + direction beside the totals)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/balances/unobserved-totals.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { classifyAccounts } from "@/lib/account-classifier";
import { resolveWalletBalance } from "@/lib/crypto/wallet-current-value";
import {
  excludedAccountCounts, unobservedTotalCoverage, aiTotalsCoverage, exclusionBadge,
} from "./unobserved-totals";
import { resolvePerspectiveEnvelope, partialTotalWarnings } from "@/lib/perspectives/envelope";
import { wealthTotalsCoverage, wealthHeadlineCoverage } from "@/components/space/widgets/wealth/WealthHero";
import { computeDebt, type DebtAccountRow } from "@/lib/perspective-engine/lenses/debt.core";
import { registerAssembler } from "@/lib/ai/assembler-registry";
import { getFinancialSnapshot } from "@/lib/ai/conversation/tools/snapshot";
import { FinanceDomains, type AccountsSectionData } from "@/lib/ai/types";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const unobs = resolveWalletBalance(300_000, undefined, false); // balanceObserved = false
const CHECKING = { id: "chk", type: "checking", balance: 10_000, currency: "USD" };
const PROPERTY = { id: "house", type: "other", balance: 500_000, currency: "USD" };
const MORTGAGE_UNOBSERVED = { id: "mtg", type: "debt", currency: "USD", providerSubtype: "mortgage", ...unobs };
const SAVINGS_UNOBSERVED  = { id: "sav", type: "savings", currency: "USD", ...resolveWalletBalance(25_000, undefined, false) };
const BROKERAGE_UNOBSERVED = { id: "brk", type: "investment", currency: "USD", ...resolveWalletBalance(40_000, undefined, false) };

// ── 1. unobserved debt ⇒ net worth PARTIAL, "true total is lower" ────────────
console.log("1. Unobserved DEBT ⇒ net worth PARTIAL, true total is lower");
{
  const rows = [CHECKING, PROPERTY, MORTGAGE_UNOBSERVED];
  const c = classifyAccounts(rows);
  const counts = excludedAccountCounts(rows);
  const nw = unobservedTotalCoverage("NET_WORTH", counts);
  check("the balance stays EXCLUDED (no invented number): netWorth 510,000, liabilities 0", c.netWorth === 510_000 && c.totalLiabilities === 0, c);
  check("counts: 1 debt (an installment loan), 0 assets", counts.debt === 1 && counts.installmentDebt === 1 && counts.asset === 0 && counts.liquid === 0, counts);
  check("net worth PARTIAL, TRUE_TOTAL_LOWER", nw.status === "PARTIAL" && nw.directions.join() === "TRUE_TOTAL_LOWER" && nw.excludedDebtCount === 1, nw);
  check("note: 'Excludes a debt of unknown balance — the true total is lower'", nw.notes[0] === "Excludes a debt of unknown balance — the true total is lower", nw.notes);
  const debt = unobservedTotalCoverage("TOTAL_DEBT", counts);
  check("debt total PARTIAL — 'the true amount owed is higher'", debt.status === "PARTIAL" && debt.directions.join() === "TRUE_TOTAL_HIGHER"
    && debt.notes[0] === "Excludes a debt of unknown balance — the true amount owed is higher", debt);
  // Mortgage F1 — liquid NW never subtracts an installment loan, so an unknown
  // mortgage balance cannot make it partial.
  check("liquid net worth COMPLETE — a mortgage is excluded from it (F1)", unobservedTotalCoverage("LIQUID_NET_WORTH", counts).status === "COMPLETE");
  const unknownKindDebt = { id: "d", type: "debt", currency: "USD", ...unobs };
  check("…an unobserved debt of UNKNOWN kind still makes liquid net worth PARTIAL, lower",
    unobservedTotalCoverage("LIQUID_NET_WORTH", excludedAccountCounts([CHECKING, unknownKindDebt])).directions.join() === "TRUE_TOTAL_LOWER");
  check("total assets unaffected by an excluded debt ⇒ COMPLETE", unobservedTotalCoverage("TOTAL_ASSETS", counts).status === "COMPLETE");
  check("badge: 'Partial — true total is lower'", exclusionBadge(nw.directions[0]) === "Partial — true total is lower");
  const two = unobservedTotalCoverage("NET_WORTH", { debt: 2, asset: 0, liquid: 0 });
  check("plural: 'Excludes 2 debts of unknown balance — the true total is lower'", two.notes[0] === "Excludes 2 debts of unknown balance — the true total is lower", two.notes);
}

// ── 2. unobserved asset ⇒ "may be higher" ───────────────────────────────────
console.log("2. Unobserved ASSET ⇒ true total may be higher");
{
  const counts = excludedAccountCounts([CHECKING, BROKERAGE_UNOBSERVED]);
  const nw = unobservedTotalCoverage("NET_WORTH", counts);
  check("net worth PARTIAL, TRUE_TOTAL_MAY_BE_HIGHER", nw.status === "PARTIAL" && nw.directions.join() === "TRUE_TOTAL_MAY_BE_HIGHER", nw);
  check("note: 'Excludes an account of unknown balance — the true total may be higher'",
    nw.notes[0] === "Excludes an account of unknown balance — the true total may be higher", nw.notes);
  check("total assets PARTIAL too; the debt total is COMPLETE",
    unobservedTotalCoverage("TOTAL_ASSETS", counts).status === "PARTIAL" && unobservedTotalCoverage("TOTAL_DEBT", counts).status === "COMPLETE");
  check("a brokerage account never makes LIQUID figures partial",
    unobservedTotalCoverage("LIQUID_NET_WORTH", counts).status === "COMPLETE" && unobservedTotalCoverage("LIQUID_CASH", counts).status === "COMPLETE");
  const sav = excludedAccountCounts([CHECKING, SAVINGS_UNOBSERVED]);
  check("an unobserved savings account makes liquid net worth PARTIAL, may be higher",
    unobservedTotalCoverage("LIQUID_NET_WORTH", sav).directions.join() === "TRUE_TOTAL_MAY_BE_HIGHER");
  check("an aggregate row's excluded members count by the row's type",
    excludedAccountCounts([{ type: "debt", unvaluedMemberCount: 2 }, { type: "savings", unvaluedMemberCount: 1 }]).debt === 2
      && excludedAccountCounts([{ type: "savings", unvaluedMemberCount: 1 }]).liquid === 1);
}

// ── 3. both ⇒ both directions listed ────────────────────────────────────────
console.log("3. Excluded debt AND asset ⇒ both directions listed");
{
  const counts = excludedAccountCounts([CHECKING, MORTGAGE_UNOBSERVED, BROKERAGE_UNOBSERVED]);
  const nw = unobservedTotalCoverage("NET_WORTH", counts);
  check("net worth PARTIAL with BOTH directions, debt first",
    nw.status === "PARTIAL" && nw.directions.join() === "TRUE_TOTAL_LOWER,TRUE_TOTAL_MAY_BE_HIGHER" && nw.notes.length === 2, nw);
  const w = partialTotalWarnings(nw);
  check("envelope: one 'partial-total' warning per direction, labels state each direction",
    w.length === 2 && w.every((x) => x.kind === "partial-total")
      && w[0].label === "Partial — true total is lower" && w[1].label === "Partial — true total may be higher", w);
  check("warning detail quotes the note and says never $0 / never estimated",
    w[0].detail!.startsWith("Excludes a debt of unknown balance — the true total is lower.") && w[0].detail!.includes("never counted as $0"));
}

// ── 4. none ⇒ COMPLETE, no badge ────────────────────────────────────────────
console.log("4. Nothing excluded ⇒ COMPLETE, no badge");
{
  const counts = excludedAccountCounts([CHECKING, PROPERTY, { id: "mtg", type: "debt", balance: 300_000, currency: "USD" }]);
  const nw = unobservedTotalCoverage("NET_WORTH", counts);
  check("COMPLETE, no directions, no notes", nw.status === "COMPLETE" && nw.directions.length === 0 && nw.notes.length === 0, nw);
  check("no envelope warning for a COMPLETE total", partialTotalWarnings(nw).length === 0);
  check("AI: no totalsCoverage when every total is COMPLETE", aiTotalsCoverage(counts) === null);
  check("wealth: no metric carries partial coverage", Object.keys(wealthTotalsCoverage(counts)).length === 0);
}

// ── 5. Surfaces ─────────────────────────────────────────────────────────────
console.log("5. Wealth envelope + hero, debt lens, AI tool contract");
{
  const counts = excludedAccountCounts([CHECKING, PROPERTY, MORTGAGE_UNOBSERVED]);
  const cov = wealthTotalsCoverage(counts);
  // Mortgage F1 — the excluded debt is a MORTGAGE, which liquid NW never subtracts.
  check("wealth: netWorth / totalLiabilities partial; liquidNetWorth (mortgage excluded, F1) / totalAssets / cash not",
    cov.netWorth?.status === "PARTIAL" && cov.liquidNetWorth === undefined && cov.totalLiabilities?.status === "PARTIAL"
      && cov.totalAssets === undefined && cov.cash === undefined, Object.keys(cov));

  // A minimal WealthResult — the envelope's wealth branch needs only asOfState.
  const result = { asOfState: { found: true, isEstimated: false, date: "2026-07-15" }, compareState: null, hasHistory: true } as unknown as WealthResult;
  const env = resolvePerspectiveEnvelope({
    perspectiveId: "wealth", wealthResult: result, currency: "USD", wealthChipTier: "observed",
    totalsCoverage: wealthHeadlineCoverage(cov, "netWorth", counts),
  });
  check("wealth envelope (net worth headline) carries 'Partial — true total is lower'",
    (env.warnings ?? []).some((w) => w.kind === "partial-total" && w.label === "Partial — true total is lower"), env.warnings);
  const clean = resolvePerspectiveEnvelope({
    perspectiveId: "wealth", wealthResult: result, currency: "USD", wealthChipTier: "observed",
    totalsCoverage: wealthHeadlineCoverage({}, "netWorth", excludedAccountCounts([CHECKING])),
  });
  check("wealth envelope with nothing excluded: no partial caveat", !(clean.warnings ?? []).some((w) => w.kind === "partial-total"), clean.warnings);
  const hero = readFileSync(join(process.cwd(), "components/space/widgets/wealth/WealthHero.tsx"), "utf8");
  check("hero secondary stats render the PartialMark beside each figure",
    hero.includes("<PartialMark coverage={totalsCoverage?.[row.key]} />"));

  // Debt lens: an unobserved mortgage (structural 0 + valuationUnknown) beside a $5k card.
  const now = () => new Date("2026-07-15T12:00:00.000Z");
  const row = (o: Partial<DebtAccountRow> & { id: string; balance: number }): DebtAccountRow => ({
    type: "debt", currency: "USD", lastUpdated: "2026-07-15T00:00:00.000Z", visibilityLevel: "FULL", ...o,
  } as DebtAccountRow);
  const lens = computeDebt({ spaceId: "s1", userId: "u1" } as never, { now } as never, [
    row({ id: "card", balance: 5_000, interestRate: 25 }),
    row({ id: "mtg", balance: 0, valuationUnknown: true }),
  ]);
  check("debt lens: totalDebt 5,000 (the mortgage is not invented)", lens.headline?.value === 5_000, lens.headline);
  check("debt lens: headline labelled partial with the direction",
    lens.headline?.label === "Total debt — partial: Excludes a debt of unknown balance — the true amount owed is higher", lens.headline?.label);
  check("debt lens: totalsCoverage PARTIAL / TRUE_TOTAL_HIGHER, verdict + assumption state it",
    lens.totalsCoverage?.status === "PARTIAL" && lens.totalsCoverage.directions.join() === "TRUE_TOTAL_HIGHER"
      && (lens.verdict ?? "").endsWith("the true amount owed is higher.")
      && lens.assumptions.some((a) => a.id === "excluded-unknown-balance"), lens);
  const lensEnv = resolvePerspectiveEnvelope({ perspectiveId: "debt", lensResult: lens });
  check("debt envelope carries 'Partial — true amount owed is higher'",
    (lensEnv.warnings ?? []).some((w) => w.label === "Partial — true amount owed is higher"), lensEnv.warnings);
  const cleanLens = computeDebt({ spaceId: "s1", userId: "u1" } as never, { now } as never, [row({ id: "card", balance: 5_000, interestRate: 25 })]);
  check("debt lens with every balance observed: no totalsCoverage key, plain 'Total debt'",
    !("totalsCoverage" in cleanLens) && cleanLens.headline?.label === "Total debt");

  // AI tool contract — the payload get_financial_snapshot returns.
  const ai = aiTotalsCoverage(counts)!;
  check("AI coverage: netWorth PARTIAL lower, totalLiabilities PARTIAL higher, totalAssets COMPLETE, meaning quotable",
    ai.netWorth.status === "PARTIAL" && ai.netWorth.directions.join() === "TRUE_TOTAL_LOWER"
      && ai.totalLiabilities.directions.join() === "TRUE_TOTAL_HIGHER" && ai.totalAssets.status === "COMPLETE"
      && ai.meaning.includes("true net worth is LOWER"), ai);
  const c = classifyAccounts([CHECKING, PROPERTY, MORTGAGE_UNOBSERVED]);
  const data = {
    totalCount: 3, redactedCount: 0, totalAssets: c.totalAssets, totalLiabilities: c.totalLiabilities, netWorth: c.netWorth,
    totalLiquid: c.totalLiquid, totalInvestments: 0, totalDigitalAssets: 0, totalRealAssets: c.totalRealAssets,
    totalsEstimated: false, totalsUnconverted: false, totalsUnvaluedCount: c.unvaluedCount, totalsCoverage: ai,
    counts: { liquid: 1, investments: 0, digitalAssets: 0, realAssets: 1, liabilities: 1 },
    health: { errorCount: 0, staleCount: 0, needsReauthCount: 0, errorAccountNames: [], staleAccountNames: [], needsReauthAccountNames: [] },
    knowledgeGaps: [], accounts: [],
  } as unknown as AccountsSectionData;
  registerAssembler(FinanceDomains.ACCOUNTS, async () => ({ domain: FinanceDomains.ACCOUNTS, assembledAt: "2026-07-15T00:00:00.000Z", data }) as never);
  void (async () => {
    const out = await getFinancialSnapshot.run({}, { asOfISO: "2026-07-15", readClient: {} as never, spaceCtx: {} as never } as never) as Record<string, unknown>;
    const tc = out.totalsCoverage as typeof ai | undefined;
    check("get_financial_snapshot: netWorth 510,000 travels WITH totalsCoverage.netWorth PARTIAL + 'the true total is lower'",
      out.netWorth === 510_000 && tc?.netWorth.status === "PARTIAL" && tc.netWorth.notes[0] === "Excludes a debt of unknown balance — the true total is lower", { nw: out.netWorth, tc });
    check("get_financial_snapshot: totalLiabilities carries 'the true amount owed is higher'",
      tc?.totalLiabilities.notes[0] === "Excludes a debt of unknown balance — the true amount owed is higher");

    // The assembler (needs a DB) — source scan: balanceObserved is selected and
    // routed through the FIN-A2 classification, and the coverage is attached.
    const asm = readFileSync(join(process.cwd(), "lib/ai/assemblers/accounts.ts"), "utf8");
    check("assembler selects balanceObserved and excludes never-observed rows via resolveWalletBalance(…, balanceObserved)",
      asm.includes("balanceObserved: true,") && asm.includes("if (!isBalanceUnobserved(l.financialAccount)) continue;")
        && asm.includes("resolveWalletBalance(l.financialAccount.balance, undefined, l.financialAccount.balanceObserved)"));
    check("assembler attaches aiTotalsCoverage(excludedAccountCounts(classifiableAll))",
      asm.includes("aiTotalsCoverage(excludedAccountCounts(classifiableAll))"));

    if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
    console.log("\nAll F8 partial-total checks pass.");
  })().catch((e) => { console.error(e); process.exit(1); });
}
