/**
 * lib/plaid/encrypted-fields.test.ts  (PRIV-004 — the encrypted-field census)
 *
 * A key rotation re-encrypts the columns in ENCRYPTED_FIELDS and nothing else.
 * A column written through encryptWithPurpose()/sealWithPurpose() but missing
 * from the registry would be STRANDED by the rotation: readable while
 * ENCRYPTION_KEY_PREVIOUS is set, lost the moment it is removed. So:
 *
 *   1. every encryptWithPurpose( / sealWithPurpose( call in non-test source is a
 *      CLASSIFIED writer site (file × purpose × count) — a new call fails here
 *      until someone says which field it writes;
 *   2. each classified site writes a REGISTERED field (or a declared non-stored
 *      carrier), with the purpose the registry gives that field, and the file
 *      names that field;
 *   3. every registry entry has at least one writer, and every EncryptionPurpose
 *      is either one registered field's purpose or declared non-stored;
 *   4. every entry exists in prisma/schema.prisma as a String column of an
 *      un-mapped model (the rotation script addresses table/column by name);
 *   5. the format discriminator agrees with the registry's format.
 *
 *   npx tsx lib/plaid/encrypted-fields.test.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { EncryptionPurpose } from "./encryption";
import { ENCRYPTED_FIELDS, NON_STORED_PURPOSES, fieldLabel, scopeWhere } from "./encrypted-fields";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const SCAN_DIRS = ["app", "lib", "jobs", "scripts", "prisma", "components"];
const DEFINITION = "lib/plaid/encryption.ts";
/**
 * The FROZEN copy of the previous release's module (a test fixture, never
 * imported by application code): it DEFINES encryptWithPurpose/sealWithPurpose
 * and writes no column. Pinned by hash in lib/plaid/encryption-b9-compat.test.ts.
 */
const FROZEN_DEFINITIONS = new Set(["lib/plaid/__fixtures__/encryption-b9.ts"]);

/** The classified writers. `field` is a registry label, or "NON_STORED" for a carrier. */
const WRITER_SITES: ReadonlyArray<{ file: string; purpose: keyof typeof EncryptionPurpose; count: number; field: string }> = [
  { file: "lib/plaid/exchangeToken.ts",               purpose: "PLAID_ACCESS_TOKEN",    count: 1, field: "PlaidItem.encryptedToken" },
  { file: "lib/plaid/exchangeToken.ts",               purpose: "CONNECTION_CREDENTIAL", count: 1, field: "Connection.credential" },
  { file: "app/api/user/totp/setup/route.ts",         purpose: "TOTP_SECRET",           count: 1, field: "User.totpSecret" },
  { file: "app/api/auth/register/route.ts",           purpose: "DATE_OF_BIRTH",         count: 1, field: "User.dateOfBirthEncrypted" },
  { file: "app/api/user/profile/route.ts",            purpose: "DATE_OF_BIRTH",         count: 1, field: "User.dateOfBirthEncrypted" },
  { file: "prisma/seed.ts",                           purpose: "DATE_OF_BIRTH",         count: 3, field: "User.dateOfBirthEncrypted" },
  // B10.6 rollback rehearsal: a synthetic TOTP user in its own throwaway database (the v2 rollback-format check).
  { file: "scripts/test-b10-rehearsal-b10-probe.ts",  purpose: "TOTP_SECRET",           count: 1, field: "User.totpSecret" },
  { file: "lib/platform/growth/beta-abuse-evidence.ts", purpose: "BETA_ABUSE_EVIDENCE", count: 1, field: "BetaAbuseEvidence.sealedPayload" },
  { file: "lib/ai/conversation/runtime-state.ts",     purpose: "AI_RUNTIME_STATE",      count: 1, field: "NON_STORED" },
];

/**
 * Sites allowed to pass a NON-constant purpose, each for a stated reason:
 *   the rotation engine re-encrypts `f.purpose` for `f` of ENCRYPTED_FIELDS — it
 *   can only write registered fields, by construction;
 *   the rotation acceptance suite builds fixtures in its own throwaway database.
 */
