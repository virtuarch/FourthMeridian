/**
 * scripts/cleanup-orphaned-plaid-items.ts
 *
 * One-time remediation for docs/bugfixes/BUGFIX_PLAID_REFRESH_ORPHANED_PLAID_ITEMS.md.
 *
 * Root cause (full writeup in that doc): lib/accounts/reconcile.ts's
 * duplicate-merge paths archived a "loser" FinancialAccount without ever
 * closing out its AccountConnection/PlaidItem — leaving a still-ACTIVE
 * PlaidItem with zero active linked accounts, which lib/plaid/refresh.ts
 * then kept refreshing forever, producing nothing but a
 * "[plaid][D2-3E] ProviderAccountIdentity miss, legacy plaidAccountId hit"
 * warning on every run. Both reconcile.ts (Step A) and refresh.ts (Step C,
 * with inline self-heal) have since been fixed so this can't recur and so a
 * live refresh will self-heal a stray item it happens to hit — this script
 * is the one-time sweep for whatever is already orphaned in the database
 * today, so the fix doesn't have to wait for every affected user to trigger
 * a refresh themselves.
 *
 * What counts as "orphaned" — identical definition to refresh.ts's
 * hasActiveLinkedAccount() and to the doc's Step E SQL check:
 *   PlaidItem.status = ACTIVE AND there is no AccountConnection row with
 *   deletedAt IS NULL whose FinancialAccount also has deletedAt IS NULL.
 *
 * What this script does to an orphaned item, in --apply mode only:
 *   1. Soft-deletes any AccountConnection rows still marked live
 *      (deletedAt: null) for that item — there may be zero, one, or more,
 *      depending on how many stale duplicate-merge losers point at it.
 *   2. Calls disconnectPlaidItemIfOrphaned(item.id) — the same function
 *      app/api/accounts/[id]/route.ts's DELETE handler already uses. It
 *      re-checks live connection count itself (now zero, post-step-1), then
 *      calls Plaid's itemRemove() and sets PlaidItem.status = REVOKED. A
 *      failed itemRemove() call (e.g. token already invalid) is logged by
 *      that function and does NOT block the status update — Plaid-side
 *      cleanup is best-effort, our own state always converges to REVOKED.
 *
 * This script imports lib/db and lib/plaid/disconnect directly rather than
 * instantiating its own PrismaClient (the convention every other script in
 * this directory uses) — deliberate, not an oversight. Every other script
 * here only ever reads/writes Prisma tables; this one also needs the real
 * Plaid-calling + token-decryption logic in lib/plaid/disconnect.ts, and
 * that logic should have exactly one implementation rather than a second
 * copy living in this script. Confirmed tsx resolves this project's "@/*"
 * tsconfig path alias at script-execution time, so this import works the
 * same way it would from application code.
 *
 * Usage:
 *   npx tsx scripts/cleanup-orphaned-plaid-items.ts [--verbose]
 *   npx tsx scripts/cleanup-orphaned-plaid-items.ts --apply [--verbose]
 *
 *   (default)   Dry run. Computes and prints every orphaned PlaidItem and
 *               every stray AccountConnection that would be closed. Zero
 *               database writes and zero calls to Plaid. This is the
 *               opposite default of backfill-provider-account-identity.ts
 *               (which defaults to LIVE) — deliberate, because --apply here
 *               calls Plaid's itemRemove(), which is not reversible (the
 *               user has to relink), unlike that script's plain additive
 *               insert.
 *   --apply     Perform the writes described above for real.
 *   --verbose   Log every item processed, not just the summary.
 *
 * Rollback: AccountConnection.deletedAt can be cleared back to null cheaply
 * if a row was closed in error (no data is destroyed — soft delete only).
 * PlaidItem.status = REVOKED can likewise be reset to ACTIVE in the
 * database, but the underlying Plaid itemRemove() call (if it succeeded) is
 * not reversible — the access token is gone at Plaid's end either way, and
 * the user would need to relink via Plaid Link regardless of our own status
 * field. This mirrors disconnectPlaidItemIfOrphaned's existing, accepted
 * behavior at every other call site (manual delete) — nothing new here.
 */

