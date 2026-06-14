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
import { db } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";

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

  await db.$transaction([
    // Invalidate all existing (unused) codes for this user
    db.recoveryCode.deleteMany({
      where: { userId, usedAt: null },
    }),
    // Create new codes
    db.recoveryCode.createMany({
      data: hashes.map((codeHash) => ({ userId, codeHash })),
    }),
    // Audit log
    db.auditLog.create({
      data: {
        userId,
        action: isRegen ? AuditAction.RECOVERY_CODES_REGENERATED : AuditAction.RECOVERY_CODES_GENERATED,
        performedByAdminId: adminId ?? null,
        metadata: { codeCount: CODE_COUNT, triggeredByAdmin: !!adminId },
      },
    }),
  ]);

  return plaintextCodes;
}

/**
 * Verify a recovery code for a user.
 * If valid and unused, marks it used and returns true.
 * Writes a RECOVERY_CODE_USED audit log event.
 */
export async function verifyRecoveryCode(
  userId: string,
  plaintextCode: string,
): Promise<boolean> {
  const unusedCodes = await db.recoveryCode.findMany({
    where: { userId, usedAt: null },
  });

  for (const row of unusedCodes) {
    const match = await bcrypt.compare(plaintextCode, row.codeHash);
    if (match) {
      await db.$transaction([
        db.recoveryCode.update({
          where: { id: row.id },
          data:  { usedAt: new Date() },
        }),
        db.auditLog.create({
          data: { userId, action: AuditAction.RECOVERY_CODE_USED },
        }),
      ]);
      return true;
    }
  }

  return false;
}

/** Count remaining (unused) recovery codes for a user. */
export async function countRemainingCodes(userId: string): Promise<number> {
  return db.recoveryCode.count({ where: { userId, usedAt: null } });
}
