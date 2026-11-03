/**
 * scripts/lib/rotate-encryption-key.core.ts  (PRIV-004 — the rotation engine)
 *
 * The part of scripts/rotate-encryption-key.ts that touches rows, separated so
 * the acceptance suite (scripts/encryption-key-rotation-acceptance.ts) can drive
 * it against a throwaway Postgres — including the concurrent-write case, which
 * needs a hook between the read and the guarded write.
 *
 * For every field in ENCRYPTED_FIELDS (lib/plaid/encrypted-fields.ts):
 *
 *   SCAN   id-ordered keyset pages of (id, value). Each value is classified:
 *            empty          NULL / "" (incl. PlaidItem's revoked-token sentinel)
 *            unrecognised   not a ciphertext of the field's format — never touched
 *            current        v3 under the current kid / a seal the current key opens
 *            candidate      v3 under the previous kid, ANY legacy v1/v2 (no kid),
 *                           or a seal only the previous key opens
 *            unreadable     an unknown kid, or no key in the keyring authenticates it
 *          Candidates are trial-decrypted in the scan, so a dry run proves every
 *          one of them CAN be rotated before anything is written.
 *
 *   APPLY  (apply: true) per candidate: decrypt → encrypt under the current key →
 *            UPDATE "T" SET "col" = $new WHERE "id" = $id AND "col" = $old
 *          — compare-and-swap on the OLD CIPHERTEXT. Zero rows updated means the
 *          row changed since it was read (a re-link, a TOTP reset, a delete):
 *          the row is SKIPPED and reported as a conflict, never retried blindly.
 *          After every write the row is READ BACK and decrypted; it must yield
 *          the same plaintext under the current kid, or the old ciphertext is
 *          put back (CAS on the value just written) and the run ABORTS.
 *
 * Idempotent: a value already under the current kid is never a candidate, so a
 * second apply writes nothing.
 *
 * ⚠️ VALUE-FREE. Plaintext and ciphertext exist only in local variables; the
 * report holds counts, key ids (non-secret fingerprints) and row ids. Nothing
 * here logs. No session-level SET is ever sent (each statement autocommits).
 */

import { randomUUID } from "node:crypto";
import { AuditAction } from "@/lib/audit-actions";
import {
  ciphertextKeyId,
  decryptWithPurposeReportingKey,
  detectCiphertextVersion,
  encryptWithPurpose,
  keyringKeyIds,
  openWithPurposeReportingKey,
  previousKeyWarning,
  sealWithPurpose,
} from "@/lib/plaid/encryption";
import { ENCRYPTED_FIELDS, fieldLabel, type EncryptedField } from "@/lib/plaid/encrypted-fields";

/** The two raw-SQL entry points of a PrismaClient — all this engine needs. */
export interface RotationClient {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
}

export interface FieldReport {
  field: string;
  scanned: number;
  empty: number;
  unrecognised: number;
  /** Already under the current key (v3 current kid, or a seal the current key opens). */
  current: number;
  /** v3 / sealed values by the kid that names (or opened) them — current kid included. */
  byKid: Record<string, number>;
  /** Kid-less legacy values, by format. Always candidates. */
  legacy: { v1: number; v2: number };
  /** Values that need re-encryption under the current key. */
  candidates: number;
  /** Unknown kid, or no key authenticates it. Never written. */
  unreadable: number;
  /**
   * Values that would be UNREADABLE with the current key alone — i.e. lost if
   * ENCRYPTION_KEY_PREVIOUS were removed now: anything opened only by a
   * non-current key, plus everything unreadable. `--verify-complete` requires 0.
   * (A kid-less legacy value the CURRENT key opens is a candidate but not blocking.)
   */
  blocking: number;
  rotated: number;
  /** Row ids skipped because the old ciphertext changed between read and write. */
  conflicts: string[];
}

export interface RotationReport {
  mode: "DRY_RUN" | "APPLY" | "VERIFY";
  keyIds: { current: string; previous: string | null };
  fields: FieldReport[];
  totals: { scanned: number; candidates: number; unreadable: number; unrecognised: number; blocking: number; rotated: number; conflicts: number };
  /**
   * DRY_RUN · COMPLETE / INCOMPLETE (apply) · ABORTED_VERIFY · REFUSED_EXPECT_MISMATCH ·
   * VERIFIED_COMPLETE / NOT_COMPLETE (--verify-complete) · REFUSED_PRINCIPAL (the
   * connecting role does not bypass RLS, so a scan could silently miss rows).
   */
  outcome: "DRY_RUN" | "COMPLETE" | "INCOMPLETE" | "ABORTED_VERIFY" | "REFUSED_EXPECT_MISMATCH" | "VERIFIED_COMPLETE" | "NOT_COMPLETE" | "REFUSED_PRINCIPAL";
  /** Set when outcome is ABORTED_VERIFY — the field and row whose read-back failed. */
  abortedAt?: { field: string; id: string; reason: string };
  expect?: { expected: number; planned: number; matched: boolean };
}