import { db } from "@/lib/db";
import { PlaidItemStatus } from "@prisma/client";
import { disconnectPlaidItemIfOrphaned } from "@/lib/plaid/disconnect";

const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");

function vlog(...args: unknown[]) {
  if (VERBOSE) console.log(...args);
}

type StrayConnection = {
  id: string;
  financialAccountId: string;
  financialAccount: { id: string; name: string; deletedAt: Date | null; plaidAccountId: string | null } | null;
};

async function main() {
  console.log(`\n${APPLY ? "" : "[DRY RUN] "}Orphaned-PlaidItem cleanup`);
  console.log(`Mode: ${APPLY ? "LIVE (will close connections + call Plaid itemRemove)" : "dry-run (no writes, no Plaid calls)"}\n`);

  const activeItems = await db.plaidItem.findMany({
    where:  { status: PlaidItemStatus.ACTIVE },
    select: { id: true, institutionName: true, userId: true },
  });

  console.log(`Scanned ${activeItems.length} ACTIVE PlaidItem row(s).\n`);

  let orphanedCount = 0;
  let totalStrayConnections = 0;
  let revokedCount = 0;
  const orphanedSummaries: string[] = [];

  for (const item of activeItems) {
    const activeLinkedCount = await db.accountConnection.count({
      where: {
        plaidItemDbId: item.id,
        deletedAt: null,
        financialAccount: { deletedAt: null },
      },
    });

    if (activeLinkedCount > 0) {
      vlog(`  [OK] PlaidItem ${item.id} (${item.institutionName}) — ${activeLinkedCount} active linked account(s), skipping.`);
      continue;
    }

    // Orphaned: zero active linked accounts. Gather the stray connections
    // (if any) for reporting + cleanup.
    const strayConnections: StrayConnection[] = await db.accountConnection.findMany({
      where:  { plaidItemDbId: item.id, deletedAt: null },
      select: {
        id: true,
        financialAccountId: true,
        financialAccount: { select: { id: true, name: true, deletedAt: true, plaidAccountId: true } },
      },
    });

    orphanedCount++;
    totalStrayConnections += strayConnections.length;

    const detail = strayConnections
      .map((c) => `financialAccountId=${c.financialAccountId}${c.financialAccount?.deletedAt ? " (archived)" : " (missing/active?)"} plaidAccountId=${c.financialAccount?.plaidAccountId ?? "null"}`)
      .join("; ");
    const summaryLine = `PlaidItem ${item.id} (${item.institutionName}, userId=${item.userId}) — ${strayConnections.length} stray live connection(s)${detail ? `: ${detail}` : ""}`;
    orphanedSummaries.push(summaryLine);
    console.log(`  [ORPHANED] ${summaryLine}`);

    if (APPLY) {
      if (strayConnections.length > 0) {
        await db.accountConnection.updateMany({
          where: { plaidItemDbId: item.id, deletedAt: null },
          data:  { deletedAt: new Date() },
        });
      }
      await disconnectPlaidItemIfOrphaned(item.id);

      const after = await db.plaidItem.findUnique({ where: { id: item.id }, select: { status: true } });
      if (after?.status === PlaidItemStatus.REVOKED) {
        revokedCount++;
        vlog(`    -> revoked.`);
      } else {
        console.warn(`    -> WARNING: expected status REVOKED after cleanup, got ${after?.status}. Investigate before re-running.`);
      }
    }
  }

  console.log("\n──────────────────────────────────────────────────────────");
  console.log(`ACTIVE PlaidItems scanned:        ${activeItems.length}`);
  console.log(`Orphaned (0 active linked accts): ${orphanedCount}`);
  console.log(`Stray live connections found:     ${totalStrayConnections}`);
  if (APPLY) {
    console.log(`Connections closed:               ${totalStrayConnections}`);
    console.log(`PlaidItems revoked:                ${revokedCount}`);
  }
  console.log("──────────────────────────────────────────────────────────");

  if (!APPLY && orphanedCount > 0) {
    console.log("\nDry run only — no rows were written, no Plaid calls made. Re-run with --apply to clean these up for real.");
  }
  if (orphanedCount === 0) {
    console.log("\nNo orphaned PlaidItems found — nothing to do.");
  }
}

main()
  .catch((e) => {
    console.error("❌  Cleanup failed to run:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
