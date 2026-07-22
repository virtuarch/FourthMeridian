/**
 * lib/account-deletion/purge-revocation-wiring.test.ts
 *
 * PRE-BETA-OPS-CLOSE Phase 3 — source-level proof that purge.ts WIRES the
 * bounded revocation policy, and that no secret can reach the evidence trail
 * (house pattern: standalone tsx, DB-free):
 *
 *   npx tsx lib/account-deletion/purge-revocation-wiring.test.ts
 *
 * purge.ts is DB-bound end-to-end (there is no purge harness in this repo), so
 * the decision logic is proven behaviourally in revocation.test.ts and the
 * WIRING is proven structurally here. The properties asserted are the ones whose
 * violation would silently reopen the gap.
 */

import { readFileSync } from "node:fs";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const src = readFileSync("lib/account-deletion/purge.ts", "utf8");
/** Comments describe the OLD behaviour, so structural claims must ignore them. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ── 1. The decision is delegated, not re-implemented ────────────────────────
console.log("1. Policy lives in the authority, not inline");
{
  check("imports the revocation authority", /from "@\/lib\/account-deletion\/revocation"/.test(code));
  check("calls decideRevocation", /decideRevocation\(/.test(code));
  check("counts prior failures in DAYS via the authority", /countPriorFailureDays\(/.test(code));
  check("classifies failures via the authority", /classifyRevocationFailure\(/.test(code));
  check("no hard-coded attempt threshold inline", !/priorFailureDays\s*>=\s*3|attempt\s*>=\s*3/.test(code));
}

// ── 2. REVOKED is only marked on a CONFIRMED outcome ────────────────────────
console.log("2. REVOKED means confirmed — the bug that broke the retry loop");
{
  // The old code marked REVOKED unconditionally after the try/catch, which also
  // excluded the item from this job's own `status: ACTIVE` work-list.
  check("the update is guarded by a confirmed-revocation flag", /if \(revoked\) \{/.test(code));
  check("still filters the work-list on ACTIVE", /status:\s*PlaidItemStatus\.ACTIVE/.test(code));
  check("a retryable failure is collected, not swallowed", /retryableFailures\.push\(/.test(code));
}

// ── 3. HOLD does not destroy anything ───────────────────────────────────────
console.log("3. Hold preserves the ability to retry");
{
  const holdIdx = code.indexOf('action === "hold"');
  check("a hold branch exists", holdIdx > 0);
  const holdBranch = code.slice(holdIdx, holdIdx + 700);
  check("hold RETURNS before the destructive purge", /return \{[\s\S]*?skipped:\s*"pending-provider-revocation"/.test(holdBranch));
  // The User delete is what cascades the encrypted token away.
  check("user.delete comes AFTER the hold return", code.indexOf("db.user.delete") > holdIdx);
  check("deletionScheduledAt is never cleared on hold", !/deletionScheduledAt:\s*null/.test(holdBranch));
}

// ── 4. Terminal path is honest and durable ──────────────────────────────────
console.log("4. Terminal completion records what actually happened");
{
  check("writes ACCOUNT_DELETION_REVOCATION_FAILED per failed item",
    /AuditAction\.ACCOUNT_DELETION_REVOCATION_FAILED/.test(code));
  check("writes the terminal ACCOUNT_DELETED_UNREVOKED record",
    /AuditAction\.ACCOUNT_DELETED_UNREVOKED/.test(code));
  check("terminal record is a DISTINCT action from ACCOUNT_DELETED",
    /AuditAction\.ACCOUNT_DELETED\b/.test(code) && /AuditAction\.ACCOUNT_DELETED_UNREVOKED/.test(code));
  const termIdx = code.indexOf("ACCOUNT_DELETED_UNREVOKED");
  check("the terminal record is written BEFORE the user delete (so it survives)",
    termIdx > 0 && termIdx < code.indexOf("db.user.delete"));
  check("emits a CRITICAL operator log line", /\[CRITICAL\]/.test(src));
  check("evidence carries the item id + institution for manual revocation",
    /plaidItemId:\s*f\.itemId/.test(code) && /institution:\s*f\.institution/.test(code));
}

// ── 5. SECRET SAFETY — the non-negotiable ───────────────────────────────────
console.log("5. No secret can reach audit or logs");
{
  // The token is decrypted into a local const and handed straight to Plaid.
  check("accessToken is only passed to itemRemove",
    /itemRemove\(\{ access_token: accessToken \}\)/.test(code));
  // Indentation-agnostic: take a generous window after each audit write rather
  // than relying on a closing-brace column that differs by nesting depth.
  const auditBlocks = [...code.matchAll(/db\.auditLog\.create\(/g)]
    .map((m) => code.slice(m.index ?? 0, (m.index ?? 0) + 900));
  check("found the audit writes to inspect", auditBlocks.length >= 2, `${auditBlocks.length}`);
  for (const [i, b] of auditBlocks.entries()) {
    check(`audit write #${i + 1} contains no token/secret reference`,
      !/accessToken|access_token|encryptedToken|secret/i.test(b));
  }
  // Console lines must not interpolate the token either.
  const logs = [...src.matchAll(/console\.(log|warn|error)\([\s\S]*?\);/g)].map((m) => m[0]);
  check("no console line references the token",
    logs.every((l) => !/accessToken|access_token|encryptedToken/.test(l)), `${logs.length} log lines scanned`);
  // The sanitized reason is a Plaid error CODE, never a raw error object.
  check("failure reason is a sanitized code, not a raw error",
    /reason:\s*code \?\? "PLAID_ITEM_REMOVE_FAILED"/.test(code));
}

// ── 6. Idempotency of the surrounding job is preserved ──────────────────────
console.log("6. The existing cron contract still holds");
{
  const job = readFileSync("jobs/process-deletions.ts", "utf8");
  check("the cron still selects on deletionScheduledAt", /deletionScheduledAt:\s*\{\s*not:\s*null,\s*lte:/.test(job));
  check("a held user is therefore re-selected next run (User row survives)",
    /result\.purged/.test(job));
}

console.log(failures === 0
  ? "\n✅ purge revocation wiring: all checks passed"
  : `\n❌ purge revocation wiring: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