export interface RotationOptions {
  apply: boolean;
  /** --verify-complete: read-only; VERIFIED_COMPLETE only when every field has 0 blocking values. */
  verifyComplete?: boolean;
  /** Recorded in the one AuditLog row an apply writes. Never a URL, host or secret. */
  audit?: { env: string | null; targetHash: string | null; approvalTicket: string | null };
  batchSize?: number;
  /** For --expect: refuse to write when the scan's candidate total differs. */
  expect?: number | null;
  /** Restrict to these registry labels (tests). Default: every registered field. */
  fields?: readonly string[];
  /** TEST SEAM — runs after a candidate is read and before its guarded write. */
  beforeWrite?: (field: EncryptedField, id: string) => Promise<void>;
}

const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;
const q = (ident: string): string => {
  if (!IDENT.test(ident)) throw new Error("refusing a non-identifier table/column name");
  return `"${ident}"`;
};

type Classified =
  | { kind: "empty" }
  | { kind: "unrecognised" }
  | { kind: "unreadable"; kid: string | null }
  | { kind: "current"; kid: string }
  | { kind: "candidate"; kid: string; legacy: "v1" | "v2" | null; plaintext: string };

/** Classify one stored value. Decrypts in memory only; never returns ciphertext. */
export function classifyValue(f: EncryptedField, value: string | null, currentKid: string): Classified {
  if (value === null || value === "") return { kind: "empty" };
  if (f.format === "sealed") {
    if (!value.startsWith("c1.")) return { kind: "unrecognised" };
    try {
      const { plaintext, kid } = openWithPurposeReportingKey(value, f.purpose);
      return kid === currentKid ? { kind: "current", kid } : { kind: "candidate", kid, legacy: null, plaintext };
    } catch {
      return { kind: "unreadable", kid: null };
    }
  }
  const version = detectCiphertextVersion(value);
  if (version === "invalid") return { kind: "unrecognised" };
  const declared = ciphertextKeyId(value);
  if (version === "v3" && declared === currentKid) {
    // Named current: still authenticate it, so a dry run's "current" is a proof.
    try { decryptWithPurposeReportingKey(value, f.purpose); return { kind: "current", kid: currentKid }; }
    catch { return { kind: "unreadable", kid: declared }; }
  }
  try {
    const { plaintext, kid } = decryptWithPurposeReportingKey(value, f.purpose);
    return { kind: "candidate", kid, legacy: version === "v3" ? null : version, plaintext };
  } catch {
    return { kind: "unreadable", kid: declared };
  }
}

function reencrypt(f: EncryptedField, plaintext: string): string {
  return f.format === "sealed" ? sealWithPurpose(plaintext, f.purpose) : encryptWithPurpose(plaintext, f.purpose);
}

/** Read-back proof: the stored value opens to `plaintext` under the current kid (and, for cipher, is v3). */
function verifyStored(f: EncryptedField, stored: string | null, plaintext: string, currentKid: string): string | null {
  if (stored === null) return "row value is NULL after the write";
  try {
    if (f.format === "sealed") {
      const r = openWithPurposeReportingKey(stored, f.purpose);
      if (r.kid !== currentKid) return "read-back opened under a non-current key";
      return r.plaintext === plaintext ? null : "read-back plaintext differs";
    }
    if (detectCiphertextVersion(stored) !== "v3" || ciphertextKeyId(stored) !== currentKid) return "read-back is not v3 under the current kid";
    const r = decryptWithPurposeReportingKey(stored, f.purpose);
    return r.plaintext === plaintext ? null : "read-back plaintext differs";
  } catch {
    return "read-back does not decrypt";
  }
}

function emptyFieldReport(f: EncryptedField): FieldReport {
  return { field: fieldLabel(f), scanned: 0, empty: 0, unrecognised: 0, current: 0, byKid: {}, legacy: { v1: 0, v2: 0 }, candidates: 0, unreadable: 0, blocking: 0, rotated: 0, conflicts: [] };
}

