/**
 * scripts/verify-provider-account-identity-backfill.ts
 *
 * D2 Step 1C-B — companion validation script for
 * backfill-provider-account-identity.ts. Read-only: makes zero writes to any
 * table. Modeled directly on scripts/verify-space-account-link-backfill.ts.
 * Design reference: docs/initiatives/d2/D2_STEP1C_PROVIDER_ACCOUNT_IDENTITY_BACKFILL_INVESTIGATION.md §D.
 *
 * Scope, deliberately narrow: PLAID only. WALLET accounts are reported as a
 * known exception (informational), never verified for correctness — WALLET
 * backfill hasn't happened yet (walletAddress collision pre-check is still
 * pending per the investigation report §C).
 *
 * Checks (real failures, exit code 1):
 *   1. Every eligible active PLAID FinancialAccount (deletedAt IS NULL,
 *      plaidAccountId IS NOT NULL) has exactly one ProviderAccountIdentity
 *      row with provider=PLAID, externalAccountId=plaidAccountId. Missing
 *      rows are reported here.
 *   2. No FinancialAccount has more than one PLAID ProviderAccountIdentity
 *      row.
 *   3. Provider mismatch — every PLAID ProviderAccountIdentity's
 *      externalAccountId must equal its linked FinancialAccount's current
 *      plaidAccountId. (Can drift after this script first runs: nothing
 *      dual-writes ProviderAccountIdentity yet, so a later reconnect/
 *      fingerprint-merge that changes plaidAccountId — see
 *      lib/accounts/reconcile.ts — will not be reflected until backfill
 *      re-runs. Expected, not a bug; see investigation report §D caveat.)
 *   4. Duplicate (provider, externalAccountId) rows across ALL
 *      ProviderAccountIdentity rows, any provider — defensive only. The
 *      @@unique([provider, externalAccountId]) constraint (D2 Step 1B)
 *      should make this impossible; checked directly rather than trusted
 *      blindly.
 *
 * Informational only (never affects exit code):
 *   5. Orphaned PLAID identities — rows pointing at a FinancialAccount that
 *      is now soft-deleted (deletedAt IS NOT NULL). Hard-deletes can't
 *      produce this case (onDelete: Cascade removes the identity row
 *      automatically); soft-deletes can, same treatment as D3's orphan check.
 *   6. Known exceptions — accounts with no plaidAccountId (split into
 *      WALLET-for-now vs. MANUAL/other), and archived accounts of any kind.
 *      Counted, never treated as failures.
 *
 * Usage:
 *   npx tsx scripts/verify-provider-account-identity-backfill.ts [--verbose]
 *
 * Exit code: 1 if checks 1-4 find any real failure, 0 otherwise. Checks 5-6
 * never affect the exit code.
 */

