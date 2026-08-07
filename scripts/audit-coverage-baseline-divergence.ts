/**
 * scripts/audit-coverage-baseline-divergence.ts
 *
 * v2.6-ASSESS-1 — the measuring instrument for "how many months of expenses does
 * my cash cover?" READ-ONLY: writes nothing, ever.
 *
 * ── The question ────────────────────────────────────────────────────────────
 *
 * Three surfaces answer it, and none of them agree on what it means:
 *
 *   Liquidity workspace   cashNow / config.monthlyExpenses
 *     (components/space/widgets/liquidity/LiquidityWorkspace.tsx)
 *
 *   Overview EF hero      savingsSeries.last / config.monthlyExpenses
 *     (components/dashboard/SpaceDashboard.tsx)
 *
 *   computeAssessment     totalLiquid / computeAverageMonthlySpending(txn)
 *     (lib/ai/intelligence/annotations/engine.ts — and it CLASSIFIES the result
 *      CRITICAL / WARNING / SAFE / EXCELLENT, which the other two never do)
 *
 * Different numerators AND different denominators for one judgment. The product
 * asks the USER what their monthly expenses are; the assessment engine MEASURES
 * them from transactions. Both are defensible — but only one can be right on a
 * screen, and after v2.6-BRIEF-1 the Daily Brief began publishing the engine's
 * verdict ("Low cash position") beside a Liquidity workspace still showing the
 * config's number. That is the cross-surface contradiction this arc exists to end.
 *
 * ── What this measures, and what it deliberately does not ───────────────────
 *
 * The DENOMINATORS, which is where the divergence lives and the only half that
 * can be measured honestly from a probe:
 *
 *   · `emergency_fund_progress.config.monthlyExpenses` — read from
 *     SpaceDashboardSection exactly as the two product surfaces read it;
 *   · `computeAverageMonthlySpending(txn)` — via the REAL transactions assembler
 *     at the REAL scope, the same call `computeAssessment` makes.
 *
 * ⚠️ The NUMERATORS are not measured here. `cashNow` comes from the liquidity
 * adapters and `totalLiquid` from the accounts assembler; both reach
 * `server-only`, which only Next resolves (the same constraint documented in
 * lib/data/banking-population.ts). Claiming to measure them would be exactly the
 * "probe that is not the live path" failure v2.6-TRUTH-8 was caused by. The
 * denominator divergence is sufficient to size the defect: a baseline that
 * differs by 2× makes every coverage figure differ by 2×, whatever the numerator.
 *
 * ── Tier ────────────────────────────────────────────────────────────────────
 *
 * INFORMATIONAL. It reports a corpus — how many Spaces currently declare a
 * baseline, and how far it sits from the measured one. A divergence count is a
 * fact about this database, not an invariant.
 *
 * Run: npx tsx --env-file=.env.local scripts/audit-coverage-baseline-divergence.ts
 */

import "@/lib/ai/assemblers/transactions";
import { getAssembler } from "@/lib/ai/assembler-registry";
import { FinanceDomains } from "@/lib/ai/types";
import type { TransactionsSummaryData } from "@/lib/ai/types";
import { computeAverageMonthlySpending } from "@/lib/ai/intelligence";
import { db } from "@/lib/db";
import type { SpaceContext } from "@/lib/space";

