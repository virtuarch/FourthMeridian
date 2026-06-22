/**
 * scripts/backfill-space-account-link.ts
 *
 * D3 Step 2 — backfill SpaceAccountLink (HOME + SHARED) from existing
 * FinancialAccount / WorkspaceAccountShare data. Design reference:
 * docs/D3_STEP2_BACKFILL_REVIEW.md (§1 HOME strategy, §2 SHARED strategy,
 * §3 collision analysis, §7 implementation checklist).
 *
 * Scope, deliberately narrow:
 *   - Writes ONLY to SpaceAccountLink. Never touches WorkspaceAccountShare,
 *     FinancialAccount, or any other table.
 *   - SpaceAccountLink is not yet read by any application code (confirmed
 *     zero references in app/, lib/, components/ as of D3 Step 2) — running
 *     this script cannot change anything a user sees.
 *   - Idempotent: every insert goes through `createMany({ skipDuplicates:
 *     true })` against the (spaceId, financialAccountId) unique constraint
 *     SpaceAccountLink already has, so re-running after a partial failure
 *     never double-inserts and never throws on rows that already exist.
 *   - Never aborts the run for a single bad account. Accounts whose creator
 *     can't be resolved, or whose creator has no ACTIVE PERSONAL Space, are
 *     skipped and logged as exceptions (see D3_STEP2_BACKFILL_REVIEW.md §1
 *     Edge Cases A/B) — the rest of the run proceeds.
 *
 * Usage:
 *   npx tsx scripts/backfill-space-account-link.ts --dry-run [--verbose]
 *   npx tsx scripts/backfill-space-account-link.ts [--verbose]
 *
 *   --dry-run   Compute and print everything that would be written. Zero
 *               database writes (the script never calls createMany at all
 *               in this mode).
 *   --verbose   Log every account/share processed, not just the summary
 *               and exceptions.
 *
 * Rollback (see D3_STEP2_BACKFILL_REVIEW.md §6): the table is additive and
 * read by nothing, so rollback is a full data wipe —
 *   DELETE FROM "SpaceAccountLink";
 * — followed by a clean re-run. No migration or schema reversion needed.
 */

import {
  PrismaClient,
  ShareStatus,
  VisibilityLevel,
  SpaceAccountLinkKind,
  type Prisma,
} from "@prisma/client";

const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");

type ExceptionReason = "NO_RESOLVABLE_CREATOR" | "NO_ACTIVE_PERSONAL_SPACE";

interface SkippedAccount {
  financialAccountId: string;
  creatorUserId: string | null;
  reason: ExceptionReason;
}

function vlog(...args: unknown[]) {
  if (VERBOSE) console.log(...args);
}

function pairKey(spaceId: string, financialAccountId: string) {
  return `${spaceId}::${financialAccountId}`;
}

