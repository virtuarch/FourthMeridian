/**
 * scripts/dedupe-home-links.ts
 *
 * KD-5 pre-flight — one-time data cleanup that must run GREEN before the
 * partial unique index migration
 * (prisma/migrations/20260702170000_kd5_home_partial_unique_index) can be
 * applied. Design reference:
 * docs/investigations/KD5_HOME_UNIQUENESS_CONCURRENCY_INVESTIGATION.md §5.
 *
 * Problem this fixes:
 *   "Exactly one HOME SpaceAccountLink per FinancialAccount" was, until KD-5,
 *   enforced only by application code (computeLinkKind). A concurrent HOME
 *   race (two transactions both counting zero rows under Read Committed) could
 *   leave an account with more than one row of kind = HOME. The KD-5 partial
 *   unique index rejects such rows going forward, but `CREATE UNIQUE INDEX`
 *   FAILS if any pre-existing duplicate is present. This script finds and
 *   resolves those duplicates first.
 *
 * What it does, deliberately narrow:
 *   - Finds every financialAccountId that has more than one kind = HOME row
 *     (status-agnostic — matches the index predicate WHERE kind = 'HOME').
 *   - Keeps exactly one HOME per account: the earliest-created HOME (by
 *     createdAt), i.e. the account's true owning Space — the same
 *     earliest-createdAt heuristic scripts/correct-home-links.ts uses.
 *   - DEMOTES every other HOME row for that account to kind = SHARED. It does
 *     NOT delete them: they may be legitimate shares, and demotion is additive
 *     before subtractive and fully reversible.
 *   - Leaves status, visibilityLevel, addedByUserId, and every other column
 *     untouched. Never touches WorkspaceAccountShare, FinancialAccount, or any
 *     other table.
 *   - Idempotent: after a run each account has exactly one HOME, so a re-run
 *     finds nothing. Safe to run repeatedly.
 *   - On a tie for earliest createdAt (two HOME rows with identical createdAt),
 *     the account is SKIPPED and logged for manual review rather than guessing
 *     which Space is canonical.
 *
 * Usage:
 *   npx tsx scripts/dedupe-home-links.ts --dry-run [--verbose]
 *   npx tsx scripts/dedupe-home-links.ts [--verbose]
 *
 *   --dry-run   Compute and print every demotion that would be made. Zero
 *               database writes.
 *   --verbose   Log every account examined, not just the ones with duplicates.
 *
 * Rollback: this script only ever flips extra HOME rows' `kind` column to
 * SHARED. Run with --dry-run first and keep the output — it lists every
 * (spaceId, financialAccountId) demoted, which is the exact set to flip back
 * to HOME if a manual revert is ever needed. No schema or migration change is
 * involved.
 */

import { PrismaClient, SpaceAccountLinkKind } from "@prisma/client";

const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");

function vlog(...args: unknown[]) {
  if (VERBOSE) console.log(...args);
}

interface SkippedAccount {
  financialAccountId: string;
  detail: string;
}

async function main() {
  console.log(`\n${DRY_RUN ? "[DRY RUN] " : ""}KD-5 — duplicate HOME link cleanup`);
  console.log(`Mode: ${DRY_RUN ? "dry-run (no writes)" : "LIVE (will demote extra HOME rows to SHARED)"}\n`);

  // ── Find accounts with more than one HOME row (status-agnostic) ──────────
  const homeCounts = await prisma.spaceAccountLink.groupBy({
    by: ["financialAccountId"],
    where: { kind: SpaceAccountLinkKind.HOME },
    _count: { _all: true },
  });

  const duplicateAccountIds = homeCounts
    .filter((h) => h._count._all > 1)
    .map((h) => h.financialAccountId);

  console.log(`Accounts with a single HOME (nothing to do):  ${homeCounts.length - duplicateAccountIds.length}`);
  console.log(`Accounts with duplicate HOME rows:            ${duplicateAccountIds.length}\n`);

  let demotedRows = 0;
  let fixedAccounts = 0;
  const skipped: SkippedAccount[] = [];

  for (const financialAccountId of duplicateAccountIds) {
    const homeLinks = await prisma.spaceAccountLink.findMany({
      where: { financialAccountId, kind: SpaceAccountLinkKind.HOME },
      select: { spaceId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    const keeper = homeLinks[0];
    const tiedWithKeeper = homeLinks.filter(
      (l) => l.createdAt.getTime() === keeper.createdAt.getTime()
    );

    if (tiedWithKeeper.length > 1) {
      skipped.push({
        financialAccountId,
        detail: `${tiedWithKeeper.length} HOME rows share the same earliest createdAt (${keeper.createdAt.toISOString()}): ${tiedWithKeeper
          .map((l) => l.spaceId)
          .join(", ")}. Cannot pick a canonical HOME automatically — resolve manually.`,
      });
      console.warn(`  [SKIP] ${financialAccountId} — ambiguous keeper (tie at ${keeper.createdAt.toISOString()}), not demoting`);
      continue;
    }

    const toDemote = homeLinks.slice(1); // everything after the earliest keeper
    vlog(`  [FIX] ${financialAccountId} — keep HOME at ${keeper.spaceId}, demote ${toDemote.length} other HOME row(s) to SHARED: ${toDemote.map((l) => l.spaceId).join(", ")}`);

    if (!DRY_RUN) {
      for (const l of toDemote) {
        await prisma.spaceAccountLink.update({
          where: {
            spaceId_financialAccountId: {
              spaceId: l.spaceId,
              financialAccountId,
            },
          },
          data: { kind: SpaceAccountLinkKind.SHARED },
        });
      }
    }

    demotedRows += toDemote.length;
    fixedAccounts++;
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("──────────────────────────────────────────────────────────");
  console.log(`Accounts with duplicate HOME examined:   ${duplicateAccountIds.length}`);
  console.log(`Accounts ${DRY_RUN ? "that would be fixed" : "fixed"}:              ${fixedAccounts}`);
  console.log(`HOME rows ${DRY_RUN ? "that would be demoted" : "demoted"} to SHARED: ${demotedRows}`);
  console.log(`Skipped (ambiguous, manual review):      ${skipped.length}`);
  console.log("──────────────────────────────────────────────────────────");

  if (skipped.length > 0) {
    console.log("\nException detail:");
    for (const ex of skipped) {
      console.log(`  - account=${ex.financialAccountId}`);
      console.log(`    ${ex.detail}`);
    }
  }

  if (DRY_RUN) {
    console.log("\nDry run only — no rows were written. Re-run without --dry-run to apply for real.");
  } else {
    // Idempotency / gate self-check: re-scan for any account still holding >1 HOME.
    const remaining = await prisma.spaceAccountLink.groupBy({
      by: ["financialAccountId"],
      where: { kind: SpaceAccountLinkKind.HOME },
      _count: { _all: true },
    });
    const stillDuplicated = remaining.filter((h) => h._count._all > 1).length;
    console.log(`\nPost-run check — accounts still holding >1 HOME: ${stillDuplicated}`);
    if (stillDuplicated > 0) {
      console.log("(Expected only for accounts skipped above as ambiguous ties — the index migration will still fail until those are resolved manually.)");
      process.exitCode = 1;
    }
  }
}

main()
  .catch((e) => {
    console.error("❌  Dedupe failed:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
