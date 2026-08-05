/**
 * scripts/backfill-economic-date.ts   (L8-A)
 *
 * Populate `Transaction.economicDate` from the PROVEN read authority.
 *
 * DRY-RUN BY DEFAULT. `--apply` is required to write.
 *
 * ── What it writes, and nothing else ────────────────────────────────────────
 *
 * One column, on rows where it is null or disagrees with the authority. Every
 * value comes from `economicDateWriteFields`, which wraps
 * `lib/transactions/economic-date.ts` — the same resolver the read path has used
 * since V27-L4B. This script contains NO date logic of its own, deliberately: a
 * backfill that re-derived the rule would be a second authority, and the whole
 * point of the column is to have one.
 *
 * ⚠️ `date`, `authorizedAt` and every other column are untouched. The economic
 * date is a pure function of the first two, so the backfill is re-runnable and
 * idempotent by construction: a second pass finds nothing to do.
 *
 * ── Soft-deleted rows are INCLUDED ─────────────────────────────────────────
 *
 * Tombstoned rows are excluded from reads but still exist, and an import
 * rollback can resurrect them. Leaving their `economicDate` null would mean a
 * resurrected row silently re-enters the corpus without a chronology — so they
 * are backfilled too, and the completeness probe counts every row in the table.
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/backfill-economic-date.ts
 *   npx tsx --env-file=.env.local scripts/backfill-economic-date.ts --apply
 */

import { db } from "@/lib/db";
import { createHash } from "node:crypto";
import { resolveEconomicDate } from "@/lib/transactions/economic-date";
import { economicDateWriteFields } from "@/lib/transactions/economic-date-write";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const BATCH = 500;

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`\n[backfill-economic-date] ${apply ? "APPLY" : "DRY RUN"}\n`);

  const rows = await db.transaction.findMany({
    select: { id: true, date: true, authorizedAt: true, economicDate: true, deletedAt: true },
  });
  console.log(`  rows in table (tombstones included): ${rows.length}`);

  type Plan = { id: string; from: string | null; to: string; basis: string; state: string };
  const plan: Plan[] = [];
  const basisTally = new Map<string, number>();
  const stateTally = new Map<string, number>();
  let agree = 0;

  for (const r of rows) {
    const res = resolveEconomicDate({ postingDate: r.date, authorizedAt: r.authorizedAt });
    const want = economicDateWriteFields({ postingDate: r.date, authorizedAt: r.authorizedAt }).economicDate;
    basisTally.set(res.basis, (basisTally.get(res.basis) ?? 0) + 1);
    stateTally.set(res.state, (stateTally.get(res.state) ?? 0) + 1);
    const have = r.economicDate ? iso(r.economicDate) : null;
    if (have === iso(want)) { agree++; continue; }
    plan.push({ id: r.id, from: have, to: iso(want), basis: res.basis, state: res.state });
  }

  console.log(`  already correct : ${agree}`);
  console.log(`  to write        : ${plan.length}`);
  console.log(`\n  resolution basis across the whole table:`);
  for (const [k, v] of [...basisTally].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(5)}  ${k}`);
  console.log(`  resolution state:`);
  for (const [k, v] of [...stateTally].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(5)}  ${k}`);

  // The population that actually MOVES — the reason the column exists.
  const movers = plan.filter((p) => p.basis === "AUTHORIZATION");
  const monthCrossers = rows.filter((r) => {
    const res = resolveEconomicDate({ postingDate: r.date, authorizedAt: r.authorizedAt });
    return res.economicDate.slice(0, 7) !== res.postingDate.slice(0, 7);
  }).length;
  console.log(`\n  rows whose economic date DIFFERS from posting : ${
    rows.filter((r) => {
      const res = resolveEconomicDate({ postingDate: r.date, authorizedAt: r.authorizedAt });
      return res.economicDate !== res.postingDate;
    }).length}`);
  console.log(`  ...of which cross a MONTH boundary            : ${monthCrossers}`);
  console.log(`  CONTRADICTORY (authority falls back to posting): ${stateTally.get("CONTRADICTORY") ?? 0}`);
  void movers;

  const fp = createHash("sha256")
    .update(plan.map((p) => `${p.id}|${p.to}`).sort().join("\n")).digest("hex").slice(0, 16);
  console.log(`\n  backfill fingerprint: ${fp} (${plan.length} rows)`);

  if (plan.length === 0) {
    console.log(`\n  ✓ IDEMPOTENT — every row already carries the authority's value. Nothing to do.\n`);
    await db.$disconnect();
    return;
  }
  if (!apply) {
    console.log(`\n  Dry run — nothing written. Re-run with --apply to write.\n`);
    for (const p of plan.slice(0, 8)) console.log(`    ${p.id} ${p.from ?? "null"} → ${p.to} (${p.basis}/${p.state})`);
    await db.$disconnect();
    return;
  }

  // Batched, so one transaction never holds thousands of row locks. Each batch is
  // atomic; a failure mid-run leaves earlier batches applied and the script
  // re-runnable — safe precisely because it is idempotent.
  let written = 0;
  for (let i = 0; i < plan.length; i += BATCH) {
    const chunk = plan.slice(i, i + BATCH);
    await db.$transaction(
      chunk.map((p) => db.transaction.update({
        where: { id: p.id },
        data: { economicDate: new Date(`${p.to}T00:00:00.000Z`) },
      })),
    );
    written += chunk.length;
    console.log(`    …${written}/${plan.length}`);
  }
  console.log(`\n  APPLIED — ${written} rows.\n`);
  await db.$disconnect();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
