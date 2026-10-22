/**
 * lib/security/cron-secret.test.ts — SEC-009: the CRON_SECRET comparison is
 * constant-time and fails closed.
 *
 *     npx tsx lib/security/cron-secret.test.ts
 */

import { timingSafeStringEqual, verifyCronAuthorization } from "./cron-secret";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("cron-secret (SEC-009)\n\nA. timingSafeStringEqual");
check("equal strings → true", timingSafeStringEqual("s3cret-value", "s3cret-value"));
check("different strings of equal length → false", !timingSafeStringEqual("s3cret-value", "s3cret-valuf"));
check("different lengths → false (no throw, no short-circuit by length)", !timingSafeStringEqual("abc", "abcd") && !timingSafeStringEqual("abcd", "abc"));
check("prefix of the secret → false", !timingSafeStringEqual("s3cret", "s3cret-value"));
check("empty expected → false even for an empty actual (an unset secret never matches)", !timingSafeStringEqual("", ""));
check("non-strings → false", !timingSafeStringEqual(null, "x") && !timingSafeStringEqual("x", undefined) && !timingSafeStringEqual(42, 42));
check("unicode handled bytewise (no normalisation surprises)", timingSafeStringEqual("é", "é") && !timingSafeStringEqual("é", "é"));

console.log("\nB. verifyCronAuthorization");
const S = "cron-secret-0123456789";
check("Bearer <secret> → AUTHORIZED", verifyCronAuthorization(`Bearer ${S}`, S) === "AUTHORIZED");
check("case-insensitive scheme, surrounding whitespace tolerated", verifyCronAuthorization(`  bearer ${S} `, S) === "AUTHORIZED");
check("wrong bearer → MISMATCH", verifyCronAuthorization("Bearer nope", S) === "MISMATCH");
check("bearer that is a prefix of the secret → MISMATCH", verifyCronAuthorization(`Bearer ${S.slice(0, 10)}`, S) === "MISMATCH");
check("no header → MISSING", verifyCronAuthorization(null, S) === "MISSING" && verifyCronAuthorization(undefined, S) === "MISSING");
check("non-Bearer scheme → MISSING", verifyCronAuthorization(`Basic ${S}`, S) === "MISSING");
check("secret unset → SECRET_UNSET regardless of the header (fail closed)",
  verifyCronAuthorization(`Bearer ${S}`, undefined) === "SECRET_UNSET" && verifyCronAuthorization(`Bearer `, "") === "SECRET_UNSET");

if (failures > 0) { console.error(`\ncron-secret: ${failures} check(s) failed.`); process.exit(1); }
console.log("\ncron-secret: all checks passed.");
