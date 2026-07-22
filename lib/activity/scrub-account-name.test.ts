/**
 * lib/activity/scrub-account-name.test.ts  (P1 closeout)
 *
 * Unit test for the AuditLog activity-name scrub decision logic. Pure (no DB),
 * so it drives decideScrub directly across every tier + the legacy/no-marker and
 * deleted-account cases, and proves idempotency.
 *
 *     npx tsx lib/activity/scrub-account-name.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideScrub } from "./scrub-account-name";
import { GENERIC_ACCOUNT_LABEL } from "./account-name-privacy";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const REAL = "Real Chase Checking";
const checkingHint = { type: "checking", debtSubtype: null };
const cardHint = { type: "debt", debtSubtype: "credit_card" };

// ── 1. FULL rows are never candidates (real name retained) ────────────────────
console.log("1. FULL retains the real name");
{
  const d = decideScrub({ visibilityLevel: "FULL", storedName: REAL, hint: checkingHint });
  check("FULL → not a candidate", !d.isCandidate);
  check("FULL → safe value is the stored real name", d.safeName === REAL);
}

// ── 2. BALANCE_ONLY / SUMMARY_ONLY → redact to genericAccountName ─────────────
console.log("2. non-FULL redacts to a generic typed label");
{
  const b = decideScrub({ visibilityLevel: "BALANCE_ONLY", storedName: REAL, hint: checkingHint });
  check("BALANCE_ONLY real name → candidate", b.isCandidate);
  check("BALANCE_ONLY safe value = typed generic", b.safeName === "Checking Account");
  check("BALANCE_ONLY safe value leaks no real name", !b.safeName.includes("Chase"));

  const s = decideScrub({ visibilityLevel: "SUMMARY_ONLY", storedName: REAL, hint: cardHint });
  check("SUMMARY_ONLY real name → candidate", s.isCandidate);
  check("SUMMARY_ONLY safe value = typed generic", s.safeName === "Credit Card");
}

// ── 3. Legacy rows with NO visibility marker → fail closed (redact) ───────────
console.log("3. no visibility marker (legacy revoke) fails closed");
{
  const n = decideScrub({ visibilityLevel: null, storedName: REAL, hint: checkingHint });
  check("absent marker + real name → candidate (fail closed)", n.isCandidate);
  check("absent marker → typed generic", n.safeName === "Checking Account");

  const u = decideScrub({ visibilityLevel: undefined, storedName: REAL, hint: null });
  check("absent marker + deleted account → candidate", u.isCandidate);
  check("deleted account (no hint) → generic label constant", u.safeName === GENERIC_ACCOUNT_LABEL);
}

// ── 4. Already-safe non-FULL rows are NOT candidates (idempotency) ────────────
console.log("4. idempotency — already-generic rows are skipped");
{
  const already = decideScrub({ visibilityLevel: "BALANCE_ONLY", storedName: "Checking Account", hint: checkingHint });
  check("stored == safe → not a candidate", !already.isCandidate);

  // A row scrubbed by the write-time helper (new BALANCE_ONLY shares) is safe.
  const newRow = decideScrub({ visibilityLevel: "BALANCE_ONLY", storedName: "Credit Card", hint: cardHint });
  check("write-time-safe BALANCE_ONLY row → not a candidate", !newRow.isCandidate);

  const constAlready = decideScrub({ visibilityLevel: null, storedName: GENERIC_ACCOUNT_LABEL, hint: null });
  check("stored == generic constant → not a candidate", !constAlready.isCandidate);
}

// ── 5. Full round-trip idempotency — scrub, then re-scrub is a no-op ──────────
console.log("5. round-trip — re-scrubbing a scrubbed value is a no-op");
{
  const first = decideScrub({ visibilityLevel: "BALANCE_ONLY", storedName: REAL, hint: checkingHint });
  const second = decideScrub({ visibilityLevel: "BALANCE_ONLY", storedName: first.safeName, hint: checkingHint });
  check("second pass over the scrubbed value → not a candidate", first.isCandidate && !second.isCandidate);
}

// ── 6. Rows with no stored name are irrelevant (guarded by the harness) ───────
console.log("6. empty / missing stored name");
{
  const empty = decideScrub({ visibilityLevel: "BALANCE_ONLY", storedName: "", hint: checkingHint });
  check("empty stored name → not a candidate (nothing to redact)", !empty.isCandidate);
}

// ── 7. Source-scan — the script wires the pure decision + dry-run default ─────
console.log("7. source-scan — script safety wiring");
{
  const src = readFileSync(join(process.cwd(), "scripts", "scrub-activity-account-names.ts"), "utf8");
  check("script uses the pure decideScrub", src.includes("decideScrub("));
  check("script resolves the visibility marker from BOTH keys (read-path parity)",
    src.includes("str(meta.visibilityLevel) ?? str(meta.visibility)"));
  check("script is dry-run by default (APPLY gated on --apply)", src.includes('argv.includes("--apply")'));
  check("script only rewrites accountName (spreads existing metadata)", src.includes("...c.meta, accountName: c.after"));
  check("script runs a post-apply verification recount", src.includes("remaining non-FULL rows with an unredacted name"));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll activity-name scrub decision checks passed.");
process.exit(0);