async function* pages(client: RotationClient, f: EncryptedField, batchSize: number): AsyncGenerator<Array<{ id: string; v: string | null }>> {
  const T = q(f.model), C = q(f.field);
  const scope = f.scope ? ` AND ${q(f.scope.column)}::text <> $2` : "";
  const sql = `SELECT "id", ${C} AS v FROM ${T} WHERE "id" > $1${scope} ORDER BY "id" ASC LIMIT ${Math.trunc(batchSize)}`;
  let after = "";
  for (;;) {
    const rows = f.scope
      ? await client.$queryRawUnsafe<Array<{ id: string; v: string | null }>>(sql, after, f.scope.notEqual)
      : await client.$queryRawUnsafe<Array<{ id: string; v: string | null }>>(sql, after);
    if (rows.length === 0) return;
    yield rows;
    after = rows[rows.length - 1].id;
    if (rows.length < batchSize) return;
  }
}

async function scanField(client: RotationClient, f: EncryptedField, currentKid: string, batchSize: number,
  onCandidate?: (id: string, oldValue: string, c: Extract<Classified, { kind: "candidate" }>) => Promise<"stop" | void>): Promise<FieldReport> {
  const r = emptyFieldReport(f);
  for await (const rows of pages(client, f, batchSize)) {
    for (const row of rows) {
      r.scanned++;
      const c = classifyValue(f, row.v, currentKid);
      switch (c.kind) {
        case "empty": r.empty++; break;
        case "unrecognised": r.unrecognised++; break;
        case "unreadable": r.unreadable++; r.blocking++; if (c.kid) r.byKid[c.kid] = (r.byKid[c.kid] ?? 0) + 1; break;
        case "current": r.current++; r.byKid[c.kid] = (r.byKid[c.kid] ?? 0) + 1; break;
        case "candidate":
          r.candidates++;
          if (c.kid !== currentKid) r.blocking++;
          if (c.legacy) r.legacy[c.legacy]++;
          else r.byKid[c.kid] = (r.byKid[c.kid] ?? 0) + 1;
          if (onCandidate && (await onCandidate(row.id, row.v as string, c)) === "stop") return r;
          break;
      }
    }
  }
  return r;
}

function totalsOf(fields: FieldReport[]): RotationReport["totals"] {
  const t = { scanned: 0, candidates: 0, unreadable: 0, unrecognised: 0, blocking: 0, rotated: 0, conflicts: 0 };
  for (const f of fields) {
    t.scanned += f.scanned; t.candidates += f.candidates; t.unreadable += f.unreadable;
    t.unrecognised += f.unrecognised; t.blocking += f.blocking; t.rotated += f.rotated; t.conflicts += f.conflicts.length;
  }
  return t;
}

export const PRINCIPAL_REFUSAL = "the rotation principal must bypass RLS (rolbypassrls or rolsuper): under row-level security a scan can silently miss rows, and a rotation that misses rows strands them when ENCRYPTION_KEY_PREVIOUS is removed.";

/**
 * REQUIRED before any scan: the connecting role sees every row. A role subject
 * to RLS reads a filtered table without error, so "0 to re-encrypt" could be a
 * policy, not a fact. Null when the role bypasses RLS; the refusal otherwise.
 */
export async function rotationPrincipalRefusal(client: RotationClient): Promise<string | null> {
  const rows = await client.$queryRawUnsafe<Array<{ ok: boolean | null }>>(
    `SELECT (rolbypassrls OR rolsuper) AS ok FROM pg_roles WHERE rolname = current_user`);
  return rows.length === 1 && rows[0].ok === true ? null : PRINCIPAL_REFUSAL;
}

