/**
 * lib/plaid/encryption-b9-compat.test.ts  (S2 ruling — B10 rollback safety)
 *
 * The release on Production before the keyring (B9) reads only v1/v2. If B10
 * wrote anything B9 cannot read, rolling B10 back would strand every value
 * written after the deploy (Plaid tokens, TOTP seeds, …). So, outside a key
 * rotation, the current module must write ONLY what B9 reads.
 *
 * This proves it with B9's ACTUAL code, not a re-implementation of it:
 * lib/plaid/__fixtures__/encryption-b9.ts is B9's lib/plaid/encryption.ts,
 * vendored verbatim and frozen (its git blob hash and the fixture's SHA-256 are
 * pinned below, so nobody edits it to make this test pass).
 *
 * Every key is generated in this process (crypto.randomBytes); no real key is read.
 *
 *   npx tsx lib/plaid/encryption-b9-compat.test.ts
 */

import crypto from "crypto";
import { readFileSync } from "fs";
import path from "path";
import * as current from "./encryption";
import * as b9 from "./__fixtures__/encryption-b9";
import { ENCRYPTED_FIELDS, NON_STORED_PURPOSES, fieldLabel } from "./encrypted-fields";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
function throws(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}
function withKeys<T>(cur: string, previous: string | undefined, fn: () => T): T {
  const saved = { c: process.env.ENCRYPTION_KEY, p: process.env.ENCRYPTION_KEY_PREVIOUS };
  process.env.ENCRYPTION_KEY = cur;
  if (previous === undefined) delete process.env.ENCRYPTION_KEY_PREVIOUS; else process.env.ENCRYPTION_KEY_PREVIOUS = previous;
  try { return fn(); } finally {
    if (saved.c === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = saved.c;
    if (saved.p === undefined) delete process.env.ENCRYPTION_KEY_PREVIOUS; else process.env.ENCRYPTION_KEY_PREVIOUS = saved.p;
  }
}
const freshKey = () => crypto.randomBytes(32).toString("hex");

// ── 0. the fixture is B9's code, unedited ────────────────────────────────────
const FIXTURE = path.join(__dirname, "__fixtures__", "encryption-b9.ts");
const MARKER = "// ──────────────── VERBATIM BELOW THIS LINE ────────────────\n";
/** lib/plaid/encryption.ts at origin/main dc767110d5962c4e03d9757deddbc2f0c8553f87 (B9). */
const B9_SOURCE_COMMIT = "dc767110d5962c4e03d9757deddbc2f0c8553f87";
const B9_BLOB = "6144e45e5d8c6918b584d12ffc49b3d4e9bdcb24";
const FIXTURE_SHA256 = "4ac9d96ea33756be26bc049821fc3301844b3edbbc7d3dc0650167e19dbfb27f";

console.log("0. the B9 fixture is frozen");
{
  const raw = readFileSync(FIXTURE);
  check("the fixture file's SHA-256 is pinned (header + body)",
    crypto.createHash("sha256").update(raw).digest("hex") === FIXTURE_SHA256,
    crypto.createHash("sha256").update(raw).digest("hex"));
  const text = raw.toString("utf8");
  const at = text.indexOf(MARKER);
  check("the fixture has exactly one verbatim marker", at !== -1 && text.indexOf(MARKER, at + 1) === -1);
  const body = Buffer.from(text.slice(at + MARKER.length), "utf8");
  const blob = crypto.createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])).digest("hex");
  check(`the body is byte-identical to lib/plaid/encryption.ts at ${B9_SOURCE_COMMIT.slice(0, 7)} (git blob ${B9_BLOB.slice(0, 7)})`, blob === B9_BLOB, blob);
  check("the header names the source commit and blob", text.slice(0, at).includes(B9_SOURCE_COMMIT) && text.slice(0, at).includes(B9_BLOB));
  check("B9's reader knows only v1/v2 (sanity: this is the pre-keyring module)",
    !/v3/.test(body.toString("utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
}

const PLAINTEXTS = ["access-sandbox-0000-test", "JBSWY3DPEHPK3PXP", "1990-01-01", "", "ünïcödé · 🔐", "x".repeat(4096), JSON.stringify({ evidence: { a: 1 } })];

// ── 1. PREVIOUS unset: B9 opens EVERY value the current code writes ──────────
console.log("1. PREVIOUS unset — B9's own code opens every write, across every ENCRYPTED_FIELDS purpose");
{
  const K = freshKey();
  withKeys(K, undefined, () => {
    for (const f of ENCRYPTED_FIELDS) {
      const ok = PLAINTEXTS.every((p) => {
        if (f.format === "sealed") {
          const s = current.sealWithPurpose(p, f.purpose);
          return b9.openWithPurpose(s, f.purpose) === p;
        }
        const c = current.encryptWithPurpose(p, f.purpose);
        return c.startsWith("v2:") && b9.detectCiphertextVersion(c) === "v2" && b9.decryptWithPurpose(c, f.purpose) === p;
      });
      check(`${fieldLabel(f)} (${f.format}, ${f.purpose}): every write is opened by B9`, ok);
    }
    // The non-stored carrier crosses a deploy too (a cookie issued by B10, returned to B9 after a rollback).
    for (const p of NON_STORED_PURPOSES) {
      const ok = PLAINTEXTS.every((t) => b9.openWithPurpose(current.sealWithPurpose(t, p), p) === t
        && b9.decryptWithPurpose(current.encryptWithPurpose(t, p), p) === t);
      check(`non-stored ${p}: seals and ciphers are opened by B9`, ok);
    }
    // Belt and braces: every purpose the current module knows, both forms.
    const all = Object.values(current.EncryptionPurpose).every((p) =>
      b9.decryptWithPurpose(current.encryptWithPurpose("p", p), p) === "p" && b9.openWithPurpose(current.sealWithPurpose("p", p), p) === "p");
    check("every EncryptionPurpose: encryptWithPurpose and sealWithPurpose output both open under B9", all);
    // And the other direction (a value B9 wrote before the deploy reads under B10).
    const back = ENCRYPTED_FIELDS.every((f) => f.format === "sealed"
      ? current.openWithPurpose(b9.sealWithPurpose("b9", f.purpose), f.purpose) === "b9"
      : current.decryptWithPurpose(b9.encryptWithPurpose("b9", f.purpose), f.purpose) === "b9");
    check("every value B9 writes is read by the current code (both directions)", back);
    check("B9 under a DIFFERENT key refuses (the proof is not vacuous)",
      withKeys(freshKey(), undefined, () => throws(() => b9.decryptWithPurpose(withKeys(K, undefined, () => current.encryptWithPurpose("x", current.EncryptionPurpose.TOTP_SECRET)), current.EncryptionPurpose.TOTP_SECRET))));
  });
}

// ── 2. PREVIOUS equal to the current key: still B9-readable, plus the warning ─
console.log("2. PREVIOUS === ENCRYPTION_KEY — ignored (warning), writes stay B9-readable");
{
  const K = freshKey();
  withKeys(K, K, () => {
    check("the boot warning is raised", current.previousKeyWarning(process.env) === current.PREVIOUS_EQUALS_CURRENT_WARNING);
    check("every registered field's write is opened by B9",
      ENCRYPTED_FIELDS.every((f) => f.format === "sealed"
        ? b9.openWithPurpose(current.sealWithPurpose("eq", f.purpose), f.purpose) === "eq"
        : b9.decryptWithPurpose(current.encryptWithPurpose("eq", f.purpose), f.purpose) === "eq"));
  });
}

// ── 3. the boundary: a DISTINCT PREVIOUS (rotation step b) writes what B9 cannot read ─
console.log("3. a DISTINCT PREVIOUS (rotation in progress) writes v3 — the documented point of no return for B9");
{
  const NEW = freshKey(), OLD = freshKey();
  withKeys(NEW, OLD, () => {
    const c = current.encryptWithPurpose("rot", current.EncryptionPurpose.PLAID_ACCESS_TOKEN);
    check("the write is v3", current.detectCiphertextVersion(c) === "v3");
    check("B9 classifies it invalid and refuses it (why rollback is forbidden from step (b) on)",
      b9.detectCiphertextVersion(c) === "invalid" && throws(() => b9.decryptWithPurpose(c, current.EncryptionPurpose.PLAID_ACCESS_TOKEN)));
    // Seals carry no kid: B9 under the current key still opens them (format unchanged by the keyring).
    const s = current.sealWithPurpose("rot", current.EncryptionPurpose.BETA_ABUSE_EVIDENCE);
    check("a compact seal written during a rotation is still opened by B9 under the same key (c1 format unchanged)",
      withKeys(NEW, undefined, () => b9.openWithPurpose(s, current.EncryptionPurpose.BETA_ABUSE_EVIDENCE)) === "rot");
  });
}

console.log("");
if (failures === 0) { console.log("B9 compatibility: all cases passed."); process.exit(0); }
console.log(`${failures} failure(s).`);
process.exit(1);
