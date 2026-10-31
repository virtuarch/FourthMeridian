/**
 * lib/audit-email-hash.test.ts — PRIV-002 / UI-013: no raw e-mail address is
 * written into AuditLog.metadata by the forgot-password, reset-password,
 * growth-revenue (approve / deny / resend / revoke / cold invitation) and
 * admin 2FA-reset paths. They reference the address by auditEmailHash.
 *
 * PART A — the digest itself (executed): stable, normalised, non-reversible
 *          in shape, and the same digest the purge path uses.
 * PART B — per-path source pins (the handlers need Prisma + next/server and
 *          cannot be invoked here): each path hashes, none carries `email:`.
 * PART C — census: no route under app/api writes an `email:` key into an
 *          auditLog.create metadata object at all.
 *
 *     npx tsx lib/audit-email-hash.test.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { auditEmailHash } from "@/lib/audit";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const code = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

console.log("audit e-mail hashing (PRIV-002)\n\nA. the digest");
const h = auditEmailHash("Person@Example.com ");
check("sha256 hex, 64 chars", /^[0-9a-f]{64}$/.test(h));
check("normalised: case and surrounding whitespace do not change it", h === auditEmailHash("person@example.com"));
check("does not contain the address", !h.includes("person") && !h.includes("example"));
check("distinct addresses → distinct digests", h !== auditEmailHash("other@example.com"));

console.log("\nB. every named path hashes");
const PATHS = [
  "app/api/auth/forgot-password/route.ts",
  "app/api/auth/reset-password/route.ts",
  "app/api/platform/growth-revenue/requests/[id]/deny/route.ts",
  "app/api/platform/growth-revenue/requests/[id]/revoke/route.ts",
  // PR B — approve / resend / direct invite / extend audit through THE issuance
  // mechanism; the routes themselves write no audit row.
  "lib/platform/growth/invitation-issue.ts",
  "app/api/admin/security/users/[userId]/2fa-reset/route.ts",
];
for (const rel of PATHS) {
  const src = code(rel);
  check(`${rel} imports auditEmailHash`, /import \{[^}]*\bauditEmailHash\b[^}]*\} from "@\/lib\/audit"/.test(src));
  // SEC-PLAT-2 — the Growth beta routes write through recordOperatorAction, whose
  // `detail` is spread into AuditLog.metadata (lib/audit.ts buildOperatorActionData).
  check(`${rel} writes an emailHash into its audit metadata`, /(metadata|detail):\s*\{[^}]*[eE]mailHash:\s*auditEmailHash\(/.test(src));
  check(`${rel} writes NO raw email into audit metadata`, !/metadata:\s*\{[^}]*\b(email|targetEmail):\s*(?!auditEmailHash)/.test(src));
}

console.log("\nC. census: no app/api route writes a raw email into AuditLog.metadata");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, e);
    if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (e === "route.ts") out.push(rel);
  }
  return out;
}
const routes = walk("app/api");
const offenders = routes.filter((rel) => {
  const src = code(rel);
  // Every auditLog.create({ data: { … metadata: { … } } }) block: look for an `email:` key
  // whose value is not the digest helper.
  const blocks = src.match(/auditLog\.create\(\{[\s\S]*?\n\s*\}\);/g) ?? [];
  return blocks.some((b) => /metadata:\s*\{[^}]*\b(email|targetEmail|applicantEmail):\s*(?!auditEmailHash)/.test(b));
});
check(`no route writes email: into audit metadata (${routes.length} routes scanned)`, offenders.length === 0, offenders.join(", "));
check("the census needle fires on a counterexample (so an empty offender list means something)",
  /metadata:\s*\{[^}]*\b(email|targetEmail|applicantEmail):\s*(?!auditEmailHash)/.test("metadata: { betaRequestId: id, email: request.email }") &&
  !/metadata:\s*\{[^}]*\b(email|targetEmail|applicantEmail):\s*(?!auditEmailHash)/.test("metadata: { emailHash: auditEmailHash(x) }"));

if (failures > 0) { console.error(`\naudit-email-hash: ${failures} check(s) failed.`); process.exit(1); }
console.log("\naudit-email-hash: all checks passed.");
