/**
 * scripts/backfill-cc-payment-categories.ts
 *
 * One-time, reversible reclassification of historical DESTINATION-leg
 * credit-card payment rows from `Other` → `Payment` (CC-1).
 *
 * WHY THIS EXISTS
 * The forward path now classifies card-side payment legs correctly at import
 * time (mapPlaidCategory CREDIT_CARD_PAYMENT detailed + the guarded sync-seam
 * rule in lib/plaid/syncTransactions.ts). But Plaid's incremental
 * `transactionsSync` only returns added/modified rows after the stored cursor —
 * stable historical rows are never revisited and keep their old `Other`
 * category. This backfill rewrites those rows once, in place, with NO Plaid
 * re-fetch, NO cursor reset, and NO full resync.
 *
 * DESIGN (see docs/investigations/CREDIT_CARD_PAYMENT_CLASSIFICATION_INVESTIGATION.md §9-10)
 *  - Dry-run is the DEFAULT; `--apply` is required to write.
 *  - Candidate = category = 'Other' AND the row's owning account is a LIABILITY
 *    (FinancialAccount.type = 'debt', the signal Plaid actually populates —
 *    OR the legacy debtSubtype != null for manually-entered liabilities) AND
 *    amount > 0 AND the descriptor matches a generalized card-payment phrase.
 *    The predicate is the SAME isLiabilityCardPaymentLeg used by the live sync
 *    path (imported from lib/transactions/plaid-category.ts), so the backfill
 *    can NEVER drift from the forward mapper. Institution-agnostic — no "chase"
 *    string anywhere.
 *  - CC-1 correction: the original filter keyed on debtSubtype != null, which is
 *    NEVER set on Plaid-synced cards (they carry type = 'debt', debtSubtype null),
 *    so it scanned 0 rows. The primary signal is now FinancialAccount.type.
 *  - Legacy `Account` rows (accountId, no FinancialAccount) carry no type/subtype
 *    here and are therefore never candidates — correct: the liability guard needs
 *    the FinancialAccount signal.
 *  - Soft-deleted rows (deletedAt != null) are EXCLUDED by default (--include-deleted to include).
 *  - Keyset pagination by id (resume-safe, drift-free), mirroring
 *    scripts/backfill-merchant-categories.ts and scripts/reclassify-subscriptions.ts.
 *  - Apply writes ONLY the `category` column via a parameterized raw UPDATE that
 *    deliberately does NOT bump updatedAt, guarded by category = 'Other'. amount,
 *    flowType, flowDirection, pfc*, merchant, date, pending, FKs, and
 *    plaidTransactionId are left byte-identical.
 *  - flowType is intentionally NOT touched here. The rescued rows currently hold
 *    flowType = REFUND (positive amount in the Other spend bucket). After apply,
 *    re-derive their flow with the EXISTING FlowType backfill, scoped to the
 *    changed rows — it recomputes DEBT_PAYMENT/INFLOW from category = Payment:
 *        npx tsx scripts/backfill-flowtype.ts --apply           (see that script's flags)
 *    Run flow re-derivation AFTER this apply. This script never invents flow.
 *  - Apply emits a rollback log (JSON: [{id, from:'Other', to:'Payment'}]) under scripts/.backfill-logs/.
 *  - `--rollback=<file>` restores each id to 'Other', guarded by category = 'Payment'
 *    so a user's later re-categorization is not clobbered.
 *  - Idempotent: a second --apply finds 0 candidates.
 *
 * Run:
 *   Dry run (default):   npx tsx scripts/backfill-cc-payment-categories.ts
 *   Scoped/verbose:      npx tsx scripts/backfill-cc-payment-categories.ts --space=<id> --limit=100 --verbose
 *   Apply:               npx tsx scripts/backfill-cc-payment-categories.ts --apply
 *   Rollback:            npx tsx scripts/backfill-cc-payment-categories.ts --rollback=scripts/.backfill-logs/<file>.json
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { isLiabilityCardPaymentLeg } from "@/lib/transactions/plaid-category";

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
const TARGET_CATEGORY = "Payment" as const;

interface LogEntry { id: string; from: string; to: string }

// ─────────────────────────────────────────────────────────────────────────────
// Space scope (optional) — mirrors the read-layer join in lib/data/transactions.ts.
// ─────────────────────────────────────────────────────────────────────────────
function spaceScopeWhere(spaceId: string): Prisma.TransactionWhereInput {
  return {
    financialAccount: { spaceAccountLinks: { some: { spaceId, status: "ACTIVE" } } },
  };
}

/**
 * Base filter. Pushes as much as possible into SQL: category = 'Other',
 * amount > 0, and the owning FinancialAccount is a liability. Liability is
 * PRIMARILY type = 'debt' (the signal Plaid populates) OR the legacy
 * debtSubtype != null — mirroring isLiabilityCardPaymentLeg's OR so the SQL
 * pre-filter never excludes a row the in-memory predicate would accept. The
 * descriptor match (the only non-SQL part) is applied in memory via the shared
 * predicate. Requiring a FinancialAccount also structurally excludes legacy
 * Account-only rows (they have no FinancialAccount signal here).
 */
