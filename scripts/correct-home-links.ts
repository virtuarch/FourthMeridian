/**
 * scripts/correct-home-links.ts
 *
 * D3 Step 3 HOME Semantics Correction — one-time data correction.
 * Design reference: docs/D3_STEP3_HOME_SEMANTICS_CORRECTION.md (§4 diagnostic,
 * §5C correction scope).
 *
 * Problem this fixes:
 *   Before this correction, ensureHomeLink() (lib/accounts/space-account-link.ts)
 *   synthesized a SpaceAccountLink row at the creator's personal Space with
 *   kind: HOME whenever a Plaid item or wallet was created while a
 *   non-personal Space was active — with NO corresponding WorkspaceAccountShare
 *   row ever written there. That made Personal Space look like the "owner" of
 *   accounts it was never actually shared into, which is backwards under the
 *   corrected architecture (HOME = canonical owning Space, not "Personal").
 *
 *   This script finds exactly those synthesized-only rows — a SpaceAccountLink
 *   with kind: HOME at a Space of type PERSONAL that has no backing
 *   WorkspaceAccountShare row at the same (spaceId, financialAccountId) pair —
 *   and corrects them:
 *     1. Promotes that account's real, share-backed SpaceAccountLink (the
 *        earliest one, by createdAt — i.e. the Space the account was actually
 *        created in) to kind: HOME.
 *     2. Deletes the synthesized personal-space row outright (not demoted to
 *        SHARED — there was never a real share there, so it should not exist
 *        in any form).
 *
 * Scope, deliberately narrow:
 *   - Only touches SpaceAccountLink rows matching the exact synthesized-only
 *     fingerprint above. Legitimate, share-backed personal HOME links
 *     (an account genuinely created inside Personal Space) are left untouched.
 *   - Never touches WorkspaceAccountShare, FinancialAccount, or any other
 *     table.
 *   - Never touches manual-account auto-share-to-Personal behavior — that is
 *     a separate, not-yet-approved product decision (see correction doc §2).
 *   - Idempotent: re-running after a correction finds nothing left to fix,
 *     since the promoted link is now share-backed (no longer matches the
 *     synthesized-only fingerprint) and the synthesized row no longer exists.
 *   - Never aborts the run for a single bad account. Accounts whose
 *     synthesized row has no other backed link to promote (unexpected; see
 *     "NO_BACKED_CANDIDATE" below) are skipped and logged — the rest of the
 *     run proceeds.
 *
 * Usage:
 *   npx tsx scripts/correct-home-links.ts --dry-run [--verbose]
 *   npx tsx scripts/correct-home-links.ts [--verbose]
 *
 *   --dry-run   Compute and print every correction that would be made. Zero
 *               database writes.
 *   --verbose   Log every HOME-at-PERSONAL row examined, not just the
 *               corrections and exceptions.
 *
 * Rollback: this script only ever (a) flips an existing row's `kind` column
 * and (b) deletes rows that were never backed by a real share. Both are
 * narrow, identifiable changes — see docs/D3_STEP3_HOME_SEMANTICS_CORRECTION.md
 * for the exact fingerprint if a manual revert is ever needed. No schema or
 * migration change is involved.
 */

import {
  PrismaClient,
  SpaceAccountLinkKind,
} from "@prisma/client";

const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");

type ExceptionReason = "NO_BACKED_CANDIDATE" | "AMBIGUOUS_BACKED_CANDIDATES";

interface SkippedAccount {
  financialAccountId: string;
  personalSpaceId: string;
  reason: ExceptionReason;
  detail: string;
}

function vlog(...args: unknown[]) {
  if (VERBOSE) console.log(...args);
}