export async function runKeyRotation(client: RotationClient, opts: RotationOptions): Promise<RotationReport> {
  const keyIds = keyringKeyIds(); // throws (value-free) when ENCRYPTION_KEY / _PREVIOUS is unusable
  if (previousKeyWarning(process.env)) throw new Error("ENCRYPTION_KEY_PREVIOUS equals ENCRYPTION_KEY — refusing to rotate (the old key is missing)");
  const batchSize = Math.min(Math.max(opts.batchSize ?? 100, 1), 1000);
  const fields = ENCRYPTED_FIELDS.filter((f) => !opts.fields || opts.fields.includes(fieldLabel(f)));
  const mode = opts.verifyComplete ? "VERIFY" : opts.apply ? "APPLY" : "DRY_RUN";
  if (opts.verifyComplete && opts.apply) throw new Error("--verify-complete is read-only and cannot be combined with --apply");

  if (await rotationPrincipalRefusal(client)) {
    return { keyIds, mode, fields: [], totals: totalsOf([]), outcome: "REFUSED_PRINCIPAL" };
  }

  // 1. The plan: a full read-only scan (this IS the dry run).
  const plan: FieldReport[] = [];
  for (const f of fields) plan.push(await scanField(client, f, keyIds.current, batchSize));
  const planTotals = totalsOf(plan);
  const base = { keyIds };
  if (opts.verifyComplete) {
    return { ...base, mode: "VERIFY", fields: plan, totals: planTotals, outcome: planTotals.blocking === 0 ? "VERIFIED_COMPLETE" : "NOT_COMPLETE" };
  }
  if (!opts.apply) return { ...base, mode: "DRY_RUN", fields: plan, totals: planTotals, outcome: "DRY_RUN" };

  if (opts.expect != null && opts.expect !== planTotals.candidates) {
    const refused: RotationReport = { ...base, mode: "APPLY", fields: plan, totals: planTotals, outcome: "REFUSED_EXPECT_MISMATCH",
      expect: { expected: opts.expect, planned: planTotals.candidates, matched: false } };
    await writeAuditRow(client, refused, opts.audit);
    return refused;
  }
  const expect = opts.expect != null ? { expected: opts.expect, planned: planTotals.candidates, matched: true } : undefined;

  // 2. The write pass: re-scan (rows may have moved since the plan) and rotate each candidate, CAS-guarded.
  const done: FieldReport[] = [];
  let aborted: RotationReport["abortedAt"];
  for (const f of fields) {
    const T = q(f.model), C = q(f.field);
    const conflicts: string[] = [];
    let rotated = 0;
    const r = await scanField(client, f, keyIds.current, batchSize, async (id, oldValue, c) => {
      const next = reencrypt(f, c.plaintext);
      if (opts.beforeWrite) await opts.beforeWrite(f, id);
      const n = await client.$executeRawUnsafe(`UPDATE ${T} SET ${C} = $1 WHERE "id" = $2 AND ${C} = $3`, next, id, oldValue);
      if (n !== 1) { conflicts.push(id); return; }
      const back = await client.$queryRawUnsafe<Array<{ v: string | null }>>(`SELECT ${C} AS v FROM ${T} WHERE "id" = $1`, id);
      const problem = back.length === 1 ? verifyStored(f, back[0].v, c.plaintext, keyIds.current) : "row vanished after the write";
      if (problem) {
        // Put the old ciphertext back (still CAS-guarded on what WE wrote), so a
        // failed proof never leaves a row holding a value nobody has verified.
        const restored = await client.$executeRawUnsafe(`UPDATE ${T} SET ${C} = $1 WHERE "id" = $2 AND ${C} = $3`, oldValue, id, next);
        aborted = { field: fieldLabel(f), id, reason: `${problem}${restored === 1 ? " (old value restored)" : " (old value NOT restored — row changed again)"}` };
        return "stop";
      }
      rotated++;
    });
    r.rotated = rotated;
    r.conflicts = conflicts;
    done.push(r);
    if (aborted) break;
  }
  const totals = totalsOf(done);
  const remaining = totals.candidates - totals.rotated + totals.unreadable;
  const result: RotationReport = aborted
    ? { ...base, mode: "APPLY", fields: done, totals, outcome: "ABORTED_VERIFY", abortedAt: aborted, expect }
    : { ...base, mode: "APPLY", fields: done, totals, outcome: remaining === 0 ? "COMPLETE" : "INCOMPLETE", expect };
  await writeAuditRow(client, result, opts.audit);
  return result;
}

/**
 * The value-free audit metadata of one apply run: outcome, old/new kids and
 * per-field COUNTS. No key, ciphertext, plaintext or row id (conflict ids stay
 * in the operator's console only).
 */
export function auditMetadataOf(r: RotationReport, audit: RotationOptions["audit"]): Record<string, unknown> {
  return {
    outcome: r.outcome,
    env: audit?.env ?? null,
    targetHash: audit?.targetHash ?? null,
    approvalTicket: audit?.approvalTicket ?? null,
    newKid: r.keyIds.current,
    oldKid: r.keyIds.previous,
    totals: r.totals,
    fields: Object.fromEntries(r.fields.map((f) => [f.field, {
      scanned: f.scanned, candidates: f.candidates, rotated: f.rotated, conflicts: f.conflicts.length,
      unreadable: f.unreadable, blocking: f.blocking, legacyV1: f.legacy.v1, legacyV2: f.legacy.v2,
    }])),
  };
}

