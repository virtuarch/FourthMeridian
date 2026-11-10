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
  E0_LIVE_PROFILE, E0_LIVE_ROSTER, E0_LIVE_AREAS, ALWAYS_FORBIDDEN_AREAS, E0_LIVE_FLIP_OPERATOR, e0LiveOperator, isE0LiveGrantAllowed,
  isRosterGrant, isE0LiveFlipArea, computeE0LiveDeadline, e0LiveDirFor, e0LiveOperatorDir, e0LiveRecordDirRefusal, parseE0LiveRecord,
  classifySignalLine, regrantAuditAction, AWAIT_SIGNAL_GO, AWAIT_SIGNAL_MAX_MS,
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
const createOpBody = src.slice(src.indexOf("async function createOperatorInTx("), src.indexOf("async function checkOperatorShape("));
check("each grant and its PLATFORM_GRANT_CREATED audit row are written in ONE $transaction (the shared registration writer, on the tx client)",
  /createOperatorInTx\(tx, reg, who, SYNTHETIC_GRANTS, isGrantAllowed, passwordHash, now\)/.test(provisionTx)
    && /tx: Tx,/.test(createOpBody) && /tx\.platformGrant\.create\(/.test(createOpBody) && /AuditAction\.PLATFORM_GRANT_CREATED/.test(createOpBody)
    && /if \(!allowed\(g\.area, g\.level\)\) throw new Error\("grant outside the allowlist"\);/.test(createOpBody)
    && !/\bdb\.platformGrant\.create|\bdb\.auditLog\.create|\bdb\.platformGrant\.upsert/.test(src));
check("the DEFAULT profile's provision grants through isGrantAllowed (which refuses CUSTOMER_SUCCESS)",
  /SYNTHETIC_GRANTS\) if \(!isGrantAllowed\(g\.area, g\.level\)\)/.test(provisionBody) && !/isRosterGrant|E0_LIVE/.test(provisionBody));
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
  /for \(const f of SECRET_FILES\) shredFile\(path\.join\(opDir, f\)\);/.test(src)
    && /export const SECRET_FILES = \[CREDENTIALS_FILE, TOTP_FILE\] as const;/.test(readFileSync("scripts/lib/synthetic-operator.files.ts", "utf8")));
check("every interactive transaction carries the remote-target bounds (TX_OPTIONS: maxWait 10 s, timeout 60 s)",
  /const TX_OPTIONS = \{ maxWait: 10_000, timeout: 60_000 \} as const;/.test(src)
    && (src.match(/db\.\$transaction\(/g) ?? []).length === 5 && (src.match(/\}, TX_OPTIONS\)/g) ?? []).length === 5);
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

// ══ PROFILE e0-live (S2 ruling R-1) ══════════════════════════════════════════

console.log("\nsynthetic operator — e0-live profile: the gate (Preview only)\n");
const E0 = (...a: string[]) => ["--profile=e0-live", ...a];
const d0 = decideSyntheticOperator(E0("--env=preview", "--provision"), PREV);
check("--profile=e0-live --env=preview --provision on a non-Production Supabase target ⇒ allowed, profile e0-live",
  d0.ok && d0.profile === "e0-live" && d0.env === "preview" && d0.command.kind === "provision", d0);
check("e0-live --env=local ⇒ refused even on loopback (Preview-only)", !ok(decideSyntheticOperator(E0("--env=local", "--provision"), LOCAL)));
check("e0-live --env=production ⇒ refused", !ok(decideSyntheticOperator(E0("--env=production", "--provision"), E({ DATABASE_URL: direct(PROD_REF) }))));
check("e0-live --env=preview pointed at the PRODUCTION ref ⇒ refused", !ok(decideSyntheticOperator(E0("--env=preview", "--provision"), E({ DATABASE_URL: direct(PROD_REF) }))));
check("e0-live with FM_PRODUCTION_DB_REF unset ⇒ refused",
  !ok(decideSyntheticOperator(E0("--env=preview", "--provision"), E({ FM_PRODUCTION_DB_REF: undefined, DATABASE_URL: direct(PREV_REF) }))));
check("e0-live with VERCEL_ENV=production ⇒ refused",
  !ok(decideSyntheticOperator(E0("--env=preview", "--provision"), E({ DATABASE_URL: direct(PREV_REF), VERCEL_ENV: "production" }))));
