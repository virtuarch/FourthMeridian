/**
 * lib/account-deletion/preflight.test.ts  (OPS-2 S7b)
 *
 * Pure guards for the sole-OWNER deletion block. Standalone tsx script:
 *
 *     npx tsx lib/account-deletion/preflight.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network.
 */

import { GRACE_DAYS, GRACE_MS, isSoleOwnerBlock } from "@/lib/account-deletion/preflight";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ME = "me";

console.log("account-deletion/preflight");

// Grace constant sanity.
check("GRACE_DAYS is 7 (decision D1)", GRACE_DAYS === 7);
check("GRACE_MS matches GRACE_DAYS", GRACE_MS === 7 * 24 * 60 * 60 * 1000);

// Sole OWNER with other active members → BLOCK.
check(
  "sole active OWNER + other active members → blocked",
  isSoleOwnerBlock({
    userId: ME, spaceType: "SHARED",
    activeMembers: [{ userId: ME, role: "OWNER" }, { userId: "other", role: "MEMBER" }],
  }) === true,
);

// Sole OWNER but no other members → NOT blocked (materially personal property).
check(
  "sole OWNER, no other active members → not blocked",
  isSoleOwnerBlock({
    userId: ME, spaceType: "SHARED",
    activeMembers: [{ userId: ME, role: "OWNER" }],
  }) === false,
);

// A co-OWNER exists → NOT blocked.
check(
  "co-OWNER present → not blocked",
  isSoleOwnerBlock({
    userId: ME, spaceType: "SHARED",
    activeMembers: [{ userId: ME, role: "OWNER" }, { userId: "other", role: "OWNER" }],
  }) === false,
);

// User is not an OWNER (just a member) → NOT blocked (normal leave semantics).
check(
  "non-OWNER member → not blocked",
  isSoleOwnerBlock({
    userId: ME, spaceType: "SHARED",
    activeMembers: [{ userId: ME, role: "MEMBER" }, { userId: "boss", role: "OWNER" }],
  }) === false,
);

// PERSONAL Space is never a blocker.
check(
  "PERSONAL Space → never blocked",
  isSoleOwnerBlock({
    userId: ME, spaceType: "PERSONAL",
    activeMembers: [{ userId: ME, role: "OWNER" }, { userId: "other", role: "MEMBER" }],
  }) === false,
);

// Other members are only counted when ACTIVE (caller pre-filters to ACTIVE);
// a lone active OWNER whose only "other" was removed is passed as just [ME].
check(
  "removed/left members excluded upstream → lone active OWNER not blocked",
  isSoleOwnerBlock({
    userId: ME, spaceType: "SHARED",
    activeMembers: [{ userId: ME, role: "OWNER" }],
  }) === false,
);

console.log(failures === 0 ? "\nAll preflight checks passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
