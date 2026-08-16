/**
 * scripts/audit-coverage-fraction-divergence.ts
 *
 * v2.6-ASSESS-2 — BOTH halves of "how many months of expenses does my cash
 * cover?", measured per Space. READ-ONLY: writes nothing, ever.
 *
 * ── Why both halves ─────────────────────────────────────────────────────────
 *
 * v2.6-ASSESS-1 recorded D2 as a DENOMINATOR divergence: the product divides by
 * a user-declared baseline, the assessment engine by a measured one. Converging
 * only that would not make the surfaces agree, because they also divide
 * different NUMERATORS:
 *
 *   Liquidity workspace   reachableNow(accounts)   — REACHABLE cash (v2.6-L3),
 *                                                    from availableBalance
 *   Overview EF hero      heroPoints.last          — the hero series value
 *   computeAssessment     accts.totalLiquid        — the LEDGER sum of liquid
 *                                                    accounts
 *
 * The workspace already knows these differ — it suppresses its delta when
 * `cashNow !== classification.totalLiquid` — and its own header records the gap
 * that motivated v2.6-L3: "the ledger sum was $13,674.16 while $8,000 of it was
 * not reachable at all."
 *
 * So this measures the whole fraction. A coverage figure is numerator over
 * denominator; a divergence in either produces a different answer under the same
 * words, and the point of measuring first is to learn which one actually moves
 * on this corpus rather than assuming both do.
 *
 * ── What it measures, and how honestly ──────────────────────────────────────
 *
 *   DENOMINATOR-declared   `emergency_fund_progress.config.monthlyExpenses`,
 *                          read exactly as the two product surfaces read it.
 *   DENOMINATOR-measured   `computeAverageMonthlySpending(txn)` via the REAL
 *                          transactions assembler — the engine's own call.
 *   NUMERATOR-reachable    `totalReachableCash(...)` — the SAME pure authority
 *                          `reachableNow` delegates to, over the same
 *                          checking/savings rows, using each account's
 *                          `availableBalance` under the same three-state rule.
 *   NUMERATOR-ledger       the ledger `balance` sum over the same rows.
 *
 * ⚠️ The numerators are computed here in the Space's NATIVE currency, with no FX
 * conversion, because `reachableNow` converts through a ConversionContext the
 * React layer builds and a probe cannot. On a single-currency Space (every Space
 * in this corpus) that changes nothing; on a mixed-currency one these figures
 * would be a native-magnitude sum and must not be compared to a converted one.
 * The audit says so per Space rather than quietly summing across currencies.
 *
 * ⚠️ It does NOT reproduce `computeAssessment`'s `totalLiquid` through the
 * accounts assembler — that reaches `server-only`, which only Next resolves.
 * The ledger sum below is the same arithmetic over the same population, but it
 * is a RECONSTRUCTION, not the live path, and is labelled as such.
 *
 * ── Tier ────────────────────────────────────────────────────────────────────
 *
 * INFORMATIONAL — a corpus census. The invariant this leads to is pinned in CI
 * by lib/ai/intelligence/liquidity-baseline-refusal.test.ts and by the baseline
 * authority's own tests.
 *
 * Run: npm run audit:coverage-fraction-divergence
 *
 * (Run via the npm script: this file transitively imports a module that declares
 *  `import "server-only"`, which is not an installed npm package, so bare
 *  `npx tsx` dies at module load. The npm script wires in the same preload the
 *  test runner uses — scripts/lib/server-only-preload.cjs. Nothing else changes.)
 */

import "@/lib/ai/assemblers/transactions";
import { getAssembler } from "@/lib/ai/assembler-registry";
import { FinanceDomains } from "@/lib/ai/types";
import type { TransactionsSummaryData } from "@/lib/ai/types";
import { computeAverageMonthlySpending } from "@/lib/ai/intelligence";
import { totalReachableCash } from "@/lib/balances/reachable";
import { TRANSACTION_DETAIL_VISIBILITY } from "@/lib/ai/visibility";
import { db } from "@/lib/db";
import type { SpaceContext } from "@/lib/space";

