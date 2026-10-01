/**
 * lib/recovery-codes.ts
 *
 * Recovery code generation and verification.
 * Codes are 10 random 8-character hex segments (format: XXXXXXXX-XXXXXXXX).
 * Stored as bcrypt hashes (cost 10 — fast enough for 10 codes, secure enough).
 * Shown to the user ONCE in plaintext; never stored in plaintext.
 */

import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { AuditAction } from "@/lib/audit-actions";

/**
 * ── RLS-13 — AUTHORITY FOLLOWS THE EXECUTION PHASE, NOT THE MODULE ──────────
 *
 * This module used to import one client, which quietly asserted that every
 * recovery-code operation has the same authority. It does not. The SAME code
 * path runs under three of them:
 *
 *   verifyRecoveryCode     PRE-IDENTITY. It is one of the two ways a session is
 *                          established, so there is no app.user_id yet and
 *                          there cannot be. Caller supplies `authDb` (fm_auth).
 *
 *   generateRecoveryCodes  POST-IDENTITY when a user enrols or regenerates
 *                          their own codes — the caller is authenticated, so it
 *                          runs inside withTenantDb under their identity.
 *                          OPERATOR when an admin regenerates codes for SOMEONE
 *                          ELSE: fm_app's RecoveryCode policy is
 *                          `userId = current_fm_user_id()`, so the tenant role
 *                          structurally cannot do it, and the admin route
 *                          supplies `systemDb`.
 *
 *   countRemainingCodes    POST-IDENTITY for a user reading their own count;
 *                          OPERATOR for the admin console reading another's.
 *
 * So the client is a REQUIRED FIRST PARAMETER and every call site states its
 * own authority. The alternative — leaving the whole module on fm_auth because
 * one of its functions is pre-identity — would have made the login role a
 * convenience authority for authenticated user operations, which is exactly
 * what fm_auth must never become.
 */
export type RecoveryCodeClient =
  Pick<Prisma.TransactionClient, "recoveryCode" | "auditLog"> &
  Partial<Pick<PrismaClient, "$transaction">>;

/** Run `fn` in ONE transaction: open one if the client can, else the caller already did. */
async function inOneTransaction<T>(
  client: RecoveryCodeClient,
  fn: (tx: Pick<Prisma.TransactionClient, "recoveryCode" | "auditLog">) => Promise<T>,
): Promise<T> {
  // ⚠️ A CAPABILITY TEST, NEVER AN IDENTITY TEST. Prisma.TransactionClient has
  // no $transaction (ITXClientDenyList), a PrismaClient does. Comparing against
  // a particular client object silently drops atomicity for any client that is
  // not that exact object — a bug this programme already found once.
  if ("$transaction" in client && typeof client.$transaction === "function") {
    return (client as PrismaClient).$transaction((tx) => fn(tx));
  }
  return fn(client);
}

const CODE_COUNT = 10;
const BCRYPT_ROUNDS = 10;

/** Generate one plaintext recovery code in format XXXXXXXX-XXXXXXXX. */
function generatePlaintextCode(): string {
  const a = randomBytes(4).toString("hex").toUpperCase();
  const b = randomBytes(4).toString("hex").toUpperCase();
  return `${a}-${b}`;
}

/**
 * Generate CODE_COUNT recovery codes for a user.
 * - Invalidates all existing unused codes.
 * - Creates new hashed rows.
 * - Returns plaintext codes (show once only).
 * - Writes an audit log event.
 *
 * @param userId   Target user's id
 * @param isRegen  true = RECOVERY_CODES_REGENERATED, false = RECOVERY_CODES_GENERATED
 * @param adminId  Admin performing the action (optional — set for admin-initiated regeneration)
 */
export async function generateRecoveryCodes(
  client: RecoveryCodeClient,
  userId: string,
  isRegen: boolean,
  adminId?: string,
): Promise<string[]> {
  const plaintextCodes: string[] = [];
  const hashes: string[] = [];

  for (let i = 0; i < CODE_COUNT; i++) {
    const code = generatePlaintextCode();
    plaintextCodes.push(code);
    hashes.push(await bcrypt.hash(code, BCRYPT_ROUNDS));
  }

  // Still ONE transaction: the old codes stop working, the new ones start, and
  // the audit fact lands, or none of it does. The batch array became an
  // interactive callback only so the caller's authority can wrap it.
  await inOneTransaction(client, async (tx) => {
    await tx.recoveryCode.deleteMany({ where: { userId, usedAt: null } });
    await tx.recoveryCode.createMany({ data: hashes.map((codeHash) => ({ userId, codeHash })) });
    await tx.auditLog.create({
      data: {
        userId,
        action: isRegen ? AuditAction.RECOVERY_CODES_REGENERATED : AuditAction.RECOVERY_CODES_GENERATED,
        performedByAdminId: adminId ?? null,
        metadata: { codeCount: CODE_COUNT, triggeredByAdmin: !!adminId },
      },
    });
  });

  return plaintextCodes;
}

/**
 * Verify a recovery code for a user.
 * If valid and unused, marks it used and returns true.
 * Writes a RECOVERY_CODE_USED audit log event.
 */
export async function verifyRecoveryCode(
  client: RecoveryCodeClient,
  userId: string,
  plaintextCode: string,
): Promise<boolean> {
  const unusedCodes = await client.recoveryCode.findMany({
    where: { userId, usedAt: null },
  });

  for (const row of unusedCodes) {
    const match = await bcrypt.compare(plaintextCode, row.codeHash);
    if (match) {
      await inOneTransaction(client, async (tx) => {
        await tx.recoveryCode.update({ where: { id: row.id }, data: { usedAt: new Date() } });
        await tx.auditLog.create({ data: { userId, action: AuditAction.RECOVERY_CODE_USED } });
      });
      return true;
    }
  }

  return false;
}

/** Count remaining (unused) recovery codes for a user. */
export async function countRemainingCodes(
  client: Pick<Prisma.TransactionClient, "recoveryCode">,
  userId: string,
): Promise<number> {
  return client.recoveryCode.count({ where: { userId, usedAt: null } });
}
