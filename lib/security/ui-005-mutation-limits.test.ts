/**
 * lib/security/ui-005-mutation-limits.test.ts — UI-005: per-user limits on the
 * Space invite POST (20/h, it sends e-mail) and transaction correction (60/h,
 * it mints durable rules).
 *
 *     npx tsx lib/security/ui-005-mutation-limits.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** Source with comments removed (line comments first, so `/admin/*` in prose cannot open a phantom block). */
function routeCode(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function makeChecker(label: string) {
  let failures = 0;
  return {
    check(name: string, cond: boolean, detail?: string): void {
      if (cond) console.log(`  ✓ ${name}`);
      else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
    },
    finish(): never {
      if (failures > 0) { console.error(`\n${label}: ${failures} check(s) failed.`); process.exit(1); }
      console.log(`\n${label}: all checks passed.`);
      process.exit(0);
    },
  };
}

const { check, finish } = makeChecker("UI-005");
console.log("UI-005 — Space mutation rate limits");

const invite = routeCode("app/api/spaces/[id]/invite/route.ts");
const invPost = invite.slice(invite.indexOf("export async function POST("));
const invLimit = invPost.indexOf('limitByUser(user.id, "space-invite", { limit: 20, windowSec: 3600 })');
check("invite POST: limitByUser 20/h keyed on the inviter", invLimit !== -1);
check("invite POST: the limited response is returned", /if \(limited\) return limited;/.test(invPost));
check("invite POST: limit precedes the e-mail send", invLimit !== -1 && invLimit < invPost.indexOf("sendEmail("));
check("invite POST: limit follows the role gate (anonymous/unauthorised calls never consume a bucket)",
  invPost.indexOf("requireSpaceRole(spaceId, SpaceMemberRole.ADMIN)") < invLimit);

const correct = routeCode("app/api/transactions/[id]/correct/route.ts");
const corLimit = correct.indexOf('limitByUser(user.id, "transaction-correct", { limit: 60, windowSec: 3600 })');
check("correct POST: limitByUser 60/h keyed on the user", corLimit !== -1);
check("correct POST: the limited response is returned", /if \(limited\) return limited;/.test(correct));
check("correct POST: limit precedes the body parse and any write",
  corLimit !== -1 && corLimit < correct.indexOf("req.json()") && corLimit > correct.indexOf("await requireUser()"));
finish();
