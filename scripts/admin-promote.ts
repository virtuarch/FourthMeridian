/**
 * scripts/admin-promote.ts
 *
 * Promote an EXISTING, already-registered user to SYSTEM_ADMIN.
 *
 *   npm run admin:promote -- --email you@example.com            # dry run
 *   npm run admin:promote -- --email you@example.com --apply    # commit
 *
 * ── Why this exists, and why it does NOT create the account ──────────────────
 * The obvious shortcut — seed an admin row directly — is wrong for production.
 * Registration is a real code path that hashes the password, records
 * Terms/Privacy consent (`acceptedTermsAt` / `acceptedTermsVersion`, PO-5A), and
 * issues email verification. A hand-inserted row skips all of it and leaves an
 * account that is subtly different from every other account in the system.
 *
 * So the flow is deliberately two-step:
 *   1. register normally through the app UI (the real path, nothing special);
 *   2. run this to raise that existing user's role.
 *
 * `prisma/seed.ts` must NEVER be run against production: it creates a DEV-ONLY
 * `sysadmin@example.com` with a hardcoded password.
 *
 * ── MFA is automatic, and cannot be bypassed here ───────────────────────────
 * This sets `role` and nothing else. It deliberately does not touch
 * `totpEnabled` / `totpSecret`, because `requiresTotpEnrollment()` (PO-1) returns
 * true for a SYSTEM_ADMIN with `totpEnabled: false` — so at the next login the
 * account is forced into TOTP enrolment and can reach nothing but the 2FA setup
 * flow until it completes. That is the intended behaviour: this script grants the
 * role, the login path still demands the second factor.
 *
 * Every promotion writes an AuditLog row. An unaudited privilege escalation is
 * exactly what the platform security model forbids.
 */

import { db } from "@/lib/db";
import { UserRole } from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : null;
}

const APPLY = process.argv.includes("--apply");
const email = arg("--email")?.toLowerCase().trim() ?? null;
const username = arg("--username")?.trim() ?? null;

function fail(msg: string, hint?: string): never {
  console.error(`\n  ✗ ${msg}`);
  if (hint) console.error(`    ${hint}`);
  console.error("");
  process.exit(1);
}

async function main(): Promise<void> {
  if (!email && !username) {
    fail("Provide --email or --username.",
         "e.g. npm run admin:promote -- --email you@example.com --apply");
  }

  const user = await db.user.findFirst({
    where: email ? { email } : { username: username! },
    select: {
      id: true, email: true, username: true, name: true, role: true,
      totpEnabled: true, emailVerifiedAt: true, acceptedTermsAt: true,
      deletionScheduledAt: true, createdAt: true,
    },
  });

  if (!user) {
    fail(`No user found for ${email ? `email "${email}"` : `username "${username}"`}.`,
         "Register through the app UI first — this script promotes, it never creates.");
  }

  // Refuse to hand admin to an account that is on its way out.
  if (user.deletionScheduledAt) {
    fail("That account has a deletion scheduled.",
         "Cancel the deletion before granting SYSTEM_ADMIN.");
  }

  const target = `${user.email}${user.username ? ` (@${user.username})` : ""}`;
  console.log(`\n  ${APPLY ? "PROMOTE" : "DRY RUN"} — grant SYSTEM_ADMIN`);
  console.log(`    user:            ${target}`);
  console.log(`    id:              ${user.id}`);
  console.log(`    registered:      ${user.createdAt.toISOString()}`);
  console.log(`    current role:    ${user.role}`);
  console.log(`    email verified:  ${user.emailVerifiedAt ? "yes" : "NO"}`);
  console.log(`    terms accepted:  ${user.acceptedTermsAt ? "yes" : "NO"}`);
  console.log(`    TOTP enrolled:   ${user.totpEnabled ? "yes" : "no — will be FORCED at next login"}`);

  if (user.role === UserRole.SYSTEM_ADMIN) {
    console.log("\n  Already SYSTEM_ADMIN — nothing to do.\n");
    return;
  }

  // A kill switch left on would grant the role and immediately deny every
  // admin request, which looks like the promotion silently failed.
  if (process.env.DISABLE_SYSTEM_ADMIN === "true") {
    console.log("\n  ⚠  DISABLE_SYSTEM_ADMIN=true is set in THIS environment.");
    console.log("     Where that flag is true at runtime, every admin request is refused");
    console.log("     regardless of role (the persistent role is unaffected). If that is");
    console.log("     also set in production, unset it there before expecting access.");
  }

  if (!APPLY) {
    console.log("\n  Dry run only — nothing was written.");
    console.log("  Re-run with --apply to commit.\n");
    return;
  }

  await db.user.update({ where: { id: user.id }, data: { role: UserRole.SYSTEM_ADMIN } });

  // Audited: attributed, non-secret, and durable. `performedByAdminId` is left
  // null on purpose — this was an out-of-band operator act, not an in-app one,
  // and recording a fake actor would be worse than recording none.
  await db.auditLog.create({
    data: {
      userId: user.id,
      action: AuditAction.MEMBER_ROLE_CHANGED,
      metadata: {
        scope: "PLATFORM",
        from: user.role,
        to: UserRole.SYSTEM_ADMIN,
        via: "scripts/admin-promote.ts",
        note: "Out-of-band SYSTEM_ADMIN bootstrap. MFA enrolment is still enforced at login.",
      },
    },
  });

  console.log(`\n  ✓ ${target} is now SYSTEM_ADMIN (audited).`);
  console.log("\n  Next:");
  console.log("    1. Log out and back in — you will be forced into TOTP enrolment.");
  console.log("    2. Complete 2FA setup; admin routes stay closed until you do.");
  console.log("    3. Then set registration_mode = invite_only before inviting anyone.\n");
}

main()
  .catch((e) => { console.error("\n  ✗ admin:promote failed:", e instanceof Error ? e.message : e, "\n"); process.exit(1); })
  .finally(() => void db.$disconnect());