check("e0-live with DATABASE_URL / DIRECT_URL on different databases ⇒ refused",
  !ok(decideSyntheticOperator(E0("--env=preview", "--provision"), E({ DATABASE_URL: direct(PREV_REF), DIRECT_URL: direct(PROD_REF) }))));
check("e0-live --env=preview on a loopback target ⇒ refused (cannot prove Preview)", !ok(decideSyntheticOperator(E0("--env=preview", "--provision"), LOCAL)));
for (const envv of ["staging", "PREVIEW", "", "dev"]) {
  check(`e0-live --env=${envv || "<empty>"} ⇒ refused`, !ok(decideSyntheticOperator(E0(`--env=${envv}`, "--provision"), PREV)));
}
check("e0-live with no --env ⇒ refused", !ok(decideSyntheticOperator(E0("--provision"), PREV)));
for (const p of ["g1", "E0-LIVE", "", "e0-live2", "e0"]) {
  check(`--profile=${p || "<empty>"} ⇒ refused (only e0-live is a profile)`, !ok(decideSyntheticOperator([`--profile=${p}`, "--env=preview", "--provision"], PREV)));
}
check("two --profile flags ⇒ refused", !ok(decideSyntheticOperator(["--profile=e0-live", ...E0("--env=preview", "--provision")], PREV)));
const dRev = decideSyntheticOperator(E0("--env=preview", "--revoke-area=CUSTOMER_SUCCESS", "--operator=rev"), PREV);
check("e0-live --revoke-area=CUSTOMER_SUCCESS --operator=rev ⇒ allowed (no signal)",
  dRev.ok && dRev.profile === "e0-live" && dRev.command.kind === "revoke-area" && dRev.command.area === "CUSTOMER_SUCCESS" && dRev.command.awaitSignal === false, dRev);
const dRevSig = decideSyntheticOperator(E0("--env=preview", "--revoke-area=CUSTOMER_SUCCESS", "--operator=rev", "--await-signal"), PREV);
check("e0-live --revoke-area … --await-signal ⇒ allowed, awaitSignal true",
  dRevSig.ok && dRevSig.profile === "e0-live" && dRevSig.command.kind === "revoke-area" && dRevSig.command.awaitSignal === true, dRevSig);
const dReg = decideSyntheticOperator(E0("--env=preview", "--regrant-area=CUSTOMER_SUCCESS", "--operator=rev"), PREV);
check("e0-live --regrant-area=CUSTOMER_SUCCESS --operator=rev ⇒ allowed",
  dReg.ok && dReg.profile === "e0-live" && dReg.command.kind === "regrant-area" && dReg.command.area === "CUSTOMER_SUCCESS", dReg);
check("e0-live --revoke-area=PLATFORM_OPS --operator=rev ⇒ allowed",
  ok(decideSyntheticOperator(E0("--env=preview", "--revoke-area=PLATFORM_OPS", "--operator=rev"), PREV)));
for (const who of ["ops", "cs1", "cs2", "cs3", "REV", "synthetic", ""]) {
  check(`e0-live --revoke-area --operator=${who || "<empty>"} ⇒ refused (rev only)`,
    !ok(decideSyntheticOperator(E0("--env=preview", "--revoke-area=CUSTOMER_SUCCESS", `--operator=${who}`), PREV)));
  check(`e0-live --regrant-area --operator=${who || "<empty>"} ⇒ refused (rev only)`,
    !ok(decideSyntheticOperator(E0("--env=preview", "--regrant-area=CUSTOMER_SUCCESS", `--operator=${who}`), PREV)));
}
check("e0-live --revoke-area without --operator ⇒ refused", !ok(decideSyntheticOperator(E0("--env=preview", "--revoke-area=CUSTOMER_SUCCESS"), PREV)));
check("e0-live --regrant-area without --operator ⇒ refused", !ok(decideSyntheticOperator(E0("--env=preview", "--regrant-area=CUSTOMER_SUCCESS"), PREV)));
for (const area of ["SECURITY_OPS", "MERCHANT_OPS", "GROWTH_REVENUE", "SYSTEM_ADMIN", "customer_success", ""]) {
  check(`e0-live --revoke-area=${area || "<empty>"} --operator=rev ⇒ refused`,
    !ok(decideSyntheticOperator(E0("--env=preview", `--revoke-area=${area}`, "--operator=rev"), PREV)));
  check(`e0-live --regrant-area=${area || "<empty>"} --operator=rev ⇒ refused`,
    !ok(decideSyntheticOperator(E0("--env=preview", `--regrant-area=${area}`, "--operator=rev"), PREV)));
}
check("--await-signal with --regrant-area ⇒ refused",
  !ok(decideSyntheticOperator(E0("--env=preview", "--regrant-area=CUSTOMER_SUCCESS", "--operator=rev", "--await-signal"), PREV)));
