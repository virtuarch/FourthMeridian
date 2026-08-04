/**
 * scripts/audit-snapshot-integrity.ts
 *
 * READ-ONLY repository-wide snapshot integrity audit.
 *
 * ── The probe that decides everything ────────────────────────────────────────
 * COMPONENT-TO-SNAPSHOT EQUALITY: does the stored column equal what the
 * canonical replay produces for that day, under the canonical semantics?
 *
 *     debt(stored) === Σ amountOwed(walked balance per account)
 *
 * `amountOwed` matters. A card in credit contributes 0, not a negative — the
 * V25-SIDE-1 rule `classifyAccounts` applies when it builds the column. Summing
 * raw walked balances instead manufactures a discrepancy every time a card sits
 * in credit, which is exactly how a healthy clamp gets mistaken for a defect.
 *
 * The raw ledger identity (`debt(d) − debt(d−1) === −Σ movements(d)`) is a
 * SECONDARY probe: it localises WHERE a series first went wrong, but it breaks
 * legitimately across a clamp, so it can never be the classifier on its own.
 *
 * ── Classification ───────────────────────────────────────────────────────────
 *   FROZEN         isEstimated=false — an observation, never walked
 *   CONTRADICTORY  the row's own stored aggregates disagree with each other
 *   REPAIRABLE     estimated, and the canonical replay disagrees with the store
 *   UNSUPPORTED    no canonical evidence reaches the day
 *   HEALTHY        agrees with its evidence
 *
 * Writes nothing. Run before and after any repair.
 *
 *   npx tsx --require ./scripts/_shim.cjs scripts/audit-snapshot-integrity.ts
 */

import { db } from "@/lib/db";
import { AccountType } from "@prisma/client";
import { getAccountBalancesOverWindow } from "@/lib/data/accounts-asof-window";
import { amountOwed } from "@/lib/debt/balance-semantics";
import {
  auditLiabilitySeries, aggregateIdentityViolations, round2,
  SERIES_IDENTITY_TOLERANCE, type SeriesPoint,
} from "@/lib/snapshots/series-integrity.core";

const iso = (d: Date) => d.toISOString().slice(0, 10);

interface Bucket { n: number; min: number; max: number; from: string; to: string }
const bump = (b: Map<string, Bucket>, key: string, delta: number, dateISO: string) => {
  const cur = b.get(key) ?? { n: 0, min: Infinity, max: -Infinity, from: dateISO, to: dateISO };
  cur.n++; cur.min = Math.min(cur.min, delta); cur.max = Math.max(cur.max, delta);
  if (dateISO < cur.from) cur.from = dateISO;
  if (dateISO > cur.to) cur.to = dateISO;
  b.set(key, cur);
};

async function main() {
  const spaces = await db.space.findMany({ select: { id: true, name: true } });
  let totalRows = 0, frozenRows = 0, contradictoryRows = 0;
  const repairable = new Map<string, Bucket>();
  const detail: string[] = [];

  for (const sp of spaces) {
    const rows = await db.spaceSnapshot.findMany({
      where: { spaceId: sp.id },
      select: {
        date: true, isEstimated: true, stocks: true, crypto: true, total: true,
        cash: true, savings: true, debt: true, netWorth: true, totalAssets: true,
        netLiquid: true, cashOnHand: true, cryptoValuationStatus: true,
      },
      orderBy: { date: "asc" },
    });
    if (rows.length === 0) continue;
    totalRows += rows.length;
    const frozen = rows.filter((r) => !r.isEstimated).length;
    frozenRows += frozen;

    for (const r of rows) {
      const v = aggregateIdentityViolations(r);
      if (v.length > 0) {
        contradictoryRows++;
        if (detail.length < 6) detail.push(`  ${sp.name} ${iso(r.date)} CONTRADICTORY: ${v.join("; ")}`);
      }
    }

    const from = iso(rows[0].date), to = iso(rows[rows.length - 1].date);

    // ── debt: the component this incident is about ──────────────────────────
    const { accounts, byDate } = await getAccountBalancesOverWindow({
      spaceId: sp.id, fromISO: from, toISO: to, types: [AccountType.debt],
    });
    let healthy = 0, repair = 0, frozenSkipped = 0;

    if (accounts.length > 0) {
      const ids = accounts.map((a) => a.id);
      const owedOn = (dISO: string) =>
        ids.reduce((n, id) => n + amountOwed(byDate.get(dISO)?.get(id)?.balance ?? 0), 0);

      for (const r of rows) {
        const dISO = iso(r.date);
        if (!r.isEstimated) { frozenSkipped++; continue; }
        const delta = round2(owedOn(dISO) - r.debt);
        if (Math.abs(delta) <= SERIES_IDENTITY_TOLERANCE) { healthy++; continue; }
        repair++;
        bump(repairable, `${sp.name}|debt`, delta, dISO);
      }

      // Secondary probe — WHERE the series first diverges.
      const grouped = await db.transaction.groupBy({
        by: ["date"],
        where: { financialAccountId: { in: ids }, deletedAt: null, pending: false,
                 date: { gte: rows[0].date, lte: rows[rows.length - 1].date } },
        _sum: { amount: true },
      });
      const moveByDay = new Map(grouped.map((g) => [iso(g.date), g._sum.amount ?? 0]));
      const points: SeriesPoint[] = rows.map((r) => ({
        dateISO: iso(r.date), value: r.debt,
        movement: moveByDay.get(iso(r.date)) ?? 0, isEstimated: r.isEstimated,
      }));
      const seriesReport = auditLiabilitySeries(points);
      const first = seriesReport.violations.find((v) => v.kind === "PHANTOM");
      if (repair > 0 && first) {
        detail.push(`  ${sp.name} · debt series first diverges at ${first.dateISO} (residual ${round2(first.residual)})`);
      }
    }

    console.log(
      `${sp.name.padEnd(22)} rows=${String(rows.length).padStart(4)} frozen=${String(frozen).padStart(4)} ` +
      `debt: HEALTHY=${String(healthy).padStart(4)} REPAIRABLE=${String(repair).padStart(4)} FROZEN=${String(frozenSkipped).padStart(4)}`);
  }

  console.log(`\n══ TOTALS  rows=${totalRows}  frozen=${frozenRows}  rows with contradictory aggregates=${contradictoryRows}`);
  console.log("══ REPAIRABLE");
  if (repairable.size === 0) console.log("   (none)");
  for (const [k, b] of repairable) {
    console.log(`   ${k}  rows=${b.n}  ${b.from} → ${b.to}  delta min=${round2(b.min)} max=${round2(b.max)}`);
  }
  if (detail.length) { console.log("\n══ DETAIL"); for (const d of detail) console.log(d); }
  await db.$disconnect();
}

main();
