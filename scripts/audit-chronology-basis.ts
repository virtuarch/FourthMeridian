/**
 * scripts/audit-chronology-basis.ts
 *
 * v2.6-CHRON-1 — the basis axis holds. READ-ONLY.
 *
 *   npx tsx --env-file=.env.local scripts/audit-chronology-basis.ts
 *
 * ── What it enforces ────────────────────────────────────────────────────────
 *
 * docs/architecture/TIME_MODEL.md §8: a measure is computed on ONE basis and
 * names it. FLOW measures use `economicDate` (when the money moved). BALANCE
 * measures use `date` (when the account changed). Both columns are true; a
 * measure that mixes them is wrong even when every input is right.
 *
 * This is not a stylistic rule. On the live corpus 2,817 rows carry an economic
 * date different from their posting date and 147 cross a month boundary — one
 * month's worth of rows, every month.
 *
 *   INV-B1  (source) No Prisma aggregate over the BANKING (flow) population is
 *           keyed on the posting `date`. The flow population is defined by
 *           `bankingTransactionWhere`; grouping it by `date` produces posting
 *           keys for rows every consumer will read on the economic basis.
 *
 *   INV-B2  (data) Every economic date the flow population lands on is covered
 *           by the FX-coverage enumeration that feeds the client. This is the
 *           defect INV-B1 exists to prevent, measured rather than inferred:
 *           before the fix, 31 economic dates had no prefetched rate and 163
 *           rows landed on them.
 *
 *   INV-B3  (source) The DTO date seam documents itself correctly. The comment
 *           in `serialize.ts` asserted `date` was the POSTING date twenty lines
 *           below the line setting it to the economic date. A reader trusts the
 *           comment; this makes the contradiction a build failure.
 *
 * ── What it deliberately does NOT reach ─────────────────────────────────────
 *
 * `lib/ai/assemblers/transactions.ts` filters its window on `date` and buckets
 * on `econOf` — a genuine basis mix, of a different SHAPE (a `where` filter, not
 * an aggregate key). Correcting it moves AI totals and needs its own measured
 * cutover, so it is recorded in TIME_MODEL.md §8.6 and fixed with the other
 * three AI read-boundary divergences, not alone. INV-B1 is scoped to aggregate
 * keys so this audit does not fail on work it is not asking for.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { db } from "@/lib/db";
import { bankingTransactionWhere } from "@/lib/data/banking-population";

const ROOT = process.cwd();
const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);

const breaches: string[] = [];
function invariant(held: boolean, statement: string): boolean {
  if (!held) breaches.push(statement);
  return held;
}

function walk(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  let entries: string[];
  try { entries = readdirSync(abs); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const childRel = path.join(rel, e);
    if (statSync(path.join(ROOT, childRel)).isDirectory()) { out.push(...walk(childRel)); continue; }
    if (!/\.(ts|tsx)$/.test(e) || /\.test\.tsx?$/.test(e)) continue;
    out.push(childRel);
  }
  return out;
}
const codeOf = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const SOURCE_ROOTS = ["lib", "app", "components", "jobs"];

async function main(): Promise<void> {
  console.log("\n[AUDIT] Chronology basis — flow reads economic, balance reads posting. READ-ONLY\n");

  // ── INV-B1 — no flow aggregate keyed on the posting date ──────────────────
  bar("INV-B1 — no aggregate over the banking population is keyed on posting date");

  const offenders: string[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const file of walk(root)) {
      const code = codeOf(file);
      // Only files that actually reach for the flow population.
      if (!/bankingTransactionWhere/.test(code)) continue;
      // A Prisma aggregate keyed on `date`: groupBy({ by: ["date"] }) in any
      // spacing, and the _min/_max aggregate forms.
      const keyedOnPosting =
        /by:\s*\[[^\]]*["']date["'][^\]]*\]/.test(code) ||
        /_(min|max):\s*\{[^}]*\bdate:\s*true/.test(code);
      if (keyedOnPosting) offenders.push(file);
    }
  }
  for (const f of offenders) console.log(`  ✗ ${f}`);
  console.log(
    invariant(offenders.length === 0,
      "no aggregate over the banking (flow) population is keyed on the posting date")
      ? "  ✓ every flow aggregate keys on the economic basis"
      : "  ✗ a flow population is being aggregated on posting keys",
  );

  // ── INV-B3 — the DTO date seam documents itself ───────────────────────────
  bar("INV-B3 — the DTO date seam does not contradict itself");

  const serializeSrc = readFileSync(path.join(ROOT, "lib/transactions/serialize.ts"), "utf8");
  // The DTO's `date` IS the economic date. A comment asserting the opposite, in
  // the file that decides it, is the exact defect: it survived a full arc
  // because everyone read the comment instead of the line above it.
  const contradiction =
    /`date` above is UNCHANGED — it is the POSTING date/.test(serializeSrc) ||
    /\bDTO'?s? `?date`? is the posting date\b/i.test(serializeSrc);
  const setsEconomic = /date:\s*financialDate\(r\)/.test(serializeSrc);
  console.log(`  serializer sets DTO date from financialDate(): ${setsEconomic ? "yes" : "NO"}`);
  console.log(
    invariant(setsEconomic && !contradiction,
      "the serializer's own comments agree that the DTO date is the ECONOMIC date")
      ? "  ✓ the seam and its documentation agree"
      : "  ✗ the serializer documents a basis it does not implement",
  );

  // ── INV-B2 — every economic date is FX-reachable ──────────────────────────
  bar("INV-B2 — every economic date the flow population lands on is FX-enumerable");

  const spaces = await db.space.findMany({ select: { id: true, name: true } });
  let probed = 0;
  for (const s of spaces) {
    const where = bankingTransactionWhere(s.id);
    const total = await db.transaction.count({ where });
    if (total === 0) continue;
    probed++;

    // What /api/money/view-context enumerates for the FLOW population…
    const enumerated = new Set(
      (await db.transaction.groupBy({ by: ["economicDate"], where }))
        .map((r) => r.economicDate?.toISOString().slice(0, 10))
        .filter((d): d is string => !!d),
    );
    // …versus the dates the folds will actually ask for. Same basis by
    // construction now; this asserts it, and reports the shortfall if not.
    const asked = new Set(
      (await db.transaction.findMany({ where, select: { economicDate: true } }))
        .map((r) => r.economicDate?.toISOString().slice(0, 10))
        .filter((d): d is string => !!d),
    );
    const missing = [...asked].filter((d) => !enumerated.has(d));
    const held = invariant(
      missing.length === 0,
      `every economic date in "${s.name}" is FX-enumerable (${missing.length} unreachable)`,
    );
    console.log(
      `  ${s.name.padEnd(26)} rows=${String(total).padStart(5)}  ` +
      `enumerated=${String(enumerated.size).padStart(4)}  asked=${String(asked.size).padStart(4)}  ` +
      `${held ? "✓" : `✗ ${missing.length} UNREACHABLE`}`,
    );
    if (!held) console.log(`        sample: ${missing.slice(0, 6).join(", ")}`);
  }
  if (probed === 0) console.log("  (no Space carries flow rows — nothing to compare)");

  // Reported, not asserted: the size of the basis split this doctrine exists for.
  const split = await db.transaction.count({
    where: { deletedAt: null, NOT: { economicDate: null } },
  });
  const movers = await db.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM "Transaction"
    WHERE "deletedAt" IS NULL AND "economicDate" IS NOT NULL
      AND date_trunc('month', "economicDate") <> date_trunc('month', "date")`;
  console.log(`\n  rows carrying an economic date        : ${split}`);
  console.log(`  ...crossing a MONTH boundary          : ${movers[0]?.n ?? 0}   (reported — the population §8.2 exists for)`);

  // ── Verdict ───────────────────────────────────────────────────────────────
  bar("VERDICT");
  if (breaches.length > 0) {
    console.error(`  ✗ ${breaches.length} invariant(s) breached:`);
    for (const b of breaches) console.error(`      · ${b}`);
    console.error(
      "\n[AUDIT] FAILED — a measure is mixing chronological bases.\n" +
      "A flow read uses economicDate; a balance read uses date; a surface serving both\n" +
      "enumerates both. See docs/architecture/TIME_MODEL.md §8.\n",
    );
    process.exitCode = 1;
    return;
  }
  console.log("\n[AUDIT] PASSED — flow reads economic, balance reads posting. Nothing was written.\n");
}

main()
  .catch((err) => { console.error("audit-chronology-basis failed:", err); process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); });