check("--await-signal with --provision ⇒ refused", !ok(decideSyntheticOperator(E0("--env=preview", "--provision", "--await-signal"), PREV)));
check("--await-signal=yes ⇒ refused",
  !ok(decideSyntheticOperator(E0("--env=preview", "--revoke-area=CUSTOMER_SUCCESS", "--operator=rev", "--await-signal=yes"), PREV)));
check("--operator with --provision ⇒ refused", !ok(decideSyntheticOperator(E0("--env=preview", "--provision", "--operator=rev"), PREV)));
check("--operator with --cleanup ⇒ refused",
  !ok(decideSyntheticOperator(E0("--env=preview", "--cleanup", "--record=/x/synthetic-operator-e0l-20261110T080000Z", "--operator=rev"), PREV)));
check("e0-live revoke + regrant together ⇒ refused",
  !ok(decideSyntheticOperator(E0("--env=preview", "--revoke-area=CUSTOMER_SUCCESS", "--regrant-area=CUSTOMER_SUCCESS", "--operator=rev"), PREV)));
check("e0-live --cleanup without --record ⇒ refused", !ok(decideSyntheticOperator(E0("--env=preview", "--cleanup"), PREV)));
const dClean = decideSyntheticOperator(E0("--env=preview", "--cleanup", "--record=/x/synthetic-operator-e0l-20261110T080000Z"), PREV);
check("e0-live --cleanup --record=<dir> ⇒ allowed", dClean.ok && dClean.profile === "e0-live" && dClean.command.kind === "cleanup", dClean);
check("e0-live an unknown flag ⇒ refused", !ok(decideSyntheticOperator(E0("--env=preview", "--provision", "--force"), PREV)));
const e0Refusals = JSON.stringify([
  decideSyntheticOperator(E0("--env=preview", "--provision"), E({ DATABASE_URL: direct(PROD_REF) })),
  decideSyntheticOperator(E0("--env=preview", "--provision"), E({ DATABASE_URL: direct(PREV_REF), DIRECT_URL: direct(PROD_REF) })),
  decideSyntheticOperator(E0("--env=local", "--provision"), LOCAL),
]);
check("e0-live refusals name the rule, never a secret, ref, host or URL",
  !e0Refusals.includes(SECRET) && !e0Refusals.includes(PROD_REF) && !e0Refusals.includes(PREV_REF) && !e0Refusals.includes("supabase.co") && !e0Refusals.includes("postgresql://"));

console.log("\nsynthetic operator — the DEFAULT profile can never get CUSTOMER_SUCCESS\n");
check("default: isGrantAllowed(CUSTOMER_SUCCESS, READ) is false", !isGrantAllowed("CUSTOMER_SUCCESS", "READ"));
check("default: FORBIDDEN_AREAS still holds CUSTOMER_SUCCESS, MERCHANT_OPS, SECURITY_OPS",
  ["CUSTOMER_SUCCESS", "MERCHANT_OPS", "SECURITY_OPS"].every((a) => FORBIDDEN_AREAS.has(a)) && FORBIDDEN_AREAS.size === 3);
check("default: the allowlist holds no CUSTOMER_SUCCESS grant", !SYNTHETIC_GRANTS.some((g) => (g.area as string) === "CUSTOMER_SUCCESS"));
check("default: CUSTOMER_SUCCESS is not revocable", !isRevocableArea("CUSTOMER_SUCCESS"));
for (const flag of ["--operator=rev", "--await-signal", "--regrant-area=CUSTOMER_SUCCESS"]) {
  check(`default profile: ${flag.split("=")[0]} ⇒ refused (e0-live only)`,
    !ok(decideSyntheticOperator(["--env=preview", flag, ...(flag.startsWith("--regrant") ? [] : ["--provision"])], PREV)));
}
check("default profile: --revoke-area=CUSTOMER_SUCCESS --operator=rev ⇒ refused",
  !ok(decideSyntheticOperator(["--env=preview", "--revoke-area=CUSTOMER_SUCCESS", "--operator=rev"], PREV)));
