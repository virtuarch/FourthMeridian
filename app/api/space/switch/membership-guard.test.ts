/** ARCH-001 / CQ-007 — the Space switch uses the shared role guard, not an inline membership copy. */
import { readFileSync } from "node:fs";
let f = 0;
const check = (n: string, ok: boolean) => { if (!ok) f++; console.log(`  ${ok ? "✓" : "✗"} ${n}`); };
const s = readFileSync("app/api/space/switch/route.ts", "utf8");
check("calls requireSpaceRole(spaceId) and returns its refusal", /const \[auth, denied\] = await requireSpaceRole\(spaceId\);\s*if \(denied\) return denied;/.test(s));
check("no inline spaceMember lookup remains", !/spaceMember\.find/.test(s));
check("still authenticates and validates the body before the membership check",
  s.indexOf("requireUser()") < s.indexOf("spaceId is required") && s.indexOf("spaceId is required") < s.indexOf("requireSpaceRole(spaceId)"));
const session = readFileSync("lib/session.ts", "utf8");
check("the guard's refusal is the same 403 body the route returned", /forbidden = \(\): NextResponse =>\s*NextResponse\.json\(\{ error: "Forbidden" \}, \{ status: 403 \}\)/.test(session));
if (f) process.exit(1);
console.log("\nall checks passed");
