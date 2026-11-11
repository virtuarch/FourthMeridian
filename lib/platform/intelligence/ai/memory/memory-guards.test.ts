/**
 * lib/platform/intelligence/ai/memory/memory-guards.test.ts  (Platform AI P4 — memory guards, I-2 / D-2)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/memory/memory-guards.test.ts
 *
 * Design v2 §8.4; S2 binding ruling 1 (the operator's own note reaches the model only because
 * the note guard rejects at WRITE time: emails, cuid / uuid-shaped ids, card / account numbers,
 * URLs — P4 adds record handles). Memory never stores a customer or record ref:
 *   1. MEMORY_REF_TYPES snapshot (METRIC / PAGE / INCIDENT / JOB / PROVIDER; no CUSTOMER / USER /
 *      CONNECTION); INCIDENT by id only; every other kind a closed registry value
 *   2. the note guard refuses every identity / record-ref shape (and still accepts a clean note)
 *   3. sourceRef validation refuses handles, opaque refs, emails, cuids outside INCIDENT
 *   4. source scan: memory/** imports nothing from a customer-linkable pack, the handle table,
 *      subject resolution, the record renderer or the record placeholders
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { MEMORY_REF_TYPES } from "./constants";
import { validateOperatorNote } from "./note-guard";
import { refProblem } from "./schema";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 400)}` : ""}`); }
}
const ROOT = process.cwd();
const DIR = "lib/platform/intelligence/ai/memory";
const src = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

console.log("1. ref types — snapshot (I-2)");
check("MEMORY_REF_TYPES is exactly METRIC / PAGE / INCIDENT / JOB / PROVIDER", JSON.stringify(MEMORY_REF_TYPES) === JSON.stringify(["METRIC", "PAGE", "INCIDENT", "JOB", "PROVIDER"]), MEMORY_REF_TYPES);
const constants = src(`${DIR}/constants.ts`);
const refTypesLine = /export const MEMORY_REF_TYPES = \[[^\]]*\]/.exec(constants)?.[0] ?? "";
check("no CUSTOMER / USER / CONNECTION literal in the ref-type list", refTypesLine.length > 0 && !/CUSTOMER|USER|CONNECTION/.test(refTypesLine), refTypesLine);

console.log("\n2. the note guard rejects at WRITE time (S2 ruling 1 + P4 handles)");
const refused: [string, string][] = [
  ["an email", "watch probe@e0-model.invalid"],
  ["a cuid", "linked to cprobe0000000000000000001"],
  ["a uuid", "ref 3f2a9b1c-1234-4abc-8def-0123456789ab"],
  ["a record handle", "watch h_AbCdEfGhIjKlMnOp"],
  ["the opaque user ref", "watch user #0a1b2c3d"],
  ["a card number", "card 4111 1111 1111 1111"],
  ["an account-number run", "account 12345678"],
  ["a URL", "see https://e0-evil.invalid/x"],
  ["braces (a placeholder)", "see {{r:h_AbCdEfGhIjKlMnOp|name}}"],
];
for (const [what, note] of refused) {
  const v = validateOperatorNote(note);
  check(`note with ${what} ⇒ refused`, !v.ok, v);
}
check("a clean note is still accepted (the refusals are not vacuous)", validateOperatorNote("watch the upsert errors").ok === true);

console.log("\n3. sourceRef validation never admits a customer / record ref");
for (const [t, id] of [["INCIDENT", "h_AbCdEfGhIjKlMnOp"], ["INCIDENT", "user #0a1b2c3d"], ["INCIDENT", "probe@e0-model.invalid"], ["METRIC", "h_AbCdEfGhIjKlMnOp"], ["PAGE", "cprobe0000000000000000001"], ["JOB", "probe@e0-model.invalid"], ["PROVIDER", "3f2a9b1c-1234-4abc-8def-0123456789ab"], ["CUSTOMER", "cprobe0000000000000000001"], ["USER", "cprobe0000000000000000001"]] as const) {
  check(`${t} ref ${id.startsWith("h_") ? "<handle>" : "<identity>"} ⇒ refused`, refProblem({ t, id, observedState: "OPEN" }) !== null);
}
check("an INCIDENT ref by its cuid id is the one id-shaped ref allowed", refProblem({ t: "INCIDENT", id: "cprobe0000000000000000001", observedState: "OPEN" }) === null);

console.log("\n4. source scan — memory/** never reaches records, handles or customer packs");
const files = readdirSync(path.join(ROOT, DIR)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
const FORBIDDEN = [
  /tools\/packs\/(customers|onboarding|connections|ai-usage|audit-history)/, /authz\/handles/, /authz\/subject/, /authz\/record-render/, /compose\/record/, /authz\/boundary/,
];
for (const f of files) {
  const imports = [...src(`${DIR}/${f}`).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  check(`${f}: imports no customer pack, handle table, subject resolver or record path`, imports.every((i) => FORBIDDEN.every((r) => !r.test(i))), imports.filter((i) => FORBIDDEN.some((r) => r.test(i))));
}
check("the scan is not vacuous (memory has source files)", files.length >= 8, files.length);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
if (failures) process.exit(1);
