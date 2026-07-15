/**
 * scripts/diagnose-invalid-plaid-tokens.ts
 *
 * SEC-1 / KD-6 — READ-ONLY diagnostic for PlaidItem rows whose encryptedToken
 * is neither v1 nor v2 ("invalid" per detectCiphertextVersion). Follow-up to
 * scripts/audit-ciphertext-versions.ts, which counted 9 such rows.
 *
 * Answers, per affected row, WITHOUT ever revealing the secret:
 *   - which PlaidItem (id, externalItemId, institutionName, status, createdAt)
 *   - is it the known demo/seed placeholder? (boolean compare to the non-secret
 *     literal seeded by prisma/seed.ts — the value itself is never printed)
 *   - token SHAPE only: length, colon-segment count, and coarse prefix flags
 *     that distinguish a plaintext Plaid token from random junk
 *   - related rows: AccountConnections (active/total) and the FinancialAccounts
 *     they point to (active/total)
 *   - owning user (id + email) so demo/test accounts are identifiable
 *
 * HARD GUARANTEES (matches the task's rules):
 *   - No writes, no deletes, no updates, no re-encryption.
 *   - Never decrypts a token and never prints a raw encryptedToken value.
 *     Only derived, non-reversible descriptors (length, segment count, boolean
 *     flags) are printed.
 *
 * Run:
 *   npx tsx scripts/diagnose-invalid-plaid-tokens.ts
 *
 * Exit 0 = diagnostic ran; 1 = it could not run (e.g. DB unreachable).
 */

import { PrismaClient } from "@prisma/client";
import { detectCiphertextVersion } from "@/lib/plaid/encryption";

const db = new PrismaClient({ log: ["error", "warn"] });

const PAGE_SIZE = 1000;

// The exact, non-secret placeholder that prisma/seed.ts writes for demo items.
// Comparing against it lets us confirm "these are seed rows" while printing only
// a boolean, never the stored value.
const SEED_PLACEHOLDER = "[demo-placeholder-not-a-real-token]";

/** Non-reversible shape descriptors — safe to print; reveal no secret. */
function describeShape(value: string) {
  return {
    length: value.length,
    segments: value.split(":").length,
    // Coarse signal only: a leaked *plaintext* Plaid token begins "access-".
    // This is a prefix flag, not the value.
    looksLikePlaintextPlaidToken: /^access-(sandbox|development|production)-/.test(value),
    isKnownSeedPlaceholder: value === SEED_PLACEHOLDER,
    isPrintableAscii: /^[\x20-\x7e]*$/.test(value),
  };
}

async function main(): Promise<void> {
  console.log("");
  console.log("SEC-1 / KD-6 — invalid PlaidItem.encryptedToken diagnostic (READ-ONLY)");
  console.log("=".repeat(74));

  // Page through PlaidItems, keep only those classified "invalid".
  const invalid: Array<{
    id: string;
    externalItemId: string;
    institutionName: string;
    institutionId: string;
    status: string;
    createdAt: Date;
    userId: string;
    token: string;
  }> = [];

  let afterId: string | null = null;
  for (;;) {
    const rows: Array<{
      id: string;
      externalItemId: string;
      institutionName: string;
      institutionId: string;
      status: string;
      createdAt: Date;
      userId: string;
      encryptedToken: string;
    }> = await db.plaidItem.findMany({
      where: afterId ? { id: { gt: afterId } } : undefined,
      select: {
        id: true,
        externalItemId: true,
        institutionName: true,
        institutionId: true,
        status: true,
        createdAt: true,
        userId: true,
        encryptedToken: true,
      },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
    });
    if (rows.length === 0) break;
    for (const r of rows) {
      if (r.encryptedToken && detectCiphertextVersion(r.encryptedToken) === "invalid") {
        invalid.push({ ...r, token: r.encryptedToken });
      }
    }
    afterId = rows[rows.length - 1].id;
    if (rows.length < PAGE_SIZE) break;
  }

  console.log(`Invalid-token PlaidItems found: ${invalid.length}`);
  console.log("");

  let allAreSeedPlaceholders = true;
  let anyLooksLikePlaintextToken = false;

  for (const item of invalid) {
    const shape = describeShape(item.token);
    if (!shape.isKnownSeedPlaceholder) allAreSeedPlaceholders = false;
    if (shape.looksLikePlaintextPlaidToken) anyLooksLikePlaintextToken = true;

    // Owning user (email only — identifies demo/test accounts).
    const user = await db.user.findUnique({
      where: { id: item.userId },
      select: { email: true },
    });

    // Related AccountConnections (PlaidItem.connections) + their FinancialAccounts.
    const conns = await db.accountConnection.findMany({
      where: { plaidItemDbId: item.id },
      select: {
        deletedAt: true,
        financialAccount: { select: { id: true, deletedAt: true } },
      },
    });
    const connTotal = conns.length;
    const connActive = conns.filter((c) => c.deletedAt === null).length;
    const faIds = new Set(conns.map((c) => c.financialAccount?.id).filter(Boolean));
    const faActive = new Set(
      conns
        .filter((c) => c.financialAccount && c.financialAccount.deletedAt === null)
        .map((c) => c.financialAccount!.id),
    );

    console.log("-".repeat(74));
    console.log(`PlaidItem      ${item.id}`);
    console.log(`  user         ${item.userId}  <${user?.email ?? "?"}>`);
    console.log(`  externalItem ${item.externalItemId}`);
    console.log(`  institution  ${item.institutionName} (${item.institutionId})`);
    console.log(`  status       ${item.status}`);
    console.log(`  createdAt    ${item.createdAt.toISOString()}`);
    console.log(
      `  token shape  len=${shape.length} segments=${shape.segments} ` +
        `seedPlaceholder=${shape.isKnownSeedPlaceholder} ` +
        `plaintextPlaidToken=${shape.looksLikePlaintextPlaidToken} ` +
        `printableAscii=${shape.isPrintableAscii}`,
    );
    console.log(
      `  relations    AccountConnections=${connActive} active / ${connTotal} total; ` +
        `FinancialAccounts=${faActive.size} active / ${faIds.size} total`,
    );
  }

  console.log("-".repeat(74));
  console.log("");
  console.log("Summary");
  console.log(`  invalid rows:            ${invalid.length}`);
  console.log(`  all seed placeholders:   ${allAreSeedPlaceholders}`);
  console.log(`  any plaintext Plaid tok: ${anyLooksLikePlaintextToken}`);
  if (allAreSeedPlaceholders) {
    console.log(
      "  => All invalid rows are the prisma/seed.ts demo placeholder. Not real\n" +
        "     credentials, nothing to re-encrypt. KD-6 (v1->v2) is unaffected.",
    );
  } else if (anyLooksLikePlaintextToken) {
    console.log(
      "  => WARNING: at least one value looks like a PLAINTEXT Plaid access token.\n" +
        "     Treat as a real-secret-at-rest incident; do NOT print/log the value.",
    );
  } else {
    console.log(
      "  => Mixed/unknown invalid values — inspect the per-row shapes above before\n" +
        "     deciding on cleanup vs. repair. Still no re-encryption implied.",
    );
  }
  console.log("");
  console.log("READ-ONLY diagnostic — no tokens decrypted, no values printed, no rows modified.");
}

main()
  .then(async () => {
    await db.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("Diagnostic failed to complete:", err);
    await db.$disconnect();
    process.exit(1);
  });
