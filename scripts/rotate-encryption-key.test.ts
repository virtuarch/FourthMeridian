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
  const same = run(["--env=local"], { DATABASE_URL: LOCAL, ENCRYPTION_KEY_PREVIOUS: KEY });
  check("ENCRYPTION_KEY_PREVIOUS EQUAL to ENCRYPTION_KEY is refused by the script (the app only warns)",
    refused(same, /ENCRYPTION_KEY_PREVIOUS equals ENCRYPTION_KEY/), same.stderr);
  const noop = run(["--env=local", "--apply"], { DATABASE_URL: LOCAL });
  check("--apply with ENCRYPTION_KEY_PREVIOUS unset is a NO-OP: exit 0, 'no rotation in progress — nothing to do', before any database contact",
    noop.status === 0 && /no rotation in progress — nothing to do/.test(noop.stdout) && /no audit row/.test(noop.stdout) && !/REFUSED/.test(noop.stderr), `${noop.status} ${noop.stdout} ${noop.stderr}`);
  const noopSame = run(["--env=local", "--apply"], { DATABASE_URL: LOCAL, ENCRYPTION_KEY_PREVIOUS: KEY });
  check("--apply with PREVIOUS EQUAL to the current key is the same NO-OP (exit 0) and still prints the equal-key warning",
    noopSame.status === 0 && /no rotation in progress — nothing to do/.test(noopSame.stdout) && /ENCRYPTION_KEY_PREVIOUS equals ENCRYPTION_KEY/.test(noopSame.stdout), `${noopSame.status} ${noopSame.stdout} ${noopSame.stderr}`);
  const dryUnset = run(["--env=local"], { DATABASE_URL: LOCAL });
  check("…while a dry run with PREVIOUS unset is unchanged (it proceeds to the database; here the unreachable target makes it exit 1, never 0)",
    dryUnset.status === 1 && !/nothing to do/.test(dryUnset.stdout), `${dryUnset.status}`);
  const all = [noop, noopSame, dryUnset, same, both, noEnv, typo, prodNoAck, ackElsewhere, prodApplyNoTicket, prodApplyNoExpect, previewIsProd, noRef, localRemote, cloneGuard, vercelProd, badBatch, noKey, badPrev];
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

/**
 * 4. The engine across a whole rotation, against an IN-MEMORY table (one field:
 * User.totpSecret) that answers exactly the SQL the engine sends. The real
 * Postgres proof is scripts/encryption-key-rotation-acceptance.ts; this pins the
 * write-format rules without Docker.
 */
