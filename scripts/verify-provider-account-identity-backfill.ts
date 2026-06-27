/**
 * scripts/verify-provider-account-identity-backfill.ts
 *
 * D2 Step 1C-B — companion validation script for
 * backfill-provider-account-identity.ts. Read-only: makes zero writes to any
 * table. Modeled directly on scripts/verify-space-account-link-backfill.ts.
 * Design reference: docs/initiatives/d2/D2_STEP1C_PROVIDER_ACCOUNT_IDENTITY_BACKFILL_INVESTIGATION.md §D.
 *
 * D2 Step 2 — extended to verify WALLET alongside PLAID, now that D2 Step 1D
 * corrected ProviderAccountIdentity's unique constraint to (provider,
 * externalAccountId, financialAccountId). See
 * docs/initiatives/d2/D2_STEP1D_PROVIDER_ACCOUNT_IDENTITY_MULTI_ACCOUNT_CORRECTION.md.
 * No exclusion bucket for WALLET: every eligible active WALLET account is
 * checked exactly like PLAID is.
 *
 * Checks (real failures, exit code 1):
 *   1. Every eligible active FinancialAccount (deletedAt IS NULL, and
 *      plaidAccountId IS NOT NULL for PLAID / walletAddress IS NOT NULL for
 *      WALLET) has exactly one ProviderAccountIdentity row for that
 *      provider. Missing rows are reported here. Run once per provider.
 *   2. No FinancialAccount has more than one ProviderAccountIdentity row for
 *      a given provider. (A account legitimately having both a PLAID row
 *      and a WALLET row is fine — this checks per-provider, not total.) Run
 *      once per provider.
 *   3. Provider mismatch — every ProviderAccountIdentity's externalAccountId
 *      must equal its linked FinancialAccount's current plaidAccountId (for
 *      PLAID) or walletAddress (for WALLET). Can drift after this script
 *      first runs if nothing dual-writes on a later change — see
 *      lib/accounts/provider-identity.ts, which is wired into both PLAID's
 *      exchange-token route and WALLET's wallet route as of D2 Step 2 — so
 *      drift here is now a real signal worth investigating, not an expected
 *      gap. Run once per provider.
 *   4. Duplicate (provider, externalAccountId) rows — PLAID only. D2 Step 1D
 *      deliberately narrowed the table's DB-level unique constraint to
 *      (provider, externalAccountId, financialAccountId) specifically so
 *      WALLET can have multiple FinancialAccounts share one address — that
 *      is the corrected model's intended state, not a defect, so this check
 *      no longer applies to WALLET (see Check 7 below for WALLET's
 *      informational equivalent). It still applies to PLAID: PLAID's
 *      real-world uniqueness is independently guaranteed by
 *      FinancialAccount.plaidAccountId's own @unique, so two PLAID identity
 *      rows sharing one externalAccountId (any financialAccountId) would
 *      indicate genuine data corruption.
 *
 * Informational only (never affects exit code):
 *   5. Orphaned identities (any provider) — rows pointing at a
 *      FinancialAccount that is now soft-deleted (deletedAt IS NOT NULL).
 *      Hard-deletes can't produce this case (onDelete: Cascade removes the
 *      identity row automatically); soft-deletes can, same treatment as
 *      D3's orphan check. Generalized beyond PLAID-only in D2 Step 2.
 *   6. Known exceptions — active accounts with no external identifier at
 *      all (MANUAL/CSV/other — no plaidAccountId, no walletAddress; never
 *      backfilled by design), and archived accounts of any kind. Counted,
 *      never treated as failures.
 *   7. WALLET addresses tracked by more than one FinancialAccount. D2 Step
 *      1D's corrected model: a wallet address is a public external fact;
 *      each FinancialAccount's association with it is a private, separate
 *      row. Multiple accounts sharing one address (different owners, or the
 *      same owner's multiple accounts/Spaces) is the expected, intended
 *      state — reported here purely for visibility, never a failure.
 *
 * Usage:
 *   npx tsx scripts/verify-provider-account-identity-backfill.ts [--verbose]
 *
 * Exit code: 1 if checks 1-4 find any real failure, 0 otherwise. Checks 5-7
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

type AccountRow = {
  id: string;
  plaidAccountId: string | null;
  walletAddress: string | null;
  deletedAt: Date | null;
};
type IdentityRow = { id: string; financialAccountId: string; externalAccountId: string };

function groupByAccount(idents: IdentityRow[]): Map<string, IdentityRow[]> {
  const map = new Map<string, IdentityRow[]>();
  for (const ident of idents) {
    const arr = map.get(ident.financialAccountId) ?? [];
    arr.push(ident);
    map.set(ident.financialAccountId, arr);
  }
  return map;
}

/** Checks 1-3 for one provider. Shared logic, called once per provider. */
function checkEligibleAccounts(
  eligibleAccounts: AccountRow[],
  identitiesByAccount: Map<string, IdentityRow[]>,
  getExpectedExternalId: (a: AccountRow) => string | null
) {
  const missing: string[] = [];
  const duplicatePerAccount: string[] = [];
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
    const expected = getExpectedExternalId(acct);
    for (const ident of idents) {
      if (ident.externalAccountId !== expected) {
        mismatch.push(
          `account=${acct.id} identity=${ident.id} identity.externalAccountId=${ident.externalAccountId} expected=${expected}`
        );
      }
    }
  }

  return { missing, duplicatePerAccount, mismatch };
}