async function main() {
  console.log(`\n${DRY_RUN ? "[DRY RUN] " : ""}D3 Step 3 — HOME semantics correction`);
  console.log(`Mode: ${DRY_RUN ? "dry-run (no writes)" : "LIVE (will update/delete SpaceAccountLink rows)"}\n`);

  // ── Find every HOME link sitting at a PERSONAL-type Space ────────────────
  const personalHomeLinks = await prisma.spaceAccountLink.findMany({
    where: {
      kind: SpaceAccountLinkKind.HOME,
      space: { type: "PERSONAL" },
    },
    select: {
      spaceId: true,
      financialAccountId: true,
      space: { select: { name: true } },
    },
  });

  console.log(`HOME links at a PERSONAL space (candidates to check): ${personalHomeLinks.length}`);

  let legitimateBacked = 0;
  let correctedCount = 0;
  const skipped: SkippedAccount[] = [];

  for (const link of personalHomeLinks) {
    const { spaceId: personalSpaceId, financialAccountId } = link;

    // Is this personal HOME row actually backed by a real WorkspaceAccountShare?
    const backingShare = await prisma.workspaceAccountShare.findUnique({
      where: {
        workspaceId_financialAccountId: {
          workspaceId: personalSpaceId,
          financialAccountId,
        },
      },
      select: { id: true },
    });

    if (backingShare) {
      legitimateBacked++;
      vlog(`  [OK] ${financialAccountId} — HOME at personal space ${personalSpaceId} is backed by share ${backingShare.id}, leaving untouched`);
      continue;
    }

    // Synthesized-only: no WorkspaceAccountShare exists at this exact pair.
    // Find the account's real, share-backed SpaceAccountLink(s) elsewhere —
    // the earliest one (by createdAt) is the Space the account was actually
    // created in, and becomes the corrected HOME.
    const otherLinks = await prisma.spaceAccountLink.findMany({
      where: {
        financialAccountId,
        spaceId: { not: personalSpaceId },
      },
      select: { spaceId: true, kind: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    const backedCandidates: { spaceId: string; createdAt: Date }[] = [];
    for (const other of otherLinks) {
      const share = await prisma.workspaceAccountShare.findUnique({
        where: {
          workspaceId_financialAccountId: {
            workspaceId: other.spaceId,
            financialAccountId,
          },
        },
        select: { id: true },
      });
      if (share) backedCandidates.push({ spaceId: other.spaceId, createdAt: other.createdAt });
    }

    if (backedCandidates.length === 0) {
      skipped.push({
        financialAccountId,
        personalSpaceId,
        reason: "NO_BACKED_CANDIDATE",
        detail: "Synthesized-only personal HOME row found, but no other share-backed SpaceAccountLink exists for this account to promote. Leaving untouched — investigate manually.",
      });
      console.warn(`  [SKIP] ${financialAccountId} — no backed candidate to promote to HOME, not deleting synthesized row at ${personalSpaceId}`);
      continue;
    }

    // Earliest-created backed candidate = the account's actual creation Space.
    const sorted = [...backedCandidates].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const winner = sorted[0];
    const tiedWithWinner = sorted.filter((c) => c.createdAt.getTime() === winner.createdAt.getTime());

    if (tiedWithWinner.length > 1) {
      skipped.push({
        financialAccountId,
        personalSpaceId,
        reason: "AMBIGUOUS_BACKED_CANDIDATES",
        detail: `${tiedWithWinner.length} backed candidates share the same earliest createdAt (${winner.createdAt.toISOString()}): ${tiedWithWinner.map((c) => c.spaceId).join(", ")}. Leaving untouched — investigate manually.`,
      });
      console.warn(`  [SKIP] ${financialAccountId} — ambiguous backed candidates (tie at ${winner.createdAt.toISOString()}), not correcting`);
      continue;
    }

    vlog(`  [CORRECT] ${financialAccountId} — promote ${winner.spaceId} to HOME, delete synthesized HOME at ${personalSpaceId} (was: ${link.space.name ?? "unnamed personal space"})`);

    if (!DRY_RUN) {
      // Promote the real, share-backed link to HOME (no-op if it's already
      // HOME, e.g. from a prior partial run).
      await prisma.spaceAccountLink.update({
        where: {
          spaceId_financialAccountId: {
            spaceId: winner.spaceId,
            financialAccountId,
          },
        },
        data: { kind: SpaceAccountLinkKind.HOME },
      });

      // Delete the synthesized-only personal row outright.
      await prisma.spaceAccountLink.delete({
        where: {
          spaceId_financialAccountId: {
            spaceId: personalSpaceId,
            financialAccountId,
          },
        },
      });
    }

    correctedCount++;
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("──────────────────────────────────────────────────────────");
  console.log(`HOME-at-PERSONAL rows examined:          ${personalHomeLinks.length}`);
  console.log(`Legitimate (share-backed), untouched:    ${legitimateBacked}`);
  console.log(`Corrected ${DRY_RUN ? "(would correct)" : ""}:                       ${correctedCount}`);
  console.log(`Skipped (exceptions):                    ${skipped.length}`);
  console.log("──────────────────────────────────────────────────────────");

  if (skipped.length > 0) {
    console.log("\nException detail:");
    for (const ex of skipped) {
      console.log(`  - account=${ex.financialAccountId}  personalSpace=${ex.personalSpaceId}  reason=${ex.reason}`);
      console.log(`    ${ex.detail}`);
    }
  }

  if (DRY_RUN) {
    console.log("\nDry run only — no rows were written. Re-run without --dry-run to apply for real.");
  } else {
    // Idempotency self-check: re-scan for any remaining synthesized-only rows.
    const remaining = await prisma.spaceAccountLink.findMany({
      where: { kind: SpaceAccountLinkKind.HOME, space: { type: "PERSONAL" } },
      select: { spaceId: true, financialAccountId: true },
    });
    let remainingSynthesized = 0;
    for (const r of remaining) {
      const share = await prisma.workspaceAccountShare.findUnique({
        where: { workspaceId_financialAccountId: { workspaceId: r.spaceId, financialAccountId: r.financialAccountId } },
        select: { id: true },
      });
      if (!share) remainingSynthesized++;
    }
    console.log(`\nPost-run check — synthesized-only personal HOME rows still remaining: ${remainingSynthesized}`);
    if (remainingSynthesized > 0) {
      console.log("(Expected only if those accounts were skipped above as exceptions — check the exception detail.)");
    }
  }
}

main()
  .catch((e) => {
    console.error("❌  Correction failed:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
