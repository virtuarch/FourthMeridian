/**
 * scripts/audit-chronology-cutover.ts   (L8-B)
 *
 * Proves the economic-date read cutover, end to end. READ-ONLY.
 *
 * 1. day / month movement — the population the cutover exists for
 * 2. keyset pagination — no duplicate, no skipped row, cursor-stable
 * 3. count == list population for every tested filter
 * 4. the cursor predicate agrees with the SQL ordering
 *
 * ── v2.6-OWN-2: this audit now GATES ────────────────────────────────────────
 *
 * It previously printed ✗ for a pagination duplicate, a skipped row, a count/list
 * mismatch and a cursor disagreement — and exited 0 for every one of them. Four
 * real invariants could breach in silence. Every ✗ below is now collected and the
 * process exits 1 if any fired.
 *
 * It also pinned three CORPUS-SPECIFIC counts as expectations (2,813 day movers /
 * 147 month movers / exactly 2 contradictory rows). Those are measurements of one
 * database, not properties of the cutover: the day-mover figure had already
 * drifted to 2,817 and printed a permanent ✗ that everyone learned to ignore, and
 * on any other corpus — a CI seed, production — all three are meaningless. They
 * are now REPORTED as facts, and what is ASSERTED is the actual invariant:
 * every row carries an economic date, and a CONTRADICTORY row stays on its
 * posting date. That holds on any corpus, which is what lets this run in CI.
 *
 * Run: npx tsx --env-file=.env.local scripts/audit-chronology-cutover.ts
 */

import { db } from "@/lib/db";
import {
  orderByForSort, keysetWhere, buildFilterWhere, cursorFromRow, compareForSort,
  afterCursorMatches, type TransactionSort, type TransactionCursor,
} from "@/lib/data/transaction-query-core";
import { resolveEconomicDate } from "@/lib/transactions/economic-date";

const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Every invariant breach found. Non-empty ⇒ the audit fails. */
const breaches: string[] = [];
/** Assert an invariant, print its verdict, and remember a breach. */
function invariant(held: boolean, statement: string): boolean {
  if (!held) breaches.push(statement);
  return held;
}

