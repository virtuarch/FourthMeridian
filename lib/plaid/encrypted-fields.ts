/**
 * lib/plaid/encrypted-fields.ts  (PRIV-004 — the one field registry)
 *
 * EVERY stored column whose value is produced by lib/plaid/encryption.ts —
 * `encryptWithPurpose()` (format "cipher": v1/v2/v3 hex segments) or
 * `sealWithPurpose()` (format "sealed": the compact "c1." form). A key rotation
 * re-encrypts exactly these columns and nothing else, so a column missing here
 * is a column a rotation would strand: once ENCRYPTION_KEY_PREVIOUS is removed
 * its values can never be read again.
 *
 * lib/plaid/encrypted-fields.test.ts is the census: it scans the source for
 * every encryptWithPurpose( / sealWithPurpose( call, requires each one to be a
 * classified writer of a field listed here (or of a declared NON-STORED
 * carrier), and checks every entry against prisma/schema.prisma. Adding an
 * encrypted column = adding an entry here; the census fails until you do.
 *
 * `scope` narrows the rows of a column that hold ciphertext at all. The one
 * use: Connection.credential is encrypted for Plaid (lib/plaid/exchangeToken.ts)
 * but holds a WALLET's public watch-only descriptor IN CLEAR by design
 * (lib/accounts/wallet-connection.ts matches on it), and is null for MANUAL.
 *
 * Pure data — no key, no database, no I/O.
 */

import { EncryptionPurpose } from "./encryption";

export type EncryptedFieldFormat = "cipher" | "sealed";

export interface EncryptedField {
  /** Prisma model == table name (none of these models is @@map-ped). */
  readonly model: "PlaidItem" | "User" | "Connection" | "BetaAbuseEvidence";
  /** Prisma field == column name. */
  readonly field: string;
  readonly purpose: EncryptionPurpose;
  readonly format: EncryptedFieldFormat;
  /** Rows of this column that are NOT ciphertext, excluded by an equality on another column. */
  readonly scope?: { readonly column: string; readonly notEqual: string };
}

export const ENCRYPTED_FIELDS: readonly EncryptedField[] = [
  { model: "PlaidItem",         field: "encryptedToken",       purpose: EncryptionPurpose.PLAID_ACCESS_TOKEN,    format: "cipher" },
  { model: "User",              field: "totpSecret",           purpose: EncryptionPurpose.TOTP_SECRET,           format: "cipher" },
  { model: "User",              field: "dateOfBirthEncrypted", purpose: EncryptionPurpose.DATE_OF_BIRTH,         format: "cipher" },
  { model: "Connection",        field: "credential",           purpose: EncryptionPurpose.CONNECTION_CREDENTIAL, format: "cipher",
    scope: { column: "provider", notEqual: "WALLET" } },
  { model: "BetaAbuseEvidence", field: "sealedPayload",        purpose: EncryptionPurpose.BETA_ABUSE_EVIDENCE,   format: "sealed" },
] as const;

/**
 * Purposes that seal something the server hands out and takes back, and that
 * is NEVER stored: a rotation has nothing to re-encrypt for them. While
 * ENCRYPTION_KEY_PREVIOUS is set an old carrier still opens; once it is removed
 * the carrier fails to open and its reader starts fresh (by design — see
 * lib/ai/conversation/runtime-state.ts).
 */
export const NON_STORED_PURPOSES: readonly EncryptionPurpose[] = [EncryptionPurpose.AI_RUNTIME_STATE];

export const fieldLabel = (f: Pick<EncryptedField, "model" | "field">): string => `${f.model}.${f.field}`;
