/**
 * scripts/audit-economic-date-persistence.ts   (L8-A)
 *
 * The STANDING PROBE for the persisted economic chronology. READ-ONLY.
 *
 * Proves the one invariant the column exists to satisfy:
 *
 *     for every row:  Transaction.economicDate  ===  resolveEconomicDate(row)
 *
 * A persisted derived value can drift from its authority in three ways — a
 * writer that forgets it, a backfill that never finished, or a change to the
 * credibility bound that is not replayed. This catches all three, and it is the
 * reason the DATE may be persisted while the basis/state/lag stay derived: one
 * stored fact, continuously checked against the function that defines it.
 *
 * Run:  npx tsx --env-file=.env.local scripts/audit-economic-date-persistence.ts
 *       (or: npm run audit:economic-date)
 *
 * Exit 0 when the whole table agrees; 1 otherwise, with a non-PII breakdown.
 * Safe for CI — no writes.
 */

import { db } from "@/lib/db";
import { createHash } from "node:crypto";
import { resolveEconomicDate } from "@/lib/transactions/economic-date";
import { ECONOMIC_DATE_MAX_LAG_DAYS } from "@/lib/transactions/economic-date";

const iso = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  console.log(`\n[AUDIT] Economic-date persistence — stored vs derived, READ-ONLY\n`);

  const rows = await db.transaction.findMany({
    select: { id: true, date: true, authorizedAt: true, economicDate: true, deletedAt: true },
  });

  let agree = 0;
  const missing: string[] = [];
  const disagree: { id: string; stored: string; derived: string; basis: string }[] = [];
  const basis = new Map<string, number>();
  let movers = 0, monthCrossers = 0, contradictory = 0;

  for (const r of rows) {
    const res = resolveEconomicDate({ postingDate: r.date, authorizedAt: r.authorizedAt });
    basis.set(res.basis, (basis.get(res.basis) ?? 0) + 1);
    if (res.state === "CONTRADICTORY") contradictory++;
    if (res.economicDate !== res.postingDate) movers++;
    if (res.economicDate.slice(0, 7) !== res.postingDate.slice(0, 7)) monthCrossers++;

    if (r.economicDate == null) { missing.push(r.id); continue; }
    if (iso(r.economicDate) === res.economicDate) { agree++; continue; }
    disagree.push({ id: r.id, stored: iso(r.economicDate), derived: res.economicDate, basis: res.basis });
  }

  console.log(`  rows (tombstones included)      : ${rows.length}`);
  console.log(`  stored === derived              : ${agree}`);
  console.log(`  NULL (never backfilled)         : ${missing.length}`);
  console.log(`  stored !== derived (DRIFT)      : ${disagree.length}`);
  console.log(`\n  credibility bound in force      : ${ECONOMIC_DATE_MAX_LAG_DAYS} days`);
  console.log(`  resolution basis:`);
  for (const [k, v] of [...basis].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(5)}  ${k}`);
  console.log(`  economic ≠ posting              : ${movers}`);
  console.log(`  ...crossing a MONTH boundary    : ${monthCrossers}`);
  console.log(`  CONTRADICTORY (falls back)      : ${contradictory}`);

  const fp = createHash("sha256")
    .update(rows.map((r) => `${r.id}|${r.economicDate ? iso(r.economicDate) : "null"}`).sort().join("\n"))
    .digest("hex").slice(0, 16);
  console.log(`\n  persisted economicDate fingerprint: ${fp} (${rows.length} rows)`);

  // The chronologies must remain SEPARATE facts. A column that silently equalled
  // `date` everywhere would pass the agreement check and mean nothing.
  if (movers === 0 && rows.length > 0) {
    console.error(`\n[AUDIT] SUSPICIOUS — not one row's economic date differs from its posting date.`);
    console.error(`That is possible but unlikely; verify authorizedAt is actually being captured.\n`);
  }

  if (missing.length === 0 && disagree.length === 0) {
    console.log(`\n[AUDIT] PASSED — every row's persisted economicDate equals the authority's value. ✓\n`);
    await db.$disconnect();
    return;
  }

  console.error(`\n[AUDIT] FAILED — the persisted column does not match the authority.`);
  for (const d of disagree.slice(0, 20)) {
    console.error(`    ${d.id} stored=${d.stored} derived=${d.derived} (${d.basis})`);
  }
  if (missing.length) console.error(`    ${missing.length} row(s) have no persisted economicDate; run the backfill.`);
  console.error(`\nRe-run:  npx tsx --env-file=.env.local scripts/backfill-economic-date.ts --apply\n`);
  await db.$disconnect();
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
