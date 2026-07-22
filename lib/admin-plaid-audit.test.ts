/**
 * lib/admin-plaid-audit.test.ts — V25-CLOSE-3 Part 3
 *
 * INVARIANT: every high-impact admin Expand-History operation on a customer's
 * Plaid item writes a forensic audit record — attributed, on the success path
 * only, and without secrets.
 *
 *     npx tsx lib/admin-plaid-audit.test.ts
 *
 * These three routes mutate real customer infrastructure (create a link token,
 * exchange a public_token into a new PlaidItem, retire a superseded item via
 * /item/remove) and previously left no record. This guard mirrors the platform
 * ops guard pattern (beta-ops-guards / connection-ops-guards): assert the write
 * exists, is attributed, uses a typed action, and never logs a token.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { AuditAction } from "@/lib/audit-actions";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}
/** Slice the exact `auditLog.create( ... )` argument by balancing parentheses. */
function auditCreateCall(code: string): string {
  const at = code.search(/auditLog\.create\s*\(/);
  if (at === -1) return "";
  const open = code.indexOf("(", at);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) return code.slice(open, i + 1);
  }
  return code.slice(open);
}

const ROUTES: { file: string; action: string }[] = [
  { file: "app/api/admin/plaid/retire-superseded-item/route.ts",        action: "ADMIN_PLAID_ITEM_RETIRED" },
  { file: "app/api/admin/plaid/exchange-expanded-history-token/route.ts", action: "ADMIN_PLAID_HISTORY_TOKEN_EXCHANGED" },
  { file: "app/api/admin/plaid/expand-history-token/route.ts",          action: "ADMIN_PLAID_HISTORY_TOKEN_CREATED" },
];

// The typed vocabulary must actually carry these actions.
for (const { action } of ROUTES) {
  check(`AuditAction.${action} is a canon constant`, (AuditAction as Record<string, string>)[action] === action);
}

for (const { file, action } of ROUTES) {
  const raw = read(file);
  const code = stripComments(raw);

  check(`${file} writes an audit row`, /auditLog\.create\s*\(/.test(code), "no db.auditLog.create found");

  check(
    `${file} uses the typed action AuditAction.${action}`,
    code.includes(`AuditAction.${action}`),
    "the audit write must use the typed action constant, not a free string",
  );

  check(
    `${file} attributes the acting admin (performedByAdminId)`,
    /performedByAdminId\s*:/.test(code),
    "the audit row must record who acted",
  );

  // Auth-before-audit: the guard must return BEFORE any audit write, so a
  // rejected caller never produces a misleading record. Assert the guard's
  // early-return precedes the first auditLog.create in source order.
  const guardIdx = code.search(/requireSystemAdmin\s*\(\s*\)/);
  const errReturnIdx = code.search(/if\s*\(\s*err\s*\)\s*return\s+err/);
  const auditIdx = code.search(/auditLog\.create/);
  check(
    `${file} authorizes before it audits (no record for a rejected caller)`,
    guardIdx !== -1 && errReturnIdx !== -1 && auditIdx !== -1 && errReturnIdx < auditIdx,
    `guard@${guardIdx} errReturn@${errReturnIdx} audit@${auditIdx}`,
  );

  // No secrets in the audit payload. These tokens must never be logged. Allow the
  // word to appear elsewhere in the route (it legitimately handles tokens) — only
  // forbid it INSIDE the exact auditLog.create(...) argument.
  const auditBlock = auditCreateCall(code);
  for (const secret of ["publicToken", "public_token", "access_token", "accessToken", "link_token", "linkToken"]) {
    check(
      `${file} audit payload does not log ${secret}`,
      !auditBlock.includes(secret),
      `"${secret}" appears within the audit metadata block`,
    );
  }
}

console.log(`\nadmin-plaid-audit: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
