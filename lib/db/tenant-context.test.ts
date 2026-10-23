/**
 * lib/db/tenant-context.test.ts  (RLS-2)
 *
 * Pins the CONTRACT of the trusted identity channel without a database.
 *
 * The behavioural proof — that SET LOCAL actually isolates tenants, clears on
 * commit and on rollback, and cannot leak across a recycled pooled connection —
 * lives in scripts/rls-acceptance.ts, which needs a real Postgres and real
 * roles. What this file defends is the set of properties a future edit could
 * silently remove while every other test stayed green.
 */

import { readFileSync } from "node:fs";
import { join }         from "node:path";

const ROOT = join(__dirname, "..", "..");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) { failures++; console.error(`FAIL  ${name}${detail ? `  -> ${detail}` : ""}`); }
  else console.log(`pass  ${name}`);
}

const ctx = src("lib/db/tenant-context.ts");
const dbSrc = src("lib/db.ts");

// ── The one property the whole design rests on ───────────────────────────────
// A session-level SET survives the transaction and is inherited by whoever
// borrows the pooled connection next. Transaction-local is the only safe form.
check("identity is set TRANSACTION-LOCALLY (set_config(..., true))",
  /set_config\(\s*\$\{?TENANT_GUC\}?\s*,\s*\$\{?userId\}?\s*,\s*true\s*\)/.test(ctx)
  || /set_config\([\s\S]*TENANT_GUC[\s\S]*userId[\s\S]*true\)/.test(ctx));

check("no session-scoped `SET app.` anywhere in the channel",
  !/\bSET\s+app\./i.test(ctx.replace(/SET LOCAL/gi, "")) || !/\bSET\s+app\.[a-z_]+\s*=/i.test(ctx));

// Strip comments first: the header EXPLAINS why `SET LOCAL app.user_id = $1`
// cannot be used, and a naive scan would match the explanation and call it the
// defect it warns about.
const ctxCode = ctx.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
check("the identity is BOUND, never interpolated into SQL text",
  ctxCode.includes("set_config(")
  && !/\$(execute|query)RawUnsafe/.test(ctxCode)
  && !/SET\s+LOCAL/i.test(ctxCode));

// ── Fail closed, loudly ──────────────────────────────────────────────────────
// An empty identity makes every policy evaluate false, which yields silent
// empty result sets — indistinguishable from "no data" anywhere in this
// codebase. Refusing is the difference between an outage and a mystery.
check("refuses an empty identity rather than running unidentified",
  ctx.includes("TenantIdentityError") && /userId\.length === 0|!userId/.test(ctx));

check("the refusal happens BEFORE the transaction opens",
  ctx.indexOf("TenantIdentityError") < ctx.indexOf("$transaction"));

// ── It must be an INTERACTIVE transaction ────────────────────────────────────
// A batch-array $transaction has no statement slot before the writes, so there
// is nowhere for the identity to go.
check("uses the interactive ($transaction with a callback) form",
  /\$transaction\(\s*async\s*\(tx\)/.test(ctx));

// ── Role separation ──────────────────────────────────────────────────────────
check("tenant work goes to the fm_app client, not the legacy shared one",
  ctx.includes("tenantDb") && !/from "@\/lib\/db";[\s\S]*\bdb\b\s*\./.test(ctx));

check("lib/db.ts exposes one client per database role",
  ["tenantDb", "authDb", "systemDb"].every((n) => dbSrc.includes(`export const ${n}`)));

check("role clients fall back to the shared client when unprovisioned",
  /tenantClient \?\? db/.test(dbSrc) && /authClient\s+\?\? db/.test(dbSrc) && /systemClient \?\? db/.test(dbSrc));

check("the fallback is observable rather than silent (activeDbRoles)",
  dbSrc.includes("export function activeDbRoles"));

check("every role client is clone-guarded like the primary one",
  /roleClient[\s\S]{0,400}assertNonLiveDatabase/.test(dbSrc));

check("role clients are cached across dev hot-reload (no pool exhaustion)",
  dbSrc.includes("globalForRoles"));

// ── Identity provenance ──────────────────────────────────────────────────────
// Documented, because the rule is unenforceable by types: the id must come from
// server-side session state, never from anything the client can set.
check("documents that the identity must not come from client input",
  /never a request body|Never a request body/i.test(ctx) && /cookie/i.test(ctx));

// ── RLS-PREVIEW-13b: a tenant transaction cannot stay idle indefinitely ──────
// A phase orphaned by a failing sibling, in a suspended instance, sat idle in
// transaction for 150 s+ until a manual terminate. The server-side timeout must be
// set on EVERY tenant transaction, transaction-locally, in the identity statement.
check("every tenant transaction sets idle_in_transaction_session_timeout TRANSACTION-LOCALLY, in the identity statement",
  /SELECT set_config\(\$\{TENANT_GUC\}, \$\{userId\}, true\), set_config\('idle_in_transaction_session_timeout', \$\{TENANT_IDLE_IN_TRANSACTION_TIMEOUT\}, true\)/.test(ctxCode),
  "the identity statement no longer carries the transaction-local idle timeout");
check("…and the timeout is a short bound (≤ 30 s), not disabled",
  /TENANT_IDLE_IN_TRANSACTION_TIMEOUT = "(\d+)s"/.test(ctx) && Number(/TENANT_IDLE_IN_TRANSACTION_TIMEOUT = "(\d+)s"/.exec(ctx)?.[1]) > 0
  && Number(/TENANT_IDLE_IN_TRANSACTION_TIMEOUT = "(\d+)s"/.exec(ctx)?.[1]) <= 30);

check("server-only, so the channel cannot be imported into a client bundle",
  ctx.includes('import "server-only"'));

if (failures > 0) { console.error(`\ntenant-context: ${failures} failure(s).`); process.exit(1); }
console.log("\ntenant-context: all passed.");