const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
const money = (n: number | null) =>
  n === null ? "(none)" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main(): Promise<void> {
  console.log(`\n[AUDIT] coverage baseline divergence — READ-ONLY`);
  console.log(`  The DENOMINATOR of "months of expenses covered", per surface.`);

  const assemble = getAssembler(FinanceDomains.TRANSACTIONS_SUMMARY);
  if (!assemble) {
    console.error("  ✗ TRANSACTIONS_SUMMARY assembler is not registered.");
    process.exitCode = 1;
    return;
  }

  const spaces = await db.space.findMany({
    where:  { archivedAt: null, deletedAt: null },
    select: { id: true, name: true, type: true, category: true, isPublic: true, reportingCurrency: true },
  });

  let withConfig = 0, withDerived = 0, bothPresent = 0, diverging = 0, measured = 0;

  for (const space of spaces) {
    const owner = await db.spaceMember.findFirst({
      where:  { spaceId: space.id, role: "OWNER", status: "ACTIVE" },
      select: { userId: true },
    });
    if (!owner) continue;

    // The DECLARED baseline — read exactly as the product surfaces read it.
    const section = await db.spaceDashboardSection.findFirst({
      where:  { spaceId: space.id, key: "emergency_fund_progress" },
      select: { config: true },
    });
    const rawCfg = (section?.config as { monthlyExpenses?: unknown } | null)?.monthlyExpenses;
    const declared = ((): number | null => {
      const n = Number(rawCfg);
      return Number.isFinite(n) && n > 0 ? n : null;
    })();

    // The MEASURED baseline — the assessment engine's own call, at its own scope.
    const spaceCtx: SpaceContext = {
      userId: owner.userId, spaceId: space.id, role: "OWNER",
      permissions: { canInvite: true, canManage: true, canWrite: true, canRead: true, isOwner: true },
      space: {
        id: space.id, name: space.name, type: space.type,
        category: space.category, isPublic: space.isPublic,
        reportingCurrency: space.reportingCurrency,
      },
    };
    const section2 = await assemble(spaceCtx, { scopeHint: "full" });
    const txn = section2 ? (section2.data as TransactionsSummaryData) : null;
    const derived = computeAverageMonthlySpending(txn);

    if (declared === null && derived === null) continue;
    measured++;
    if (declared !== null) withConfig++;
    if (derived !== null) withDerived++;

    console.log(`\n  ${space.name}`);
    console.log(`      declared (user config)   : ${money(declared)}`);
    console.log(`      measured (reliable-month): ${money(derived)}`);

    if (declared !== null && derived !== null) {
      bothPresent++;
      const ratio = derived / declared;
      const apart = Math.abs(ratio - 1);
      console.log(`      ratio measured/declared  : ${ratio.toFixed(2)}×`);
      // A coverage figure divides BY this number, so the baselines' ratio is
      // exactly the ratio the two coverage answers will differ by.
      if (apart >= 0.10) {
        diverging++;
        console.log(`      ⚠ the two surfaces state coverage figures ${ratio.toFixed(2)}× apart`);
      } else {
        console.log(`      ✓ within 10%`);
      }
    } else if (declared === null) {
      console.log(`      ⚠ NO declared baseline — the Liquidity workspace and the EF hero`);
      console.log(`        show NO coverage at all, while the assessment engine computes one`);
      console.log(`        from ${money(derived)} and the Brief may publish its verdict.`);
    } else {
      console.log(`      ⚠ NO measured baseline — the engine refuses (liquidity UNKNOWN)`);
      console.log(`        while the product shows a coverage multiple from ${money(declared)}.`);
    }
  }

  bar("VERDICT");
  console.log(`  Spaces with a baseline of either kind : ${measured}`);
  console.log(`  ...with a DECLARED (config) baseline  : ${withConfig}`);
  console.log(`  ...with a MEASURED (derived) baseline : ${withDerived}`);
  console.log(`  ...with BOTH                          : ${bothPresent}`);
  console.log(`  ...where the two are >10% apart       : ${diverging}`);

  if (withConfig !== withDerived || diverging > 0) {
    console.log(
      `\n  ⚠ One judgment, two baselines. A Space with only a measured baseline shows\n` +
      `    the user NOTHING while the engine grades it; a Space with only a declared\n` +
      `    one shows a multiple the engine will not stand behind. Neither surface\n` +
      `    discloses which baseline it used, so a user cannot reconcile them.\n`,
    );
  }
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => { console.error(e); await db.$disconnect(); process.exitCode = 1; });