import { PrismaClient, ProviderType } from "@prisma/client";

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
  console.log("\nD2 Step 1C-B — ProviderAccountIdentity backfill verification (PLAID)\n");

  let failed = false;

  // ── Load source data once ───────────────────────────────────────────────
  const accounts = await prisma.financialAccount.findMany({
    select: { id: true, plaidAccountId: true, walletAddress: true, deletedAt: true },
  });
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const activeAccounts = accounts.filter((a) => a.deletedAt === null);
  const archivedAccounts = accounts.filter((a) => a.deletedAt !== null);
  const eligibleAccounts = activeAccounts.filter((a) => a.plaidAccountId !== null);

  const plaidIdentities = await prisma.providerAccountIdentity.findMany({
    where: { provider: ProviderType.PLAID },
    select: { id: true, financialAccountId: true, externalAccountId: true },
  });

  const identitiesByAccount = new Map<string, typeof plaidIdentities>();
  for (const ident of plaidIdentities) {
    const arr = identitiesByAccount.get(ident.financialAccountId) ?? [];
    arr.push(ident);
    identitiesByAccount.set(ident.financialAccountId, arr);
  }

  // ── Checks 1 — missing ────────────────────────────────────────────────
  const missing: string[] = [];
  // ── Check 2 — duplicate per account ──────────────────────────────────
  const duplicatePerAccount: string[] = [];
  // ── Check 3 — provider mismatch ──────────────────────────────────────
  const mismatch: string[] = [];

  for (const acct of eligibleAccounts) {
    const idents = identitiesByAccount.get(acct.id) ?? [];

    if (idents.length === 0) {
      missing.push(acct.id);
      continue;
    }
    if (idents.length > 1) {
      duplicatePerAccount.push(acct.id);
    }
    for (const ident of idents) {
      if (ident.externalAccountId !== acct.plaidAccountId) {
        mismatch.push(
          `account=${acct.id} identity=${ident.id} identity.externalAccountId=${ident.externalAccountId} account.plaidAccountId=${acct.plaidAccountId}`
        );
      }
    }
  }

  console.log("CHECK 1 — every eligible active PLAID FinancialAccount has exactly one ProviderAccountIdentity row");
  console.log(`  Eligible PLAID accounts (deletedAt IS NULL, plaidAccountId IS NOT NULL): ${eligibleAccounts.length}`);
  printIds("  Missing PLAID identity (real failure)", missing);
  console.log(missing.length === 0 ? "  PASS\n" : "  FAIL\n");
  if (missing.length > 0) failed = true;

  console.log("CHECK 2 — no FinancialAccount has more than one PLAID ProviderAccountIdentity row");
  printIds("  Duplicate PLAID identity per account", duplicatePerAccount);
  console.log(duplicatePerAccount.length === 0 ? "  PASS\n" : "  FAIL\n");
  if (duplicatePerAccount.length > 0) failed = true;

  console.log("CHECK 3 — provider mismatch (identity.externalAccountId must equal account.plaidAccountId)");
  printIds("  Mismatched rows", mismatch);
  console.log(mismatch.length === 0 ? "  PASS\n" : "  FAIL\n");
  if (mismatch.length > 0) failed = true;

  // ── Check 4 — global (provider, externalAccountId) uniqueness, defensive ─
  const allIdentities = await prisma.providerAccountIdentity.findMany({
    select: { id: true, provider: true, externalAccountId: true },
  });
  const keyGroups = new Map<string, string[]>();
  for (const ident of allIdentities) {
    const key = `${ident.provider}::${ident.externalAccountId}`;
    const arr = keyGroups.get(key) ?? [];
    arr.push(ident.id);
    keyGroups.set(key, arr);
  }
  const uniquenessViolations: string[] = [];
  for (const [key, ids] of keyGroups) {
    if (ids.length > 1) uniquenessViolations.push(`${key} -> [${ids.join(", ")}]`);
  }

  console.log("CHECK 4 — duplicate (provider, externalAccountId) rows across all providers (defensive — DB constraint should make this impossible)");
  printIds("  Uniqueness violations", uniquenessViolations);
  console.log(uniquenessViolations.length === 0 ? "  PASS\n" : "  FAIL\n");
  if (uniquenessViolations.length > 0) failed = true;

  // ── Check 5 — orphaned identities (informational only) ──────────────────
  const orphaned = plaidIdentities
    .filter((i) => {
      const acct = accountById.get(i.financialAccountId);
      return acct ? acct.deletedAt !== null : true; // also flag if the FK target is missing entirely (should never happen — onDelete: Cascade)
    })
    .map((i) => i.id);

  console.log("CHECK 5 — PLAID identities pointing at a since-soft-deleted account (informational only, never fails)");
  printIds("  Orphaned identity (identity.id)", orphaned);
  console.log("  INFO\n");

  // ── Check 6 — known exceptions (informational only) ─────────────────────
  const activeNoPlaidId = activeAccounts.filter((a) => a.plaidAccountId === null);
  const walletForNow = activeNoPlaidId.filter((a) => a.walletAddress !== null);
  const manualOrOther = activeNoPlaidId.filter((a) => a.walletAddress === null);

  console.log("CHECK 6 — known exceptions (informational only, never fails)");
  console.log(`  Active accounts with no plaidAccountId:           ${activeNoPlaidId.length}`);
  console.log(`    of which WALLET (walletAddress set, for now):   ${walletForNow.length}`);
  console.log(`    of which MANUAL/other (no walletAddress):       ${manualOrOther.length}`);
  console.log(`  Archived accounts (deletedAt IS NOT NULL, any provider): ${archivedAccounts.length}`);
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