/** ONE AuditLog row per --apply run (append-only table; INSERT only). */
async function writeAuditRow(client: RotationClient, r: RotationReport, audit: RotationOptions["audit"]): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO "AuditLog" ("id", "action", "metadata", "createdAt") VALUES ($1, $2, $3::jsonb, now())`,
    randomUUID(), AuditAction.ENCRYPTION_KEY_ROTATED, JSON.stringify(auditMetadataOf(r, audit)));
}

/** The operator summary. Counts, key ids and (for conflicts) row ids — never a value. */
export function summarizeRotation(r: RotationReport, env: string | null): string {
  const L: string[] = [];
  L.push(`ENCRYPTION KEY ROTATION — ${r.mode === "DRY_RUN" ? "DRY RUN (no writes)" : r.mode === "VERIFY" ? "VERIFY COMPLETE (no writes)" : "APPLY"}${env ? ` · env=${env}` : ""}`);
  L.push(`  current kid: ${r.keyIds.current}   previous kid: ${r.keyIds.previous ?? "(unset — only legacy values under the current key can be rotated)"}`);
  for (const f of r.fields) {
    L.push("");
    L.push(`  ${f.field}   scanned ${f.scanned} · empty ${f.empty} · unrecognised ${f.unrecognised}`);
    for (const [kid, n] of Object.entries(f.byKid).sort()) {
      const role = kid === r.keyIds.current ? "current" : kid === r.keyIds.previous ? "previous" : "UNKNOWN — unreadable";
      L.push(`      kid ${kid} (${role})`.padEnd(48) + String(n));
    }
    if (f.legacy.v2) L.push("      legacy v2 (no kid)".padEnd(48) + String(f.legacy.v2));
    if (f.legacy.v1) L.push("      legacy v1 (no kid)".padEnd(48) + String(f.legacy.v1));
    L.push("      → to re-encrypt under the current key".padEnd(48) + String(f.candidates));
    if (f.unreadable) L.push("      ✗ unreadable with this keyring (never written)".padEnd(48) + String(f.unreadable));
    L.push("      blocking (lost if PREVIOUS removed now)".padEnd(48) + String(f.blocking));
    if (r.mode === "APPLY") {
      L.push("      rotated (CAS write + read-back verified)".padEnd(48) + String(f.rotated));
      if (f.conflicts.length) {
        L.push("      skipped — changed since read (CAS conflict)".padEnd(48) + String(f.conflicts.length));
        L.push(`        ids: ${f.conflicts.slice(0, 50).join(", ")}${f.conflicts.length > 50 ? ` … (+${f.conflicts.length - 50})` : ""}`);
      }
    }
  }
  L.push("");
  const t = r.totals;
  L.push(`  TOTAL scanned ${t.scanned} · to re-encrypt ${t.candidates} · unreadable ${t.unreadable} · unrecognised ${t.unrecognised} · blocking ${t.blocking}` +
    (r.mode === "APPLY" ? ` · rotated ${t.rotated} · conflicts ${t.conflicts}` : ""));
  if (r.expect) L.push(`  --expect=${r.expect.expected}: planned ${r.expect.planned} — ${r.expect.matched ? "matched" : "MISMATCH, nothing written"}`);
  switch (r.outcome) {
    case "DRY_RUN": L.push(`  Dry run. An apply would re-encrypt ${t.candidates} value(s); pass --expect=${t.candidates} to bind it to this count.`); break;
    case "COMPLETE": L.push("  COMPLETE — every value is under the current key. Re-run the dry run to confirm 0 to re-encrypt."); break;
    case "INCOMPLETE": L.push("  INCOMPLETE — conflicts and/or unreadable values remain. Re-run (conflicts are re-read and retried on the next run); investigate unreadable values before removing ENCRYPTION_KEY_PREVIOUS."); break;
    case "ABORTED_VERIFY": L.push(`  ABORTED — read-back verification failed on ${r.abortedAt?.field} id ${r.abortedAt?.id}: ${r.abortedAt?.reason}. STOP; do not remove ENCRYPTION_KEY_PREVIOUS.`); break;
    case "REFUSED_EXPECT_MISMATCH": L.push("  REFUSED — the candidate count differs from --expect; nothing was written. Re-run the dry run."); break;
    case "VERIFIED_COMPLETE": L.push("  VERIFIED COMPLETE — 0 values under a non-current kid and 0 kid-less values the current key cannot open, in every registered field. Step (d) may proceed."); break;
    case "NOT_COMPLETE": L.push(`  NOT COMPLETE — ${t.blocking} value(s) would be unreadable without ENCRYPTION_KEY_PREVIOUS. Do NOT remove it; run the apply (and investigate anything unreadable).`); break;
    case "REFUSED_PRINCIPAL": L.push(`  REFUSED — ${PRINCIPAL_REFUSAL}`); break;
  }
  return L.join("\n");
}
