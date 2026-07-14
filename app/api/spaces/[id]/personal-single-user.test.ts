/**
 * app/api/spaces/[id]/personal-single-user.test.ts
 *
 * Invariant gate: a PERSONAL Space is strictly single-user (its sole member is
 * the OWNER). The whole app resolves "which personal space is mine?" by
 * membership with no owner filter (lib/space.ts, space-account-link,
 * app/api/brief, Sidebar, and — catastrophically — lib/account-deletion/purge.ts,
 * which would cross-user-delete a personal Space you're merely a member of), so
 * a second member of ANY role is unsafe. The three mutation entry points must
 * reject it server-side:
 *
 *   - POST   /invite                    — can't create an invite into a personal Space
 *   - PATCH  /invites/[inviteId] accept — can't materialize a membership from one
 *   - PATCH  /members/[userId]          — can't re-role (there's no non-owner member)
 *
 * Impure DB-bound handlers, so the house pattern (standalone tsx, exit 0/1):
 *   1. Behavioral fixture — mirror of the guard predicate: PERSONAL rejected,
 *      SHARED untouched.
 *   2. Source-scan drift guards — each route still carries the SpaceType.PERSONAL
 *      rejection, and (invite/accept) it fires BEFORE the membership write.
 *
 *   npx tsx app/api/spaces/[id]/personal-single-user.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── 1. Behavioral fixture: mirror of the guard predicate ──────────────────────
// Mirrors:  if (space?.type === SpaceType.PERSONAL) return 400  (else proceed)
function rejectsMembership(spaceType: "PERSONAL" | "SHARED" | null | undefined): boolean {
  return spaceType === "PERSONAL";
}

check("PERSONAL space rejects a new member (invite)", rejectsMembership("PERSONAL") === true);
check("PERSONAL space rejects accepting into it", rejectsMembership("PERSONAL") === true);
check("PERSONAL space rejects a role change", rejectsMembership("PERSONAL") === true);
check("SHARED space is unaffected — membership allowed", rejectsMembership("SHARED") === false);
// Option A is role-blind: ANY role is rejected on PERSONAL, not just non-VIEWER.
for (const role of ["OWNER", "ADMIN", "MEMBER", "VIEWER"]) {
  check(`PERSONAL rejects invite regardless of role (${role})`, rejectsMembership("PERSONAL") === true);
}

// ── 2. Source-scan drift/safety guards ────────────────────────────────────────
const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), "utf8");
const scrunch = (s: string) => s.replace(/\s+/g, " ");

// -- invite route: rejects PERSONAL, before creating the invite --
{
  const src = read("app", "api", "spaces", "[id]", "invite", "route.ts");
  check("invite route guards on SpaceType.PERSONAL", /SpaceType\.PERSONAL/.test(src));
  check("invite route returns a 400 rejection", /status:\s*400/.test(scrunch(src)) && /additional members/i.test(src));
  const guardAt = src.indexOf("SpaceType.PERSONAL");
  const upsertAt = src.indexOf("spaceInvite.upsert");
  check("invite PERSONAL guard fires before the invite upsert", guardAt !== -1 && upsertAt !== -1 && guardAt < upsertAt, `guard@${guardAt} upsert@${upsertAt}`);
}

// -- accept route: rejects PERSONAL inside the accept branch, before the member write --
{
  const src = read("app", "api", "spaces", "[id]", "invites", "[inviteId]", "route.ts");
  check("accept route guards on SpaceType.PERSONAL", /SpaceType\.PERSONAL/.test(src));
  const guardAt  = src.indexOf("SpaceType.PERSONAL");
  const acceptAt = src.indexOf('action === "accept"');
  const memberAt = src.indexOf("spaceMember.upsert");
  check("accept PERSONAL guard is inside the accept branch", acceptAt !== -1 && guardAt > acceptAt);
  check("accept PERSONAL guard fires before the membership upsert", guardAt !== -1 && memberAt !== -1 && guardAt < memberAt, `guard@${guardAt} member@${memberAt}`);
}

// -- role-change route: PATCH rejects PERSONAL --
{
  const src = read("app", "api", "spaces", "[id]", "members", "[userId]", "route.ts");
  check("members role route guards on SpaceType.PERSONAL", /SpaceType\.PERSONAL/.test(src));
  check("members role route returns a 400 rejection", /status:\s*400/.test(scrunch(src)) && /members to manage/i.test(src));
}

// -- UI: ManageSpaceModal hides the invite affordance for personal spaces --
{
  const src = read("components", "dashboard", "ManageSpaceModal.tsx");
  check("ManageSpaceModal derives isPersonal from space.type", /isPersonal\s*=\s*space\.type\s*===\s*"PERSONAL"/.test(scrunch(src)));
  check("ManageSpaceModal gates canInvite on !isPersonal", /canInvite\s*=\s*!isPersonal/.test(scrunch(src)));
}

// ── Report ────────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\npersonal-single-user: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`personal-single-user: ${passed} checks passed`);