function baseWhere(): Prisma.TransactionWhereInput {
  const and: Prisma.TransactionWhereInput[] = [
    { category: SOURCE_CATEGORY },
    { amount: { gt: 0 } },
    { financialAccount: { is: { OR: [{ type: "debt" }, { debtSubtype: { not: null } }] } } },
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
  console.log(`\n[ROLLBACK] Restoring ${entries.length} row(s) to 'Other' from ${file}`);
  console.log(`Guard: only rows currently category='Payment' are reverted.\n`);

  let restored = 0;
  for (let i = 0; i < entries.length; i += BATCH) {
    const slice = entries.slice(i, i + BATCH);
    const ops = slice.map((e) =>
      db.$executeRaw`
        UPDATE "Transaction"
        SET "category" = ${e.from}::"TransactionCategory"
        WHERE "id" = ${e.id} AND "category" = 'Payment'
      `,
    );
    const counts = await db.$transaction(ops);
    restored += counts.reduce((s, c) => s + (c as number), 0);
    if (VERBOSE) for (const e of slice) console.log(`  ${e.id} → ${e.from} (was Payment)`);
  }

  console.log(`\nRestored ${restored} of ${entries.length} logged row(s).`);
  const skipped = entries.length - restored;
  if (skipped > 0) {
    console.log(`${skipped} row(s) NOT reverted — no longer category='Payment' (user re-categorized, or already restored).`);
  }
  console.log(`Note: flowType was not changed by this script; re-run the FlowType backfill after a rollback if flow columns need to follow.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dry-run / apply mode
// ─────────────────────────────────────────────────────────────────────────────
async function runBackfill(): Promise<void> {
  console.log(`\n${APPLY ? "[APPLY] CC payment backfill — WRITING category" : "[DRY RUN] CC payment backfill — READ-ONLY, no writes"}`);
  console.log(
    `Selection: category = '${SOURCE_CATEGORY}' AND amount > 0 AND account.debtSubtype != null AND card-payment descriptor` +
    `${INCLUDE_DELETED ? " (including soft-deleted)" : " (excluding soft-deleted)"}` +
    `${SPACE_ID ? `  scope: space=${SPACE_ID}` : ""}`,
  );
  console.log(`Batch: ${BATCH}${Number.isFinite(LIMIT) ? `   Limit: ${LIMIT}` : ""}\n`);

  const where = baseWhere();
  // merchant → { count, subtypes } and per-account rollup for the summary.
  const byMerchant = new Map<string, number>();
  const byAccount = new Map<string, { count: number; institution: string; type: string; debtSubtype: string }>();
  const log: LogEntry[] = [];
  let scanned = 0;    // liability + positive 'Other' rows examined
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
        id: true, category: true, merchant: true, description: true, amount: true,
        pfcPrimary: true, pfcDetailed: true,
        financialAccountId: true,
        financialAccount: { select: { institution: true, type: true, debtSubtype: true } },
      },
    });
    if (rows.length === 0) break;

    // In-memory descriptor guard via the SHARED predicate (identical to sync).
    const pageCandidates = rows.filter((r) =>
      isLiabilityCardPaymentLeg({
        accountType: r.financialAccount?.type ?? null,
        debtSubtype: r.financialAccount?.debtSubtype ?? null,
        amount: r.amount,
        merchant: r.merchant,
        name: r.description,
      }),
    );

    for (const r of pageCandidates) {
      candidates++;
      const mkey = r.merchant || "(no merchant)";
      byMerchant.set(mkey, (byMerchant.get(mkey) ?? 0) + 1);
      const akey = r.financialAccountId ?? "(none)";
      const inst = r.financialAccount?.institution ?? "(unknown)";
      const atype = r.financialAccount?.type ?? "(none)";
      const sub = r.financialAccount?.debtSubtype ?? "(none)";
      const agg = byAccount.get(akey) ?? { count: 0, institution: inst, type: atype, debtSubtype: sub };
      agg.count++;
      byAccount.set(akey, agg);
      log.push({ id: r.id, from: SOURCE_CATEGORY, to: TARGET_CATEGORY });
      if (VERBOSE) {
        const p = r.pfcPrimary || r.pfcDetailed ? `  [pfc ${r.pfcPrimary ?? "-"}/${r.pfcDetailed ?? "-"}]` : "";
        console.log(`  ${r.id}  ${inst} (type=${atype}, debtSubtype=${sub})  ${mkey}  +${r.amount}  Other → Payment${p}`);
      }
    }

    // Apply: raw UPDATE of ONLY category, guarded by category='Other', no
    // updatedAt bump, batched atomically.
    if (APPLY && pageCandidates.length > 0) {
      const ops = pageCandidates.map((r) =>
        db.$executeRaw`
          UPDATE "Transaction"
          SET "category" = ${TARGET_CATEGORY}::"TransactionCategory"
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
  console.log(`Scanned (liability, +amount, Other): ${scanned}${scanned >= LIMIT ? " (--limit reached)" : ""}`);
  console.log(`Candidates (card-payment descriptor): ${candidates}\n`);

  if (candidates > 0) {
    console.log("By account (count · institution · type / debtSubtype):");
    for (const [id, agg] of [...byAccount.entries()].sort((a, b) => b[1].count - a[1].count)) {
      console.log(`  ${String(agg.count).padStart(5)}  ${agg.institution}  type=${agg.type} / debtSubtype=${agg.debtSubtype}   (account ${id})`);
    }
    console.log("\nBy merchant descriptor:");
    for (const [merchant, n] of [...byMerchant.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)}  ${merchant}`);
    }
    console.log("");
  }

  if (APPLY) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logPath = `${LOG_DIR}/backfill-cc-payment-categories-${stamp}.json`;
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, JSON.stringify(log, null, 2), "utf8");
    console.log(`Applied — category rewritten to Payment on ${updated} row(s).`);
    console.log(`Rollback log: ${logPath}`);
    if (updated !== candidates) {
      console.log(`Note: updated (${updated}) != candidates (${candidates}) — some rows changed category between scan and write (guard held).`);
    }
    console.log(`NEXT: re-derive flow columns for the changed rows — run the FlowType backfill (scripts/backfill-flowtype.ts) so they become DEBT_PAYMENT.`);
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
    console.error("backfill-cc-payment-categories failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
