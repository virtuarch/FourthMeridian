/**
 * scripts/backfill-provider-account-identity.ts
 *
 * D2 Step 1C-A — backfill ProviderAccountIdentity for PLAID accounts only.
 * Design reference: docs/D2_STEP1C_PROVIDER_ACCOUNT_IDENTITY_BACKFILL_INVESTIGATION.md
 * (§B eligibility matrix, §C recommended backfill rules, §F smallest safe slice).
 *
 * Scope, deliberately narrow:
 *   - PLAID only. WALLET is explicitly deferred — walletAddress has no DB-level
 *     uniqueness and needs the collision pre-check described in the
 *     investigation report (§C) before it can backfill safely. MANUAL has no
 *     external identifier at all and is never backfilled (§C item 2).
 *   - Eligible accounts: FinancialAccount.deletedAt IS NULL AND
 *     plaidAccountId IS NOT NULL. Archived accounts are never included — see
 *     investigation report §C item 1 (stale plaidAccountId values from
 *     pre-reissue history would create semantically-misleading rows).
 *   - Writes ONLY to ProviderAccountIdentity. Never touches FinancialAccount,
 *     Connection, AccountConnection, or any other table.
 *   - connectionId is always null — backfilling PlaidItem -> Connection is
 *     explicitly out of scope (carried over from docs/D2_PROVIDER_CONNECTION_ARCHITECTURE.md
 *     §10 Phase 2).
 *   - ProviderAccountIdentity is not yet read by any application code
 *     (confirmed zero references in app/, lib/, components/ as of this
 *     script's creation) — running this script cannot change anything a
 *     user sees.
 *   - Idempotent: every insert goes through createMany({ skipDuplicates: true })
 *     against the (provider, externalAccountId) unique constraint
 *     ProviderAccountIdentity already has (added in D2 Step 1B), so re-running
 *     after a partial failure never double-inserts and never throws on rows
 *     that already exist. plaidAccountId is itself globally @unique on
 *     FinancialAccount, so no two eligible accounts in a single run can ever
 *     produce colliding candidates.
 *
 * Usage:
 *   npx tsx scripts/backfill-provider-account-identity.ts --dry-run [--verbose]
 *   npx tsx scripts/backfill-provider-account-identity.ts [--verbose]
 *
 *   --dry-run   Compute and print everything that would be written. Zero
 *               database writes (the script never calls createMany at all
 *               in this mode).
 *   --verbose   Log every account processed, not just the summary.
 *
 * Rollback (see investigation report §E): the table is additive and read by
 * nothing, so rollback is a full data wipe —
 *   DELETE FROM "ProviderAccountIdentity";
 * — followed by a clean re-run. No migration or schema reversion needed.
 */

import { PrismaClient, ProviderType, type Prisma } from "@prisma/client";

const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");

function vlog(...args: unknown[]) {
  if (VERBOSE) console.log(...args);
}

async function main() {
  console.log(`\n${DRY_RUN ? "[DRY RUN] " : ""}D2 Step 1C-A — ProviderAccountIdentity backfill (PLAID only)`);
  console.log(`Mode: ${DRY_RUN ? "dry-run (no writes)" : "LIVE (will write to ProviderAccountIdentity)"}\n`);

  // ── Snapshot existing PLAID identities once up front ────────────────────
  // Used both to make the run idempotent (skip externalAccountIds that
  // already have a row) and to give dry-run accurate "would insert" counts
  // without writing anything.
  const existingIdentities = await prisma.providerAccountIdentity.findMany({
    where: { provider: ProviderType.PLAID },
    select: { externalAccountId: true },
  });
  const alreadyBackfilled = new Set(existingIdentities.map((i) => i.externalAccountId));

  // ── Eligible accounts: active + plaidAccountId set ──────────────────────
  const accounts = await prisma.financialAccount.findMany({
    where: { deletedAt: null, plaidAccountId: { not: null } },
    select: { id: true, plaidAccountId: true },
  });

  const candidates: Prisma.ProviderAccountIdentityCreateManyInput[] = [];
  let alreadyPresent = 0;

  for (const account of accounts) {
    // Guaranteed non-null by the where clause, but plaidAccountId's type is
    // `string | null` until narrowed.
    const plaidAccountId = account.plaidAccountId;
    if (!plaidAccountId) continue;

    if (alreadyBackfilled.has(plaidAccountId)) {
      alreadyPresent++;
      vlog(`  [SKIP] ${account.id} — ProviderAccountIdentity already exists for plaidAccountId ${plaidAccountId} (re-run)`);
      continue;
    }

    vlog(`  [PLAID] ${account.id} -> externalAccountId ${plaidAccountId}`);
    candidates.push({
      financialAccountId: account.id,
      connectionId: null,
      provider: ProviderType.PLAID,
      externalAccountId: plaidAccountId,
    });
  }

  // ── Write (skipped entirely in dry-run mode) ────────────────────────────
  let inserted = 0;

  if (!DRY_RUN && candidates.length > 0) {
    const res = await prisma.providerAccountIdentity.createMany({ data: candidates, skipDuplicates: true });
    inserted = res.count;
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("──────────────────────────────────────────────────────────");
  console.log(`Eligible accounts scanned (deletedAt IS NULL, plaidAccountId IS NOT NULL): ${accounts.length}`);
  console.log(`Already backfilled (re-run):                                              ${alreadyPresent}`);
  console.log(`PLAID candidates ${DRY_RUN ? "(would insert)" : "inserted"}:` + " ".repeat(DRY_RUN ? 30 : 38) + `${candidates.length}${DRY_RUN ? "" : ` (createMany count: ${inserted})`}`);
  console.log("──────────────────────────────────────────────────────────");

  if (VERBOSE && candidates.length > 0) {
    console.log("\nCandidate detail:");
    for (const c of candidates) {
      console.log(`  - financialAccountId=${c.financialAccountId}  externalAccountId=${c.externalAccountId}`);
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
