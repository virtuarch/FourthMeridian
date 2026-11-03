/**
 * scripts/encryption-key-rotation-acceptance.ts  (PRIV-004 — the rotation, against a REAL Postgres)
 *
 * scripts/rotate-encryption-key.test.ts proves the CLI's refusals without a
 * database. This suite proves the part that only a database can: that the
 * script re-encrypts exactly the registered columns, CAS-guards every write on
 * the old ciphertext, verifies by reading back, leaves non-ciphertext alone, is
 * idempotent, and fails closed on a key id it does not hold.
 *
 * It builds its OWN throwaway Postgres (scripts/lib/rls-harness.ts: a fresh
 * container carrying the committed migrations, removed afterwards with
 * `docker rm -f -v`) and refuses to fall back to any configured database. Every
 * key is generated here, per run (crypto.randomBytes); no real key is read.
 *
 *   [cli]     the real script, spawned as an operator would run it
 *   [engine]  scripts/lib/rotate-encryption-key.core.ts driven directly (for the
 *             concurrent-write seam)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/encryption-key-rotation-acceptance.ts [--keep]
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { makeRecorder, prepareHarness, psql, teardownHarness } from "./lib/rls-harness";

const KEEP = process.argv.includes("--keep");
const { check, report } = makeRecorder();
const ROOT = process.cwd();

const OLD = randomBytes(32).toString("hex");
const NEW = randomBytes(32).toString("hex");
const STRANGER = randomBytes(32).toString("hex");

function withKeys<T>(current: string, previous: string | undefined, fn: () => T): T {
  const saved = { c: process.env.ENCRYPTION_KEY, p: process.env.ENCRYPTION_KEY_PREVIOUS };
  process.env.ENCRYPTION_KEY = current;
  if (previous === undefined) delete process.env.ENCRYPTION_KEY_PREVIOUS; else process.env.ENCRYPTION_KEY_PREVIOUS = previous;
  try { return fn(); } finally {
    process.env.ENCRYPTION_KEY = saved.c;
    if (saved.p === undefined) delete process.env.ENCRYPTION_KEY_PREVIOUS; else process.env.ENCRYPTION_KEY_PREVIOUS = saved.p;
  }
}

const sqlStr = (v: string | null) => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);

async function main(): Promise<number> {
  console.log("\n=== ENCRYPTION KEY ROTATION — THROWAWAY POSTGRES ACCEPTANCE ===\n");
  const h = prepareHarness("keyrot");
  const owner = h.ownerUrl;
  const one = (sql: string) => { const r = psql(owner, sql); if (!r.ok) throw new Error(`fixture SQL failed: ${r.err}`); return r.out; };

  const enc = await import("@/lib/plaid/encryption");
  const { EncryptionPurpose: P } = enc;
  const crypto = await import("node:crypto");
  const kid = (hex: string) => enc.keyIdOf(Buffer.from(hex, "hex"));
  const v2Under = (key: string, plain: string, purpose: string) => {
    const sub = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(key, "hex"), Buffer.alloc(0), purpose, 32));
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv("aes-256-gcm", sub, iv);
    const e = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return ["v2", iv.toString("hex"), c.getAuthTag().toString("hex"), e.toString("hex")].join(":");
  };
  const v1Under = (key: string, plain: string) => {
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
    const e = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return [iv.toString("hex"), c.getAuthTag().toString("hex"), e.toString("hex")].join(":");
  };
  // v3 is written only DURING a rotation (a distinct PREVIOUS set); outside one the
  // application writes v2 (B10 rollback safety). v3Under = a write made while `key`
  // was the current key of some rotation; appUnder = the application's ordinary write.
  const v3Under = (key: string, plain: string, purpose: typeof P[keyof typeof P]) => withKeys(key, randomBytes(32).toString("hex"), () => enc.encryptWithPurpose(plain, purpose));
  const appUnder = (key: string, plain: string, purpose: typeof P[keyof typeof P]) => withKeys(key, undefined, () => enc.encryptWithPurpose(plain, purpose));
  const sealUnder = (key: string, plain: string, purpose: typeof P[keyof typeof P]) => withKeys(key, undefined, () => enc.sealWithPurpose(plain, purpose));

  // ── fixtures: every registered column, every format, plus what must NOT be touched ──
  const XPUB = "xpub-watch-only-descriptor-in-clear";
  const plain = {
    u1t: "totp-seed-u1", u2t: "totp-seed-u2", u3t: "totp-seed-u3", u4t: "totp-seed-u4",
    u1d: "1990-01-01", u2d: "1991-02-02",
    tok1: "access-sandbox-tok1", tok2: "access-sandbox-tok2",
    cred: "access-sandbox-cred", ev: JSON.stringify({ evidence: "payload" }),
  };
  const fixture = {
    u1t: v3Under(OLD, plain.u1t, P.TOTP_SECRET),         // v3 under the previous kid
    u2t: appUnder(OLD, plain.u2t, P.TOTP_SECRET),        // the app's own pre-rotation write (kid-less v2) under previous
    u3t: v1Under(OLD, plain.u3t),                         // legacy v1 under previous
    u4t: v3Under(NEW, plain.u4t, P.TOTP_SECRET),         // already current — must not be rewritten
    u1d: v2Under(NEW, plain.u1d, P.DATE_OF_BIRTH),       // legacy v2 under CURRENT — re-encrypted to v3
    u2d: v3Under(OLD, plain.u2d, P.DATE_OF_BIRTH),
    tok1: v3Under(OLD, plain.tok1, P.PLAID_ACCESS_TOKEN),
    tok2: v2Under(OLD, plain.tok2, P.PLAID_ACCESS_TOKEN),
    cred: v3Under(OLD, plain.cred, P.CONNECTION_CREDENTIAL),
    ev: sealUnder(OLD, plain.ev, P.BETA_ABUSE_EVIDENCE),
  };
  one(`insert into "User" (id,email,name,"updatedAt","totpSecret","dateOfBirthEncrypted") values
    ('u1','u1@example.test','U1',now(),${sqlStr(fixture.u1t)},${sqlStr(fixture.u1d)}),
    ('u2','u2@example.test','U2',now(),${sqlStr(fixture.u2t)},${sqlStr(fixture.u2d)}),
    ('u3','u3@example.test','U3',now(),${sqlStr(fixture.u3t)},NULL),
    ('u4','u4@example.test','U4',now(),${sqlStr(fixture.u4t)},NULL),
    ('u5','u5@example.test','U5',now(),NULL,NULL);
  insert into "PlaidItem" (id,"userId","externalItemId","institutionId","institutionName","encryptedToken","updatedAt") values
    ('p1','u1','item-1','ins_1','Test Bank One',${sqlStr(fixture.tok1)},now()),
    ('p2','u2','item-2','ins_2','Test Bank Two',${sqlStr(fixture.tok2)},now()),
    ('p3','u3','item-3','ins_3','Test Bank Three','',now());
  insert into "Connection" (id,"userId",provider,credential,"updatedAt") values
    ('c1','u1','PLAID',${sqlStr(fixture.cred)},now()),
    ('c2','u2','WALLET',${sqlStr(XPUB)},now()),
    ('c3','u3','MANUAL',NULL,now());
  insert into "BetaAbuseEvidence" (id,"sourceRequestId","sealedPayload","capturedById",
    "reasonCode","retainUntil") values ('e1','req-1',${sqlStr(fixture.ev)},'u1','TEST',now() + interval '1 day');`);

  check(0, "[fixture] the application's pre-rotation write is kid-less v2 and v3Under is v3 (the write rule holds before any assertion)",
    enc.detectCiphertextVersion(fixture.u2t) === "v2" && enc.ciphertextKeyId(fixture.u1t) === kid(OLD) && enc.ciphertextKeyId(fixture.u4t) === kid(NEW));

  const snapshot = () => one(`select string_agg(t, E'\\n' order by t) from (
      select 'User.'||id||'.t='||coalesce("totpSecret",'<null>') t from "User"
      union all select 'User.'||id||'.d='||coalesce("dateOfBirthEncrypted",'<null>') from "User"
      union all select 'PlaidItem.'||id||'='||"encryptedToken" from "PlaidItem"
      union all select 'Connection.'||id||'='||coalesce(credential,'<null>') from "Connection"
      union all select 'Evidence.'||id||'='||"sealedPayload" from "BetaAbuseEvidence") s;`);
  const val = (sql: string) => one(sql);

  const cli = (args: string[], keys: { current: string; previous?: string }) => spawnSync(
    path.join(ROOT, "node_modules", ".bin", "tsx"),
    ["--require", "./scripts/lib/server-only-preload.cjs", "scripts/rotate-encryption-key.ts", ...args],
    { cwd: ROOT, encoding: "utf8", timeout: 300_000,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
        DATABASE_URL: `${owner}?schema=public`, DIRECT_URL: `${owner}?schema=public`,
        ENCRYPTION_KEY: keys.current, ...(keys.previous ? { ENCRYPTION_KEY_PREVIOUS: keys.previous } : {}) } as unknown as NodeJS.ProcessEnv },
  );
  const out = (r: ReturnType<typeof cli>) => `${r.stdout}${r.stderr}`;
  // Output contract: counts and kids only — no key, plaintext, ciphertext (any format) or connection string.
  const CIPHER_SHAPE = /\bv[23]:[0-9a-f]{8}|[0-9a-f]{32}:[0-9a-f]{32}|\bc1\.[A-Za-z0-9_-]{8}|[0-9a-f]{64}/i;
  const leaks = (text: string) => CIPHER_SHAPE.test(text) || [OLD, NEW, STRANGER, ...Object.values(plain), ...Object.values(fixture), owner].some((s) => text.includes(s));
  const auditRows = () => Number(val(`select count(*) from "AuditLog" where action = 'ENCRYPTION_KEY_ROTATED';`));
  const lastAudit = () => val(`select metadata::text from "AuditLog" where action = 'ENCRYPTION_KEY_ROTATED' order by "createdAt" desc, id desc limit 1;`);

  // ── 0. [cli] the principal must BYPASS RLS — refused before any scan, for every mode ──
  {
    const pw = randomBytes(18).toString("hex");
    one(`create role fm_rotation_probe login password '${pw}' nobypassrls nosuperuser; grant usage on schema public to fm_rotation_probe;`);
    const u = new URL(owner); u.username = "fm_rotation_probe"; u.password = pw;
    const probe = (args: string[]) => spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"),
      ["--require", "./scripts/lib/server-only-preload.cjs", "scripts/rotate-encryption-key.ts", ...args],
      { cwd: ROOT, encoding: "utf8", timeout: 300_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
        DATABASE_URL: `${u.toString()}?schema=public`, DIRECT_URL: `${u.toString()}?schema=public`, ENCRYPTION_KEY: NEW, ENCRYPTION_KEY_PREVIOUS: OLD } as unknown as NodeJS.ProcessEnv });
    const before = snapshot();
    const results = [probe(["--env=local"]), probe(["--env=local", "--verify-complete"]), probe(["--env=local", "--apply"])];
    check(0, "[cli] a role WITHOUT BYPASSRLS is refused (exit 2, 'the rotation principal must bypass RLS') for dry run, --verify-complete and --apply",
      results.every((r) => r.status === 2 && /the rotation principal must bypass RLS/.test(r.stderr)), results.map((r) => `${r.status} ${r.stderr.slice(-200)}`).join(" | "));
    check(0, "[cli] …and nothing was written, not even an audit row", snapshot() === before && auditRows() === 0);
  }

  // 9 candidates: u1t u2t u3t u1d u2d tok1 tok2 cred ev (u4t current; NULLs, sentinel, WALLET, MANUAL excluded)
  const EXPECTED = 9;

  // ── 1. [cli] DRY RUN: counts per field and per kid; writes nothing ──
  {
    const before = snapshot();
    const r = cli(["--env=local"], { current: NEW, previous: OLD });
    const o = out(r);
    check(1, "[cli] dry run exits 0 and writes nothing (every registered column byte-identical)", r.status === 0 && snapshot() === before, `${r.status} ${o.slice(-800)}`);
    check(1, `[cli] dry run reports ${EXPECTED} to re-encrypt, both kids by role, legacy formats, and 0 unreadable`,
      o.includes(`to re-encrypt ${EXPECTED}`) && o.includes(`kid ${kid(OLD)} (previous)`) && o.includes(`kid ${kid(NEW)} (current)`)
        && o.includes("legacy v2 (no kid)") && o.includes("legacy v1 (no kid)") && o.includes("unreadable 0"), o.slice(-1500));
    check(1, "[cli] the WALLET descriptor is out of scope (Connection scans 2 rows: PLAID + MANUAL)", /Connection\.credential\s+scanned 2 /.test(o), o);
    check(1, "[cli] the output holds no key, plaintext, ciphertext or connection string", !leaks(o));
    const v = cli(["--env=local", "--verify-complete"], { current: NEW, previous: OLD });
    check(1, "[cli] --verify-complete before the apply exits 3 NOT COMPLETE: 8 values would be lost without PREVIOUS (the legacy v2 under the CURRENT key is not blocking), sealed evidence included",
      v.status === 3 && out(v).includes("NOT COMPLETE") && out(v).includes("blocking 8") && /BetaAbuseEvidence\.sealedPayload[\s\S]*?blocking \(lost if PREVIOUS removed now\)\s+1\n/.test(out(v)) && snapshot() === before,
      `${v.status} ${out(v).slice(-900)}`);
    check(1, "[cli] --verify-complete writes nothing and leaks nothing", !leaks(out(v)) && auditRows() === 0);
  }

  // ── 2. [cli] --expect mismatch refuses before the first write ──
  {
    const before = snapshot();
    const r = cli(["--env=local", "--apply", `--expect=${EXPECTED + 1}`], { current: NEW, previous: OLD });
    check(2, "[cli] apply with a wrong --expect exits 3 and writes no ciphertext", r.status === 3 && /MISMATCH, nothing written/.test(out(r)) && snapshot() === before, `${r.status} ${out(r).slice(-600)}`);
    check(2, "[cli] …and records the refused run as ONE AuditLog row (outcome REFUSED_EXPECT_MISMATCH)", auditRows() === 1 && JSON.parse(lastAudit()).outcome === "REFUSED_EXPECT_MISMATCH");
  }

  // ── 3. [cli] APPLY ──
  {
    const r = cli(["--env=local", "--apply", `--expect=${EXPECTED}`, "--batch=2"], { current: NEW, previous: OLD });
    const o = out(r);
    check(3, `[cli] apply (batch 2) exits 0 COMPLETE with ${EXPECTED} rotated, 0 conflicts`, r.status === 0 && o.includes(`rotated ${EXPECTED} · conflicts 0`) && o.includes("COMPLETE"), `${r.status} ${o.slice(-1200)}`);
    check(3, "[cli] the apply output holds no key, plaintext or ciphertext", !leaks(o));
    const meta = lastAudit();
    const m = JSON.parse(meta) as { outcome: string; env: string; newKid: string; oldKid: string; fields: Record<string, { rotated: number; candidates: number; conflicts: number }> };
    check(3, "[cli] the apply wrote exactly ONE AuditLog row ENCRYPTION_KEY_ROTATED: outcome, env, old/new kids, per-field counts",
      auditRows() === 2 && m.outcome === "COMPLETE" && m.env === "local" && m.newKid === kid(NEW) && m.oldKid === kid(OLD)
        && m.fields["User.totpSecret"].rotated === 3 && m.fields["BetaAbuseEvidence.sealedPayload"].rotated === 1 && m.fields["Connection.credential"].rotated === 1, meta);
    check(3, "[cli] the audit metadata holds no value, key or row id", !leaks(meta) && !/"u[1-5]"|"p[1-3]"|"c[1-3]"|"e1"/.test(meta));
    // Every value now opens with the NEW key ALONE — i.e. after PREVIOUS is removed.
    const read = (sql: string, purpose: typeof P[keyof typeof P]) => withKeys(NEW, undefined, () => {
      const v = val(sql);
      return { v, kid: enc.ciphertextKeyId(v), plain: enc.decryptWithPurpose(v, purpose) };
    });
    const rows = {
      u1t: read(`select "totpSecret" from "User" where id='u1'`, P.TOTP_SECRET),
      u2t: read(`select "totpSecret" from "User" where id='u2'`, P.TOTP_SECRET),
      u3t: read(`select "totpSecret" from "User" where id='u3'`, P.TOTP_SECRET),
      u1d: read(`select "dateOfBirthEncrypted" from "User" where id='u1'`, P.DATE_OF_BIRTH),
      u2d: read(`select "dateOfBirthEncrypted" from "User" where id='u2'`, P.DATE_OF_BIRTH),
      tok1: read(`select "encryptedToken" from "PlaidItem" where id='p1'`, P.PLAID_ACCESS_TOKEN),
      tok2: read(`select "encryptedToken" from "PlaidItem" where id='p2'`, P.PLAID_ACCESS_TOKEN),
      cred: read(`select credential from "Connection" where id='c1'`, P.CONNECTION_CREDENTIAL),
    };
    const allV3New = Object.entries(rows).every(([k, r2]) => r2.kid === kid(NEW) && r2.plain === plain[k as keyof typeof plain]);
    check(3, "[cli] every rotated cipher column is v3 under the NEW kid and decrypts to its original plaintext with PREVIOUS unset", allV3New,
      JSON.stringify(Object.fromEntries(Object.entries(rows).map(([k, r2]) => [k, r2.kid]))));
    check(3, "[cli] the kid-less values that opened ONLY under PREVIOUS (app v2 + legacy v1) were re-encrypted to v3 under the NEW kid",
      rows.u2t.kid === kid(NEW) && rows.u3t.kid === kid(NEW) && rows.u2t.plain === plain.u2t && rows.u3t.plain === plain.u3t);
    const ev = withKeys(NEW, undefined, () => enc.openWithPurposeReportingKey(val(`select "sealedPayload" from "BetaAbuseEvidence" where id='e1'`), P.BETA_ABUSE_EVIDENCE));
    check(3, "[cli] the sealed evidence opens under the NEW key alone with its original payload", ev.kid === kid(NEW) && ev.plaintext === plain.ev);
    check(3, "[cli] the already-current value was NOT rewritten (byte-identical)", val(`select "totpSecret" from "User" where id='u4'`) === fixture.u4t);
    check(3, "[cli] the WALLET descriptor, the MANUAL NULL, the revoked-token sentinel and NULL columns are untouched",
      val(`select credential from "Connection" where id='c2'`) === XPUB && val(`select coalesce(credential,'<null>') from "Connection" where id='c3'`) === "<null>"
        && val(`select "encryptedToken" from "PlaidItem" where id='p3'`) === "" && val(`select coalesce("totpSecret",'<null>') from "User" where id='u5'`) === "<null>");
  }

  // ── 4. [cli] IDEMPOTENT: a second apply writes nothing; the dry run reports 0 ──
  {
    const before = snapshot();
    const r = cli(["--env=local", "--apply"], { current: NEW, previous: OLD });
    check(4, "[cli] a second apply exits 0, rotates 0 and leaves every column byte-identical", r.status === 0 && out(r).includes("rotated 0 · conflicts 0") && snapshot() === before, out(r).slice(-600));
    check(4, "[cli] …and still writes its one audit row (one per --apply run)", auditRows() === 3 && JSON.parse(lastAudit()).totals.rotated === 0);
    const vBoth = cli(["--env=local", "--verify-complete"], { current: NEW, previous: OLD });
    const vNew = cli(["--env=local", "--verify-complete"], { current: NEW });
    check(4, "[cli] --verify-complete now exits 0 VERIFIED COMPLETE — with PREVIOUS still set and with it removed",
      vBoth.status === 0 && vNew.status === 0 && out(vBoth).includes("VERIFIED COMPLETE") && out(vNew).includes("blocking 0") && !leaks(out(vNew)), `${vBoth.status}/${vNew.status} ${out(vNew).slice(-600)}`);
    const d = cli(["--env=local"], { current: NEW });
    check(4, "[cli] the dry run with PREVIOUS removed reports 0 to re-encrypt and 0 unreadable (the old kid's count is 0)",
      d.status === 0 && out(d).includes("to re-encrypt 0") && out(d).includes("unreadable 0") && !out(d).includes(kid(OLD)), out(d).slice(-800));
  }

  // ── 5. [engine] CAS CONFLICT: a row that changes between read and write is skipped, never overwritten ──
  {
    const raceOld = v3Under(OLD, "seed-before-reset", P.TOTP_SECRET);
    const raceNew = v3Under(OLD, "seed-after-concurrent-reset", P.TOTP_SECRET);
    const calm = v3Under(OLD, "seed-calm", P.TOTP_SECRET);
    one(`insert into "User" (id,email,name,"updatedAt","totpSecret") values
      ('r1','r1@example.test','R1',now(),${sqlStr(raceOld)}),('r2','r2@example.test','R2',now(),${sqlStr(calm)});`);
    const { runKeyRotation } = await import("./lib/rotate-encryption-key.core");
    const { db } = await import("@/lib/db");
    const rep = await withKeysAsync(NEW, OLD, () => runKeyRotation(db, {
      apply: true, fields: ["User.totpSecret"],
      beforeWrite: async (_f, id) => { if (id === "r1") one(`update "User" set "totpSecret" = ${sqlStr(raceNew)} where id='r1';`); },
    }));
    const t = rep.fields[0];
    check(5, "[engine] the raced row is reported as a CAS conflict, the calm row is rotated, outcome INCOMPLETE",
      rep.outcome === "INCOMPLETE" && t.conflicts.join() === "r1" && t.rotated === 1, JSON.stringify({ outcome: rep.outcome, conflicts: t.conflicts, rotated: t.rotated }));
    check(5, "[engine] the concurrent write survives — the rotation did NOT overwrite it", val(`select "totpSecret" from "User" where id='r1'`) === raceNew);
    const rerun = await withKeysAsync(NEW, OLD, () => runKeyRotation(db, { apply: true, fields: ["User.totpSecret"] }));
    const r1 = withKeys(NEW, undefined, () => enc.decryptWithPurposeReportingKey(val(`select "totpSecret" from "User" where id='r1'`), P.TOTP_SECRET));
    check(5, "[engine] a re-run picks the conflicted row up: COMPLETE, and it now holds the CONCURRENT plaintext under the new kid",
      rerun.outcome === "COMPLETE" && rerun.fields[0].rotated === 1 && r1.kid === kid(NEW) && r1.plaintext === "seed-after-concurrent-reset");
    await db.$disconnect();
  }

  // ── 6. [cli] FAIL CLOSED: an unknown kid is reported, never written, and the run is INCOMPLETE ──
  {
    const stranger = v3Under(STRANGER, "foreign", P.TOTP_SECRET);
    one(`insert into "User" (id,email,name,"updatedAt","totpSecret") values ('x1','x1@example.test','X1',now(),${sqlStr(stranger)});`);
    const d = cli(["--env=local"], { current: NEW, previous: OLD });
    check(6, "[cli] the dry run reports the unknown kid as UNKNOWN — unreadable", d.status === 0 && out(d).includes(`kid ${kid(STRANGER)} (UNKNOWN — unreadable)`) && out(d).includes("unreadable 1"), out(d).slice(-800));
    const a = cli(["--env=local", "--apply"], { current: NEW, previous: OLD });
    check(6, "[cli] apply exits 3 INCOMPLETE and leaves the unknown-kid value byte-identical",
      a.status === 3 && out(a).includes("INCOMPLETE") && val(`select "totpSecret" from "User" where id='x1'`) === stranger, `${a.status} ${out(a).slice(-600)}`);
    let threw = "";
    withKeys(NEW, OLD, () => { try { enc.decryptWithPurpose(stranger, P.TOTP_SECRET); } catch (e) { threw = (e as Error).message; } });
    check(6, "[cli] and the application read path throws on it (fail closed), naming no key", /not in the keyring/.test(threw) && !threw.includes(kid(STRANGER)));
    const v = cli(["--env=local", "--verify-complete"], { current: NEW, previous: OLD });
    check(6, "[cli] --verify-complete refuses completion while an unknown-kid value exists (exit 3)", v.status === 3 && out(v).includes("blocking 1"), `${v.status} ${out(v).slice(-500)}`);
    one(`delete from "User" where id='x1';`);
  }

  // ── 7. [cli] --verify-complete covers EVERY registered field: one old seal alone blocks it ──
  {
    one(`insert into "BetaAbuseEvidence" (id,"sourceRequestId","sealedPayload","capturedById","reasonCode","retainUntil")
      values ('e2','req-2',${sqlStr(sealUnder(OLD, "late-evidence", P.BETA_ABUSE_EVIDENCE))},'u1','TEST',now() + interval '1 day');`);
    const v = cli(["--env=local", "--verify-complete"], { current: NEW, previous: OLD });
    check(7, "[cli] a single BetaAbuseEvidence seal opened only by PREVIOUS makes --verify-complete exit 3",
      v.status === 3 && out(v).includes("blocking 1") && /BetaAbuseEvidence\.sealedPayload[\s\S]*?blocking \(lost if PREVIOUS removed now\)\s+1\n/.test(out(v)), `${v.status} ${out(v).slice(-700)}`);
    one(`delete from "BetaAbuseEvidence" where id='e2';`);
  }

  // ── 8. [cli] the read-only format census honours the WALLET exclusion ──
  {
    const r = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"),
      ["--require", "./scripts/lib/server-only-preload.cjs", "scripts/audit-ciphertext-versions.ts"],
      { cwd: ROOT, encoding: "utf8", timeout: 300_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
        DATABASE_URL: `${owner}?schema=public`, DIRECT_URL: `${owner}?schema=public` } as unknown as NodeJS.ProcessEnv });
    const o = out(r);
    // Columns: v1 v2 v3 invalid null total. Connection holds PLAID (v3) + MANUAL (NULL) + WALLET (clear-text descriptor, excluded).
    const line = o.split("\n").find((l) => l.startsWith("Connection.credential")) ?? "";
    const nums = line.trim().split(/\s+/).slice(-6).map(Number);
    check(8, "[cli] audit-ciphertext-versions exits 0 and counts Connection.credential WITHOUT the WALLET row: 1 v3, 0 invalid, 1 null, 2 total",
      r.status === 0 && JSON.stringify(nums) === JSON.stringify([0, 0, 1, 0, 1, 2]) && /provider≠WALLET/.test(line), `${r.status} ${line} ${o.slice(-400)}`);
    check(8, "[cli] …and reports no invalid value anywhere", /TOTAL(\s+\d+){3}\s+0\s/.test(o) && !/WARNING: \d+ value\(s\) are neither/.test(o), o.slice(-600));
  }

  // ── 9. [cli] AFTER (d): writes revert to v2 under the new key; verify accepts them; nothing churns ──
  {
    const after = appUnder(NEW, "totp-seed-after-d", P.TOTP_SECRET);
    one(`insert into "User" (id,email,name,"updatedAt","totpSecret") values ('u9','u9@example.test','U9',now(),${sqlStr(after)});`);
    check(9, "[fixture] with PREVIOUS removed the application writes v2", enc.detectCiphertextVersion(after) === "v2");
    const before = snapshot();
    const v = cli(["--env=local", "--verify-complete"], { current: NEW });
    check(9, "[cli] --verify-complete with the new key alone exits 0 with a kid-less v2 present (the current key opens it)",
      v.status === 0 && out(v).includes("VERIFIED COMPLETE") && out(v).includes("legacy v2 (no kid)") && out(v).includes("blocking 0"), `${v.status} ${out(v).slice(-700)}`);
    const audits0 = auditRows();
    const a = cli(["--env=local", "--apply"], { current: NEW });
    check(9, "[cli] an apply with PREVIOUS unset is a NO-OP: exit 0, 'no rotation in progress — nothing to do', every column byte-identical, NO audit row",
      a.status === 0 && out(a).includes("no rotation in progress — nothing to do") && snapshot() === before && auditRows() === audits0, `${a.status} ${out(a).slice(-700)}`);
    const aSame = cli(["--env=local", "--apply"], { current: NEW, previous: NEW });
    check(9, "[cli] an apply with PREVIOUS equal to the current key is the same NO-OP (exit 0, no write, no audit row)",
      aSame.status === 0 && out(aSame).includes("no rotation in progress — nothing to do") && snapshot() === before && auditRows() === audits0, `${aSame.status} ${out(aSame).slice(-500)}`);
    const dry = cli(["--env=local"], { current: NEW });
    check(9, "[cli] the dry run with PREVIOUS unset is unchanged: exit 0, 0 to re-encrypt (the kid-less v2 is current)",
      dry.status === 0 && out(dry).includes("to re-encrypt 0") && snapshot() === before, `${dry.status} ${out(dry).slice(-500)}`);
    const u1 = withKeys(NEW, undefined, () => enc.decryptWithPurposeReportingKey(val(`select "totpSecret" from "User" where id='u1'`), P.TOTP_SECRET));
    check(9, "[cli] a v3 value written during the rotation is still v3 and reads under the new key alone after (d)",
      enc.detectCiphertextVersion(val(`select "totpSecret" from "User" where id='u1'`)) === "v3" && u1.kid === kid(NEW) && u1.plaintext === plain.u1t);
  }

  return report("ENCRYPTION KEY ROTATION ACCEPTANCE");
}

async function withKeysAsync<T>(current: string, previous: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = { c: process.env.ENCRYPTION_KEY, p: process.env.ENCRYPTION_KEY_PREVIOUS };
  process.env.ENCRYPTION_KEY = current;
  if (previous === undefined) delete process.env.ENCRYPTION_KEY_PREVIOUS; else process.env.ENCRYPTION_KEY_PREVIOUS = previous;
  try { return await fn(); } finally {
    process.env.ENCRYPTION_KEY = saved.c;
    if (saved.p === undefined) delete process.env.ENCRYPTION_KEY_PREVIOUS; else process.env.ENCRYPTION_KEY_PREVIOUS = saved.p;
  }
}

main()
  .then((failed) => { teardownHarness(KEEP); process.exit(failed ? 1 : 0); })
  .catch((e) => { console.error(e instanceof Error ? e.message : e); teardownHarness(KEEP); process.exit(1); });