async function engineAcrossTheRotation(): Promise<void> {
  console.log("4. the engine across a rotation — kid-less values re-encrypted to v3; v2 writes outside a rotation are never churned");
  const { runKeyRotation } = await import("./lib/rotate-encryption-key.core");
  const enc = await import("@/lib/plaid/encryption");
  const P = enc.EncryptionPurpose.TOTP_SECRET;
  const nodeCrypto = await import("node:crypto");
  const OLD = randomBytes(32).toString("hex"), NEW = randomBytes(32).toString("hex");
  const kidOf = (hex: string) => enc.keyIdOf(Buffer.from(hex, "hex"));
  const keys = <T>(current: string, previous: string | undefined, fn: () => T): T => {
    const saved = { c: process.env.ENCRYPTION_KEY, p: process.env.ENCRYPTION_KEY_PREVIOUS };
    process.env.ENCRYPTION_KEY = current;
    if (previous === undefined) delete process.env.ENCRYPTION_KEY_PREVIOUS; else process.env.ENCRYPTION_KEY_PREVIOUS = previous;
    try { return fn(); } finally {
      process.env.ENCRYPTION_KEY = saved.c;
      if (saved.p === undefined) delete process.env.ENCRYPTION_KEY_PREVIOUS; else process.env.ENCRYPTION_KEY_PREVIOUS = saved.p;
    }
  };
  const keysAsync = async <T>(current: string, previous: string | undefined, fn: () => Promise<T>): Promise<T> => {
    const saved = { c: process.env.ENCRYPTION_KEY, p: process.env.ENCRYPTION_KEY_PREVIOUS };
    process.env.ENCRYPTION_KEY = current;
    if (previous === undefined) delete process.env.ENCRYPTION_KEY_PREVIOUS; else process.env.ENCRYPTION_KEY_PREVIOUS = previous;
    try { return await fn(); } finally {
      process.env.ENCRYPTION_KEY = saved.c;
      if (saved.p === undefined) delete process.env.ENCRYPTION_KEY_PREVIOUS; else process.env.ENCRYPTION_KEY_PREVIOUS = saved.p;
    }
  };
  const v1Under = (key: string, plain: string) => {
    const iv = nodeCrypto.randomBytes(16);
    const c = nodeCrypto.createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
    const e = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return [iv.toString("hex"), c.getAuthTag().toString("hex"), e.toString("hex")].join(":");
  };

  // The table: id → totpSecret. `writes` counts every UPDATE the engine lands.
  const table = new Map<string, string | null>();
  let writes = 0, calls = 0, audits = 0;
  const client = {
    async $queryRawUnsafe<T>(sql: string, ...v: unknown[]): Promise<T> {
      calls++;
      if (/FROM pg_roles/.test(sql)) return [{ ok: true }] as T;
      let m = /^SELECT "id", "totpSecret" AS v FROM "User" WHERE "id" > \$1 ORDER BY "id" ASC LIMIT (\d+)$/.exec(sql);
      if (m) {
        const lim = Number(m[1]);
        return [...table.keys()].sort().filter((id) => id > String(v[0])).slice(0, lim).map((id) => ({ id, v: table.get(id) ?? null })) as T;
      }
      m = /^SELECT "totpSecret" AS v FROM "User" WHERE "id" = \$1$/.exec(sql);
      if (m) return (table.has(String(v[0])) ? [{ v: table.get(String(v[0])) ?? null }] : []) as T;
      throw new Error(`unexpected query: ${sql}`);
    },
    async $executeRawUnsafe(sql: string, ...v: unknown[]): Promise<number> {
      calls++;
      if (/^INSERT INTO "AuditLog"/.test(sql)) { audits++; return 1; }
      if (/^UPDATE "User" SET "totpSecret" = \$1 WHERE "id" = \$2 AND "totpSecret" = \$3$/.test(sql)) {
        const [next, id, old] = v as [string, string, string];
        if (table.get(id) !== old) return 0;
        table.set(id, next); writes++; return 1;
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  };
  const run = (current: string, previous: string | undefined, opts: { apply?: boolean; verifyComplete?: boolean }) =>
    keysAsync(current, previous, () => runKeyRotation(client, { apply: !!opts.apply, verifyComplete: opts.verifyComplete, fields: ["User.totpSecret"], batchSize: 2 }));

  // BEFORE (b): the app has written v2 under OLD; the script with OLD alone writes nothing.
  table.set("a", keys(OLD, undefined, () => enc.encryptWithPurpose("seed-a", P)));          // app write, pre-rotation (kid-less v2)
  table.set("b", v1Under(OLD, "seed-b"));                                                  // legacy v1 under OLD
  check("precondition: the pre-rotation application write is v2", enc.detectCiphertextVersion(table.get("a")!) === "v2");
  const pre = await run(OLD, undefined, { apply: true });
  check("before (b): an apply with PREVIOUS unset is a NO-OP (NO_ROTATION): no query, no write, no audit row — B9 can still read every value",
    pre.outcome === "NO_ROTATION" && calls === 0 && writes === 0 && audits === 0, `${pre.outcome} calls=${calls}`);
  const preSame = await run(OLD, OLD, { apply: true });
  check("an apply with PREVIOUS EQUAL to the current key is the same NO-OP", preSame.outcome === "NO_ROTATION" && calls === 0 && audits === 0);
  const { summarizeRotation: summarize } = await import("./lib/rotate-encryption-key.core");
  check("the NO-OP summary says 'no rotation in progress — nothing to do'", /no rotation in progress — nothing to do/.test(summarize(pre, "local")));
  const preDry = await run(OLD, undefined, {});
  check("…while a dry run with PREVIOUS unset is unchanged: it scans (0 to re-encrypt, the kid-less values are current)",
    preDry.outcome === "DRY_RUN" && calls > 0 && preDry.totals.scanned === 2 && preDry.totals.candidates === 0 && audits === 0, JSON.stringify(preDry.totals));
  const preVerify = await run(OLD, undefined, { verifyComplete: true });
  check("…and --verify-complete with PREVIOUS unset is unchanged (VERIFIED_COMPLETE)", preVerify.outcome === "VERIFIED_COMPLETE");

  // During the rotation (b)–(c): NEW current, OLD previous.
  table.set("c", keys(NEW, undefined, () => enc.encryptWithPurpose("seed-c", P)));          // kid-less v2 under NEW
  table.set("d", keys(OLD, randomBytes(32).toString("hex"), () => enc.encryptWithPurpose("seed-d", P))); // v3 under OLD (an earlier rotation)
  table.set("e", keys(NEW, OLD, () => enc.encryptWithPurpose("seed-e", P)));                // v3 written during THIS rotation
  const eBefore = table.get("e");
  check("precondition: a write during the rotation is v3 under the NEW kid", enc.ciphertextKeyId(eBefore!) === kidOf(NEW));
  const dry = await run(NEW, OLD, {});
  check("during the rotation: candidates = the kid-less values (both keys) + the old-kid v3; blocking = those only PREVIOUS opens",
    dry.totals.candidates === 4 && dry.totals.blocking === 3 && dry.fields[0].legacy.v2 === 2 && dry.fields[0].legacy.v1 === 1, JSON.stringify(dry.fields[0]));
  const notYet = await run(NEW, OLD, { verifyComplete: true });
  check("--verify-complete is NOT COMPLETE while a kid-less value opens only under PREVIOUS", notYet.outcome === "NOT_COMPLETE");
  const apply = await run(NEW, OLD, { apply: true });
  check("the apply re-encrypts all 4 (including the kid-less v2/v1 that open ONLY under PREVIOUS) and verifies each read-back",
    apply.outcome === "COMPLETE" && apply.totals.rotated === 4 && writes === 4, JSON.stringify(apply.totals));
  check("every re-encrypted value is v3 under the NEW kid with its original plaintext",
    ["a", "b", "c", "d"].every((id) => enc.ciphertextKeyId(table.get(id)!) === kidOf(NEW)
      && keys(NEW, undefined, () => enc.decryptWithPurpose(table.get(id)!, P)) === `seed-${id}`));
  check("the value already under the current kid was not rewritten", table.get("e") === eBefore);

  // AFTER (d): PREVIOUS removed. Writes revert to v2 under NEW; v3 from the rotation still reads.
  table.set("f", keys(NEW, undefined, () => enc.encryptWithPurpose("seed-f", P)));
  check("after (d): the application writes v2 under the new key", enc.detectCiphertextVersion(table.get("f")!) === "v2");
  const w0 = writes;
  const verified = await run(NEW, undefined, { verifyComplete: true });
  check("after (d): --verify-complete accepts the kid-less v2 the current key opens (VERIFIED_COMPLETE, 0 blocking)",
    verified.outcome === "VERIFIED_COMPLETE" && verified.totals.blocking === 0 && verified.fields[0].legacy.v2 === 1, JSON.stringify(verified.fields[0]));
  const a0 = audits;
  const idle = await run(NEW, undefined, { apply: true });
  check("after (d): an apply is the NO-OP and writes nothing, not even an audit row (v2 writes are not churned)", idle.outcome === "NO_ROTATION" && writes === w0 && audits === a0);
  const idleDry = await run(NEW, undefined, {});
  check("after (d): the dry run reports 0 to re-encrypt with the kid-less v2 counted as current", idleDry.totals.candidates === 0 && idleDry.fields[0].legacy.v2 === 1);
  check("after (d): every v3 value written during the rotation is still v3 and reads under the new key alone",
    ["a", "b", "c", "d", "e"].every((id) => enc.detectCiphertextVersion(table.get(id)!) === "v3"
      && keys(NEW, undefined, () => enc.decryptWithPurpose(table.get(id)!, P)) === `seed-${id}`));
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
    // A v3 under the current kid, as written during a rotation (a distinct throwaway PREVIOUS).
    const asRotating = <T>(current: string, fn: () => T): T => {
      const saved = { c: process.env.ENCRYPTION_KEY, p: process.env.ENCRYPTION_KEY_PREVIOUS };
      process.env.ENCRYPTION_KEY = current; process.env.ENCRYPTION_KEY_PREVIOUS = randomBytes(32).toString("hex");
      try { return fn(); } finally {
        process.env.ENCRYPTION_KEY = saved.c;
        if (saved.p === undefined) delete process.env.ENCRYPTION_KEY_PREVIOUS; else process.env.ENCRYPTION_KEY_PREVIOUS = saved.p;
      }
    };
    const v3 = asRotating(KEY, () => encryptWithPurpose("seed-plaintext", EncryptionPurpose.TOTP_SECRET));
    check("a current-kid value is 'current' (not a candidate)", classifyValue(totp, v3, kid, null).kind === "current" && classifyValue(totp, v3, kid, "0badc0de").kind === "current");
    const appV2 = encryptWithPurpose("seed-plaintext", EncryptionPurpose.TOTP_SECRET);
    check("outside a rotation the application writes v2, and that value is 'current' (never re-encrypted to v3, never blocking)",
      appV2.startsWith("v2:") && classifyValue(totp, appV2, kid, null).kind === "current");
    check("NULL and '' are empty", classifyValue(totp, null, kid, null).kind === "empty" && classifyValue(totp, "", kid, null).kind === "empty");
    check("a non-ciphertext is unrecognised and never a candidate", classifyValue(totp, "xpub-like-value", kid, null).kind === "unrecognised");
    const foreign = asRotating(randomBytes(32).toString("hex"), () => encryptWithPurpose("x", EncryptionPurpose.TOTP_SECRET));
    check("an unknown kid is unreadable", classifyValue(totp, foreign, kid, null).kind === "unreadable");
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

    await engineAcrossTheRotation();

    console.log("");
    if (failures === 0) { console.log("rotate-encryption-key: all cases passed."); process.exit(0); }
    console.log(`${failures} failure(s).`);
    process.exit(1);
  })().catch((e) => { console.error(e); process.exit(1); });
}
