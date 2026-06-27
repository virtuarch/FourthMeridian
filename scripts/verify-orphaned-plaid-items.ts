/**
 * scripts/verify-orphaned-plaid-items.ts
 *
 * Companion validation script for cleanup-orphaned-plaid-items.ts. Read-only:
 * makes zero writes to any table, calls Plaid for nothing.
 * Design reference: docs/bugfixes/BUGFIX_PLAID_REFRESH_ORPHANED_PLAID_ITEMS.md
 * (Step E SQL check, validation plan).
 *
 * Checks (real failure, exit code 1):
 *   1. No ACTIVE PlaidItem has zero active linked accounts — i.e. for every
 *      PlaidItem with status = ACTIVE, at least one AccountConnection row
 *      exists with deletedAt IS NULL whose FinancialAccount also has
 *      deletedAt IS NULL. Same definition as refresh.ts's
 *      hasActiveLinkedAccount() and cleanup-orphaned-plaid-items.ts. A
 *      non-empty result here means either the cleanup script hasn't been
 *      run yet, or a new orphan has appeared since — both worth
 *      investigating before assuming the bugfix is fully landed.
 *
 * Informational only (never affects exit code):
 *   2. Live AccountConnection rows whose FinancialAccount is archived but
 *      whose PlaidItem is NOT ACTIVE (e.g. already REVOKED, or NEEDS_REAUTH/
 *      ERROR) — these don't trigger refresh.ts's ACTIVE-only query so they
 *      aren't part of the bug this checks for, but a live connection on an
 *      archived account is still slightly inconsistent state worth knowing
 *      about. Counted, never treated as a failure.
 *   3. Count of archived FinancialAccounts that still hold a plaidAccountId
 *      with no ProviderAccountIdentity row — cross-reference only, this is
 *      the population the "[plaid][D2-3E] ProviderAccountIdentity miss"
 *      warning fires for. Expected to shrink to (ideally) zero new
 *      occurrences once Check 1 above passes and stays passing, since the
 *      PlaidItems behind them will have been revoked and stopped being
 *      refreshed. Not a failure either way — ProviderAccountIdentity
 *      backfill for archived accounts is explicitly out of scope for this
 *      fix (see the bugfix doc's "out of scope" list).
 *
 * Usage:
 *   npx tsx scripts/verify-orphaned-plaid-items.ts [--verbose]
 *
 * Exit code: 1 if Check 1 finds any orphaned ACTIVE PlaidItem, 0 otherwise.
 * Check 2-3 never affect the exit code.
 */

import { PrismaClient, PlaidItemStatus, ProviderType } from "@prisma/client";

const prisma = new PrismaClient();
const VERBOSE = process.argv.includes("--verbose");

function printIds(label: string, ids: string[], limit = 10) {
  console.log(`${label} (${ids.length}):`);
  if (ids.length === 0) return;
  const shown = VERBOSE ? ids : ids.slice(0, limit);
  for (const id of shown) console.log(`  - ${id}`);
  if (!VERBOSE && ids.length > limit) {
    console.log(`  ... and ${ids.length - limit} more (re-run with --verbose to see all)`);
  }
}

async function main() {
  console.log("\nOrphaned-PlaidItem verification (post bugfix/cleanup)\n");

  let failed = false;

  // ── Check 1 — ACTIVE PlaidItems with zero active linked accounts ────────
  const activeItems = await prisma.plaidItem.findMany({
    where:  { status: PlaidItemStatus.ACTIVE },
    select: { id: true, institutionName: true },
  });

  const orphanedActiveItemIds: string[] = [];
  for (const item of activeItems) {
    const activeLinkedCount = await prisma.accountConnection.count({
      where: {
        plaidItemDbId: item.id,
        deletedAt: null,
        financialAccount: { deletedAt: null },
      },
    });
    if (activeLinkedCount === 0) orphanedActiveItemIds.push(item.id);
  }

  console.log("CHECK 1 — every ACTIVE PlaidItem has at least one active linked FinancialAccount");
  console.log(`  ACTIVE PlaidItems scanned: ${activeItems.length}`);
  printIds("  Orphaned (real failure)", orphanedActiveItemIds);
  console.log(orphanedActiveItemIds.length === 0 ? "  PASS\n" : "  FAIL\n");
  if (orphanedActiveItemIds.length > 0) failed = true;

  // ── Check 2 — live connections on archived accounts, non-ACTIVE item ────
  // (informational only — refresh.ts's ACTIVE-only query never reaches these)
  const liveConnections = await prisma.accountConnection.findMany({
    where: { deletedAt: null, financialAccount: { deletedAt: { not: null } } },
    select: { id: true, plaidItemDbId: true, financialAccountId: true },
  });
  const nonActiveItemIds = new Set(
    (await prisma.plaidItem.findMany({
      where:  { status: { not: PlaidItemStatus.ACTIVE } },
      select: { id: true },
    })).map((i) => i.id)
  );
  const informationalStaleConnections = liveConnections
    .filter((c) => c.plaidItemDbId && nonActiveItemIds.has(c.plaidItemDbId))
    .map((c) => `connection=${c.id} financialAccountId=${c.financialAccountId} plaidItemDbId=${c.plaidItemDbId}`);

  console.log("CHECK 2 — live connections on an archived account whose PlaidItem isn't ACTIVE (informational only, never fails)");
  printIds("  Stale-but-harmless connections", informationalStaleConnections);
  console.log("  INFO\n");

  // ── Check 3 — archived accounts with plaidAccountId but no identity row ─
  // (informational cross-reference with the D2-3E warning population)
  const archivedPlaidAccounts = await prisma.financialAccount.findMany({
    where:  { deletedAt: { not: null }, plaidAccountId: { not: null } },
    select: { id: true, plaidAccountId: true },
  });
  const plaidIdentityAccountIds = new Set(
    (await prisma.providerAccountIdentity.findMany({
      where:  { provider: ProviderType.PLAID },
      select: { financialAccountId: true },
    })).map((i) => i.financialAccountId)
  );
  const archivedNoIdentity = archivedPlaidAccounts.filter((a) => !plaidIdentityAccountIds.has(a.id)).map((a) => a.id);

  console.log("CHECK 3 — archived PLAID accounts with no ProviderAccountIdentity row (informational only, never fails — by design, see D2_STEP1C investigation doc)");
  console.log(`  Archived accounts with plaidAccountId: ${archivedPlaidAccounts.length}`);
  printIds("  ...with no ProviderAccountIdentity row", archivedNoIdentity);
  console.log("  INFO\n");

  console.log("──────────────────────────────────────────────────────────");
  console.log(failed ? "RESULT: FAIL — see failing checks above." : "RESULT: PASS");
  console.log("──────────────────────────────────────────────────────────");

  if (failed) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("❌  Verification failed to run:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
