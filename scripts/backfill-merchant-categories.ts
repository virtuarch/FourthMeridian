/**
 * scripts/backfill-merchant-categories.ts
 *
 * One-time, reversible reclassification of historical Transaction rows that are
 * currently `Other` but match a curated GLOBAL merchant rule
 * (lib/transactions/merchant-rules.ts, Merchant Intelligence Slice 1).
 *
 * WHY THIS EXISTS
 * The forward mapper (lib/transactions/plaid-category.ts) now applies merchant
 * rules at import time, but Plaid's incremental `transactionsSync` only returns
 * added/modified rows after the stored cursor — so stable historical rows are
 * never revisited and keep their old `Other` category. This backfill rewrites
 * those rows once, in place, with NO Plaid re-fetch, NO cursor reset, and NO
 * full resync.
 *
 * DESIGN (see docs/investigations/MERCHANT_INTELLIGENCE_SLICE1_CHECKLIST.md §8/§9)
 *  - Dry-run is the DEFAULT; `--apply` is required to write.
 *  - Candidate = category = 'Other' AND resolveMerchantCategory(merchant, description)
 *    returns a NON-null, NON-'Other' category. Restricting the SOURCE to 'Other'
 *    (not Shopping/Dining) keeps the operation conservative and makes rollback
 *    trivial and deterministic — see below. The resolver is single-sourced in
 *    merchant-rules.ts, imported here, so the backfill can NEVER drift from the
 *    live mapper.
 *  - Detection is MERCHANT-RULE-DRIVEN ONLY — pfcPrimary/pfcDetailed are never
 *    used as a match signal.
 *  - Soft-deleted rows (deletedAt != null) are EXCLUDED by default (--include-deleted to include).
 *  - Keyset pagination by id (resume-safe, drift-free), mirroring
 *    scripts/reclassify-subscriptions.ts and scripts/backfill-flowtype.ts.
 *  - Apply writes ONLY the `category` column via a parameterized raw UPDATE that
 *    deliberately does NOT bump updatedAt, guarded by category = 'Other' so
 *    nothing else can ever flip. amount, flowType, flowDirection, pfc*, merchant,
 *    date, pending, FKs, and plaidTransactionId are left byte-identical.
 *    FlowType is intentionally NOT touched — a later flow re-run over changed
 *    rows is a separate, deferred operation.
 *  - Apply emits a rollback log (JSON: [{id, from:'Other', to}]) under scripts/.backfill-logs/.
 *  - `--rollback=<file>` restores each id to 'Other', guarded by category = <to>
 *    so a user's later re-categorization is not clobbered.
 *  - Idempotent: a second --apply finds 0 candidates (rows are no longer 'Other').
 *
 * Run:
 *   Dry run (default):   npx tsx scripts/backfill-merchant-categories.ts
 *   Scoped/verbose:      npx tsx scripts/backfill-merchant-categories.ts --space=<id> --limit=100 --verbose
 *   Apply:               npx tsx scripts/backfill-merchant-categories.ts --apply
 *   Cautious apply:      npx tsx scripts/backfill-merchant-categories.ts --apply --batch=200 --limit=500
 *   Rollback:            npx tsx scripts/backfill-merchant-categories.ts --rollback=scripts/.backfill-logs/<file>.json
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { db } from "@/lib/db";
import type { Prisma, TransactionCategory } from "@prisma/client";
import { resolveMerchantCategory } from "@/lib/transactions/merchant-rules";

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

// Only 'Other' rows are ever eligible to flip (conservative; trivial rollback).
const SOURCE_CATEGORY = "Other" as const;

interface LogEntry { id: string; from: string; to: string }

// ─────────────────────────────────────────────────────────────────────────────
// Space scope (optional) — mirrors the read-layer join in lib/data/transactions.ts:
// Plaid-synced rows via an ACTIVE spaceAccountLink.
// ─────────────────────────────────────────────────────────────────────────────
function spaceScopeWhere(spaceId: string): Prisma.TransactionWhereInput {
  return {
    financialAccount: { spaceAccountLinks: { some: { spaceId, status: "ACTIVE" } } },
  };
}

function baseWhere(): Prisma.TransactionWhereInput {
  const and: Prisma.TransactionWhereInput[] = [{ category: SOURCE_CATEGORY }];
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
  console.log(`\n[ROLLBACK] Restoring ${entries.length} row(s) to 'Other' from ${file}`);
  console.log(`Guard: each row is reverted only if it still holds the category this backfill set.\n`);

  let restored = 0;
  for (let i = 0; i < entries.length; i += BATCH) {
    const slice = entries.slice(i, i + BATCH);
    const ops = slice.map((e) =>
      db.$executeRaw`
        UPDATE "Transaction"
        SET "category" = ${e.from}::"TransactionCategory"
        WHERE "id" = ${e.id} AND "category" = ${e.to}::"TransactionCategory"
      `,
    );
    const counts = await db.$transaction(ops);
    restored += counts.reduce((s, c) => s + (c as number), 0);
    if (VERBOSE) for (const e of slice) console.log(`  ${e.id} → ${e.from} (was ${e.to})`);
  }

  console.log(`\nRestored ${restored} of ${entries.length} logged row(s).`);
  const skipped = entries.length - restored;
  if (skipped > 0) {
    console.log(`${skipped} row(s) NOT reverted — category changed since apply (user re-categorized, or already restored).`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dry-run / apply mode
// ─────────────────────────────────────────────────────────────────────────────
async function runBackfill(): Promise<void> {
  console.log(`\n${APPLY ? "[APPLY] Merchant-category backfill — WRITING category" : "[DRY RUN] Merchant-category backfill — READ-ONLY, no writes"}`);
  console.log(
    `Selection: category = '${SOURCE_CATEGORY}' AND curated merchant rule matches (→ non-Other)` +
    `${INCLUDE_DELETED ? " (including soft-deleted)" : " (excluding soft-deleted)"}` +
    `${SPACE_ID ? `  scope: space=${SPACE_ID}` : ""}`,
  );
  console.log(`Batch: ${BATCH}${Number.isFinite(LIMIT) ? `   Limit: ${LIMIT}` : ""}\n`);

  const where = baseWhere();
  // merchant → { count, target } and a per-target rollup for the summary.
  const byMerchant = new Map<string, { count: number; to: string }>();
  const byTarget = new Map<string, number>();
  const log: LogEntry[] = [];
  let scanned = 0;    // 'Other' rows examined
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

    // Resolve each row; a candidate is one that resolves to a non-null,
    // non-Other category. (resolveMerchantCategory never returns 'Other', but
    // the guard is explicit for safety.)
    const pageCandidates = rows
      .map((r) => ({ row: r, to: resolveMerchantCategory(r.merchant, r.description) }))
      .filter((c): c is { row: typeof rows[number]; to: TransactionCategory } => c.to != null && c.to !== "Other");

    for (const { row: r, to } of pageCandidates) {
      candidates++;
      const key = r.merchant || "(no merchant)";
      const agg = byMerchant.get(key) ?? { count: 0, to };
      agg.count++;
      byMerchant.set(key, agg);
      byTarget.set(to, (byTarget.get(to) ?? 0) + 1);
      log.push({ id: r.id, from: SOURCE_CATEGORY, to });
      if (VERBOSE) {
        const pfc = r.pfcPrimary || r.pfcDetailed ? `  [pfc ${r.pfcPrimary ?? "-"}/${r.pfcDetailed ?? "-"}]` : "";
        console.log(`  ${r.id}  ${key}  Other → ${to}${pfc}`);
      }
    }

    // Apply: raw UPDATE of ONLY category, guarded by category='Other', no
    // updatedAt bump, batched atomically. Each row goes to its resolved target.
    if (APPLY && pageCandidates.length > 0) {
      const ops = pageCandidates.map(({ row: r, to }) =>
        db.$executeRaw`
          UPDATE "Transaction"
          SET "category" = ${to}::"TransactionCategory"
          WHERE "id" = ${r.id} AND "category" = 'Other'
        `,
      );
      const counts = await db.$transaction(ops);
      updated += counts.reduce((s, c) => s + (c as number), 0);
    }

    for (const r of rows) { lastId = r.id; scanned++; }
    if (rows.length < take) break;
  }

  // Report.
  console.log(`Scanned (Other):     ${scanned}${scanned >= LIMIT ? " (--limit reached)" : ""}`);
  console.log(`Candidates (matched): ${candidates}\n`);

  if (candidates > 0) {
    console.log("By target category (Other → X):");
    for (const [target, n] of [...byTarget.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)}  → ${target}`);
    }
    console.log("\nBy merchant (count · target):");
    const sorted = [...byMerchant.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [merchant, agg] of sorted) {
      console.log(`  ${String(agg.count).padStart(5)}  ${merchant}   → ${agg.to}`);
    }
    console.log("");
  }

  if (APPLY) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logPath = `${LOG_DIR}/backfill-merchant-categories-${stamp}.json`;
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, JSON.stringify(log, null, 2), "utf8");
    console.log(`Applied — category rewritten on ${updated} row(s).`);
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
    await runBackfill();
  }
}

main()
  .catch((err) => {
    console.error("backfill-merchant-categories failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
