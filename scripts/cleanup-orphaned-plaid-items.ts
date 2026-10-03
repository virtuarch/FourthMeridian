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
 *      calls Plaid's itemRemove() and sets PlaidItem.status = REVOKED.
 *
 * ── A SECOND WORK-LIST: REVOCATIONS THAT WERE NEVER CONFIRMED ───────────────
 * This script used to find orphans by `status: ACTIVE` ALONE, and that was the
 * hole. A failed `itemRemove` still wrote REVOKED, so the item dropped out of
 * this query — and out of every other retry work-list in the repository, all of
 * which select ACTIVE — while the Item kept existing, kept emitting webhooks and
 * kept BILLING at Plaid. That is what stranded seven live Items on 2026-07-22.
 * This file's own verification made it invisible too: it asserted
 * `status === REVOKED` afterwards, which the function wrote unconditionally, so
 * the check could never fail.
 *
 * `lib/plaid/disconnect.ts` now records the provider-cleanup question
 * separately from the product status, as a pair of AuditLog markers. So this
 * script sweeps TWO populations:
 *
 *   A. status ACTIVE with no live linked account   (the original orphan)
 *   B. any item whose most recent revocation marker is UNCONFIRMED
 *      (the removal was attempted and NOT confirmed upstream — cleanup owed,
 *      whatever the status column says)
 *
 * Both are handled by the same idempotent call, and B's completion is verified
 * by the marker flipping to CONFIRMED rather than by re-reading a status the
 * call sets regardless.
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
 *   npm run plaid:cleanup-orphans -- [--verbose]
 *   npm run plaid:cleanup-orphans -- --apply [--verbose]
 *
 *   NOTE: run via the npm script. This file reaches lib/plaid/client.ts, which
 *   imports "server-only" — a Next-internal alias that is NOT an installed npm
 *   package, so bare `npx tsx` dies at module load with MODULE_NOT_FOUND. The
 *   npm script wires in the same preload the test runner uses
 *   (scripts/lib/server-only-preload.cjs). Behavior is otherwise unchanged.
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
import { redactedErrorForLog } from "@/lib/plaid/errors";
import { AuditAction } from "@/lib/audit-actions";

const REVOCATION_MARKERS = [
  AuditAction.PLAID_ITEM_REVOCATION_UNCONFIRMED,
  AuditAction.PLAID_ITEM_REVOCATION_CONFIRMED,
] as const;

/**
 * Every PlaidItem whose MOST RECENT revocation marker is UNCONFIRMED — i.e.
 * provider cleanup is still owed, regardless of the status column.
 *
 * ⚠️ FOLDED IN JS RATHER THAN QUERIED BY JSON PATH, DELIBERATELY. The marker
 * names its item in `metadata.plaidItemId`, and a `metadata: { path: [...] }`
 * filter would work on Postgres — but it would also have to express
 * "newest row per item wins", which is a window function Prisma cannot write.
 * Reading both marker kinds in creation order and keeping the last one per item
 * is exact, needs no raw SQL, and the population is tiny: these rows are only
 * written when an orphaned item is revoked, which is rare by construction.
 * Ascending order is load-bearing — the LAST write per item is the verdict.
 */