const GENERIC_SITES: ReadonlyArray<{ file: string; count: number; purposeExpr: RegExp; mustImport?: string }> = [
  { file: "scripts/lib/rotate-encryption-key.core.ts", count: 2, purposeExpr: /^\s*(encryptWithPurpose|sealWithPurpose)\s*\(\s*plaintext\s*,\s*f\.purpose\s*\)/, mustImport: "ENCRYPTED_FIELDS" },
  { file: "scripts/encryption-key-rotation-acceptance.ts", count: 3, purposeExpr: /^\s*(encryptWithPurpose|sealWithPurpose)\s*\(\s*plain\s*,\s*purpose\s*\)/ },
];

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === "prototype") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

// ── 1. discover every call site ─────────────────────────────────────────────
console.log("1. every encryptWithPurpose( / sealWithPurpose( call is a classified writer");
const files: string[] = [];
for (const d of SCAN_DIRS) {
  const abs = path.join(ROOT, d);
  try { if (statSync(abs).isDirectory()) walk(abs, files); } catch { /* absent dir */ }
}
const found = new Map<string, number>(); // "file|PURPOSE" -> count
const genericFound = new Map<string, number>(); // GENERIC_SITES file -> count
const unattributed: string[] = [];
for (const abs of files) {
  const rel = path.relative(ROOT, abs).split(path.sep).join("/");
  if (rel === DEFINITION || FROZEN_DEFINITIONS.has(rel)) continue;
  const src = stripComments(readFileSync(abs, "utf8"));
  const call = /\b(encryptWithPurpose|sealWithPurpose)\s*\(/g;
  const generic = GENERIC_SITES.find((g) => g.file === rel);
  for (let m = call.exec(src); m; m = call.exec(src)) {
    const window = src.slice(m.index, m.index + 400);
    if (generic && generic.purposeExpr.test(window)) { genericFound.set(rel, (genericFound.get(rel) ?? 0) + 1); continue; }
    const purpose = /^[^;]*?EncryptionPurpose\.([A-Z_]+)/.exec(window)?.[1];
    if (!purpose) { unattributed.push(`${rel}@${m.index}`); continue; }
    const key = `${rel}|${purpose}`;
    found.set(key, (found.get(key) ?? 0) + 1);
  }
}
check(`scanned ${files.length} source files`, files.length > 100, String(files.length));
check("the frozen B9 fixture is not imported by any application source",
  files.every((abs) => /\.test\.tsx?$/.test(abs) || !/__fixtures__\/encryption-b9/.test(readFileSync(abs, "utf8"))
    || FROZEN_DEFINITIONS.has(path.relative(ROOT, abs).split(path.sep).join("/"))));
check("every call names its purpose as an EncryptionPurpose constant", unattributed.length === 0, unattributed.join(", "));
const classified = new Map(WRITER_SITES.map((w) => [`${w.file}|${w.purpose}`, w]));
const unclassified = [...found.keys()].filter((k) => !classified.has(k));
check("no unclassified writer (a new one must be added to WRITER_SITES AND, if stored, to ENCRYPTED_FIELDS)",
  unclassified.length === 0, unclassified.join(", "));
for (const g of GENERIC_SITES) {
  check(`${g.file} has exactly ${g.count} registry-driven call(s)`, (genericFound.get(g.file) ?? 0) === g.count, `found ${genericFound.get(g.file) ?? 0}`);
  if (g.mustImport) {
    check(`${g.file} takes its fields from ${g.mustImport}`, readFileSync(path.join(ROOT, g.file), "utf8").includes(g.mustImport));
  }
}
for (const w of WRITER_SITES) {
  const n = found.get(`${w.file}|${w.purpose}`) ?? 0;
  check(`${w.file} has exactly ${w.count} ${w.purpose} call(s)`, n === w.count, `found ${n}`);
}

// ── 2. each writer writes a registered field ────────────────────────────────
console.log("2. each classified writer writes a registered field with that field's purpose");
const byLabel = new Map(ENCRYPTED_FIELDS.map((f) => [fieldLabel(f), f]));
for (const w of WRITER_SITES) {
  const purposeValue = EncryptionPurpose[w.purpose];
  if (w.field === "NON_STORED") {
    check(`${w.file} ${w.purpose} is a declared non-stored carrier`, NON_STORED_PURPOSES.includes(purposeValue));
    continue;
  }
  const f = byLabel.get(w.field);
  check(`${w.file} → ${w.field} is registered`, !!f);
  if (!f) continue;
  check(`${w.field}: registry purpose matches the writer's (${w.purpose})`, f.purpose === purposeValue);
  const src = readFileSync(path.join(ROOT, w.file), "utf8");
  check(`${w.file} names the column ${f.field}`, src.includes(f.field));
  const fn = f.format === "sealed" ? "sealWithPurpose" : "encryptWithPurpose";
  check(`${w.file} writes ${w.field} with ${fn} (registry format "${f.format}")`,
    new RegExp(`\\b${fn}\\s*\\([^;]*EncryptionPurpose\\.${w.purpose}`).test(stripComments(src).replace(/\s+/g, " ")));
}

// ── 3. registry completeness ────────────────────────────────────────────────
console.log("3. the registry has no orphan entry and every purpose is accounted for");
for (const f of ENCRYPTED_FIELDS) {
  check(`${fieldLabel(f)} has at least one writer`, WRITER_SITES.some((w) => w.field === fieldLabel(f)));
}
const labels = ENCRYPTED_FIELDS.map(fieldLabel);
check("registry labels are unique", new Set(labels).size === labels.length, labels.join(", "));
const purposes = ENCRYPTED_FIELDS.map((f) => f.purpose);
check("one registered field per purpose (purposes isolate fields)", new Set(purposes).size === purposes.length);
for (const p of Object.values(EncryptionPurpose)) {
  const stored = purposes.includes(p);
  const carrier = NON_STORED_PURPOSES.includes(p);
  check(`purpose ${p} is exactly one of: a registered field, a non-stored carrier`, stored !== carrier);
}
check("the registry is the five known columns",
  labels.slice().sort().join() === ["BetaAbuseEvidence.sealedPayload", "Connection.credential", "PlaidItem.encryptedToken", "User.dateOfBirthEncrypted", "User.totpSecret"].join(),
  labels.join(", "));

// ── 3b. the format census honours the registry's scope ──────────────────────
console.log("3b. scripts/audit-ciphertext-versions.ts scans the registry, excluding clear-text WALLET rows");
{
  const conn = ENCRYPTED_FIELDS.find((f) => fieldLabel(f) === "Connection.credential")!;
  check("Connection.credential is scoped to provider ≠ WALLET", JSON.stringify(scopeWhere(conn)) === JSON.stringify({ provider: { not: "WALLET" } }));
  check("an unscoped field selects every row", ENCRYPTED_FIELDS.filter((f) => !f.scope).every((f) => JSON.stringify(scopeWhere(f)) === "{}"));
  const audit = stripComments(readFileSync(path.join(ROOT, "scripts/audit-ciphertext-versions.ts"), "utf8"));
  check("the audit iterates ENCRYPTED_FIELDS (cipher format) instead of a hand-kept list",
    /for \(const f of ENCRYPTED_FIELDS\.filter\(\(x\) => x\.format === "cipher"\)\)/.test(audit));
  check("the audit applies scopeWhere(f) to every page query", /where: \{ AND: \[afterId \? \{ id: \{ gt: afterId \} \} : \{\}, scopeWhere\(f\)\] \}/.test(audit));
  check("the audit no longer queries a registered column by hand", !/db\.(plaidItem|user|connection)\.findMany/.test(audit));
  check("the audit stays read-only (findMany only)", !/\.(update|updateMany|create|delete|deleteMany|upsert)\(|\$executeRaw/.test(audit));
}

// ── 4. schema agreement ─────────────────────────────────────────────────────
console.log("4. every entry is a String column of an un-mapped model in prisma/schema.prisma");
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
const modelBlock = (name: string): string | null => {
  const m = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, "m").exec(schema);
  return m ? m[1] : null;
};
for (const f of ENCRYPTED_FIELDS) {
  const block = modelBlock(f.model);
  check(`model ${f.model} exists`, block !== null);
  if (!block) continue;
  check(`model ${f.model} is not @@map-ped (table name == model name)`, !/@@map\(/.test(block));
  const line = new RegExp(`^\\s*${f.field}\\s+(String\\??)(.*)$`, "m").exec(block);
  check(`${fieldLabel(f)} is a String column`, !!line);
  check(`${fieldLabel(f)} is not @map-ped (column name == field name)`, !!line && !/@map\(/.test(line[2]));
  if (f.scope) {
    check(`${fieldLabel(f)} scope column ${f.scope.column} exists`, new RegExp(`^\\s*${f.scope.column}\\s+\\w`, "m").test(block));
  }
}

console.log("");
if (failures === 0) { console.log("Encrypted-field census: all cases passed."); process.exit(0); }
console.log(`${failures} failure(s).`);
process.exit(1);