const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
const money = (n: number | null) =>
  n === null ? "(none)" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main(): Promise<void> {
  console.log(`\n[AUDIT] coverage fraction divergence — READ-ONLY`);
  console.log(`  Both halves of "months of expenses covered", per Space.`);

  const assemble = getAssembler(FinanceDomains.TRANSACTIONS_SUMMARY);
  if (!assemble) { console.error("  ✗ assembler not registered"); process.exitCode = 1; return; }

  const spaces = await db.space.findMany({
    where:  { archivedAt: null, deletedAt: null },
    select: { id: true, name: true, type: true, category: true, isPublic: true, reportingCurrency: true },
  });

  let numeratorDiverges = 0, denominatorBothPresent = 0, denominatorDeclaredOnly = 0,
      denominatorMeasuredOnly = 0, mixedCurrency = 0, measured = 0;

  for (const space of spaces) {
    const owner = await db.spaceMember.findFirst({
      where:  { spaceId: space.id, role: "OWNER", status: "ACTIVE" },
      select: { userId: true },
    });
    if (!owner) continue;

    // ── Numerators, over the liquid population both surfaces use ────────────
    const links = await db.spaceAccountLink.findMany({
      where: {
        spaceId: space.id, status: "ACTIVE",
        visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY },
        financialAccount: { deletedAt: null, type: { in: ["checking", "savings"] } },
      },
      select: {
        financialAccount: {
          select: { id: true, name: true, balance: true, availableBalance: true, currency: true },
        },
      },
    });
    if (links.length === 0) continue;
    measured++;

    const currencies = new Set(links.map((l) => l.financialAccount.currency ?? "USD"));
    const mixed = currencies.size > 1;
    if (mixed) mixedCurrency++;

    const ledger = links.reduce((s, l) => s + (l.financialAccount.balance ?? 0), 0);
    // The SAME three-state rule reachableNow applies: an absent availableBalance
    // means no reachable claim was made and the ledger figure is the only answer;
    // an explicit null would mean a claim was made and reachable is UNKNOWN.
    const reach = totalReachableCash(links.map((l) => ({
      accountId:   l.financialAccount.id,
      reachable:   l.financialAccount.availableBalance ?? l.financialAccount.balance ?? 0,
      unexplained: null,
    })));

    // ── Denominators ────────────────────────────────────────────────────────
    const section = await db.spaceDashboardSection.findFirst({
      where:  { spaceId: space.id, key: "emergency_fund_progress" },
      select: { config: true },
    });
    const rawCfg = (section?.config as { monthlyExpenses?: unknown } | null)?.monthlyExpenses;
    const declared = ((): number | null => {
      const n = Number(rawCfg);
      return Number.isFinite(n) && n > 0 ? n : null;
    })();

    const spaceCtx: SpaceContext = {
      userId: owner.userId, spaceId: space.id, role: "OWNER",
      permissions: { canInvite: true, canManage: true, canWrite: true, canRead: true, isOwner: true },
      space: {
        id: space.id, name: space.name, type: space.type,
        category: space.category, isPublic: space.isPublic,
        reportingCurrency: space.reportingCurrency,
      },
    };
    const sec = await assemble(spaceCtx, { scopeHint: "full" });
    const measuredBaseline = computeAverageMonthlySpending(sec ? (sec.data as TransactionsSummaryData) : null);

    // ── Report ──────────────────────────────────────────────────────────────
    console.log(`\n  ${space.name}${mixed ? `   ⚠ MIXED CURRENCY (${[...currencies].join(", ")}) — native sums, not comparable` : ""}`);
    console.log(`      NUMERATOR   reachable (product) : ${money(reach.total)}${reach.unknownCount > 0 ? `   (${reach.unknownCount} unknown, excluded)` : ""}`);
    console.log(`      NUMERATOR   ledger    (engine)  : ${money(ledger)}   [reconstruction]`);
    const numGap = Math.abs(reach.total - ledger);
    if (numGap >= 0.005) {
      numeratorDiverges++;
      console.log(`      ⚠ the two numerators differ by ${money(numGap)}`);
    } else {
      console.log(`      ✓ numerators agree`);
    }

    console.log(`      DENOMINATOR declared (product) : ${money(declared)}`);
    console.log(`      DENOMINATOR measured (engine)  : ${money(measuredBaseline)}`);
    if (declared !== null && measuredBaseline !== null) denominatorBothPresent++;
    else if (declared !== null) denominatorDeclaredOnly++;
    else if (measuredBaseline !== null) denominatorMeasuredOnly++;

    // What each surface would actually SAY.
    const productMonths = declared !== null && declared > 0 && reach.total > 0
      ? (reach.total / declared) : null;
    const engineMonths = measuredBaseline !== null && measuredBaseline > 0
      ? (ledger / measuredBaseline) : null;
    console.log(`      → product says : ${productMonths === null ? "(nothing)" : `${productMonths.toFixed(1)} months`}`);
    console.log(`      → engine says  : ${engineMonths === null ? "(refused)" : `${engineMonths.toFixed(1)} months`}`);
  }

  bar("VERDICT");
  console.log(`  Spaces with a liquid population        : ${measured}`);
  console.log(`  ...where the NUMERATORS differ         : ${numeratorDiverges}`);
  console.log(`  ...with BOTH denominators              : ${denominatorBothPresent}`);
  console.log(`  ...declared only                       : ${denominatorDeclaredOnly}`);
  console.log(`  ...measured only                       : ${denominatorMeasuredOnly}`);
  console.log(`  ...mixed-currency (sums not comparable): ${mixedCurrency}`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => { console.error(e); await db.$disconnect(); process.exitCode = 1; });
