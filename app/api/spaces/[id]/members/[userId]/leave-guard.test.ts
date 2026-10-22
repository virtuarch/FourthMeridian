/**
 * IDEMP-010 — last-OWNER and PERSONAL guards on member DELETE.
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs "app/api/spaces/[id]/members/[userId]/leave-guard.test.ts"
 */
import { readFileSync } from "node:fs";
import { decideMemberRemoval } from "./leave-guard";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

check("a non-owner may always leave / be removed", decideMemberRemoval({ targetRole: "MEMBER", spaceType: "SHARED", otherActiveOwners: 0 }).ok);
const personal = decideMemberRemoval({ targetRole: "OWNER", spaceType: "PERSONAL", otherActiveOwners: 0 });
check("the owner cannot leave a PERSONAL Space (400)", !personal.ok && personal.status === 400);
const last = decideMemberRemoval({ targetRole: "OWNER", spaceType: "SHARED", otherActiveOwners: 0 });
check("the LAST owner cannot leave a SHARED Space (409, transfer first)", !last.ok && last.status === 409 && /Transfer ownership/.test(last.error));
check("an owner may leave when another ACTIVE owner remains", decideMemberRemoval({ targetRole: "OWNER", spaceType: "SHARED", otherActiveOwners: 1 }).ok);

const route = readFileSync("app/api/spaces/[id]/members/[userId]/route.ts", "utf8");
const del = route.slice(route.indexOf("export const DELETE"));
const iGuard = del.indexOf("decideMemberRemoval(");
const iWrite = del.indexOf("tx.spaceAccountLink.count(");
check("DELETE consults the guard BEFORE any write", iGuard > 0 && iWrite > iGuard, `${iGuard} ${iWrite}`);
check("other owners are counted as ACTIVE OWNERs excluding the target", /role: SpaceMemberRole\.OWNER, status: SpaceMemberStatus\.ACTIVE, userId: \{ not: targetUserId \}/.test(del));

if (failures > 0) { console.error(`\n❌ leave guard: ${failures} check(s) failed`); process.exit(1); }
console.log("\n✅ leave guard: all checks passed");
