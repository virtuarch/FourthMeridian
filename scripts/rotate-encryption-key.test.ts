/**
 * scripts/rotate-encryption-key.test.ts  (PRIV-004)
 *
 * DB-free coverage of the rotation CLI: every refusal happens BEFORE a database
 * client is constructed (each spawn below points at an unreachable / fake
 * target; a refusal exits 2 without contacting it), the value-free contract of
 * the engine's classifier and summary, and source pins (owner-gated header, no
 * session-level SET, CAS guard on the old ciphertext, read-back verify).
 * The rows-against-a-real-Postgres proof is
 * scripts/encryption-key-rotation-acceptance.ts (CI: Architecture audits job).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/rotate-encryption-key.test.ts
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = path.resolve(__dirname, "..");
const PROD_REF = "prodprojectref0000001";
const PREV_REF = "previewprojectref0002";
const SECRET = "s3cr3tPassw0rd";
const direct = (ref: string) => `postgresql://postgres:${SECRET}@db.${ref}.supabase.co:5432/postgres`;
// Port 9 (discard) on loopback: nothing listens, so even a gate bug could not reach a database.
const LOCAL = `postgresql://fm:${SECRET}@127.0.0.1:9/fintracker`;
const KEY = randomBytes(32).toString("hex");

const run = (args: string[], env: Record<string, string>) => spawnSync(
  path.join(ROOT, "node_modules", ".bin", "tsx"),
  ["--require", "./scripts/lib/server-only-preload.cjs", "scripts/rotate-encryption-key.ts", ...args],
  { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ENCRYPTION_KEY: KEY, ...env } as unknown as NodeJS.ProcessEnv, timeout: 120_000 },
);
const refused = (r: ReturnType<typeof run>, re: RegExp) => r.status === 2 && /REFUSED — nothing was read or written/.test(r.stderr) && re.test(r.stderr);
const leaks = (r: ReturnType<typeof run>) => [SECRET, PROD_REF, PREV_REF, KEY].some((s) => `${r.stdout}${r.stderr}`.includes(s));

console.log("1. the CLI refuses before any database contact");
{
  const noEnv = run([], { DATABASE_URL: LOCAL });
  check("a run with no --env (even a dry run) is refused", refused(noEnv, /--env=<local\|preview\|production> is required/), `${noEnv.status} ${noEnv.stderr}`);
  const typo = run(["--aply", "--env=local"], { DATABASE_URL: LOCAL });
  check("an unknown flag is refused (no guessing)", refused(typo, /unknown argument/), typo.stderr);
  const prodNoAck = run(["--env=production"], { DATABASE_URL: direct(PROD_REF), FM_PRODUCTION_DB_REF: PROD_REF });
  check("--env=production without the acknowledgement flag is refused, dry run included",
    refused(prodNoAck, /--acknowledge-production-key-rotation/) && /OWNER-GATED/.test(prodNoAck.stderr), prodNoAck.stderr);
  const ackElsewhere = run(["--env=local", "--acknowledge-production-key-rotation"], { DATABASE_URL: LOCAL });
  check("the acknowledgement flag outside --env=production is refused", refused(ackElsewhere, /only meaningful with --env=production/), ackElsewhere.stderr);
  const prodApplyNoTicket = run(["--env=production", "--acknowledge-production-key-rotation", "--apply", "--expect=3"],
    { DATABASE_URL: direct(PROD_REF), FM_PRODUCTION_DB_REF: PROD_REF });
  check("a Production apply without --i-have-owner-approval is refused", refused(prodApplyNoTicket, /i-have-owner-approval/), prodApplyNoTicket.stderr);
  const prodApplyNoExpect = run(["--env=production", "--acknowledge-production-key-rotation", "--apply", "--i-have-owner-approval=FM-OPS-1"],
    { DATABASE_URL: direct(PROD_REF), FM_PRODUCTION_DB_REF: PROD_REF });
  check("a Production apply without --expect is refused", refused(prodApplyNoExpect, /--expect/), prodApplyNoExpect.stderr);
  const previewIsProd = run(["--env=preview", "--apply"], { DATABASE_URL: direct(PROD_REF), FM_PRODUCTION_DB_REF: PROD_REF });
  check("--env=preview pointed at the Production project is refused", refused(previewIsProd, /IS the Production project/), previewIsProd.stderr);
  const noRef = run(["--env=preview"], { DATABASE_URL: direct(PREV_REF) });
  check("--env=preview without FM_PRODUCTION_DB_REF is refused (cannot prove it is not Production)", refused(noRef, /FM_PRODUCTION_DB_REF/), noRef.stderr);
  const localRemote = run(["--env=local", "--apply"], { DATABASE_URL: direct(PREV_REF) });
  check("--env=local against a remote host is refused", refused(localRemote, /loopback/), localRemote.stderr);
  const cloneGuard = run(["--env=preview", "--apply"], { DATABASE_URL: direct(PREV_REF), FM_PRODUCTION_DB_REF: PROD_REF, FM_DB_GUARD: "clone-only" });
  check("FM_DB_GUARD=clone-only refuses a non-clone target", refused(cloneGuard, /clone-only/), cloneGuard.stderr);
  const vercelProd = run(["--env=local", "--apply"], { DATABASE_URL: LOCAL, VERCEL_ENV: "production" });
  check("VERCEL_ENV=production refuses a non-production --env", refused(vercelProd, /VERCEL_ENV/), vercelProd.stderr);
  const badBatch = run(["--env=local", "--batch=0"], { DATABASE_URL: LOCAL });
  check("--batch is validated", refused(badBatch, /--batch/), badBatch.stderr);
  const noKey = run(["--env=local"], { DATABASE_URL: LOCAL, ENCRYPTION_KEY: "" });
  check("no ENCRYPTION_KEY is refused before the database", refused(noKey, /ENCRYPTION_KEY must be exactly 64 hex/), noKey.stderr);
  const badPrev = run(["--env=local"], { DATABASE_URL: LOCAL, ENCRYPTION_KEY_PREVIOUS: "zz-not-hex" });
  check("a malformed ENCRYPTION_KEY_PREVIOUS is refused before the database, without echoing it",
    refused(badPrev, /ENCRYPTION_KEY_PREVIOUS/) && !badPrev.stderr.includes("zz-not-hex"), badPrev.stderr);
  const both = run(["--env=local", "--apply", "--verify-complete"], { DATABASE_URL: LOCAL });
  check("--verify-complete with --apply is refused (verify is read-only)", refused(both, /read-only/), both.stderr);
  const all = [both, noEnv, typo, prodNoAck, ackElsewhere, prodApplyNoTicket, prodApplyNoExpect, previewIsProd, noRef, localRemote, cloneGuard, vercelProd, badBatch, noKey, badPrev];
  check("no refusal prints a password, project ref or key", all.every((r) => !leaks(r)));
}

console.log("2. source pins");
{
  const cli = readFileSync(path.join(ROOT, "scripts/rotate-encryption-key.ts"), "utf8");
  const core = readFileSync(path.join(ROOT, "scripts/lib/rotate-encryption-key.core.ts"), "utf8");
  const header = cli.slice(0, cli.indexOf("*/"));
  check("the header states the Production run and the env steps b–d are OWNER-GATED",
    /OWNER-GATED/.test(header) && /PRODUCTION/.test(header) && /steps b–d/.test(header) && /ENCRYPTION_KEY_PREVIOUS/.test(header));
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("no session-level SET / RESET / set_config in the CLI or the engine",
    ![code(cli), code(core)].some((s) => /\bSET\s+(?!LOCAL\b)[a-z_]+\s*(=|TO)\b|\bRESET\b|set_config\s*\(/i.test(s.replace(/UPDATE \$\{T\} SET \$\{C\}/g, ""))));
  check("the write is a compare-and-swap on the OLD ciphertext",
    /UPDATE \$\{T\} SET \$\{C\} = \$1 WHERE "id" = \$2 AND \$\{C\} = \$3`, next, id, oldValue\)/.test(core));
  check("a CAS miss is a reported conflict, not a retry", /if \(n !== 1\) \{ conflicts\.push\(id\); return; \}/.test(core));
  check("every write is read back and verified under the current kid", /SELECT \$\{C\} AS v FROM \$\{T\} WHERE "id" = \$1/.test(core) && /verifyStored\(f, back\[0\]\.v, c\.plaintext, keyIds\.current\)/.test(core));
  check("the engine never logs (no console.* in the core)", !/console\./.test(code(core)));
  check("the database client is imported only after the gates",
    cli.indexOf('await import("@/lib/db")') > cli.indexOf("decideRepairEnvGuard({") && !/^import .*@\/lib\/db"/m.test(cli));
  check("the dry run is the default (writes need --apply)", /const apply = args\.includes\("--apply"\)/.test(cli));
  check("the RLS-bypass principal check runs before ANY scan (dry run, verify and apply)",
    /SELECT \(rolbypassrls OR rolsuper\) AS ok FROM pg_roles WHERE rolname = current_user/.test(core)
      && core.indexOf("await rotationPrincipalRefusal(client)") < core.indexOf("plan.push(await scanField"));
  check("the refusal reads 'the rotation principal must bypass RLS'", /the rotation principal must bypass RLS/.test(core) && /refuse\(\[PRINCIPAL_REFUSAL\]\)/.test(cli));
  check("every apply writes ONE AuditLog row with the canon action ENCRYPTION_KEY_ROTATED (INSERT only)",
    /INSERT INTO "AuditLog"/.test(core) && /AuditAction\.ENCRYPTION_KEY_ROTATED/.test(core) && !/(UPDATE|DELETE FROM) "AuditLog"/.test(core));
  const actions = readFileSync(path.join(ROOT, "lib/audit-actions.ts"), "utf8");
  check("ENCRYPTION_KEY_ROTATED is in the audit canon, the admin security filter and an admin group",
    /ENCRYPTION_KEY_ROTATED:\s+"ENCRYPTION_KEY_ROTATED"/.test(actions) && (actions.match(/AuditAction\.ENCRYPTION_KEY_ROTATED/g) ?? []).length === 2);
}

console.log("3. the engine's classifier and summary are value-free");
{
  process.env.ENCRYPTION_KEY = KEY;
  delete process.env.ENCRYPTION_KEY_PREVIOUS;
  (async () => {
    const { classifyValue, summarizeRotation } = await import("./lib/rotate-encryption-key.core");
    const { encryptWithPurpose, keyringKeyIds, EncryptionPurpose } = await import("@/lib/plaid/encryption");
    const { ENCRYPTED_FIELDS } = await import("@/lib/plaid/encrypted-fields");
    const totp = ENCRYPTED_FIELDS.find((f) => f.field === "totpSecret")!;
    const kid = keyringKeyIds().current;
    const v3 = encryptWithPurpose("seed-plaintext", EncryptionPurpose.TOTP_SECRET);
    check("a current-kid value is 'current' (not a candidate)", classifyValue(totp, v3, kid).kind === "current");
    check("NULL and '' are empty", classifyValue(totp, null, kid).kind === "empty" && classifyValue(totp, "", kid).kind === "empty");
    check("a non-ciphertext is unrecognised and never a candidate", classifyValue(totp, "xpub-like-value", kid).kind === "unrecognised");
    const foreign = (() => { process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex"); try { return encryptWithPurpose("x", EncryptionPurpose.TOTP_SECRET); } finally { process.env.ENCRYPTION_KEY = KEY; } })();
    check("an unknown kid is unreadable", classifyValue(totp, foreign, kid).kind === "unreadable");
    const summary = summarizeRotation({
      mode: "APPLY", keyIds: { current: kid, previous: "0badc0de" },
      fields: [{ field: "User.totpSecret", scanned: 3, empty: 0, unrecognised: 0, current: 1, byKid: { [kid]: 1, "0badc0de": 1 }, legacy: { v1: 0, v2: 1 }, candidates: 2, unreadable: 0, blocking: 1, rotated: 1, conflicts: ["row-1"] }],
      totals: { scanned: 3, candidates: 2, unreadable: 0, unrecognised: 0, blocking: 1, rotated: 1, conflicts: 1 }, outcome: "INCOMPLETE",
    }, "local");
    check("the summary names kids, counts and conflict ids", summary.includes(kid) && summary.includes("previous") && summary.includes("row-1") && summary.includes("INCOMPLETE"));
    check("the summary never contains a value or a key", !summary.includes(v3) && !summary.includes("seed-plaintext") && !summary.includes(KEY));
    check("the summary contains no ciphertext shape (v1/v2/v3/c1) and no 64-hex key",
      !/\bv[23]:[0-9a-f]{8}|[0-9a-f]{32}:[0-9a-f]{32}|\bc1\.[A-Za-z0-9_-]{8}|[0-9a-f]{64}/i.test(summary));
    check("the summary names kids by ROLE only (current / previous) — never pairs a kid with key material", !/kid [0-9a-f]{8}\s*[=:]\s*[0-9a-f]{16}/.test(summary));
    const { auditMetadataOf } = await import("./lib/rotate-encryption-key.core");
    const meta = JSON.stringify(auditMetadataOf({
      mode: "APPLY", keyIds: { current: kid, previous: "0badc0de" },
      fields: [{ field: "User.totpSecret", scanned: 3, empty: 0, unrecognised: 0, current: 1, byKid: {}, legacy: { v1: 0, v2: 1 }, candidates: 2, unreadable: 0, blocking: 1, rotated: 1, conflicts: ["row-1"] }],
      totals: { scanned: 3, candidates: 2, unreadable: 0, unrecognised: 0, blocking: 1, rotated: 1, conflicts: 1 }, outcome: "INCOMPLETE",
    }, { env: "local", targetHash: "0123456789abcdef", approvalTicket: null }));
    check("the AuditLog metadata carries outcome, old/new kids and per-field counts", meta.includes('"newKid":"' + kid) && meta.includes('"oldKid":"0badc0de"') && meta.includes('"User.totpSecret":{"scanned":3') && meta.includes('"conflicts":1'));
    check("…and no row id, value or key", !meta.includes("row-1") && !meta.includes(KEY) && !meta.includes(v3));

    console.log("");
    if (failures === 0) { console.log("rotate-encryption-key: all cases passed."); process.exit(0); }
    console.log(`${failures} failure(s).`);
    process.exit(1);
  })().catch((e) => { console.error(e); process.exit(1); });
}
