/**
 * scripts/rotate-encryption-key.ts   (PRIV-004 — ENCRYPTION_KEY rotation, step c)
 *
 * ⚠️ OWNER-GATED. Running this against PRODUCTION, and the environment changes
 * around it (steps b–d of docs/operations/key-rotation.md: setting the new key
 * as ENCRYPTION_KEY and the old one as ENCRYPTION_KEY_PREVIOUS, then removing
 * ENCRYPTION_KEY_PREVIOUS), are OWNER-GATED actions. This script is step (c)
 * only; it never changes an environment variable.
 *
 * Re-encrypts every registered encrypted column (lib/plaid/encrypted-fields.ts)
 * whose value is not under the CURRENT key: v3 values under the previous kid,
 * and every kid-less legacy v1/v2 value. Engine and guarantees:
 * scripts/lib/rotate-encryption-key.core.ts (CAS on the old ciphertext, read-back
 * verify, idempotent, value-free output).
 *
 *   # dry run (default) — counts per field and per key id; writes nothing
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/rotate-encryption-key.ts --env=<local|preview>
 *
 *   # verify complete — the gate for step (d): exits 0 ONLY when no registered
 *   # value would be unreadable without ENCRYPTION_KEY_PREVIOUS
 *   npx tsx … scripts/rotate-encryption-key.ts --env=<env> --verify-complete
 *
 *   # apply — local / Preview
 *   FM_PRODUCTION_DB_REF=<prod ref> npx tsx … scripts/rotate-encryption-key.ts --env=preview --apply [--expect=<n>] [--batch=<n>]
 *
 *   # PRODUCTION — only under a written owner authorization, both steps:
 *   FM_PRODUCTION_DB_REF=<prod ref> npx tsx … scripts/rotate-encryption-key.ts --env=production \
 *     --acknowledge-production-key-rotation
 *   FM_PRODUCTION_DB_REF=<prod ref> npx tsx … scripts/rotate-encryption-key.ts --env=production \
 *     --acknowledge-production-key-rotation --apply --i-have-owner-approval=<ticket> --expect=<n from the dry run>
 *
 * Environment the process needs: DATABASE_URL (and DIRECT_URL, which must be the
 * same database) for the migration principal, ENCRYPTION_KEY (the NEW key), and
 * during a rotation ENCRYPTION_KEY_PREVIOUS (the OLD key). Keys are read by
 * lib/plaid/encryption.ts and never printed; only their key ids (non-secret
 * SHA-256 fingerprints) appear in the output.
 *
 * GUARDS (scripts/lib/repair-env-guard.ts — the same gate as the repair scripts):
 *   · --env is REQUIRED for every run, dry or apply: the target must PROVE it is
 *     that environment (loopback for local; a Supabase project that is not /
 *     is FM_PRODUCTION_DB_REF for preview / production).
 *   · --env=production additionally requires --acknowledge-production-key-rotation
 *     (dry run included), and an apply requires --i-have-owner-approval=<ticket>
 *     and --expect=<n> (the dry run's "to re-encrypt" total; a different count
 *     refuses before the first write).
 *   · FM_DB_GUARD=clone-only keeps its meaning (refuses anything not a clone);
 *     VERCEL_ENV=production refuses a non-production --env.
 *   · The connecting role must BYPASS RLS (rolbypassrls or rolsuper), checked
 *     before any scan: under row-level security a filtered table reads without
 *     error, and a rotation that misses rows strands them.
 *   · No session-level SET is sent — every statement autocommits on its own.
 *   · Every --apply run writes ONE AuditLog row (ENCRYPTION_KEY_ROTATED): the
 *     outcome, old/new kids and per-field counts — never a value.
 *
 * OUTPUT CONTRACT: counts, key ids and (for conflicts / an abort) row ids only.
 * Never a key, a ciphertext, a plaintext, or which key a kid belongs to.
 *
 * Exit: 0 dry run done / apply COMPLETE / VERIFIED COMPLETE · 2 refused (before any
 *       row is read) · 3 apply INCOMPLETE, --expect mismatch, or NOT COMPLETE ·
 *       4 read-back verification failed (aborted; the failing row was restored) ·
 *       1 could not run.
 */

import { decideRepairEnvGuard, redactConnectionDetails } from "./lib/repair-env-guard";
import { PRINCIPAL_REFUSAL, runKeyRotation, summarizeRotation } from "./lib/rotate-encryption-key.core";

