/**
 * scripts/backfill-provider-account-identity.ts
 *
 * D2 Step 1C-A — backfill ProviderAccountIdentity for PLAID accounts.
 * D2 Step 2 — extended to back-fill WALLET accounts too, now that D2 Step 1D
 * has corrected ProviderAccountIdentity's unique constraint to
 * (provider, externalAccountId, financialAccountId). See
 * docs/initiatives/d2/D2_STEP1D_PROVIDER_ACCOUNT_IDENTITY_MULTI_ACCOUNT_CORRECTION.md.
 * Design reference: docs/initiatives/d2/D2_STEP1C_PROVIDER_ACCOUNT_IDENTITY_BACKFILL_INVESTIGATION.md
 * (§B eligibility matrix, §C recommended backfill rules, §F smallest safe slice).
 *
 * Scope:
 *   - PLAID + WALLET. MANUAL has no external identifier at all and is never
 *     backfilled (§C item 2) — structurally exempt, not deferred.
 *   - Eligible accounts: FinancialAccount.deletedAt IS NULL AND
 *     (plaidAccountId IS NOT NULL OR walletAddress IS NOT NULL), each
 *     provider backfilled independently. Archived accounts are never
 *     included — see investigation report §C item 1 (stale values from
 *     pre-reissue/pre-edit history would create semantically-misleading
 *     rows).
 *   - WALLET has no collision exclusion set, unlike the original PLAID-only
 *     design this script shipped with. Under the corrected D2 Step 1D model,
 *     multiple FinancialAccounts legitimately sharing one walletAddress is
 *     the expected, intended state — not a risk to filter out. Every
 *     eligible active WALLET account gets backfilled, full stop.
 *   - Writes ONLY to ProviderAccountIdentity. Never touches FinancialAccount,
 *     Connection, AccountConnection, or any other table.
 *   - connectionId is always null — backfilling PlaidItem -> Connection is
 *     explicitly out of scope (carried over from docs/architecture/D2_PROVIDER_CONNECTION_ARCHITECTURE.md
 *     §10 Phase 2).
 *   - ProviderAccountIdentity is not yet read by any application code for
 *     WALLET (PLAID's read cutover shipped in Step 3; WALLET's hasn't
 *     started) — running this script for WALLET cannot change anything a
 *     user sees yet.
 *   - Idempotent, but the dedup key differs by provider since D2 Step 1D:
 *     PLAID's pre-run dedup is still keyed by externalAccountId alone — safe
 *     because FinancialAccount.plaidAccountId is itself globally @unique, so
 *     no two eligible PLAID accounts can ever share one. WALLET's pre-run
 *     dedup is keyed by financialAccountId instead — checking "has this
 *     externalAccountId already been backfilled" would wrongly skip a
 *     second, different account that legitimately shares an address with an
 *     already-backfilled one. createMany({ skipDuplicates: true }) remains a
 *     defensive backstop against both of ProviderAccountIdentity's unique
 *     constraints either way.
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
 * Rollback (see investigation report §E): the table is additive. For PLAID
 * alone nothing reads it yet either way, so a full wipe and clean re-run is
 * always safe —
 *   DELETE FROM "ProviderAccountIdentity";
 * — or scope a rollback to one provider: DELETE ... WHERE provider = 'WALLET';
 * No migration or schema reversion needed either way.
 */

import { PrismaClient, ProviderType, type Prisma } from "@prisma/client";

const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");

function vlog(...args: unknown[]) {
  if (VERBOSE) console.log(...args);
}

