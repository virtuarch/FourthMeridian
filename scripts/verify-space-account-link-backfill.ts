/**
 * scripts/verify-space-account-link-backfill.ts
 *
 * D3 Step 2 — companion validation script for backfill-space-account-link.ts.
 * Read-only: makes zero writes to any table. Implements the four checks from
 * docs/initiatives/d3/D3_STEP2_BACKFILL_REVIEW.md §5 ("Application checks") via Prisma
 * instead of raw SQL, so they run against the live schema types.
 *
 * Checks:
 *   1. Every active FinancialAccount has exactly one HOME link — excluding
 *      accounts that independently qualify as a known exception (no
 *      resolvable creator, or creator has no ACTIVE PERSONAL Space; see
 *      D3_STEP2_BACKFILL_REVIEW.md §1 Edge Cases A/B). Those are reported
 *      separately, not counted as failures.
 *   2. No account has more than one HOME link (across different Spaces) —
 *      the DB's unique constraint only covers (spaceId, financialAccountId),
 *      so this is the one thing actually enforcing "exactly one HOME per
 *      account" (see schema.prisma:153-159).
 *   3. Every WorkspaceAccountShare row has a corresponding SpaceAccountLink
 *      row at the same (space, account) pair, with matching status and
 *      visibilityLevel.
 *   4. Logically orphaned links — a SpaceAccountLink pointing at an account
 *      that is now soft-deleted. Reported as informational only, per
 *      D3_STEP2_BACKFILL_REVIEW.md §5 ("non-zero later is normal").
 *
 * Usage:
 *   npx tsx scripts/verify-space-account-link-backfill.ts [--verbose]
 *
 * Exit code: 1 if any of checks 1-3 fail, 0 otherwise. Check 4 never affects
 * the exit code.
 */

import { PrismaClient, SpaceAccountLinkKind } from "@prisma/client";

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

/** Same rule as backfill-space-account-link.ts — duplicated deliberately so
 * this script has no import dependency on the backfill script or on any
 * application module, and stays a standalone, read-only check. */
async function resolvePersonalSpaceId(userId: string): Promise<string | null> {
  const membership = await prisma.spaceMember.findFirst({
    where: {
      userId,
      status: "ACTIVE",
      space: { type: "PERSONAL", archivedAt: null, deletedAt: null },
    },
    select: { spaceId: true },
    orderBy: { joinedAt: "asc" },
  });
  return membership?.spaceId ?? null;
}

async function main() {
  console.log("\nD3 Step 2 — SpaceAccountLink backfill verification\n");

  let failed = false;

  // ── Checks 1 & 2: HOME cardinality ──────────────────────────────────────
  const activeAccounts = await prisma.financialAccount.findMany({
    where: { deletedAt: null },
    select: { id: true, createdByUserId: true, ownerUserId: true },
  });

  const homeCounts = await prisma.spaceAccountLink.groupBy({
    by: ["financialAccountId"],
    where: { kind: SpaceAccountLinkKind.HOME },
    _count: { _all: true },
  });
  const homeCountByAccount = new Map(homeCounts.map((h) => [h.financialAccountId, h._count._all]));

  const missingHome: string[] = [];
  const duplicateHome: string[] = [];
  const knownExceptions: string[] = [];
  const personalSpaceCache = new Map<string, string | null>();

  for (const acct of activeAccounts) {
    const count = homeCountByAccount.get(acct.id) ?? 0;

    if (count === 1) continue;
    if (count > 1) {
      duplicateHome.push(acct.id);
      continue;
    }

    // count === 0 — confirm whether this is a known, expected exception
    // before flagging it as a real failure.
    const creatorUserId = acct.createdByUserId ?? acct.ownerUserId ?? null;
    let isKnownException = !creatorUserId;
    if (creatorUserId) {
      let personalSpaceId = personalSpaceCache.get(creatorUserId);
      if (personalSpaceId === undefined) {
        personalSpaceId = await resolvePersonalSpaceId(creatorUserId);
        personalSpaceCache.set(creatorUserId, personalSpaceId);
      }
      isKnownException = !personalSpaceId;
    }

    if (isKnownException) knownExceptions.push(acct.id);
    else missingHome.push(acct.id);
  }

  console.log("CHECK 1 — every active FinancialAccount has exactly one HOME link");
  printIds("  Missing HOME (real failure)", missingHome);
  printIds("  Known exceptions (no resolvable creator / no PERSONAL space — expected, not a failure)", knownExceptions);
  console.log(missingHome.length === 0 ? "  PASS\n" : "  FAIL\n");
  if (missingHome.length > 0) failed = true;

  console.log("CHECK 2 — no account has more than one HOME link");
  printIds("  Duplicate HOME", duplicateHome);
  console.log(duplicateHome.length === 0 ? "  PASS\n" : "  FAIL\n");
  if (duplicateHome.length > 0) failed = true;

  // ── Check 3: SHARED links match WorkspaceAccountShare ───────────────────
  const shares = await prisma.workspaceAccountShare.findMany();
  const links = await prisma.spaceAccountLink.findMany();
  const linkByPair = new Map(links.map((l) => [`${l.spaceId}::${l.financialAccountId}`, l]));

  const missingLink: string[] = [];
  const fieldDrift: string[] = [];

  for (const share of shares) {
    const link = linkByPair.get(`${share.workspaceId}::${share.financialAccountId}`);
    if (!link) {
      missingLink.push(share.id);
      continue;
    }
    if (link.status !== share.status || link.visibilityLevel !== share.visibilityLevel) {
      fieldDrift.push(share.id);
    }
  }

  console.log("CHECK 3 — every WorkspaceAccountShare row has a matching SpaceAccountLink row");
  printIds("  Missing link (share.id)", missingLink);
  printIds("  Field drift — status/visibilityLevel mismatch (share.id)", fieldDrift);
  console.log(missingLink.length === 0 && fieldDrift.length === 0 ? "  PASS\n" : "  FAIL\n");
  if (missingLink.length > 0 || fieldDrift.length > 0) failed = true;

  // ── Check 4: logically orphaned links (informational only) ─────────────
  const activeAccountIds = new Set(activeAccounts.map((a) => a.id));
  const orphaned = links.filter((l) => !activeAccountIds.has(l.financialAccountId)).map((l) => l.id);

  console.log("CHECK 4 — links pointing at a since-soft-deleted account (informational only, never fails)");
  printIds("  Orphaned link (link.id)", orphaned);
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
