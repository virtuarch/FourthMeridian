/**
 * lib/activity/account-name-privacy.test.ts  (P1-3)
 *
 * Regression for the Space activity-feed account-name policy. Founder ruling:
 * FULL may surface the real account name; BALANCE_ONLY / SUMMARY_ONLY must use a
 * generic identity; REVOKED / deleted links must not surface stale detail. The
 * fix is defense in depth:
 *   - storedActivityAccountName (WRITE) never persists a real name for a
 *     non-FULL share.
 *   - displayActivityAccountName (READ) redacts a legacy payload that already
 *     persisted a real BALANCE_ONLY name, failing closed when the visibility
 *     marker is absent (legacy revoke rows).
 *
 * These tests drive both real helpers, then source-scan guards prove the write
 * sites (share route) and the read site (activity route) are wired to them.
 *
 *     npx tsx lib/activity/account-name-privacy.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VisibilityLevel } from "@prisma/client";
import {
  storedActivityAccountName,
  displayActivityAccountName,
  GENERIC_ACCOUNT_LABEL,
} from "./account-name-privacy";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const REAL = "Real Chase Checking";
const checkingHint = { type: "checking", debtSubtype: null };
const cardHint = { type: "debt", debtSubtype: "credit_card" };

function main(): void {
  // ── 1. WRITE time — a real name is never persisted for a non-FULL share ────
  console.log("1. storedActivityAccountName (write) — real name only for FULL");
  check("FULL persists the real name", storedActivityAccountName(VisibilityLevel.FULL, REAL, checkingHint) === REAL);
  {
    const balance = storedActivityAccountName(VisibilityLevel.BALANCE_ONLY, REAL, checkingHint);
    check("BALANCE_ONLY persists a generic typed label", balance === "Checking Account");
    check("BALANCE_ONLY never persists the real name", balance !== REAL && !balance.includes("Chase"));
  }
  {
    const summary = storedActivityAccountName(VisibilityLevel.SUMMARY_ONLY, REAL, cardHint);
    check("SUMMARY_ONLY persists a generic typed label (fails closed)", summary === "Credit Card");
    check("SUMMARY_ONLY never persists the real name", summary !== REAL && !summary.includes("Chase"));
  }
  check("FULL with unknown real name falls back to a generic label", storedActivityAccountName(VisibilityLevel.FULL, null, checkingHint) === "Checking Account");

  // ── 2. READ time — display fails closed unless the marker is FULL ──────────
  console.log("2. displayActivityAccountName (read) — fail closed unless FULL");
  check("FULL surfaces the persisted name", displayActivityAccountName(REAL, "FULL") === REAL);
  check("BALANCE_ONLY redacts to the generic label", displayActivityAccountName(REAL, "BALANCE_ONLY") === GENERIC_ACCOUNT_LABEL);
  check("SUMMARY_ONLY redacts to the generic label", displayActivityAccountName(REAL, "SUMMARY_ONLY") === GENERIC_ACCOUNT_LABEL);
  // The load-bearing legacy case: an old BALANCE_ONLY *share* row whose real name
  // was persisted before this slice — visibility marker present, non-FULL.
  check("legacy BALANCE_ONLY share payload (real name persisted) is redacted on render", displayActivityAccountName(REAL, "BALANCE_ONLY") === GENERIC_ACCOUNT_LABEL);
  // Legacy *revoke* rows carried NO visibility marker at all — fail closed.
  check("legacy revoke payload with NO visibility marker is redacted (fail closed)", displayActivityAccountName(REAL, "") === GENERIC_ACCOUNT_LABEL);
  check("undefined visibility marker is redacted (fail closed)", displayActivityAccountName(REAL, undefined) === GENERIC_ACCOUNT_LABEL);
  check("FULL revoke with empty persisted name → generic label", displayActivityAccountName("", "FULL") === GENERIC_ACCOUNT_LABEL);

  // ── 3. Round-trip — a fixed non-FULL write never round-trips a real name ────
  console.log("3. round-trip — a non-FULL share leaks no real name at either layer");
  {
    const stored = storedActivityAccountName(VisibilityLevel.BALANCE_ONLY, REAL, checkingHint);
    const displayed = displayActivityAccountName(stored, "BALANCE_ONLY");
    check("write→read for BALANCE_ONLY never exposes the real name", !stored.includes("Chase") && displayed === GENERIC_ACCOUNT_LABEL);
  }

  // ── 4. Source-scan — write sites (share route) wired ───────────────────────
  console.log("4. source-scan — share route write sites wired");
  {
    const shareSrc = readFileSync(join(process.cwd(), "app", "api", "spaces", "[id]", "accounts", "share", "route.ts"), "utf8");
    check("share route imports storedActivityAccountName", shareSrc.includes("storedActivityAccountName"));
    check("share (POST) no longer persists the raw fa.name", !/accountName:\s*fa\.name/.test(shareSrc));
    check("revoke (DELETE) no longer persists the raw account name", !/accountName:\s*link\.financialAccount\?\.name/.test(shareSrc));
    check("revoke payload now carries visibilityLevel", /visibilityLevel:\s*link\.visibilityLevel/.test(shareSrc));
  }

  // ── 5. Source-scan — read site (activity route) wired ──────────────────────
  console.log("5. source-scan — activity route read site wired");
  {
    const actSrc = readFileSync(join(process.cwd(), "app", "api", "spaces", "[id]", "activity", "route.ts"), "utf8");
    check("activity route imports displayActivityAccountName", actSrc.includes("displayActivityAccountName"));
    // The old ungated fallback must be gone from BOTH the share and revoke cases.
    check("no ungated `|| \"an account\"` fallback remains for account events", !/str\(meta\.accountName\) \|\| str\(meta\.name\) \|\| "an account"/.test(actSrc));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll activity account-name privacy checks passed.");
  process.exit(0);
}

main();