const dDef = decideSyntheticOperator(["--env=preview", "--provision"], PREV);
check("default profile decision is labelled g1", dDef.ok && dDef.profile === "g1", dDef);

console.log("\nsynthetic operator — e0-live roster and areas\n");
check("the roster is EXACTLY ops, cs1–cs3, rev with their grants (pinned)",
  JSON.stringify(E0_LIVE_ROSTER.map((o) => [o.role, o.email, o.username, o.grants.map((x) => `${x.area}:${x.level}`)])) === JSON.stringify([
    ["ops", "e0l-ops@example.test", "e0l_ops", ["PLATFORM_OPS:READ"]],
    ["cs1", "e0l-cs1@example.test", "e0l_cs1", ["CUSTOMER_SUCCESS:READ"]],
    ["cs2", "e0l-cs2@example.test", "e0l_cs2", ["CUSTOMER_SUCCESS:READ"]],
    ["cs3", "e0l-cs3@example.test", "e0l_cs3", ["CUSTOMER_SUCCESS:READ"]],
    ["rev", "e0l-rev@example.test", "e0l_rev", ["PLATFORM_OPS:READ", "CUSTOMER_SUCCESS:READ"]],
  ]));
check("the roster and every entry/grant list are frozen",
  Object.isFrozen(E0_LIVE_ROSTER) && E0_LIVE_ROSTER.every((o) => Object.isFrozen(o) && Object.isFrozen(o.grants) && o.grants.every((x) => Object.isFrozen(x))));
check("every roster address is an allowed @example.test address, and all are distinct",
  E0_LIVE_ROSTER.every((o) => isSyntheticEmailAllowed(o.email)) && new Set(E0_LIVE_ROSTER.map((o) => o.email)).size === 5);
check("no roster address or username collides with the default synthetic operator",
  E0_LIVE_ROSTER.every((o) => o.email !== SYNTHETIC_EMAIL && o.username !== "synthetic_operator"));
check("E0_LIVE_AREAS = { PLATFORM_OPS, CUSTOMER_SUCCESS }", JSON.stringify([...E0_LIVE_AREAS].sort()) === JSON.stringify(["CUSTOMER_SUCCESS", "PLATFORM_OPS"]));
check("ALWAYS_FORBIDDEN_AREAS = { MERCHANT_OPS, SECURITY_OPS }", JSON.stringify([...ALWAYS_FORBIDDEN_AREAS].sort()) === JSON.stringify(["MERCHANT_OPS", "SECURITY_OPS"]));
check("isE0LiveGrantAllowed: PLATFORM_OPS READ and CUSTOMER_SUCCESS READ only",
  isE0LiveGrantAllowed("PLATFORM_OPS", "READ") && isE0LiveGrantAllowed("CUSTOMER_SUCCESS", "READ"));
for (const [area, level] of [["SECURITY_OPS", "READ"], ["MERCHANT_OPS", "READ"], ["GROWTH_REVENUE", "READ"], ["SYSTEM_ADMIN", "READ"], ["CUSTOMER_SUCCESS", "WRITE"], ["CUSTOMER_SUCCESS", "CONTROL"], ["PLATFORM_OPS", "WRITE"]]) {
  check(`e0-live grant ${area}:${level} ⇒ not allowed`, !isE0LiveGrantAllowed(area, level));
}
check("isRosterGrant binds each grant to its operator",
  isRosterGrant("ops", "PLATFORM_OPS", "READ") && !isRosterGrant("ops", "CUSTOMER_SUCCESS", "READ")
  && isRosterGrant("cs1", "CUSTOMER_SUCCESS", "READ") && !isRosterGrant("cs1", "PLATFORM_OPS", "READ")
  && isRosterGrant("rev", "PLATFORM_OPS", "READ") && isRosterGrant("rev", "CUSTOMER_SUCCESS", "READ")
  && !isRosterGrant("cs4", "CUSTOMER_SUCCESS", "READ") && !isRosterGrant("synthetic", "PLATFORM_OPS", "READ"));
check("flip areas = rev's own grants only",
  isE0LiveFlipArea("CUSTOMER_SUCCESS") && isE0LiveFlipArea("PLATFORM_OPS") && !isE0LiveFlipArea("GROWTH_REVENUE") && !isE0LiveFlipArea("SECURITY_OPS"));