const KNOWN_FLAGS = new Set(["apply", "verify-complete", "env", "expect", "batch", "i-have-owner-approval", "acknowledge-production-key-rotation"]);
const PRODUCTION_ACK_FLAG = "--acknowledge-production-key-rotation";

function flag(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1);
}

function refuse(reasons: string[], code = 2): never {
  console.error("\n  REFUSED — nothing was read or written.");
  for (const r of reasons) console.error(`    · ${r}`);
  console.error("");
  process.exit(code);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !a.startsWith("--") || !KNOWN_FLAGS.has(a.replace(/^--/, "").split("=")[0]));
  if (unknown.length) refuse([`unknown argument(s): ${unknown.map((a) => a.split("=")[0]).join(", ")} — refusing rather than guessing.`]);

  const apply = args.includes("--apply");
  const verifyComplete = args.includes("--verify-complete");
  if (apply && verifyComplete) refuse(["--verify-complete is read-only; it cannot be combined with --apply."]);
  const envFlag = flag("env");
  if (envFlag == null || envFlag === "") refuse(["--env=<local|preview|production> is required for every run, dry run included."]);
  if (envFlag === "production" && !args.includes(PRODUCTION_ACK_FLAG)) {
    refuse([`--env=production requires ${PRODUCTION_ACK_FLAG}: a Production key rotation is OWNER-GATED (docs/operations/key-rotation.md).`]);
  }
  if (envFlag !== "production" && args.includes(PRODUCTION_ACK_FLAG)) {
    refuse([`${PRODUCTION_ACK_FLAG} is only meaningful with --env=production; refusing so the environment is never ambiguous.`]);
  }
  const batchRaw = flag("batch");
  if (batchRaw !== null && !/^[1-9][0-9]{0,3}$/.test(batchRaw)) refuse(["--batch must be a whole number from 1 to 1000."]);
  const batchSize = batchRaw ? Math.min(Number(batchRaw), 1000) : 100;

  const gate = decideRepairEnvGuard({
    apply,
    envFlag,
    databaseUrl: process.env.DATABASE_URL,
    directUrl: process.env.DIRECT_URL,
    productionRef: process.env.FM_PRODUCTION_DB_REF,
    vercelEnv: process.env.VERCEL_ENV,
    env: process.env,
    approvalTicket: flag("i-have-owner-approval"),
    expect: flag("expect"),
  });
  if (!gate.ok) refuse(gate.reasons);

  // Keyring before the database: an unusable key is a refusal, not a half-run.
  const { keyringKeyIds, previousKeyWarning } = await import("@/lib/plaid/encryption");
  try { keyringKeyIds(); } catch (e) { refuse([e instanceof Error ? e.message : "the keyring could not be read"]); }
  // The app tolerates PREVIOUS === current (ignored, boot warning); a rotation does not:
  // the operator almost certainly pasted the new key twice and the old key is missing.
  if (previousKeyWarning(process.env)) {
    refuse(["ENCRYPTION_KEY_PREVIOUS equals ENCRYPTION_KEY — a rotation needs the OLD key in ENCRYPTION_KEY_PREVIOUS and the NEW key in ENCRYPTION_KEY."]);
  }

  // Imported only after the gates: constructing the client is the first contact with any database.
  const { db } = await import("@/lib/db");
  const report = await runKeyRotation(db, {
    apply, verifyComplete, batchSize, expect: gate.expect,
    audit: { env: gate.env, targetHash: gate.targetHash, approvalTicket: gate.approvalTicket },
  });
  if (report.outcome === "REFUSED_PRINCIPAL") {
    await db.$disconnect();
    refuse([PRINCIPAL_REFUSAL]);
  }
  console.log(`\n${summarizeRotation(report, gate.env)}\n`);
  if (gate.approvalTicket) console.log(`  owner approval: ${gate.approvalTicket}\n`);
  await db.$disconnect();
  const code = { DRY_RUN: 0, COMPLETE: 0, VERIFIED_COMPLETE: 0, INCOMPLETE: 3, NOT_COMPLETE: 3, REFUSED_EXPECT_MISMATCH: 3, ABORTED_VERIFY: 4, REFUSED_PRINCIPAL: 2 }[report.outcome];
  process.exit(code);
}

main().catch((e) => {
  console.error(redactConnectionDetails(e instanceof Error ? e.message : String(e), [process.env.FM_PRODUCTION_DB_REF]));
  process.exit(1);
});
