/**
 * scripts/verify-seed-emails.ts
 *
 * One-time data fix: mark the four dev seed users' emails as verified.
 *
 * Background:
 *   prisma/seed.ts creates jane@example.com, john@example.com,
 *   alex@example.com, and sysadmin@example.com but never set
 *   emailVerifiedAt (prisma/schema.prisma, the OPS-1 S2b verification
 *   field). The login path blocks unverified accounts (the email-
 *   verification gate at app/api/auth/pre-login/route.ts:65, authoritative
 *   in lib/auth.ts authorize()), so those four accounts are locked out of
 *   sign-in until this field is set. This is a seed-script gap, not
 *   intentional behavior — the root cause is fixed in seed.ts so future
 *   reseeds don't need this script.
 *
 * What it does, deliberately narrow:
 *   - Sets emailVerifiedAt = new Date() for EXACTLY the four seed emails
 *     listed below, matched by explicit email — NOT a blanket
 *     "all users where emailVerifiedAt is null" update. This keeps the fix
 *     safe if real user accounts (legitimately unverified) ever coexist
 *     with seed accounts in the same database.
 *   - Skips any of the four that are already verified (idempotent) and any
 *     that don't exist (e.g. a DB seeded before an account was added).
 *   - Prints every row's email + before/after emailVerifiedAt so the fix is
 *     visible, not silent. Touches no other column and no other table.
 *
 * Run:
 *   npx tsx scripts/verify-seed-emails.ts
 *
 * Idempotent: a second run finds all four already verified and writes nothing.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient({ log: ["error", "warn"] });

const SEED_EMAILS = [
  "jane@example.com",
  "john@example.com",
  "alex@example.com",
  "sysadmin@example.com",
] as const;

async function main() {
  console.log("Verifying seed-user emails (explicit-email scope)…\n");

  let updated = 0;
  let alreadyVerified = 0;
  let missing = 0;

  for (const email of SEED_EMAILS) {
    const before = await db.user.findUnique({
      where: { email },
      select: { id: true, email: true, emailVerifiedAt: true },
    });

    if (!before) {
      console.log(`  – ${email}: NOT FOUND (skipped)`);
      missing++;
      continue;
    }

    if (before.emailVerifiedAt) {
      console.log(
        `  = ${email}: already verified at ${before.emailVerifiedAt.toISOString()} (skipped)`,
      );
      alreadyVerified++;
      continue;
    }

    const after = await db.user.update({
      where: { email },
      data:  { emailVerifiedAt: new Date() },
      select: { email: true, emailVerifiedAt: true },
    });

    console.log(
      `  ✓ ${email}: emailVerifiedAt null → ${after.emailVerifiedAt!.toISOString()}`,
    );
    updated++;
  }

  console.log(
    `\nDone. updated: ${updated}, already verified: ${alreadyVerified}, not found: ${missing}`,
  );
}

main()
  .catch((err) => {
    console.error("verify-seed-emails failed:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
