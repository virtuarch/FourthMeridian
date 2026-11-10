/**
 * scripts/synthetic-operator.test.ts — the synthetic Preview operator's gate,
 * rules, private files and source pins (S2 rulings). No database and no
 * network: every URL is synthetic and only parsed; files go to a temp dir.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/synthetic-operator.test.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decideSyntheticOperator, isSyntheticEmailAllowed, isGrantAllowed, isRevocableArea, SYNTHETIC_GRANTS, SYNTHETIC_EMAIL,
  SYNTHETIC_ROLE, FORBIDDEN_AREAS, computeCleanupDeadline, HARD_DEADLINE, CLEANUP_WINDOW_MS, privateDirFor, recordDirRefusal,
  passwordFromBytes, parseSyntheticRecord, cleanupCountsRecord, utcStamp, providerConnectionBlocksCleanup,
} from "./lib/synthetic-operator.core";
import { createPrivateDir, writePrivateJson, shredFile } from "./lib/synthetic-operator.files";
import { PlaidItemStatus } from "@prisma/client";

let failures = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const PROD_REF = "prodprojectref0000001";
const PREV_REF = "previewprojectref0002";
const SECRET = "s3cr3tPassw0rd";
const direct = (ref: string) => `postgresql://postgres:${SECRET}@db.${ref}.supabase.co:5432/postgres`;
const local = () => `postgresql://fm:${SECRET}@localhost:5432/fintracker`;
const E = (over: Record<string, string | undefined>) => ({ FM_PRODUCTION_DB_REF: PROD_REF, ...over }) as unknown as NodeJS.ProcessEnv;
const ok = (d: ReturnType<typeof decideSyntheticOperator>) => d.ok;
const PREV = E({ DATABASE_URL: direct(PREV_REF), DIRECT_URL: direct(PREV_REF) });
const LOCAL = E({ DATABASE_URL: local() });

console.log("\nsynthetic operator — the gate\n");
check("--env=preview --provision on a non-Production Supabase target ⇒ allowed", ok(decideSyntheticOperator(["--env=preview", "--provision"], PREV)));
check("--env=local --provision on loopback ⇒ allowed", ok(decideSyntheticOperator(["--env=local", "--provision"], LOCAL)));
check("--env=local --revoke-area=GROWTH_REVENUE ⇒ allowed", ok(decideSyntheticOperator(["--env=local", "--revoke-area=GROWTH_REVENUE"], LOCAL)));
check("--env=local --cleanup --record=<dir> ⇒ allowed", ok(decideSyntheticOperator(["--env=local", "--cleanup", "--record=/x/synthetic-operator-20261105T120000Z"], LOCAL)));
check("--env=production ⇒ ALWAYS refused, even pointed at the Production ref",
  !ok(decideSyntheticOperator(["--env=production", "--provision"], E({ DATABASE_URL: direct(PROD_REF) }))));
check("--env=preview pointed at the PRODUCTION ref ⇒ refused", !ok(decideSyntheticOperator(["--env=preview", "--provision"], E({ DATABASE_URL: direct(PROD_REF) }))));
check("--env=preview with FM_PRODUCTION_DB_REF unset ⇒ refused",
  !ok(decideSyntheticOperator(["--env=preview", "--provision"], E({ FM_PRODUCTION_DB_REF: undefined, DATABASE_URL: direct(PREV_REF) }))));
check("VERCEL_ENV=production ⇒ refused", !ok(decideSyntheticOperator(["--env=local", "--provision"], E({ DATABASE_URL: local(), VERCEL_ENV: "production" }))));
check("DATABASE_URL and DIRECT_URL on different databases ⇒ refused",
  !ok(decideSyntheticOperator(["--env=preview", "--provision"], E({ DATABASE_URL: direct(PREV_REF), DIRECT_URL: direct(PROD_REF) }))));
check("--env=local on a remote target ⇒ refused", !ok(decideSyntheticOperator(["--env=local", "--provision"], E({ DATABASE_URL: direct(PREV_REF) }))));
check("an unknown flag ⇒ refused", !ok(decideSyntheticOperator(["--env=local", "--provision", "--force"], LOCAL)));
check("a bare positional argument ⇒ refused", !ok(decideSyntheticOperator(["--env=local", "--provision", "extra"], LOCAL)));
check("--email (not a flag of this tool) ⇒ refused", !ok(decideSyntheticOperator(["--env=local", "--provision", "--email=a@b.com"], LOCAL)));
check("no --env ⇒ refused", !ok(decideSyntheticOperator(["--provision"], LOCAL)));
check("two --env flags ⇒ refused", !ok(decideSyntheticOperator(["--env=local", "--env=preview", "--provision"], LOCAL)));
check("no command ⇒ refused", !ok(decideSyntheticOperator(["--env=local"], LOCAL)));
check("two commands ⇒ refused", !ok(decideSyntheticOperator(["--env=local", "--provision", "--cleanup", "--record=/x"], LOCAL)));
check("--provision=value ⇒ refused", !ok(decideSyntheticOperator(["--env=local", "--provision=yes"], LOCAL)));
check("--cleanup without --record ⇒ refused", !ok(decideSyntheticOperator(["--env=local", "--cleanup"], LOCAL)));
check("--record without --cleanup ⇒ refused", !ok(decideSyntheticOperator(["--env=local", "--provision", "--record=/x"], LOCAL)));
for (const area of ["CUSTOMER_SUCCESS", "MERCHANT_OPS", "SECURITY_OPS", "platform_ops", ""]) {
  check(`--revoke-area=${area || "<empty>"} ⇒ refused (allowlist only)`, !ok(decideSyntheticOperator(["--env=local", `--revoke-area=${area}`], LOCAL)));
}
const refusals = JSON.stringify([
  decideSyntheticOperator(["--env=preview", "--provision"], E({ DATABASE_URL: direct(PROD_REF) })),
  decideSyntheticOperator(["--env=preview", "--provision"], E({ DATABASE_URL: direct(PREV_REF), DIRECT_URL: direct(PROD_REF) })),
  decideSyntheticOperator(["--env=production", "--provision"], E({ DATABASE_URL: direct(PROD_REF) })),
]);
check("refusals name the rule, never a secret, ref, host or URL",
  !refusals.includes(SECRET) && !refusals.includes(PROD_REF) && !refusals.includes(PREV_REF) && !refusals.includes("supabase.co") && !refusals.includes("postgresql://"));

console.log("\nsynthetic operator — identity and grants allowlist\n");
check("the synthetic address is @example.test and allowed", SYNTHETIC_EMAIL.endsWith("@example.test") && isSyntheticEmailAllowed(SYNTHETIC_EMAIL));
for (const bad of ["owner@gmail.com", "a@example.test.com", "a@example.com", "A@EXAMPLE.TEST", "a@b@example.test", " a@example.test", "@example.test"]) {
  check(`email ${JSON.stringify(bad)} ⇒ refused`, !isSyntheticEmailAllowed(bad));
}
check("role is USER (never SYSTEM_ADMIN)", SYNTHETIC_ROLE === "USER");
check("the grant allowlist is EXACTLY PLATFORM_OPS READ + GROWTH_REVENUE READ",
  JSON.stringify(SYNTHETIC_GRANTS) === JSON.stringify([{ area: "PLATFORM_OPS", level: "READ" }, { area: "GROWTH_REVENUE", level: "READ" }]));
check("the allowlist is frozen", Object.isFrozen(SYNTHETIC_GRANTS) && SYNTHETIC_GRANTS.every((g) => Object.isFrozen(g)));
check("CUSTOMER_SUCCESS and MERCHANT_OPS are forbidden", FORBIDDEN_AREAS.has("CUSTOMER_SUCCESS") && FORBIDDEN_AREAS.has("MERCHANT_OPS"));
for (const [area, level] of [["CUSTOMER_SUCCESS", "READ"], ["MERCHANT_OPS", "READ"], ["SECURITY_OPS", "READ"], ["PLATFORM_OPS", "WRITE"], ["PLATFORM_OPS", "CONTROL"], ["GROWTH_REVENUE", "WRITE"]]) {
  check(`grant ${area}:${level} ⇒ not allowed`, !isGrantAllowed(area, level));
}
check("PLATFORM_OPS:READ and GROWTH_REVENUE:READ allowed", isGrantAllowed("PLATFORM_OPS", "READ") && isGrantAllowed("GROWTH_REVENUE", "READ"));
check("revocable areas = the allowlist's areas only", isRevocableArea("GROWTH_REVENUE") && isRevocableArea("PLATFORM_OPS") && !isRevocableArea("CUSTOMER_SUCCESS"));
// The names match the real Prisma enums.
const schema = readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8");
const enumBody = (name: string) => (new RegExp(`enum ${name} \\{([\\s\\S]*?)\\}`).exec(schema)?.[1] ?? "").split("\n").map((l) => l.replace(/\/\/.*$/, "").trim()).filter((l) => /^[A-Z_]+$/.test(l));
check("allowlist areas/levels exist in prisma PlatformArea / PlatformAccessLevel",
  SYNTHETIC_GRANTS.every((g) => enumBody("PlatformArea").includes(g.area) && enumBody("PlatformAccessLevel").includes(g.level)), { areas: enumBody("PlatformArea") });

console.log("\nsynthetic operator — deadline and records\n");
const t0 = new Date("2026-11-05T12:00:00Z");
check("deadline = provision + 14 d when that is earlier than the hard stop",
  computeCleanupDeadline(new Date("2026-11-01T00:00:00Z")).getTime() === new Date("2026-11-01T00:00:00Z").getTime() + CLEANUP_WINDOW_MS);
check("deadline = 2026-11-19T23:59:59Z when provision + 14 d is later", computeCleanupDeadline(new Date("2026-11-10T00:00:00Z")).toISOString() === HARD_DEADLINE.toISOString() && HARD_DEADLINE.toISOString() === "2026-11-19T23:59:59.000Z");
check("deadline never exceeds the hard stop", computeCleanupDeadline(new Date("2027-01-01T00:00:00Z")).getTime() === HARD_DEADLINE.getTime());
check("UTC stamp format", utcStamp(t0) === "20261105T120000Z");
const pw = passwordFromBytes(Buffer.alloc(24, 7));
check("password is 32 characters", pw.length === 32);
check("record dir must be synthetic-operator-<stamp> directly inside the private base",
  recordDirRefusal("/home/x/FourthMeridian-private/synthetic-operator-20261105T120000Z", "/home/x/FourthMeridian-private") === null
  && recordDirRefusal("/home/x/FourthMeridian-private/other", "/home/x/FourthMeridian-private") !== null
  && recordDirRefusal("/tmp/synthetic-operator-20261105T120000Z", "/home/x/FourthMeridian-private") !== null
  && recordDirRefusal("/home/x/FourthMeridian-private/a/synthetic-operator-20261105T120000Z", "/home/x/FourthMeridian-private") !== null);
let threw = false;
try { parseSyntheticRecord({ kind: "synthetic-operator-record", userId: "cabc12345678", email: "owner@gmail.com", env: "preview", targetHash: null }); } catch { threw = true; }
check("a record naming a non-@example.test user is rejected", threw);
const counts = cleanupCountsRecord("local", { users: 1, grants: 2, conversations: 3, messages: 9, sessions: 1 }, { users: 0, grants: 0, conversations: 0, messages: 0, sessions: 0 }, t0);
check("cleanup record carries counts only", JSON.stringify(counts.removed) === JSON.stringify({ users: 1, grants: 2, conversations: 3, messages: 9, sessions: 1 })
  && !/userId|email|password|totp/i.test(JSON.stringify(counts)));

console.log("\nsynthetic operator — private files\n");
const tmpBase = mkdtempSync(path.join(os.tmpdir(), "fm-synth-test-"));
const prevUmask = process.umask(0o022);
try {
  const dir = privateDirFor(path.join(tmpBase, "FourthMeridian-private"), t0);
  createPrivateDir(dir);
  const file = writePrivateJson(dir, "credentials.json", { password: "x".repeat(32) }, true);
  check("private dir is 0700 (even under a permissive umask)", (statSync(dir).mode & 0o777) === 0o700, (statSync(dir).mode & 0o777).toString(8));
  check("credential file is 0600", (statSync(file).mode & 0o777) === 0o600, (statSync(file).mode & 0o777).toString(8));
  check("the process umask is restored after the write", process.umask() === 0o022);
  let exclusive = false;
  try { writePrivateJson(dir, "credentials.json", {}, true); } catch { exclusive = true; }
  check("an exclusive write refuses an existing credential file", exclusive);
  let reuse = false;
  try { createPrivateDir(dir); } catch { reuse = true; }
  check("an existing private directory is never reused", reuse);
  writeFileSync(path.join(dir, "loose.json"), "{}", { mode: 0o644 });
  const f2 = writePrivateJson(dir, "loose.json", { a: 1 });
  check("rewriting a pre-existing 0644 file leaves it 0600", (statSync(f2).mode & 0o777) === 0o600);
  check("shred removes the credential file", shredFile(file) && !existsSync(file));
} finally {
  process.umask(prevUmask);
  rmSync(tmpBase, { recursive: true, force: true });
}

console.log("\nsynthetic operator — the script refuses before contact\n");
const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts/synthetic-operator.ts");
const r = spawnSync(process.execPath, [...process.execArgv, SCRIPT, "--env=production", "--provision"], {
  encoding: "utf8", env: { ...process.env, DATABASE_URL: direct(PROD_REF), DIRECT_URL: "", FM_PRODUCTION_DB_REF: PROD_REF },
});
check("--env=production exits 2 with 'nothing was contacted'", r.status === 2 && /REFUSED — nothing was contacted/.test(r.stderr), { status: r.status, err: r.stderr.slice(0, 300) });
check("the refusal prints no URL/ref/secret", !r.stderr.includes(PROD_REF) && !r.stderr.includes(SECRET) && !r.stdout.includes(SECRET));

console.log("\nsynthetic operator — source pins\n");
const raw = readFileSync(SCRIPT, "utf8");
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const importSpecs = [...src.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
const coreSrc = [readFileSync(path.join(ROOT, "scripts/lib/synthetic-operator.core.ts"), "utf8"), readFileSync(path.join(ROOT, "scripts/lib/synthetic-operator.files.ts"), "utf8")].join("\n");
const coreSpecs = [...coreSrc.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
const allSpecs = [...importSpecs, ...coreSpecs];
check("no notification / e-mail module is imported (notify, email, resend, sendMail, notifications)",
  !allSpecs.some((s) => /notif|email|resend|sendmail|mailer/i.test(s)), allSpecs);
check("no notifyPlatformAccessChange / sendEmail / createNotification call in the script",
  !/notifyPlatformAccessChange|createNotification|sendWelcome|\bsendEmail\(|sendMail/.test(src));
check("app/api/admin/platform-grants is never imported", !allSpecs.some((s) => /app\/api\/admin|platform-grants/.test(s)));
check("no static database import (lib/db only after the gate)",
  !/^import[^\n]*["']@\/lib\/db["']/m.test(src) && src.indexOf("decideSyntheticOperator(") < src.indexOf('await import("@/lib/db")'));
check("uses the registration hash (bcryptjs cost 12)", /import\("bcryptjs"\)/.test(src) && /bcrypt\.hash\(password, 12\)/.test(src));
check("provisions NO TOTP (no seed sealed with the local key; enrolment is the app's own flow)",
  !/@\/lib\/totp/.test(src) && !/TOTP_SECRET/.test(src) && /totpEnabled: false/.test(src) && !/totpSecret[,:]/.test(src.replace(/select: \{[^}]*\}/g, "")));
const provisionBody = src.slice(src.indexOf("async function provision("), src.indexOf("async function revokeArea("));
const provisionTx = provisionBody.slice(provisionBody.indexOf("db.$transaction("));
check("each grant and its PLATFORM_GRANT_CREATED audit row are written in ONE $transaction",
  /tx\.platformGrant\.create\(/.test(provisionTx) && /AuditAction\.PLATFORM_GRANT_CREATED/.test(provisionTx) && !/\bdb\.platformGrant\.create|\bdb\.auditLog\.create/.test(src));
const revokeBody = src.slice(src.indexOf("async function revokeGrants("), src.indexOf("async function provision("));
check("each revocation and its PLATFORM_GRANT_REVOKED audit row are in ONE $transaction",
  /db\.\$transaction\(/.test(revokeBody) && /tx\.platformGrant\.updateMany\(/.test(revokeBody) && /AuditAction\.PLATFORM_GRANT_REVOKED/.test(revokeBody));
check("audit rows carry actor null/system and the synthetic reason",
  /performedByAdminId: null/.test(src) && /actorType: "SYSTEM", reason: SYNTHETIC_REASON/.test(src) && /grantedById: null/.test(src) && /revokedById: null/.test(src));
check("cleanup deletes through the account-deletion purge (purgeUser), never a raw user delete",
  /import\("@\/lib\/account-deletion\/purge"\)/.test(src) && /purgeUser\(u\.id, \{ sendEmail: noEmail, plaid: noProvider \}\)/.test(src)
  && !/\.user\.delete\(|\.user\.deleteMany\(|\$executeRaw|\$queryRaw|DELETE FROM/i.test(src.replace("db.$queryRawUnsafe<Array<{ ok: boolean }>>(PRINCIPAL_BYPASS_SQL)", "")));
check("S2 Fix B: the ONE raw read is the principal assertion, a read-only pg_roles SELECT, run before any command",
  /export const PRINCIPAL_BYPASS_SQL = `SELECT \(rolbypassrls OR rolsuper\) AS ok FROM pg_roles WHERE rolname = current_user`;/.test(src)
    && src.indexOf("PRINCIPAL_BYPASS_SQL);") < src.indexOf("const c = decision.command;") && (src.match(/\$queryRaw/g) ?? []).length === 1);
check("S2 Fix A: cleanup shreds EVERY secret file (credentials.json, totp.json)",
  /for \(const f of SECRET_FILES\) shredFile\(path\.join\(recordDir, f\)\);/.test(src)
    && /export const SECRET_FILES = \[CREDENTIALS_FILE, TOTP_FILE\] as const;/.test(readFileSync("scripts/lib/synthetic-operator.files.ts", "utf8")));
check("every interactive transaction carries the remote-target bounds (TX_OPTIONS: maxWait 10 s, timeout 60 s)",
  /const TX_OPTIONS = \{ maxWait: 10_000, timeout: 60_000 \} as const;/.test(src)
    && (src.match(/db\.\$transaction\(/g) ?? []).length === 3 && (src.match(/\}, TX_OPTIONS\)/g) ?? []).length === 3);
check("the purge dispatch is printed, never run", /ops:platform-ai-conversations-purge -- --env=preview/.test(src) && !/spawn|execSync|exec\(/.test(src));
check("the role written is SYNTHETIC_ROLE and no SYSTEM_ADMIN appears", /role: SYNTHETIC_ROLE/.test(src) && !/SYSTEM_ADMIN/.test(src));
check("no session-level SET is issued", !/\bSET\s+(SESSION|LOCAL|default_transaction|role)/i.test(src));
check("stdout never prints the password, TOTP seed or otpauth URI",
  !/console\.(log|error)\([^)]*(password|totpSeed|otpauth)/i.test(src));
// Cleanup provider-connection guard: only REVOKED (disconnected) items are ignored.
check("cleanup guard: ACTIVE item blocks", providerConnectionBlocksCleanup([PlaidItemStatus.ACTIVE]));
for (const st of Object.values(PlaidItemStatus).filter((v) => v !== PlaidItemStatus.REVOKED)) {
  check(`cleanup guard: ${st} item blocks`, providerConnectionBlocksCleanup([st]));
}
check("cleanup guard: REVOKED-only items do not block",
  !providerConnectionBlocksCleanup([PlaidItemStatus.REVOKED]) && !providerConnectionBlocksCleanup([PlaidItemStatus.REVOKED, PlaidItemStatus.REVOKED]));
check("cleanup guard: no items does not block", !providerConnectionBlocksCleanup([]));
check("cleanup guard: mixed REVOKED + ACTIVE blocks", providerConnectionBlocksCleanup([PlaidItemStatus.REVOKED, PlaidItemStatus.ACTIVE]));
check("cleanup guard: the script queries item statuses and refuses through the helper",
  /db\.plaidItem\.findMany\(\{ where: \{ userId: u\.id \}, select: \{ status: true \} \}\)/.test(src)
    && /if \(providerConnectionBlocksCleanup\(plaidItems\.map\(\(i\) => i\.status\)\)\) \{/.test(src)
    && /an active \(not disconnected\) provider connection/.test(src));
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
check("package.json exposes ops:synthetic-operator", /scripts\/synthetic-operator\.ts/.test(pkg.scripts?.["ops:synthetic-operator"] ?? ""));
check("the purge function the cleanup uses is the one process-deletions calls",
  /purgeUser/.test(readFileSync(path.join(ROOT, "jobs/process-deletions.ts"), "utf8")));

if (failures) { console.error(`\n${failures} check(s) failed, ${passed} passed`); process.exit(1); }
console.log(`\nall ${passed} checks passed`);