async function itemsOwedProviderCleanup(): Promise<Set<string>> {
  const rows = await db.auditLog.findMany({
    where:   { action: { in: [...REVOCATION_MARKERS] } },
    orderBy: { createdAt: "asc" },
    select:  { action: true, metadata: true },
  });
  const latest = new Map<string, string>();
  for (const r of rows) {
    const id = (r.metadata as { plaidItemId?: unknown } | null)?.plaidItemId;
    if (typeof id === "string") latest.set(id, r.action);
  }
  return new Set(
    [...latest.entries()]
      .filter(([, action]) => action === AuditAction.PLAID_ITEM_REVOCATION_UNCONFIRMED)
      .map(([id]) => id),
  );
}

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
  // Pass A: revoked locally but the provider removal was not confirmed.
  let unconfirmedCount = 0;
  // Pass B: items discovered ONLY by their marker (status already REVOKED).
  let unconfirmedFound = 0;
  let confirmedOnRetry = 0;
  /** Items pass A already handled, so pass B does not process them twice. */
  const handledInPassA = new Set<string>();
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
    handledInPassA.add(item.id);
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

      // ⚠️ THE VERIFICATION IS THE MARKER, NOT THE STATUS. This used to assert
      // `status === REVOKED`, which disconnectPlaidItemIfOrphaned writes
      // unconditionally — so the check could never fail and reported success
      // for a removal Plaid had refused. What has to be true is that the
      // provider cleanup was CONFIRMED.
      const stillOwed = await itemsOwedProviderCleanup();
      const after = await db.plaidItem.findUnique({ where: { id: item.id }, select: { status: true } });
      if (after?.status === PlaidItemStatus.REVOKED && !stillOwed.has(item.id)) {
        revokedCount++;
        vlog(`    -> revoked, provider removal CONFIRMED.`);
      } else if (after?.status === PlaidItemStatus.REVOKED) {
        unconfirmedCount++;
        console.warn(
          `    -> REVOKED locally but provider removal NOT CONFIRMED. The item is recorded as owing cleanup ` +
          `and this script will find it again; re-run after investigating the logged Plaid error.`,
        );
      } else {
        console.warn(`    -> WARNING: expected status REVOKED after cleanup, got ${after?.status}. Investigate before re-running.`);
      }
    }
  }

  // ── PASS B — revocations that were attempted and never confirmed ──────────
  // Items here may be REVOKED already, so pass A's `status: ACTIVE` sweep
  // cannot see them. This is the population the old query lost.
  const owed = await itemsOwedProviderCleanup();
  const owedNotAlreadySeen = [...owed].filter((id) => !handledInPassA.has(id));
  console.log(
    `\n${owed.size} item(s) owe provider cleanup by marker; ${owedNotAlreadySeen.length} not already swept above.`,
  );
  for (const itemId of owedNotAlreadySeen) {
    const row = await db.plaidItem.findUnique({
      where: { id: itemId }, select: { id: true, institutionName: true, userId: true, status: true },
    });
    if (!row) {
      // The marker outlives the item by design — AuditLog is not cascaded away
      // for forensics. Nothing to clean up, and nothing is wrong.
      vlog(`  [GONE] PlaidItem ${itemId} no longer exists; marker retained for forensics.`);
      continue;
    }
    console.log(`  [UNCONFIRMED] PlaidItem ${row.id} (${row.institutionName}, userId=${row.userId}, status=${row.status}) — provider removal never confirmed.`);
    unconfirmedFound++;
    if (APPLY) {
      await disconnectPlaidItemIfOrphaned(row.id);
      const stillOwed = await itemsOwedProviderCleanup();
      if (!stillOwed.has(row.id)) {
        confirmedOnRetry++;
        vlog(`    -> provider removal CONFIRMED on retry.`);
      } else {
        console.warn(`    -> still unconfirmed; left eligible for the next run.`);
      }
    }
  }

  console.log("\n──────────────────────────────────────────────────────────");
  console.log(`ACTIVE PlaidItems scanned:        ${activeItems.length}`);
  console.log(`Orphaned (0 active linked accts): ${orphanedCount}`);
  console.log(`Stray live connections found:     ${totalStrayConnections}`);
  console.log(`Owed cleanup by marker (pass B):  ${unconfirmedFound}`);
  if (APPLY) {
    console.log(`Connections closed:               ${totalStrayConnections}`);
    // RENAMED, because the old label was a lie: it counted local status writes,
    // which happen whatever Plaid answered. These two count CONFIRMATIONS.
    console.log(`Provider removals CONFIRMED (A):  ${revokedCount}`);
    console.log(`Still UNCONFIRMED after pass A:   ${unconfirmedCount}`);
    console.log(`Confirmed on retry (pass B):      ${confirmedOnRetry}`);
    console.log(`Still owed after this run:        ${(await itemsOwedProviderCleanup()).size}`);
  }
  console.log("──────────────────────────────────────────────────────────");

  const nothingToDo = orphanedCount === 0 && unconfirmedFound === 0;
  if (!APPLY && !nothingToDo) {
    console.log("\nDry run only — no rows were written, no Plaid calls made. Re-run with --apply to clean these up for real.");
  }
  if (nothingToDo) {
    console.log("\nNo orphaned PlaidItems and no unconfirmed revocations — nothing to do.");
  }
}

main()
  .catch((e) => {
    console.error("❌  Cleanup failed to run:", redactedErrorForLog(e));
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
