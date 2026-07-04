/**
 * scripts/reclassify-subscriptions.ts
 *
 * One-time, reversible reclassification of historical Transaction rows from
 * `Other`/`Shopping` → `Subscriptions` for known subscription merchants.
 *
 * WHY THIS EXISTS
 * The forward mapper (lib/transactions/plaid-category.ts) already classifies
 * subscription merchants correctly at import time, but Plaid's incremental
 * `transactionsSync` only returns added/modified rows after the stored cursor —
 * so stable historical rows are never revisited and keep their old category.
 * This backfill rewrites those rows once, in place, with NO Plaid re-fetch, NO
 * cursor reset, and NO full resync.
 *
 * DESIGN (see docs/investigations/SUBSCRIPTIONS_RECLASSIFY_BACKFILL_CHECKLIST.md)
 *  - Dry-run is the DEFAULT; `--apply` is required to write.
 *  - Candidate = category IN ('Other','Shopping') AND
 *    isKnownSubscriptionMerchant(merchant, description). Detection is
 *    MERCHANT-ALLOWLIST-DRIVEN ONLY — pfcPrimary/pfcDetailed are never used as a
 *    match signal (that would reintroduce the ENTERTAINMENT_* bucket false
 *    positives the mapper correction removed). The allowlist is single-sourced in
 *    plaid-category.ts, imported here, so the backfill can't drift from the mapper.
 *  - Soft-deleted rows (deletedAt != null) are EXCLUDED by default (--include-deleted to include).
 *  - Keyset pagination by id (resume-safe, drift-free), mirroring scripts/backfill-flowtype.ts.
 *  - Apply writes ONLY the `category` column via a parameterized raw UPDATE that
 *    deliberately does NOT bump updatedAt, and is guarded by
 *    category IN ('Other','Shopping') so nothing else can ever flip. amount,
 *    flowType, flowDirection, pfc*, merchant, date, pending, FKs, and
 *    plaidTransactionId are left byte-identical.
 *  - Apply emits a rollback log (JSON: [{id, from, to}]) under scripts/.backfill-logs/.
 *  - `--rollback=<file>` restores each id to its recorded prior category, guarded
 *    by category = 'Subscriptions' so a user's later re-categorization is not clobbered.
 *  - Idempotent: a second --apply finds 0 candidates.
 *
 * Run:
 *   Dry run (default):   npx tsx scripts/reclassify-subscriptions.ts
 *   Scoped/verbose:      npx tsx scripts/reclassify-subscriptions.ts --space=<id> --limit=100 --verbose
 *   Apply:               npx tsx scripts/reclassify-subscriptions.ts --apply
 *   Cautious apply:      npx tsx scripts/reclassify-subscriptions.ts --apply --batch=200 --limit=500
 *   Rollback:            npx tsx scripts/reclassify-subscriptions.ts --rollback=scripts/.backfill-logs/<file>.json
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { isKnownSubscriptionMerchant } from "@/lib/transactions/plaid-category";

const argv = process.argv.slice(2);

function intFlag(name: string, def: number): number {
  const a = argv.find((x) => x.startsWith(`${name}=`));
  if (!a) return def;
  const n = parseInt(a.split("=")[1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}
function strFlag(name: string): string | null {
  const a = argv.find((x) => x.startsWith(`${name}=`));
  return a ? (a.split("=").slice(1).join("=") || null) : null;
}

const VERBOSE         = argv.includes("--verbose");
const APPLY           = argv.includes("--apply");
const INCLUDE_DELETED = argv.includes("--include-deleted");
const SPACE_ID        = strFlag("--space");
const ROLLBACK_FILE   = strFlag("--rollback");
const BATCH           = intFlag("--batch", 500);
const LIMIT           = intFlag("--limit", Number.POSITIVE_INFINITY);

const LOG_DIR = "scripts/.backfill-logs";

// Only these two categories are ever eligible to flip.
const SOURCE_CATEGORIES = ["Other", "Shopping"] as const;

interface LogEntry { id: string; from: string; to: string }

// ─────────────────────────────────────────────────────────────────────────────
// Space scope (optional) — mirrors the read-layer join in lib/data/transactions.ts:
// legacy rows via account.spaceId, Plaid-synced rows via an ACTIVE spaceAccountLink.
// ─────────────────────────────────────────────────────────────────────────────
function spaceScopeWhere(spaceId: string): Prisma.TransactionWhereInput {
  return {
    OR: [
      { account: { spaceId } },
      { financialAccount: { spaceAccountLinks: { some: { spaceId, status: "ACTIVE" } } } },
    ],
  };
}

function baseWhere(): Prisma.TransactionWhereInput {
  const and: Prisma.TransactionWhereInput[] = [
    { category: { in: [...SOURCE_CATEGORIES] } },
  ];
  if (!INCLUDE_DELETED) and.push({ deletedAt: null });
  if (SPACE_ID) and.push(spaceScopeWhere(SPACE_ID));
  return { AND: and };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rollback mode
// ─────────────────────────────────────────────────────────────────────────────
async function runRollback(file: string): Promise<void> {
  const raw = readFileSync(file, "utf8");
  const entries = JSON.parse(raw) as LogEntry[];
  console.log(`\n[ROLLBACK] Restoring ${entries.length} row(s) from ${file}`);
  console.log(`Guard: only rows currently category='Subscriptions' are reverted.\n`);

  let restored = 0;
  for (let i = 0; i < entries.length; i += BATCH) {
    const slice = entries.slice(i, i + BATCH);
    const ops = slice.map((e) =>
      db.$executeRaw`
        UPDATE "Transaction"
        SET "category" = ${e.from}::"TransactionCategory"
        WHERE "id" = ${e.id} AND "category" = 'Subscriptions'
      `,
    );
    const counts = await db.$transaction(ops);
    restored += counts.reduce((s, c) => s + (c as number), 0);
    if (VERBOSE) for (const e of slice) console.log(`  ${e.id} → ${e.from} (was Subscriptions)`);
  }

  console.log(`\nRestored ${restored} of ${entries.length} logged row(s).`);
  const skipped = entries.length - restored;
  if (skipped > 0) {
    console.log(`${skipped} row(s) NOT reverted — no longer category='Subscriptions' (user re-categorized, or already restored).`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dry-run / apply mode
// ─────────────────────────────────────────────────────────────────────────────
async function runReclassify(): Promise<void> {
  console.log(`\n${APPLY ? "[APPLY] Subscriptions reclassify — WRITING category" : "[DRY RUN] Subscriptions reclassify — READ-ONLY, no writes"}`);
  console.log(
    `Selection: category IN (${SOURCE_CATEGORIES.join(", ")}) AND known subscription merchant` +
    `${INCLUDE_DELETED ? " (including soft-deleted)" : " (excluding soft-deleted)"}` +
    `${SPACE_ID ? `  scope: space=${SPACE_ID}` : ""}`,
  );
  console.log(`Batch: ${BATCH}${Number.isFinite(LIMIT) ? `   Limit: ${LIMIT}` : ""}\n`);

  const where = baseWhere();
  const byMerchant = new Map<string, { count: number; fromOther: number; fromShopping: number }>();
  const log: LogEntry[] = [];
  let scanned = 0;   // Other/Shopping rows examined
  let candidates = 0;
  let updated = 0;
  let lastId = "";

  while (scanned < LIMIT) {
    const take = Math.min(BATCH, LIMIT - scanned);
    const rows = await db.transaction.findMany({
      where: lastId ? { AND: [where, { id: { gt: lastId } }] } : where,
      orderBy: { id: "asc" },
      take,
      select: {
        id: true, category: true, merchant: true, description: true,
        pfcPrimary: true, pfcDetailed: true,
      },
    });
    if (rows.length === 0) break;

    const pageCandidates = rows.filter((r) => isKnownSubscriptionMerchant(r.merchant, r.description));

    // Report accumulation.
    for (const r of pageCandidates) {
      candidates++;
      const key = r.merchant || "(no merchant)";
      const agg = byMerchant.get(key) ?? { count: 0, fromOther: 0, fromShopping: 0 };
      agg.count++;
      if (r.category === "Other") agg.fromOther++; else if (r.category === "Shopping") agg.fromShopping++;
      byMerchant.set(key, agg);
      log.push({ id: r.id, from: r.category as string, to: "Subscriptions" });
      if (VERBOSE) {
        const pfc = r.pfcPrimary || r.pfcDetailed ? `  [pfc ${r.pfcPrimary ?? "-"}/${r.pfcDetailed ?? "-"}]` : "";
        console.log(`  ${r.id}  ${key}  ${r.category} → Subscriptions${pfc}`);
      }
    }

    // Apply: raw UPDATE of ONLY category, guarded, no updatedAt bump, batched atomically.
    if (APPLY && pageCandidates.length > 0) {
      const ops = pageCandidates.map((r) =>
        db.$executeRaw`
          UPDATE "Transaction"
          SET "category" = ${"Subscriptions"}::"TransactionCategory"
          WHERE "id" = ${r.id} AND "category" IN ('Other','Shopping')
        `,
      );
      const counts = await db.$transaction(ops);
      updated += counts.reduce((s, c) => s + (c as number), 0);
    }

    for (const r of rows) { lastId = r.id; scanned++; }
    if (rows.length < take) break;
  }

  // Report.
  console.log(`Scanned (Other/Shopping):  ${scanned}${scanned >= LIMIT ? " (--limit reached)" : ""}`);
  console.log(`Candidates (subscription): ${candidates}\n`);

  if (candidates > 0) {
    console.log("By merchant (count · from Other / from Shopping):");
    const sorted = [...byMerchant.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [merchant, agg] of sorted) {
      console.log(`  ${String(agg.count).padStart(5)}  ${merchant}   (Other ${agg.fromOther} / Shopping ${agg.fromShopping})`);
    }
    console.log("");
  }

  if (APPLY) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logPath = `${LOG_DIR}/reclassify-subscriptions-${stamp}.json`;
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, JSON.stringify(log, null, 2), "utf8");
    console.log(`Applied — category rewritten to Subscriptions on ${updated} row(s).`);
    console.log(`Rollback log: ${logPath}`);
    if (updated !== candidates) {
      console.log(`Note: updated (${updated}) != candidates (${candidates}) — some rows changed category between scan and write (guard held).`);
    }
    console.log(`Re-run without --apply to verify 0 candidates remain.`);
  } else {
    console.log("Dry run only — no writes. Re-run with --apply to write.");
  }
}

async function main(): Promise<void> {
  if (ROLLBACK_FILE) {
    await runRollback(ROLLBACK_FILE);
  } else {
    await runReclassify();
  }
}

main()
  .catch((err) => {
    console.error("reclassify-subscriptions failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