check("the flip operator is rev", E0_LIVE_FLIP_OPERATOR === "rev" && e0LiveOperator("rev")?.grants.length === 2 && e0LiveOperator("nobody") === null);
check("roster areas/levels exist in prisma PlatformArea / PlatformAccessLevel",
  E0_LIVE_ROSTER.every((o) => o.grants.every((x) => enumBody("PlatformArea").includes(x.area) && enumBody("PlatformAccessLevel").includes(x.level))));
check("the roster is never SYSTEM_ADMIN: the only role written is USER", SYNTHETIC_ROLE === "USER" && E0_LIVE_PROFILE === "e0-live");

console.log("\nsynthetic operator — e0-live deadline, records, signal, regrant\n");
check("same-day deadline: 08:15Z ⇒ that UTC day 23:59:59Z",
  computeE0LiveDeadline(new Date("2026-11-10T08:15:00Z")).toISOString() === "2026-11-10T23:59:59.000Z");
check("same-day deadline: 00:00:00Z ⇒ same day", computeE0LiveDeadline(new Date("2026-11-10T00:00:00Z")).toISOString() === "2026-11-10T23:59:59.000Z");
check("same-day deadline: 23:59:59.5Z ⇒ already passed (provision refuses)",
  computeE0LiveDeadline(new Date("2026-11-10T23:59:59.500Z")).getTime() <= new Date("2026-11-10T23:59:59.500Z").getTime());
check("same-day deadline never crosses into the next UTC day (and is not the 14-day G1 window)",
  computeE0LiveDeadline(new Date("2026-11-10T22:00:00Z")).getTime() - new Date("2026-11-10T22:00:00Z").getTime() < 24 * 3600 * 1000
  && computeE0LiveDeadline(new Date("2026-11-10T22:00:00Z")).getTime() < computeCleanupDeadline(new Date("2026-11-10T22:00:00Z")).getTime());
const e0dir = e0LiveDirFor("/home/x/FourthMeridian-private", t0);
check("e0-live private dir = synthetic-operator-e0l-<UTC stamp>", path.basename(e0dir) === "synthetic-operator-e0l-20261105T120000Z");
check("e0-live --record must be a synthetic-operator-e0l-<stamp> directly inside the private base",
  e0LiveRecordDirRefusal(e0dir, "/home/x/FourthMeridian-private") === null
  && e0LiveRecordDirRefusal("/home/x/FourthMeridian-private/synthetic-operator-20261105T120000Z", "/home/x/FourthMeridian-private") !== null
  && e0LiveRecordDirRefusal("/tmp/synthetic-operator-e0l-20261105T120000Z", "/home/x/FourthMeridian-private") !== null
  && e0LiveRecordDirRefusal(path.join(e0dir, "rev"), "/home/x/FourthMeridian-private") !== null);
check("the default profile's --record refuses an e0-live directory", recordDirRefusal(e0dir, "/home/x/FourthMeridian-private") !== null);
check("per-operator sub-directory = <dir>/<role>", e0LiveOperatorDir(e0dir, "cs2") === path.join(e0dir, "cs2"));
const goodRec = {
  kind: "synthetic-operator-e0l-record", profile: "e0-live", role: "cs1", env: "preview", targetHash: "abcd1234abcd1234",
  email: "e0l-cs1@example.test", userId: "cabc12345678", grantIds: {}, provisionedAt: t0.toISOString(), cleanupDeadline: t0.toISOString(),
};
const parses = (raw: unknown, role: "ops" | "cs1" | "cs2" | "cs3" | "rev") => { try { parseE0LiveRecord(raw, role); return true; } catch { return false; } };
check("an e0-live record parses for its own role", parses(goodRec, "cs1"));
check("an e0-live record is refused under another role", !parses(goodRec, "cs2"));
check("an e0-live record whose email is another roster address is refused", !parses({ ...goodRec, email: "e0l-cs2@example.test" }, "cs1"));
check("an e0-live record naming a non-@example.test user is refused", !parses({ ...goodRec, email: "owner@gmail.com" }, "cs1"));
check("an e0-live record with env local is refused", !parses({ ...goodRec, env: "local" }, "cs1"));
check("a default-profile record is not an e0-live record", !parses({ ...goodRec, kind: "synthetic-operator-record" }, "cs1"));
check("signal: exactly REVOKE (whitespace-trimmed) releases the revoke",
  classifySignalLine("REVOKE") === "go" && classifySignalLine("REVOKE\r") === "go" && classifySignalLine("  REVOKE ") === "go" && AWAIT_SIGNAL_GO === "REVOKE");