async function main() {
  console.log("\nD2 Step 1C-B/Step 2 — ProviderAccountIdentity backfill verification (PLAID + WALLET)\n");

  let failed = false;

  // ── Load source data once ───────────────────────────────────────────────
  const accounts = await prisma.financialAccount.findMany({
    select: { id: true, plaidAccountId: true, walletAddress: true, deletedAt: true },
  });
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const activeAccounts = accounts.filter((a) => a.deletedAt === null);
  const archivedAccounts = accounts.filter((a) => a.deletedAt !== null);
  const eligiblePlaidAccounts = activeAccounts.filter((a) => a.plaidAccountId !== null);
  const eligibleWalletAccounts = activeAccounts.filter((a) => a.walletAddress !== null);

  const plaidIdentities = await prisma.providerAccountIdentity.findMany({
    where: { provider: ProviderType.PLAID },
    select: { id: true, financialAccountId: true, externalAccountId: true },
  });
  const walletIdentities = await prisma.providerAccountIdentity.findMany({
    where: { provider: ProviderType.WALLET },
    select: { id: true, financialAccountId: true, externalAccountId: true },
  });

  const identitiesByAccountPlaid = groupByAccount(plaidIdentities);
  const identitiesByAccountWallet = groupByAccount(walletIdentities);

  // ── Checks 1-3, PLAID ────────────────────────────────────────────────────
  const plaidResult = checkEligibleAccounts(
    eligiblePlaidAccounts,
    identitiesByAccountPlaid,
    (a) => a.plaidAccountId
  );

  console.log("CHECK 1 (PLAID) — every eligible active PLAID FinancialAccount has exactly one ProviderAccountIdentity row");
  console.log(`  Eligible PLAID accounts (deletedAt IS NULL, plaidAccountId IS NOT NULL): ${eligiblePlaidAccounts.length}`);
  printIds("  Missing PLAID identity (real failure)", plaidResult.missing);
  console.log(plaidResult.missing.length === 0 ? "  PASS\n" : "  FAIL\n");
  if (plaidResult.missing.length > 0) failed = true;

  console.log("CHECK 2 (PLAID) — no FinancialAccount has more than one PLAID ProviderAccountIdentity row");
  printIds("  Duplicate PLAID identity per account", plaidResult.duplicatePerAccount);
  console.log(plaidResult.duplicatePerAccount.length === 0 ? "  PASS\n" : "  FAIL\n");
  if (plaidResult.duplicatePerAccount.length > 0) failed = true;

  console.log("CHECK 3 (PLAID) — provider mismatch (identity.externalAccountId must equal account.plaidAccountId)");
  printIds("  Mismatched rows", plaidResult.mismatch);
  console.log(plaidResult.mismatch.length === 0 ? "  PASS\n" : "  FAIL\n");
  if (plaidResult.mismatch.length > 0) failed = true;

  // ── Checks 1-3, WALLET (D2 Step 2) ──────────────────────────────────────
  const walletResult = checkEligibleAccounts(
    eligibleWalletAccounts,
    identitiesByAccountWallet,
    (a) => a.walletAddress
  );

  console.log("CHECK 1 (WALLET) — every eligible active WALLET FinancialAccount has exactly one ProviderAccountIdentity row");
  console.log(`  Eligible WALLET accounts (deletedAt IS NULL, walletAddress IS NOT NULL): ${eligibleWalletAccounts.length}`);
  printIds("  Missing WALLET identity (real failure)", walletResult.missing);
  console.log(walletResult.missing.length === 0 ? "  PASS\n" : "  FAIL\n");
  if (walletResult.missing.length > 0) failed = true;

  console.log("CHECK 2 (WALLET) — no FinancialAccount has more than one WALLET ProviderAccountIdentity row");
  printIds("  Duplicate WALLET identity per account", walletResult.duplicatePerAccount);
  console.log(walletResult.duplicatePerAccount.length === 0 ? "  PASS\n" : "  FAIL\n");
  if (walletResult.duplicatePerAccount.length > 0) failed = true;

  console.log("CHECK 3 (WALLET) — provider mismatch (identity.externalAccountId must equal account.walletAddress)");
  printIds("  Mismatched rows", walletResult.mismatch);
  console.log(walletResult.mismatch.length === 0 ? "  PASS\n" : "  FAIL\n");
  if (walletResult.mismatch.length > 0) failed = true;

  // ── Check 4 — duplicate (provider, externalAccountId) rows, PLAID only ──
  const plaidKeyGroups = new Map<string, string[]>();
  for (const ident of plaidIdentities) {
    const arr = plaidKeyGroups.get(ident.externalAccountId) ?? [];
    arr.push(ident.id);
    plaidKeyGroups.set(ident.externalAccountId, arr);
  }
  const plaidUniquenessViolations: string[] = [];
  for (const [externalAccountId, ids] of plaidKeyGroups) {
    if (ids.length > 1) plaidUniquenessViolations.push(`PLAID::${externalAccountId} -> [${ids.join(", ")}]`);
  }

  console.log("CHECK 4 — duplicate (provider, externalAccountId) rows for PLAID (defensive — plaidAccountId is independently @unique on FinancialAccount, so this should be impossible regardless of the table's own constraint shape). Not applicable to WALLET — see Check 7.");
  printIds("  Uniqueness violations", plaidUniquenessViolations);
  console.log(plaidUniquenessViolations.length === 0 ? "  PASS\n" : "  FAIL\n");
  if (plaidUniquenessViolations.length > 0) failed = true;

  // ── Check 5 — orphaned identities, any provider (informational only) ────
  const orphaned = [...plaidIdentities, ...walletIdentities]
    .filter((i) => {
      const acct = accountById.get(i.financialAccountId);
      return acct ? acct.deletedAt !== null : true; // also flag if the FK target is missing entirely (should never happen — onDelete: Cascade)
    })
    .map((i) => i.id);

  console.log("CHECK 5 — identities (any provider) pointing at a since-soft-deleted account (informational only, never fails)");
  printIds("  Orphaned identity (identity.id)", orphaned);
  console.log("  INFO\n");

  // ── Check 6 — known exceptions (informational only) ─────────────────────
  const noExternalIdentifier = activeAccounts.filter(
    (a) => a.plaidAccountId === null && a.walletAddress === null
  );

  console.log("CHECK 6 — known exceptions (informational only, never fails)");
  console.log(`  Active accounts with no external identifier (MANUAL/other — no plaidAccountId, no walletAddress): ${noExternalIdentifier.length}`);
  console.log(`  Archived accounts (deletedAt IS NOT NULL, any provider):                                          ${archivedAccounts.length}`);
  console.log("  INFO\n");

  // ── Check 7 — WALLET addresses tracked by >1 account (informational) ───
  const walletAddressGroups = new Map<string, string[]>();
  for (const ident of walletIdentities) {
    const arr = walletAddressGroups.get(ident.externalAccountId) ?? [];
    arr.push(ident.financialAccountId);
    walletAddressGroups.set(ident.externalAccountId, arr);
  }
  const sharedWalletAddresses = [...walletAddressGroups.entries()].filter(([, accountIds]) => accountIds.length > 1);

  console.log("CHECK 7 — wallet addresses tracked by more than one FinancialAccount (informational only, never fails — expected and intended under the D2 Step 1D model)");
  console.log(`  Addresses tracked by more than one account: ${sharedWalletAddresses.length}`);
  if (sharedWalletAddresses.length > 0) {
    const shown = VERBOSE ? sharedWalletAddresses : sharedWalletAddresses.slice(0, 10);
    for (const [address, accountIds] of shown) {
      console.log(`    - ${address} -> ${accountIds.length} accounts [${accountIds.join(", ")}]`);
    }
    if (!VERBOSE && sharedWalletAddresses.length > 10) {
      console.log(`    ... and ${sharedWalletAddresses.length - 10} more (re-run with --verbose to see all)`);
    }
  }
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