async function main() {
  console.log(`\n${DRY_RUN ? "[DRY RUN] " : ""}D2 Step 1C-A/Step 2 — ProviderAccountIdentity backfill (PLAID + WALLET)`);
  console.log(`Mode: ${DRY_RUN ? "dry-run (no writes)" : "LIVE (will write to ProviderAccountIdentity)"}\n`);

  const candidates: Prisma.ProviderAccountIdentityCreateManyInput[] = [];

  // ── PLAID ────────────────────────────────────────────────────────────────
  // Snapshot existing PLAID identities once up front. Used both to make the
  // run idempotent (skip externalAccountIds that already have a row) and to
  // give dry-run accurate "would insert" counts without writing anything.
  // Keyed by externalAccountId alone — safe for PLAID specifically because
  // FinancialAccount.plaidAccountId is itself globally @unique, so no two
  // eligible accounts in a single run can ever produce colliding candidates.
  const existingPlaidIdentities = await prisma.providerAccountIdentity.findMany({
    where: { provider: ProviderType.PLAID },
    select: { externalAccountId: true },
  });
  const plaidAlreadyBackfilled = new Set(existingPlaidIdentities.map((i) => i.externalAccountId));

  const plaidAccounts = await prisma.financialAccount.findMany({
    where: { deletedAt: null, plaidAccountId: { not: null } },
    select: { id: true, plaidAccountId: true },
  });

  let plaidAlreadyPresent = 0;

  for (const account of plaidAccounts) {
    // Guaranteed non-null by the where clause, but plaidAccountId's type is
    // `string | null` until narrowed.
    const plaidAccountId = account.plaidAccountId;
    if (!plaidAccountId) continue;

    if (plaidAlreadyBackfilled.has(plaidAccountId)) {
      plaidAlreadyPresent++;
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

  // ── WALLET (D2 Step 2) ───────────────────────────────────────────────────
  // Dedup keyed by financialAccountId, NOT externalAccountId — unlike PLAID,
  // walletAddress is not globally unique under the D2 Step 1D corrected
  // model: multiple FinancialAccounts may legitimately share one address.
  // Checking "has this externalAccountId been backfilled" would wrongly
  // skip a second, different account sharing an already-backfilled address.
  const existingWalletIdentities = await prisma.providerAccountIdentity.findMany({
    where: { provider: ProviderType.WALLET },
    select: { financialAccountId: true },
  });
  const walletAlreadyBackfilled = new Set(existingWalletIdentities.map((i) => i.financialAccountId));

  const walletAccounts = await prisma.financialAccount.findMany({
    where: { deletedAt: null, walletAddress: { not: null } },
    select: { id: true, walletAddress: true },
  });

  let walletAlreadyPresent = 0;

  for (const account of walletAccounts) {
    const walletAddress = account.walletAddress;
    if (!walletAddress) continue;

    if (walletAlreadyBackfilled.has(account.id)) {
      walletAlreadyPresent++;
      vlog(`  [SKIP] ${account.id} — ProviderAccountIdentity already exists for this account (re-run)`);
      continue;
    }

    // No collision exclusion set: another account already holding this same
    // walletAddress (if any) is expected and fine — it gets its own row.
    vlog(`  [WALLET] ${account.id} -> externalAccountId ${walletAddress}`);
    candidates.push({
      financialAccountId: account.id,
      connectionId: null,
      provider: ProviderType.WALLET,
      externalAccountId: walletAddress,
    });
  }

  // ── Write (skipped entirely in dry-run mode) ────────────────────────────
  let inserted = 0;

  if (!DRY_RUN && candidates.length > 0) {
    const res = await prisma.providerAccountIdentity.createMany({ data: candidates, skipDuplicates: true });
    inserted = res.count;
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const plaidCandidates = candidates.filter((c) => c.provider === ProviderType.PLAID);
  const walletCandidates = candidates.filter((c) => c.provider === ProviderType.WALLET);

  console.log("──────────────────────────────────────────────────────────");
  console.log(`PLAID — eligible accounts scanned (deletedAt IS NULL, plaidAccountId IS NOT NULL): ${plaidAccounts.length}`);
  console.log(`PLAID — already backfilled (re-run):                                              ${plaidAlreadyPresent}`);
  console.log(`PLAID — candidates ${DRY_RUN ? "(would insert)" : "inserted"}:` + " ".repeat(DRY_RUN ? 24 : 32) + `${plaidCandidates.length}`);
  console.log("");
  console.log(`WALLET — eligible accounts scanned (deletedAt IS NULL, walletAddress IS NOT NULL): ${walletAccounts.length}`);
  console.log(`WALLET — already backfilled (re-run):                                              ${walletAlreadyPresent}`);
  console.log(`WALLET — candidates ${DRY_RUN ? "(would insert)" : "inserted"}:` + " ".repeat(DRY_RUN ? 23 : 31) + `${walletCandidates.length}`);
  console.log("");
  console.log(`TOTAL candidates ${DRY_RUN ? "(would insert)" : "inserted"}:` + " ".repeat(DRY_RUN ? 27 : 35) + `${candidates.length}${DRY_RUN ? "" : ` (createMany count: ${inserted})`}`);
  console.log("──────────────────────────────────────────────────────────");

  if (VERBOSE && candidates.length > 0) {
    console.log("\nCandidate detail:");
    for (const c of candidates) {
      console.log(`  - [${c.provider}] financialAccountId=${c.financialAccountId}  externalAccountId=${c.externalAccountId}`);
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
