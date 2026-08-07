/**
 * scripts/audit-ef-hero-coverage-divergence.ts
 *
 * v2.6-ASSESS-4 — does the Overview emergency-fund hero answer the SAME question
 * as the Liquidity workspace's coverage line? READ-ONLY: writes nothing, ever.
 *
 * ── Why this has to be measured before converging ───────────────────────────
 *
 * The EF hero was the last surface dividing by a config-only baseline, so the
 * obvious move is to hand it the resolved baseline and be done. That is only
 * correct if the DENOMINATOR is the sole divergence. If the NUMERATORS differ,
 * giving both surfaces the same baseline makes two different coverage multiples
 * agree on their divisor and still disagree on their answer — a subtler version
 * of the defect, not a fix for it.
 *
 *   Overview EF hero    heroDef.value(s) = s.totalSavings   (lib/space-hero.ts)
 *                       — the SAVINGS component of the latest SpaceSnapshot,
 *                         scoped "Savings accounts linked to this Space"
 *
 *   Liquidity workspace reachableNow(accounts)
 *                       — REACHABLE cash across CHECKING + SAVINGS, from each
 *                         account's availableBalance (v2.6-L3)
 *
 * Two different populations (savings-only vs checking+savings) and two different
 * bases (a stored snapshot component vs live reachable balances). This measures
 * how far apart they actually are, per Space, and — because the hero only renders
 * for `category === "EMERGENCY_FUND"` — which Spaces are even affected.
 *
 * ⚠️ `reachableNow` converts through a ConversionContext the React layer builds,
 * which a probe cannot. Figures here are native-currency sums; every Space in
 * this corpus is single-currency, and the audit says so per Space rather than
 * silently summing across currencies.
 *
 * Tier: INFORMATIONAL — a corpus census that scopes a decision.
 *
 * Run: npx tsx --env-file=.env.local scripts/audit-ef-hero-coverage-divergence.ts
 */

import { db } from "@/lib/db";
import { totalReachableCash } from "@/lib/balances/reachable";
import { TRANSACTION_DETAIL_VISIBILITY } from "@/lib/ai/visibility";

const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
const money = (n: number | null) =>
  n === null ? "(none)" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main(): Promise<void> {
  console.log(`\n[AUDIT] EF hero vs Liquidity coverage — READ-ONLY`);
  console.log(`  Do the two "months covered" figures answer the same question?`);

  const spaces = await db.space.findMany({
    where:  { archivedAt: null, deletedAt: null },
    select: { id: true, name: true, category: true },
  });

  let efSpaces = 0, numeratorDiverges = 0;

  for (const space of spaces) {
    // The EF hero renders ONLY for this category — everywhere else the question
    // is not even asked, which bounds what a convergence would touch.
    const isEfCategory = space.category === "EMERGENCY_FUND";

    // ── The hero's numerator: the SAVINGS component of the latest snapshot ──
    const latest = await db.spaceSnapshot.findFirst({
      where:   { spaceId: space.id },
      orderBy: { date: "desc" },
      select:  { date: true, savings: true, cash: true },
    });

    // ── The canonical liquidity numerator: reachable across checking+savings ─
    const links = await db.spaceAccountLink.findMany({
      where: {
        spaceId: space.id, status: "ACTIVE",
        visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY },
        financialAccount: { deletedAt: null, type: { in: ["checking", "savings"] } },
      },
      select: { financialAccount: { select: { id: true, type: true, balance: true, availableBalance: true, currency: true } } },
    });
    if (links.length === 0 && latest === null) continue;

    const currencies = new Set(links.map((l) => l.financialAccount.currency ?? "USD"));
    const mixed = currencies.size > 1;

    const reachable = totalReachableCash(links.map((l) => ({
      accountId:   l.financialAccount.id,
      reachable:   l.financialAccount.availableBalance ?? l.financialAccount.balance ?? 0,
      unexplained: null,
    })));
    const savingsOnlyLive = links
      .filter((l) => l.financialAccount.type === "savings")
      .reduce((s, l) => s + (l.financialAccount.availableBalance ?? l.financialAccount.balance ?? 0), 0);

    const heroNumerator = latest?.savings ?? null;

    console.log(`\n  ${space.name}   [category ${space.category}]${isEfCategory ? "   ← EF HERO RENDERS HERE" : ""}${mixed ? "   ⚠ MIXED CURRENCY" : ""}`);
    if (isEfCategory) efSpaces++;
    console.log(`      EF hero numerator   snapshot.savings   : ${money(heroNumerator)}${latest ? `   (as of ${new Date(latest.date).toISOString().slice(0, 10)})` : ""}`);
    console.log(`      Liquidity numerator reachable cash     : ${money(reachable.total)}   (checking + savings, live)`);
    console.log(`      ...of which savings, live              : ${money(savingsOnlyLive)}`);

    const gap = heroNumerator === null ? null : Math.abs(heroNumerator - reachable.total);
    if (gap !== null && gap >= 0.005) {
      numeratorDiverges++;
      console.log(`      ⚠ the two numerators differ by ${money(gap)} — they are NOT the same quantity`);
    } else if (gap !== null) {
      console.log(`      ✓ numerators agree`);
    }
  }

  bar("VERDICT");
  console.log(`  Spaces where the EF hero renders (category EMERGENCY_FUND): ${efSpaces}`);
  console.log(`  Spaces where the two numerators differ                    : ${numeratorDiverges}`);
  console.log(
    `\n  The hero divides the SAVINGS component of a stored snapshot; the Liquidity\n` +
    `  workspace divides REACHABLE cash across checking AND savings. Handing both\n` +
    `  the same baseline would align their divisors and leave their answers apart.\n`,
  );
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => { console.error(e); await db.$disconnect(); process.exitCode = 1; });