async function main() {
  // ── 1. Movement ─────────────────────────────────────────────────────────
  bar("1. DAY / MONTH MOVEMENT — the population the cutover exists for");
  const all = await db.transaction.findMany({
    where: { deletedAt: null },
    select: { id: true, date: true, economicDate: true, authorizedAt: true, amount: true, merchant: true },
  });
  let dayMovers = 0, monthMovers = 0, nulls = 0;
  const contradictory: string[] = [];
  for (const r of all) {
    if (r.economicDate == null) { nulls++; continue; }
    if (iso(r.economicDate) !== iso(r.date)) dayMovers++;
    if (iso(r.economicDate).slice(0, 7) !== iso(r.date).slice(0, 7)) monthMovers++;
    const res = resolveEconomicDate({ postingDate: r.date, authorizedAt: r.authorizedAt });
    if (res.state === "CONTRADICTORY") {
      contradictory.push(`${r.id} posting=${iso(r.date)} economic=${iso(r.economicDate)} auth=${r.authorizedAt ? iso(r.authorizedAt) : "-"} ${JSON.stringify(r.merchant).slice(0, 34)}`);
    }
  }
  console.log(`  active rows                 : ${all.length}`);
  // REPORTED, not asserted — these are facts about THIS corpus, and pinning them
  // as expectations is what left a permanent ✗ in this audit's output for weeks.
  console.log(`  rows MOVING DAY             : ${dayMovers}   (reported — corpus-specific)`);
  console.log(`  rows MOVING MONTH           : ${monthMovers}   (reported — corpus-specific)`);
  // ASSERTED — a property of the cutover, true on any corpus.
  console.log(`  rows with NO economic date  : ${nulls}   ${
    invariant(nulls === 0, "every active row carries an economic date") ? "✓" : "✗ the cutover requires the column"}`);
  console.log(`\n  CONTRADICTORY rows — must remain on the POSTING date:`);
  for (const c of contradictory) console.log(`    ${c}`);
  const contradictoryHeld = all.every((r) => {
    const res = resolveEconomicDate({ postingDate: r.date, authorizedAt: r.authorizedAt });
    return res.state !== "CONTRADICTORY" || (r.economicDate != null && iso(r.economicDate) === iso(r.date));
  });
  console.log(`  ${
    invariant(contradictoryHeld, "every CONTRADICTORY row sits on its posting date")
      ? `✓ all ${contradictory.length} sit on their posting date`
      : "✗ a CONTRADICTORY row moved"}`);

  // ── 2. Pagination ───────────────────────────────────────────────────────
  bar("2. KEYSET PAGINATION — no duplicate, no skipped row");
  // The LARGEST space — a 151-row seed Space exercises none of the boundaries
  // that matter (a month filter over it is empty, so parity is vacuous).
  const spaces = await db.space.findMany({ where: { accountLinks: { some: {} } }, select: { id: true, name: true } });
  let space: { id: string; name: string } | null = null; let best = -1;
  for (const s of spaces) {
    const n = await db.transaction.count({
      where: { deletedAt: null, financialAccount: { deletedAt: null, spaceAccountLinks: { some: { spaceId: s.id, status: "ACTIVE" } } } },
    });
    if (n > best) { best = n; space = s; }
  }
  if (!space) { console.log("  no shared space to page"); await db.$disconnect(); return; }
  console.log(`  space under test: ${space.name} (${best} rows)`);

  for (const sort of ["newest", "oldest"] as TransactionSort[]) {
    for (const limit of [10, 25]) {
      const seen: string[] = [];
      let cursor: TransactionCursor | undefined;
      let pages = 0;
      const where = {
        deletedAt: null,
        financialAccount: { deletedAt: null, spaceAccountLinks: { some: { spaceId: space.id, status: "ACTIVE" as const } } },
      };
      for (;;) {
        const ks = keysetWhere(sort, cursor);
        const rows = await db.transaction.findMany({
          where: ks ? { AND: [where, ks] } : where,
          orderBy: orderByForSort(sort),
          take: limit + 1,
          select: { id: true, economicDate: true },
        });
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        seen.push(...page.map((r) => r.id));
        pages++;
        if (!hasMore || pages > 500) break;
        cursor = cursorFromRow(page[page.length - 1], sort);
      }
      const total = await db.transaction.count({ where });
      const unique = new Set(seen).size;
      const dup = seen.length - unique;
      // Ordering must match the pure comparator exactly — the reference the
      // keyset proof rests on.
      const rowsOrdered = await db.transaction.findMany({
        where, orderBy: orderByForSort(sort), select: { id: true, economicDate: true },
      });
      const reference = [...rowsOrdered].sort((a, b) => compareForSort(a, b, sort)).map((r) => r.id);
      const sqlOrder = rowsOrdered.map((r) => r.id);
      const orderMatches = reference.length === sqlOrder.length && reference.every((id, i) => id === sqlOrder[i]);
      console.log(`  ${sort.padEnd(7)} limit=${String(limit).padStart(3)}  pages=${String(pages).padStart(3)}  seen=${seen.length}  unique=${unique}  total=${total}` +
        `  duplicates=${dup}  missing=${total - unique}` +
        `  ${invariant(dup === 0 && unique === total,
            `keyset paging over ${sort}/limit=${limit} returns every row exactly once`) ? "✓" : "✗"}` +
        `  SQL order == pure comparator: ${
          invariant(orderMatches, `SQL ordering matches the pure comparator for ${sort}/limit=${limit}`) ? "✓" : "✗"}`);
    }
  }

  // ── 3. Count parity ─────────────────────────────────────────────────────
  bar("3. COUNT == LIST POPULATION, per filter");
  const base = {
    deletedAt: null,
    financialAccount: { deletedAt: null, spaceAccountLinks: { some: { spaceId: space.id, status: "ACTIVE" as const } } },
  };
  const FILTERS: [string, Parameters<typeof buildFilterWhere>[0]][] = [
    ["all time",              { sort: "newest" }],
    ["month 2026-04",         { sort: "newest", dateFrom: "2026-04-01", dateTo: "2026-04-30" }],
    ["month 2026-07",         { sort: "newest", dateFrom: "2026-07-01", dateTo: "2026-07-31" }],
    ["week 2026-07-13..19",   { sort: "newest", dateFrom: "2026-07-13", dateTo: "2026-07-19" }],
    ["year 2025",             { sort: "newest", dateFrom: "2025-01-01", dateTo: "2025-12-31" }],
    ["custom 2026-01..2026-03", { sort: "newest", dateFrom: "2026-01-15", dateTo: "2026-03-15" }],
    ["transfers only",        { sort: "newest", flowTypes: ["TRANSFER"] as never }],
    ["month + transfers",     { sort: "newest", dateFrom: "2026-04-01", dateTo: "2026-04-30", flowTypes: ["TRANSFER"] as never }],
  ];
  for (const [label, q] of FILTERS) {
    const where = { AND: [base, buildFilterWhere(q)] };
    const count = await db.transaction.count({ where });
    // Page the whole population through the keyset and compare.
    const seen = new Set<string>();
    let cursor: TransactionCursor | undefined; let guard = 0;
    for (;;) {
      const ks = keysetWhere("newest", cursor);
      const rows = await db.transaction.findMany({
        where: ks ? { AND: [base, buildFilterWhere(q), ks] } : where,
        orderBy: orderByForSort("newest"), take: 51,
        select: { id: true, economicDate: true },
      });
      const hasMore = rows.length > 50;
      const page = hasMore ? rows.slice(0, 50) : rows;
      page.forEach((r) => seen.add(r.id));
      if (!hasMore || ++guard > 200) break;
      cursor = cursorFromRow(page[page.length - 1], "newest");
    }
    // ...and what the POSTING chronology would have said, to show the delta.
    const postingWhere = q.dateFrom || q.dateTo
      ? { AND: [base, { date: { ...(q.dateFrom ? { gte: new Date(`${q.dateFrom}T00:00:00Z`) } : {}), ...(q.dateTo ? { lte: new Date(`${q.dateTo}T00:00:00Z`) } : {}) } },
          ...(q.flowTypes ? [{ flowType: { in: q.flowTypes } }] : [])] }
      : where;
    const postingCount = await db.transaction.count({ where: postingWhere });
    console.log(`  ${label.padEnd(26)} count=${String(count).padStart(5)}  paged=${String(seen.size).padStart(5)}  ` +
      `${invariant(count === seen.size, `count == paged population for filter "${label}"`) ? "✓ parity" : "✗ MISMATCH"}` +
      `   (posting basis would be ${postingCount}${postingCount !== count ? `, Δ${count - postingCount}` : ""})`);
  }

  // ── 4. The pure reference matcher ───────────────────────────────────────
  bar("4. CURSOR PREDICATE == PURE REFERENCE");
  const sample = await db.transaction.findMany({
    where: base, orderBy: orderByForSort("newest"), take: 120,
    select: { id: true, economicDate: true },
  });
  let refOk = true;
  for (let i = 0; i < sample.length - 1; i += 17) {
    const c = cursorFromRow(sample[i], "newest");
    for (let j = 0; j < sample.length; j++) {
      const expected = j > i;
      if (afterCursorMatches(sample[j], "newest", c) !== expected) { refOk = false; break; }
    }
  }
  console.log(`  afterCursorMatches agrees with the SQL ordering at every probed boundary: ${
    invariant(refOk, "afterCursorMatches agrees with the SQL ordering") ? "✓" : "✗"}`);

  // ── Verdict ─────────────────────────────────────────────────────────────
  bar("VERDICT");
  if (breaches.length > 0) {
    console.error(`  ✗ ${breaches.length} invariant(s) breached:`);
    for (const b of breaches) console.error(`      · ${b}`);
    console.error("\n[AUDIT] FAILED — the economic-date read cutover does not hold.\n");
    process.exitCode = 1;
    return;
  }
  console.log("\n[AUDIT] PASSED — the economic-date read cutover holds end to end. ✓\n");
}
main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); });