for (const line of ["", "revoke", "REVOKE now", "GO", "yes", "REVOKED"]) {
  check(`signal ${JSON.stringify(line)} ⇒ abort (nothing changed)`, classifySignalLine(line) === "abort");
}
check("signal wait is bounded (≤ 15 minutes)", AWAIT_SIGNAL_MAX_MS > 0 && AWAIT_SIGNAL_MAX_MS <= 15 * 60 * 1000);
check("regrant: no row ⇒ PLATFORM_GRANT_CREATED", regrantAuditAction(null) === "PLATFORM_GRANT_CREATED");
check("regrant: REVOKED row ⇒ PLATFORM_GRANT_REINSTATED (the app grant route's classification)", regrantAuditAction({ status: "REVOKED" }) === "PLATFORM_GRANT_REINSTATED");
check("regrant: ACTIVE row ⇒ refused (null)", regrantAuditAction({ status: "ACTIVE" }) === null);
check("the app grant route classifies a REVOKED re-grant as REINSTATED (parity source)",
  /existing\.status === "REVOKED"[\s\S]{0,80}PLATFORM_GRANT_REINSTATED/.test(readFileSync(path.join(ROOT, "app/api/admin/platform-grants/route.ts"), "utf8")));

console.log("\nsynthetic operator — e0-live private files (one 0700 sub-dir per operator)\n");
const tmpBase2 = mkdtempSync(path.join(os.tmpdir(), "fm-synth-e0l-test-"));
const prevUmask2 = process.umask(0o022);
try {
  const roster = e0LiveDirFor(path.join(tmpBase2, "FourthMeridian-private"), t0);
  createPrivateDir(roster);
  const files: string[] = [];
  for (const o of E0_LIVE_ROSTER) {
    const d = e0LiveOperatorDir(roster, o.role);
    createPrivateDir(d);
    files.push(writePrivateJson(d, "credentials.json", { password: "x".repeat(32) }, true));
  }
  check("roster dir is 0700", (statSync(roster).mode & 0o777) === 0o700);
  check("every operator sub-dir is 0700", E0_LIVE_ROSTER.every((o) => (statSync(e0LiveOperatorDir(roster, o.role)).mode & 0o777) === 0o700));
  check("every operator credential file is 0600", files.every((f) => (statSync(f).mode & 0o777) === 0o600));
  check("the process umask is restored", process.umask() === 0o022);
} finally {
  process.umask(prevUmask2);
  rmSync(tmpBase2, { recursive: true, force: true });
}

console.log("\nsynthetic operator — e0-live: the script refuses before contact\n");
for (const argv of [
  E0("--env=local", "--provision"),
  E0("--env=preview", "--revoke-area=CUSTOMER_SUCCESS", "--operator=cs1"),
  E0("--env=preview", "--regrant-area=SECURITY_OPS", "--operator=rev"),
  ["--env=preview", "--regrant-area=CUSTOMER_SUCCESS", "--operator=rev"],
]) {
  const rr = spawnSync(process.execPath, [...process.execArgv, SCRIPT, ...argv], {
    encoding: "utf8", env: { ...process.env, DATABASE_URL: direct(PREV_REF), DIRECT_URL: "", FM_PRODUCTION_DB_REF: PROD_REF },
  });
  check(`${argv.join(" ")} exits 2 with 'nothing was contacted'`, rr.status === 2 && /REFUSED — nothing was contacted/.test(rr.stderr), { status: rr.status, err: rr.stderr.slice(0, 300) });
}

