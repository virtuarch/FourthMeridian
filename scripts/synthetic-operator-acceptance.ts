/**
 * scripts/synthetic-operator-acceptance.ts — the synthetic Preview operator
 * tool, end to end, on a THROWAWAY PostgreSQL (scripts/lib/rls-harness.ts —
 * the committed migration history, removed with `docker rm -f -v`).
 *
 * Runs the REAL CLI (scripts/synthetic-operator.ts) as a child with
 * --env=local against the throwaway database and a temp HOME (so the private
 * directory lands in a temp ~/FourthMeridian-private), then checks the stored
 * shapes with the app's own helpers: provision → refuse a second provision →
 * revoke GROWTH_REVENUE → cleanup through the account-deletion purge → zero
 * rows left, credential file shredded, counts-only cleanup record, no e-mail /
 * notification rows written. Synthetic data only; every key is per-run.
 *
 *   npm run rls:accept:synthetic-operator [-- --keep]
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareHarness, teardownHarness, psql, makeRecorder } from "./lib/rls-harness";

const KEEP = process.argv.includes("--keep");
const { check, report } = makeRecorder();

process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
delete process.env.ENCRYPTION_KEY_PREVIOUS;

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts/synthetic-operator.ts");
const EMAIL = "synthetic-operator@example.test";

async function main(): Promise<number> {
  console.log("\n=== SYNTHETIC OPERATOR — THROWAWAY-DB ACCEPTANCE ===\n");
  const h = prepareHarness("synthop");
  const owner = h.ownerUrl;
  const one = (sql: string) => { const r = psql(owner, sql); if (!r.ok) throw new Error(`SQL failed: ${r.err}`); return r.out.trim(); };
  const home = mkdtempSync(path.join(os.tmpdir(), "fm-synthop-home-"));
  const privateBase = path.join(home, "FourthMeridian-private");
  const childEnv = {
    ...process.env, HOME: home,
    PLAID_CLIENT_ID: "synthetic-client", PLAID_SECRET: "synthetic-secret", PLAID_ENV: "sandbox",
    VERCEL_ENV: "", FM_PRODUCTION_DB_REF: "",
  };
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [...process.execArgv, SCRIPT, ...args], { encoding: "utf8", env: childEnv, cwd: ROOT });
    return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
  };
  const commsRows = () => Number(one(`SELECT (SELECT count(*) FROM "CommsDelivery") + (SELECT count(*) FROM "Notification");`));
  const commsBefore = commsRows();

  try {
    // 1. Refusals before contact.
    const prod = run("--env=production", "--provision");
    check(1, "--env=production refused before contact (exit 2)", prod.status === 2 && /nothing was contacted/.test(prod.err), prod.err.slice(0, 200));
    const unk = run("--env=local", "--provision", "--grant=CUSTOMER_SUCCESS");
    check(2, "an unknown flag is refused (exit 2)", unk.status === 2, unk.err.slice(0, 200));

    // 2. Provision.
    const p = run("--env=local", "--provision");
    check(3, "provision exits 0", p.status === 0, `${p.status} ${p.err.slice(0, 500)}`);
    const dirs = existsSync(privateBase) ? readdirSync(privateBase).filter((d) => d.startsWith("synthetic-operator-")) : [];
    check(4, "exactly one private synthetic-operator-<stamp> directory", dirs.length === 1, JSON.stringify(dirs));
    const dir = path.join(privateBase, dirs[0] ?? "missing");
    const credFile = path.join(dir, "credentials.json");
    const cred = existsSync(credFile) ? JSON.parse(readFileSync(credFile, "utf8")) : {};
    check(5, "private dir 0700, credentials.json 0600", existsSync(credFile) && (statSync(dir).mode & 0o777) === 0o700 && (statSync(credFile).mode & 0o777) === 0o600);
    const stdoutLines = p.out.split("\n").map((l) => l.trim()).filter(Boolean);
    check(6, "stdout carries only PASS lines, the private directory and the deadline",
      stdoutLines.every((l) => /^PASS  /.test(l) || /^private directory: /.test(l) || /^cleanup deadline: /.test(l)), JSON.stringify(stdoutLines));
    check(7, "no secret on stdout/stderr (password, TOTP seed, otpauth)",
      typeof cred.password === "string" && cred.password.length === 32 && typeof cred.totpSecret === "string"
      && !(p.out + p.err).includes(cred.password) && !(p.out + p.err).includes(cred.totpSecret) && !/otpauth:/.test(p.out + p.err));
    check(8, "credential record carries the deadline (≤ 2026-11-19T23:59:59Z), user id and grant ids",
      typeof cred.cleanupDeadline === "string" && new Date(cred.cleanupDeadline).getTime() <= Date.parse("2026-11-19T23:59:59Z")
      && typeof cred.userId === "string" && Object.keys(cred.grantIds ?? {}).sort().join(",") === "GROWTH_REVENUE,PLATFORM_OPS"
      && /^otpauth:\/\/totp\//.test(cred.otpauthUri ?? ""));

    const uid = one(`SELECT id FROM "User" WHERE email = '${EMAIL}';`);
    check(9, "the user exists, role USER, email verified, TOTP enabled",
      one(`SELECT role || '|' || "totpEnabled" || '|' || ("emailVerifiedAt" IS NOT NULL) FROM "User" WHERE id = '${uid}';`) === "USER|true|true");
    const { default: bcrypt } = await import("bcryptjs");
    const { decryptWithPurpose, EncryptionPurpose } = await import("@/lib/plaid/encryption");
    const { generateTOTP, verifyTOTP } = await import("@/lib/totp");
    const hash = one(`SELECT "passwordHash" FROM "User" WHERE id = '${uid}';`);
    const sealed = one(`SELECT "totpSecret" FROM "User" WHERE id = '${uid}';`);
    check(10, "password hash is bcrypt cost 12 and verifies the private password", /^\$2[aby]\$12\$/.test(hash) && await bcrypt.compare(cred.password, hash));
    let opened = "";
    try { opened = decryptWithPurpose(sealed, EncryptionPurpose.TOTP_SECRET); } catch (e) { opened = `ERR ${String(e)}`; }
    check(11, "TOTP secret is sealed (v2) and opens — with the app's decrypt — to the private seed; a live code verifies",
      /^v2:/.test(sealed) && opened === cred.totpSecret && verifyTOTP(generateTOTP(cred.totpSecret), opened));
    check(12, "grants are exactly PLATFORM_OPS READ + GROWTH_REVENUE READ, ACTIVE, no grantor",
      one(`SELECT string_agg(area || ':' || level || ':' || status || ':' || coalesce("grantedById", '-'), ',' ORDER BY area::text) FROM "PlatformGrant" WHERE "userId" = '${uid}';`)
      === "GROWTH_REVENUE:READ:ACTIVE:-,PLATFORM_OPS:READ:ACTIVE:-");
    check(13, "two PLATFORM_GRANT_CREATED audit rows, actor null, synthetic reason",
      one(`SELECT count(*) FROM "AuditLog" WHERE "userId" = '${uid}' AND action = 'PLATFORM_GRANT_CREATED' AND "performedByAdminId" IS NULL AND metadata->>'reason' = 'synthetic acceptance operator' AND metadata->>'actorType' = 'SYSTEM';`) === "2");
    check(14, "exactly one Space (the registration Personal Space), no provider connection, one REGISTER audit",
      one(`SELECT (SELECT count(*) FROM "SpaceMember" WHERE "userId" = '${uid}') || '|' || (SELECT count(*) FROM "PlaidItem" WHERE "userId" = '${uid}') || '|' || (SELECT count(*) FROM "AuditLog" WHERE "userId" = '${uid}' AND action = 'REGISTER');`) === "1|0|1");

    // 3. Idempotent by refusal.
    const again = run("--env=local", "--provision");
    check(15, "a second provision is refused (exit 2) and mutates nothing",
      again.status === 2 && one(`SELECT count(*) FROM "User" WHERE email = '${EMAIL}';`) === "1"
      && readdirSync(privateBase).filter((d) => d.startsWith("synthetic-operator-")).length <= 2, again.err.slice(0, 200));

    // A conversation + messages for the operator (fixture, owner SQL) so cleanup has something to cascade.
    const conv = psql(owner, `INSERT INTO "PlatformAiConversation" (id, "operatorUserId", area, "createRequestId") VALUES ('synthconv1', '${uid}', 'PLATFORM_OPS', 'req1');
      INSERT INTO "PlatformAiMessage" (id, "conversationId", role, status, "clientRequestId") VALUES ('synthmsg1', 'synthconv1', 'USER', 'COMPLETE', 'creq1');
      INSERT INTO "PlatformAiMessage" (id, "conversationId", role, status, "replyToId", "failureCode") VALUES ('synthmsg2', 'synthconv1', 'ASSISTANT', 'FAILED', 'synthmsg1', 'PROVIDER');`);
    check(16, "fixture conversation + 2 messages inserted for the operator", conv.ok, conv.err.slice(0, 300));

    // 4. Revoke the second area.
    const bad = run("--env=local", "--revoke-area=CUSTOMER_SUCCESS");
    check(17, "--revoke-area=CUSTOMER_SUCCESS refused (exit 2)", bad.status === 2);
    const rv = run("--env=local", "--revoke-area=GROWTH_REVENUE");
    check(18, "--revoke-area=GROWTH_REVENUE exits 0", rv.status === 0, rv.err.slice(0, 300));
    check(19, "GROWTH_REVENUE REVOKED (no revoker), PLATFORM_OPS still ACTIVE, one PLATFORM_GRANT_REVOKED audit row",
      one(`SELECT string_agg(area || ':' || status || ':' || coalesce("revokedById", '-'), ',' ORDER BY area::text) FROM "PlatformGrant" WHERE "userId" = '${uid}';`) === "GROWTH_REVENUE:REVOKED:-,PLATFORM_OPS:ACTIVE:-"
      && one(`SELECT count(*) FROM "AuditLog" WHERE "userId" = '${uid}' AND action = 'PLATFORM_GRANT_REVOKED' AND metadata->>'area' = 'GROWTH_REVENUE' AND "performedByAdminId" IS NULL;`) === "1");
    const rv2 = run("--env=local", "--revoke-area=GROWTH_REVENUE");
    check(20, "revoking it again is refused (exit 2)", rv2.status === 2);

    // 5. Cleanup.
    const wrong = run("--env=local", "--cleanup", `--record=${path.join(home, "elsewhere")}`);
    check(21, "cleanup with a record outside the private base is refused (exit 2)", wrong.status === 2 && one(`SELECT count(*) FROM "User" WHERE id = '${uid}';`) === "1");
    const c = run("--env=local", "--cleanup", `--record=${dir}`);
    check(22, "cleanup exits 0", c.status === 0, `${c.status} ${c.err.slice(0, 600)} ${c.out.slice(-400)}`);
    check(23, "cleanup prints the Preview purge-dispatch instruction (not run)", /ops:platform-ai-conversations-purge -- --env=preview/.test(c.out));
    check(24, "zero rows remain: user, grants, conversations, messages, sessions, spaces, member rows",
      one(`SELECT (SELECT count(*) FROM "User" WHERE id = '${uid}' OR email = '${EMAIL}') + (SELECT count(*) FROM "PlatformGrant" WHERE "userId" = '${uid}')
        + (SELECT count(*) FROM "PlatformAiConversation" WHERE "operatorUserId" = '${uid}') + (SELECT count(*) FROM "PlatformAiMessage" WHERE "conversationId" = 'synthconv1')
        + (SELECT count(*) FROM "UserSession" WHERE "userId" = '${uid}') + (SELECT count(*) FROM "SpaceMember" WHERE "userId" = '${uid}')
        + (SELECT count(*) FROM "Space" WHERE name = 'Synthetic''s Space') + (SELECT count(*) FROM "CustomerPolicyAssignment" WHERE "userId" = '${uid}');`) === "0");
    check(25, "the deletion path ran: ACCOUNT_DELETION_REQUESTED (grace 0) + ACCOUNT_DELETED audit rows survive anonymised",
      one(`SELECT count(*) FROM "AuditLog" WHERE action = 'ACCOUNT_DELETION_REQUESTED' AND metadata->>'graceDays' = '0' AND metadata->>'reason' = 'synthetic acceptance operator';`) === "1"
      && one(`SELECT count(*) FROM "AuditLog" WHERE action = 'ACCOUNT_DELETED';`) === "1"
      && one(`SELECT count(*) FROM "AuditLog" WHERE "userId" = '${uid}';`) === "0");
    check(26, "remaining ACTIVE grant (PLATFORM_OPS) was revoked with an audit row before deletion",
      one(`SELECT count(*) FROM "AuditLog" WHERE action = 'PLATFORM_GRANT_REVOKED' AND metadata->>'area' = 'PLATFORM_OPS';`) === "1");
    const cleanupFile = path.join(dir, "cleanup.json");
    const cleanupRec = existsSync(cleanupFile) ? JSON.parse(readFileSync(cleanupFile, "utf8")) : null;
    check(27, "credentials.json shredded; cleanup.json 0600 with counts only",
      !existsSync(credFile) && !!cleanupRec && (statSync(cleanupFile).mode & 0o777) === 0o600
      && JSON.stringify(cleanupRec.removed) === JSON.stringify({ users: 1, grants: 2, conversations: 1, messages: 2, sessions: 0 })
      && !/password|totp|@example\.test|userId/i.test(readFileSync(cleanupFile, "utf8")), JSON.stringify(cleanupRec));
    check(28, "no e-mail / notification rows were written by any step", commsRows() === commsBefore, `${commsBefore} → ${commsRows()}`);
    check(29, "no secret printed by cleanup", !(c.out + c.err).includes(cred.password) && !(c.out + c.err).includes(cred.totpSecret));
  } finally {
    rmSync(home, { recursive: true, force: true });
    teardownHarness(KEEP);
  }
  return report("SYNTHETIC OPERATOR ACCEPTANCE");
}

main().then((failed) => process.exit(failed ? 1 : 0)).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  teardownHarness(KEEP);
  process.exit(1);
});