/**
 * Resolve a user's personal Space, mirroring the existing production lookup
 * used by lib/space.ts (resolveSpaceContext's PERSONAL-Space fallback) and
 * app/api/accounts/manual/route.ts: an ACTIVE SpaceMember row pointing at a
 * non-archived, non-deleted, type=PERSONAL Space.
 *
 * Adds an explicit `orderBy: joinedAt asc` tiebreaker that neither of those
 * call sites has — defensive only. No code path today can give one user two
 * ACTIVE PERSONAL memberships, but nothing in the schema prevents it either
 * (see D3_STEP2_BACKFILL_REVIEW.md §1 Edge Case C).
 */
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
  console.log(`\n${DRY_RUN ? "[DRY RUN] " : ""}D3 Step 2 — SpaceAccountLink backfill`);
  console.log(`Mode: ${DRY_RUN ? "dry-run (no writes)" : "LIVE (will write to SpaceAccountLink)"}\n`);

  // ── Snapshot existing links once up front ──────────────────────────────
  // Used both to make the run idempotent (skip pairs that already exist)
  // and to give dry-run accurate "would insert" counts without writing
  // anything.
  const existingLinks = await prisma.spaceAccountLink.findMany({
    select: { spaceId: true, financialAccountId: true, kind: true },
  });
  const claimedPairs = new Set(existingLinks.map((l) => pairKey(l.spaceId, l.financialAccountId)));
  const existingHomeCountByAccount = new Map<string, number>();
  for (const l of existingLinks) {
    if (l.kind === SpaceAccountLinkKind.HOME) {
      existingHomeCountByAccount.set(
        l.financialAccountId,
        (existingHomeCountByAccount.get(l.financialAccountId) ?? 0) + 1
      );
    }
  }

  const accounts = await prisma.financialAccount.findMany({
    where: { deletedAt: null },
    select: { id: true, createdByUserId: true, ownerUserId: true, createdAt: true },
  });

  const personalSpaceCache = new Map<string, string | null>();
  const skipped: SkippedAccount[] = [];
  const homeCandidates: Prisma.SpaceAccountLinkCreateManyInput[] = [];
  // Pairs newly claimed as HOME during this invocation — disjoint from
  // claimedPairs' initial contents (real pre-existing SpaceAccountLink
  // rows). Used only to label the SHARED-loop skip reason accurately.
  const homeClaimedThisRun = new Set<string>();
  let homeFromExistingShare = 0;
  let homeSynthesized = 0;
  let homeAlreadyPresent = 0;

  for (const account of accounts) {
    const creatorUserId = account.createdByUserId ?? account.ownerUserId ?? null;

    if (!creatorUserId) {
      skipped.push({ financialAccountId: account.id, creatorUserId: null, reason: "NO_RESOLVABLE_CREATOR" });
      vlog(`  [SKIP] ${account.id} — no createdByUserId or ownerUserId`);
      continue;
    }

    let personalSpaceId = personalSpaceCache.get(creatorUserId);
    if (personalSpaceId === undefined) {
      personalSpaceId = await resolvePersonalSpaceId(creatorUserId);
      personalSpaceCache.set(creatorUserId, personalSpaceId);
    }

    if (!personalSpaceId) {
      skipped.push({ financialAccountId: account.id, creatorUserId, reason: "NO_ACTIVE_PERSONAL_SPACE" });
      vlog(`  [SKIP] ${account.id} — creator ${creatorUserId} has no ACTIVE PERSONAL space`);
      continue;
    }

    const key = pairKey(personalSpaceId, account.id);
    if (claimedPairs.has(key)) {
      homeAlreadyPresent++;
      vlog(`  [SKIP] ${account.id} — HOME link already exists at ${personalSpaceId} (re-run)`);
      continue;
    }

    // Flag (not block) the case where this account already has a HOME link
    // at a *different* space than the one freshly resolved — should never
    // happen from a clean prior run of this same script, since the rule is
    // deterministic, but worth a loud warning if it ever does.
    const existingHomeElsewhere = existingHomeCountByAccount.get(account.id) ?? 0;
    if (existingHomeElsewhere > 0) {
      console.warn(
        `  [WARN] ${account.id} already has ${existingHomeElsewhere} HOME link(s) at a different space than the freshly resolved ${personalSpaceId} — not overwriting, investigate manually.`
      );
    }

    const existingShare = await prisma.workspaceAccountShare.findUnique({
      where: { workspaceId_financialAccountId: { workspaceId: personalSpaceId, financialAccountId: account.id } },
    });

    if (existingShare) {
      homeFromExistingShare++;
      vlog(`  [HOME:copy] ${account.id} -> space ${personalSpaceId} (from share ${existingShare.id})`);
      homeCandidates.push({
        spaceId: personalSpaceId,
        financialAccountId: account.id,
        kind: SpaceAccountLinkKind.HOME,
        addedByUserId: existingShare.addedByUserId,
        visibilityLevel: existingShare.visibilityLevel,
        status: existingShare.status,
        revokedAt: existingShare.revokedAt,
        revokedByUserId: existingShare.revokedByUserId,
        createdAt: existingShare.createdAt,
      });
    } else {
      homeSynthesized++;
      vlog(`  [HOME:synthesize] ${account.id} -> space ${personalSpaceId}`);
      homeCandidates.push({
        spaceId: personalSpaceId,
        financialAccountId: account.id,
        kind: SpaceAccountLinkKind.HOME,
        addedByUserId: creatorUserId,
        visibilityLevel: VisibilityLevel.FULL,
        status: ShareStatus.ACTIVE,
        createdAt: account.createdAt,
      });
    }

    // Reserve this pair immediately so the SHARED pass below (which also
    // considers this same WorkspaceAccountShare row, if one exists) knows
    // it has already been claimed as HOME, even though nothing is written
    // to the DB until the createMany call after the loop.
    claimedPairs.add(key);
    homeClaimedThisRun.add(key);
  }

  // ── SHARED ────────────────────────────────────────────────────────────
  // Every WorkspaceAccountShare row not already claimed as HOME becomes a
  // SHARED SpaceAccountLink row, copied verbatim — including REVOKED rows
  // (see D3_STEP2_BACKFILL_REVIEW.md §2).
  const allShares = await prisma.workspaceAccountShare.findMany();
  const sharedCandidates: Prisma.SpaceAccountLinkCreateManyInput[] = [];
  // claimedPairs mixes two different origins by the time this loop runs:
  // pairs that were already real SpaceAccountLink rows before this script
  // started (a true re-run case), and pairs the HOME loop above just
  // claimed in this same invocation (every run, dry or not — see the
  // `claimedPairs.add(key)` comment in the HOME loop). Tracked separately
  // here purely for accurate reporting; it does not change which rows are
  // skipped or inserted.
  let sharedSkippedClaimedAsHome = 0;
  let sharedAlreadyLinked = 0;
  let sharedRevokedIncluded = 0;

  for (const share of allShares) {
    const key = pairKey(share.workspaceId, share.financialAccountId);
    if (claimedPairs.has(key)) {
      if (homeClaimedThisRun.has(key)) sharedSkippedClaimedAsHome++;
      else sharedAlreadyLinked++;
      continue;
    }

    vlog(`  [SHARED] ${share.financialAccountId} -> space ${share.workspaceId} (status ${share.status})`);
    if (share.status === ShareStatus.REVOKED) sharedRevokedIncluded++;

    sharedCandidates.push({
      spaceId: share.workspaceId,
      financialAccountId: share.financialAccountId,
      kind: SpaceAccountLinkKind.SHARED,
      addedByUserId: share.addedByUserId,
      visibilityLevel: share.visibilityLevel,
      status: share.status,
      revokedAt: share.revokedAt,
      revokedByUserId: share.revokedByUserId,
      createdAt: share.createdAt,
    });
    claimedPairs.add(key);
  }

  // ── Write (skipped entirely in dry-run mode) ────────────────────────────
  let homeInserted = 0;
  let sharedInserted = 0;

  if (!DRY_RUN) {
    if (homeCandidates.length > 0) {
      const res = await prisma.spaceAccountLink.createMany({ data: homeCandidates, skipDuplicates: true });
      homeInserted = res.count;
    }
    if (sharedCandidates.length > 0) {
      const res = await prisma.spaceAccountLink.createMany({ data: sharedCandidates, skipDuplicates: true });
      sharedInserted = res.count;
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("──────────────────────────────────────────────────────────");
  console.log(`Accounts scanned (deletedAt IS NULL):   ${accounts.length}`);
  console.log(`HOME — copied from existing share:      ${homeFromExistingShare}`);
  console.log(`HOME — synthesized:                     ${homeSynthesized}`);
  console.log(`HOME — already present (re-run):        ${homeAlreadyPresent}`);
  console.log(`HOME candidates ${DRY_RUN ? "(would insert)" : "inserted"}:           ${homeCandidates.length}${DRY_RUN ? "" : ` (createMany count: ${homeInserted})`}`);
  console.log(`SHARED — skipped (claimed as HOME):     ${sharedSkippedClaimedAsHome}`);
  console.log(`SHARED — already linked (re-run):       ${sharedAlreadyLinked}`);
  console.log(`SHARED — of which REVOKED:               ${sharedRevokedIncluded}`);
  console.log(`SHARED candidates ${DRY_RUN ? "(would insert)" : "inserted"}:         ${sharedCandidates.length}${DRY_RUN ? "" : ` (createMany count: ${sharedInserted})`}`);
  console.log(`Accounts skipped (exceptions):          ${skipped.length}`);
  console.log("──────────────────────────────────────────────────────────");

  if (skipped.length > 0) {
    console.log("\nException detail:");
    for (const ex of skipped) {
      console.log(`  - account=${ex.financialAccountId}  reason=${ex.reason}  creatorUserId=${ex.creatorUserId ?? "null"}`);
    }
  }

  if (DRY_RUN) {
    console.log("\nDry run only — no rows were written. Re-run without --dry-run to write for real.");
  }
}

main()
  .catch((e) => {
    console.error("❌  Backfill failed:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