console.log("\nsynthetic operator — e0-live source pins\n");
const between = (a: string, b: string) => src.slice(src.indexOf(a), src.indexOf(b));
const e0ProvBody = between("async function provisionE0Live(", "const FLIP_OP =");
check("e0-live provision: ALL roster operators in ONE $transaction through the shared registration writer, each grant via isRosterGrant",
  /db\.\$transaction\(async \(tx\) => \{[\s\S]*for \(const p of plan\)[\s\S]*createOperatorInTx\(tx, reg, p\.op, p\.op\.grants, \(a, l\) => isRosterGrant\(p\.op\.role, a, l\), p\.passwordHash, now\)/.test(e0ProvBody));
check("e0-live provision: refuses when any roster address/username exists; refuses past the same-day deadline",
  /an e0-live roster operator already exists/.test(e0ProvBody) && /computeE0LiveDeadline\(now\)/.test(e0ProvBody) && /same-day cleanup deadline has passed/.test(e0ProvBody));
check("e0-live provision: secrets on disk BEFORE the transaction; every credential shredded if it fails",
  e0ProvBody.indexOf("writePrivateJson(p.dir, CREDENTIALS_FILE, credentials(p, null, {}), true)") < e0ProvBody.indexOf("db.$transaction(")
  && /catch \(e\) \{\s*for \(const p of plan\) shredFile\(path\.join\(p\.dir, CREDENTIALS_FILE\)\);\s*throw e;/.test(e0ProvBody));
check("e0-live provision: post-check — each operator's shape, and no area outside PLATFORM_OPS / CUSTOMER_SUCCESS",
  /checkOperatorShape\(db, created\[i\]\.userId, p\.op\.grants/.test(e0ProvBody) && /area: \{ notIn: \["PLATFORM_OPS", "CUSTOMER_SUCCESS"\] \}/.test(e0ProvBody));
const flipBody = between("const FLIP_OP =", "async function cleanupE0Live(");
check("revoke/regrant resolve ONLY the rev roster address",
  /const FLIP_OP = E0_LIVE_ROSTER\.find\(\(o\) => o\.role === E0_LIVE_FLIP_OPERATOR\)!;/.test(flipBody)
  && (flipBody.match(/where: \{ email:/g) ?? []).length === 1 && /where: \{ email: FLIP_OP\.email \}/.test(flipBody));
check("revoke (e0-live) flips through the shared audited revokeGrants; --await-signal waits BEFORE the flip",
  /await revokeGrants\(db, u\.id, area\)/.test(flipBody)
  && flipBody.indexOf("await awaitSignal()") > 0 && flipBody.indexOf("await awaitSignal()") < flipBody.indexOf("await revokeGrants(db, u.id, area)")
  && /classifySignalLine\(buf\.slice\(0, nl\)\) === "go"/.test(flipBody) && /setTimeout\(\(\) => done\(false\), AWAIT_SIGNAL_MAX_MS\)/.test(flipBody));
check("regrant: the grant upsert and its CREATED/REINSTATED audit row are in ONE $transaction, classified by regrantAuditAction",
  /db\.\$transaction\(async \(tx\) => \{[\s\S]*regrantAuditAction\(existing\)[\s\S]*tx\.platformGrant\.upsert\([\s\S]*tx\.auditLog\.create\([\s\S]*AuditAction\.PLATFORM_GRANT_REINSTATED/.test(flipBody)
  && /grantedById: null/.test(flipBody) && /performedByAdminId: null/.test(flipBody));
const e0CleanBody = src.slice(src.indexOf("async function cleanupE0Live("), src.indexOf("async function main("));
check("e0-live cleanup: preflights EVERY operator (identity + REVOKED-item guard) before purging any",
  e0CleanBody.indexOf("providerConnectionBlocksCleanup(items.map") > 0
  && e0CleanBody.indexOf("providerConnectionBlocksCleanup(items.map") < e0CleanBody.indexOf("await purgeOperator("));
check("e0-live cleanup reuses the SAME per-user cleanup (purgeOperator) as the default profile",
  /await purgeOperator\(db, r\.record\.userId, r\.op\.email, r\.dir, "preview"/.test(e0CleanBody)
  && /const rc = await purgeOperator\(db, record\.userId, SYNTHETIC_EMAIL, recordDir, env, ""\);/.test(src));
const purgeBody = src.slice(src.indexOf("async function purgeOperator("), src.indexOf("function printPurgeDispatch("));
check("the shared per-user cleanup keeps the REVOKED-item guard, the zero-grace stamp bound to the expected address, and the shred",
  /providerConnectionBlocksCleanup\(plaidItems\.map\(\(i\) => i\.status\)\)/.test(purgeBody)
  && /where: \{ id: u\.id, email: expectedEmail, role: "USER" \}/.test(purgeBody)
  && /for \(const f of SECRET_FILES\) shredFile\(path\.join\(opDir, f\)\);/.test(purgeBody));

if (failures) { console.error(`\n${failures} check(s) failed, ${passed} passed`); process.exit(1); }
console.log(`\nall ${passed} checks passed`);
